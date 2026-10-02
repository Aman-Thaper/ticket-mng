import { redis } from '../lib/redis.js';

/*
 * "1,240 people viewing now": how many browsers have an event's live seat map open, across
 * every API instance.
 *
 * Each instance knows only its own WebSocket clients, so every few seconds each one reports
 * its counts into Redis, one hash field per instance:
 *
 *   viewers:<event>   { "api-1#1": 412, "api-2#1": 398, "api-3#1": 430 }   → 1,240 viewing
 *   live-events       sorted set: event → when it last had viewers          → "Trending now"
 *
 * Every field carries its own expiry (HSETEX, Redis 8), refreshed with each report. An
 * instance that crashes simply stops refreshing, and its counts vanish within VIEWER_TTL_MS
 * instead of haunting the total forever. Readers sum whatever fields are left. No instance
 * coordinates with any other, and nothing needs cleaning up after a failure.
 *
 * Scores in live-events come from each instance's clock: a little skew (NTP keeps it to
 * milliseconds) only shifts when an event drops off the trending list.
 */

/** How often each instance reports its counts. */
export const VIEWER_REPORT_MS = 5_000;
/** A report stays valid this long: an instance that misses three reports in a row is gone. */
export const VIEWER_TTL_MS = 15_000;

export const viewersKey = (eventId: string) => `viewers:${eventId}`;
export const LIVE_EVENTS_KEY = 'live-events';

type PipelineResults = [error: Error | null, result: unknown][] | null;

function resultsOf(results: PipelineResults): unknown[] {
  return (results ?? []).map(([error, result]) => {
    if (error) throw error;
    return result;
  });
}

/** One instance's share of the counts. */
export class ViewerCounts {
  /** Events this instance reported a count for last time. */
  private reported = new Set<string>();

  constructor(
    private readonly instanceId: string,
    private readonly ttlMs = VIEWER_TTL_MS,
  ) {}

  /** Publish this instance's open connections per event (events with none are left out). */
  async report(counts: ReadonlyMap<string, number>): Promise<void> {
    // An idle instance has nothing to say. (Busy ones trim live-events; readers filter by
    // score anyway.)
    if (!counts.size && !this.reported.size) return;
    const now = Date.now();
    const pipeline = redis.pipeline();
    for (const [eventId, n] of counts) {
      // Sets the field and its expiry in one atomic command.
      pipeline.hsetex(viewersKey(eventId), 'PX', this.ttlMs, 'FIELDS', 1, this.instanceId, n);
      pipeline.zadd(LIVE_EVENTS_KEY, now, eventId);
    }
    // Events whose last viewer here has left: withdraw our count now rather than at expiry.
    for (const eventId of this.reported) {
      if (!counts.has(eventId)) pipeline.hdel(viewersKey(eventId), this.instanceId);
    }
    pipeline.zremrangebyscore(LIVE_EVENTS_KEY, '-inf', now - this.ttlMs);
    resultsOf(await pipeline.exec());
    this.reported = new Set(counts.keys());
  }

  /** Remove every count this instance reported (graceful shutdown: its clients move elsewhere). */
  async withdraw(): Promise<void> {
    if (!this.reported.size) return;
    const pipeline = redis.pipeline();
    for (const eventId of this.reported) pipeline.hdel(viewersKey(eventId), this.instanceId);
    this.reported.clear();
    resultsOf(await pipeline.exec());
  }
}

/** Viewers per event, summed over every instance's unexpired count. One round trip. */
export async function viewerTotals(eventIds: readonly string[]): Promise<Map<string, number>> {
  if (!eventIds.length) return new Map();
  const pipeline = redis.pipeline();
  for (const id of eventIds) pipeline.hvals(viewersKey(id));
  const results = resultsOf(await pipeline.exec()) as string[][];
  return new Map(eventIds.map((id, i) => [id, results[i]!.reduce((sum, n) => sum + Number(n), 0)]));
}

/** Events being watched right now, most viewers first. */
export async function mostViewed(limit: number): Promise<{ eventId: string; viewers: number }[]> {
  const live = await redis.zrangebyscore(LIVE_EVENTS_KEY, Date.now() - VIEWER_TTL_MS, '+inf');
  const totals = await viewerTotals(live);
  return [...totals]
    .filter(([, viewers]) => viewers > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([eventId, viewers]) => ({ eventId, viewers }));
}
