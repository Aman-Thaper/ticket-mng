import { afterCommit } from '../db/transaction.js';
import type { SeatStatus } from '../db/types.js';
import { redis } from '../lib/redis.js';

/** A seat's new state, as broadcast to live seat maps. */
export interface SeatChange {
  id: number;
  eventId: string;
  status: SeatStatus;
  version: number;
}

/** Wire format: compact tuples, since a busy on-sale can push thousands of these a second. */
export type SeatTuple = [id: number, status: SeatStatus, version: number];

export const seatChannel = (eventId: string) => `seats:${eventId}`;

/**
 * Broadcast seat changes to every API instance, once the transaction that made them has
 * committed. Clients must never see a hold that then rolls back.
 *
 * Redis pub/sub is fire-and-forget: an instance that is briefly disconnected misses
 * messages. That's acceptable here because the seat map endpoint is always the source of
 * truth: clients reload it when they (re)connect, and seat versions let them ignore stale
 * updates.
 */
export function notifySeatChanges(changes: SeatChange[]): void {
  if (!changes.length) return;
  const byEvent = new Map<string, SeatTuple[]>();
  for (const c of changes) {
    const list = byEvent.get(c.eventId) ?? [];
    list.push([c.id, c.status, c.version]);
    byEvent.set(c.eventId, list);
  }
  afterCommit(async () => {
    const pipeline = redis.pipeline();
    for (const [eventId, seats] of byEvent) pipeline.publish(seatChannel(eventId), JSON.stringify(seats));
    await pipeline.exec();
  });
}
