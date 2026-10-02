import type { WebSocket } from 'ws';
import { gaugeFrom } from '../lib/metrics.js';
import { createRedis } from '../lib/redis.js';
import { INSTANCE_ID, logger } from '../lib/logger.js';
import { seatChannel, type SeatTuple } from './seat-updates.js';
import { VIEWER_REPORT_MS, ViewerCounts, viewerTotals } from './viewers.js';

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
 *
 * The hub also counts its clients per event for "N viewing now" (see viewers.ts): every
 * VIEWER_REPORT_MS it reports its counts to Redis, reads back the totals across all
 * instances, and sends {type:'viewers'} to an event's clients when the total has changed.
 */
/** Every hub in this process (normally one; tests build several apps). */
const hubs = new Set<LiveSeatHub>();
let hubSeq = 0;

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
  // "#n" tells apart several hubs in one process (tests run two apps side by side).
  private readonly viewers = new ViewerCounts(`${INSTANCE_ID}#${++hubSeq}`);
  private readonly viewerTimer: NodeJS.Timeout;
  private reporting: Promise<void> | null = null;
  /** The viewer total each event's clients were last told. */
  private readonly sentTotals = new Map<string, number>();

  constructor() {
    hubs.add(this);
    this.subscriber.on('message', (channel: string, message: string) => this.onMessage(channel, message));
    this.heartbeat = setInterval(() => this.ping(), HEARTBEAT_MS);
    this.heartbeat.unref();
    this.viewerTimer = setInterval(() => {
      this.reportViewers().catch((err: unknown) => logger.warn({ err }, 'viewer count report failed'));
    }, VIEWER_REPORT_MS);
    this.viewerTimer.unref();
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

  /** The viewer total most recently sent to this event's clients, if any. */
  lastViewerCount(eventId: string): number | undefined {
    return this.sentTotals.get(eventId);
  }

  /**
   * Report this instance's clients per event, then send each event's clients the new total
   * across all instances, if it changed. Runs every VIEWER_REPORT_MS; tests call it directly.
   * One report at a time: if Redis is slow, a tick that comes due joins the running report.
   */
  reportViewers(): Promise<void> {
    this.reporting ??= this.report().finally(() => {
      this.reporting = null;
    });
    return this.reporting;
  }

  private async report() {
    const counts = new Map([...this.sockets].map(([eventId, sockets]) => [eventId, sockets.size]));
    await this.viewers.report(counts);
    const totals = await viewerTotals([...counts.keys()]);
    for (const [eventId, total] of totals) {
      if (this.sentTotals.get(eventId) === total) continue;
      this.sentTotals.set(eventId, total);
      const payload = JSON.stringify({ type: 'viewers', eventId, count: total });
      for (const socket of this.sockets.get(eventId) ?? []) this.send(socket, payload);
    }
    for (const eventId of this.sentTotals.keys()) {
      if (!this.sockets.has(eventId)) this.sentTotals.delete(eventId);
    }
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
    clearInterval(this.viewerTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    for (const viewers of this.sockets.values()) {
      for (const socket of viewers) socket.close(1001, 'Server shutting down'); // 1001 = going away: reconnect
    }
    this.sockets.clear();
    // Our clients are about to be counted by the instances they reconnect to. (A report
    // still in flight finishes first, or it could re-add counts after the withdrawal.)
    await this.reporting?.catch(() => {});
    await this.viewers
      .withdraw()
      .catch((err: unknown) => logger.warn({ err }, 'viewer count withdraw failed'));
    await this.subscriber.quit().catch(() => {});
  }
}
