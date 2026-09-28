import type { WebSocket } from 'ws';
import { gaugeFrom } from '../lib/metrics.js';
import { createRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { seatChannel, type SeatTuple } from './seat-updates.js';

/** Changes arriving within this window go out as one message. */
const FLUSH_MS = 100;
/** A client that has this much unsent data isn't keeping up: disconnect it. */
const MAX_BUFFERED_BYTES = 1 << 20;
const HEARTBEAT_MS = 30_000;
/** Connections per instance; beyond this, new ones are told to retry elsewhere. */
const MAX_CONNECTIONS = 20_000;

/*
 * One hub per API instance. Seat changes can happen on any instance (or in the worker), so
 * they travel through Redis pub/sub:
 *
 *   instance A: hold committed → PUBLISH seats:<event>
 *                                   │
 *            ┌──────────────────────┼──────────────────────┐
 *            ▼                      ▼                      ▼
 *   instance A hub          instance B hub          instance C hub   (only those with viewers)
 *   → its sockets           → its sockets           → its sockets
 *
 * Nothing about subscribers is shared between instances, so any instance can serve any
 * client, and a crashed instance takes nothing with it: its clients reconnect elsewhere.
 */
/** Every hub in this process (normally one; tests build several apps). */
const hubs = new Set<LiveSeatHub>();

gaugeFrom('websocket_connections', 'Live seat-map WebSocket connections on this instance', [], () => [
  [{}, [...hubs].reduce((sum, hub) => sum + hub.stats().connections, 0)],
]);

export class LiveSeatHub {
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly pending = new Map<string, Map<number, SeatTuple>>();
  private readonly alive = new WeakSet<WebSocket>();
  // Subscribing puts a Redis connection into a mode where it can't run other commands,
  // hence a dedicated one.
  private readonly subscriber = createRedis({ maxRetriesPerRequest: null });
  private readonly heartbeat: NodeJS.Timeout;
  private flushTimer: NodeJS.Timeout | null = null;
  private connections = 0;

  constructor() {
    hubs.add(this);
    this.subscriber.on('message', (channel: string, message: string) => this.onMessage(channel, message));
    this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  /** Register a client socket for an event's updates. Resolves once the subscription is live. */
  async join(eventId: string, socket: WebSocket): Promise<boolean> {
    if (this.connections >= MAX_CONNECTIONS) {
      socket.close(1013, 'Server busy; try again'); // 1013 = try again later
      return false;
    }
    this.connections++;
    this.alive.add(socket);
    socket.on('pong', () => this.alive.add(socket));
    socket.once('close', () => {
      this.connections--;
      this.leave(eventId, socket).catch((err: unknown) =>
        logger.warn({ err, eventId }, 'unsubscribe failed'),
      );
    });

    let viewers = this.sockets.get(eventId);
    if (!viewers) {
      viewers = new Set();
      this.sockets.set(eventId, viewers);
      await this.subscriber.subscribe(seatChannel(eventId));
    }
    viewers.add(socket);
    return true;
  }

  private async leave(eventId: string, socket: WebSocket) {
    const viewers = this.sockets.get(eventId);
    if (!viewers) return;
    viewers.delete(socket);
    if (viewers.size === 0) {
      this.sockets.delete(eventId);
      this.pending.delete(eventId);
      await this.subscriber.unsubscribe(seatChannel(eventId));
    }
  }

  private onMessage(channel: string, message: string) {
    const eventId = channel.slice('seats:'.length);
    if (!this.sockets.has(eventId)) return;

    let buffer = this.pending.get(eventId);
    if (!buffer) this.pending.set(eventId, (buffer = new Map()));
    for (const tuple of JSON.parse(message) as SeatTuple[]) {
      // Coalesce: if a seat changed twice in this window, only its newest state goes out.
      const previous = buffer.get(tuple[0]);
      if (!previous || previous[2] < tuple[2]) buffer.set(tuple[0], tuple);
    }
    this.flushTimer ??= setTimeout(() => this.flush(), FLUSH_MS);
  }

  private flush() {
    this.flushTimer = null;
    for (const [eventId, buffer] of this.pending) {
      // Serialize once per event, not once per client.
      const payload = JSON.stringify({ type: 'seats', eventId, seats: [...buffer.values()] });
      for (const socket of this.sockets.get(eventId) ?? []) this.send(socket, payload);
    }
    this.pending.clear();
  }

  private send(socket: WebSocket, payload: string) {
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Backpressure: one slow phone mustn't make the server buffer unbounded data for it.
      // It will reconnect and reload the seat map.
      socket.terminate();
      return;
    }
    socket.send(payload);
  }

  /** Drop connections that didn't answer the previous ping (half-open TCP, sleeping laptops). */
  private ping() {
    for (const viewers of this.sockets.values()) {
      for (const socket of viewers) {
        if (!this.alive.has(socket)) {
          socket.terminate();
          continue;
        }
        this.alive.delete(socket);
        socket.ping();
      }
    }
  }

  stats() {
    return { events: this.sockets.size, connections: this.connections };
  }

  async close(): Promise<void> {
    hubs.delete(this);
    clearInterval(this.heartbeat);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const viewers of this.sockets.values()) {
      for (const socket of viewers) socket.close(1001, 'Server shutting down'); // 1001 = going away: reconnect
    }
    this.sockets.clear();
    await this.subscriber.quit().catch(() => {});
  }
}
