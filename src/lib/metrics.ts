import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/**
 * Prometheus metrics. Each process (API instance, worker) keeps its own counters and serves
 * them at /metrics. Prometheus scrapes every instance and aggregates, so nothing here is
 * shared between processes.
 */
export const registry = new Registry();

// Process health: event-loop lag (the first thing to spike when a Node server is
// overloaded), heap, GC pauses, open handles, CPU.
collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request latency by route template (not raw URL, to keep label cardinality bounded)',
  labelNames: ['method', 'route', 'status_code'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

export const httpRequestsInFlight = new Gauge({
  name: 'http_requests_in_flight',
  help: 'Requests currently being handled by this instance',
  registers: [registry],
});

export const jobDuration = new Histogram({
  name: 'job_duration_seconds',
  help: 'Background job run time by queue, job name and outcome',
  labelNames: ['queue', 'job', 'outcome'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

export const holdAttempts = new Counter({
  name: 'booking_hold_attempts_total',
  help: 'Seat hold attempts by strategy and outcome (gate_rejected never reached the database)',
  labelNames: ['strategy', 'outcome'] as const,
  registers: [registry],
});

/** A gauge whose value is read when Prometheus scrapes (pool sizes, socket counts, ...). */
export function gaugeFrom(
  name: string,
  help: string,
  labelNames: string[],
  read: () => Promise<Array<[Record<string, string>, number]>> | Array<[Record<string, string>, number]>,
) {
  return new Gauge({
    name,
    help,
    labelNames,
    registers: [registry],
    async collect() {
      this.reset();
      for (const [labels, value] of await read()) this.set(labels, value);
    },
  });
}
