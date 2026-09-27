import { Counter, Registry } from 'prom-client';

/**
 * Prometheus metrics. Each process (API instance, worker) keeps its own counters. Prometheus
 * scrapes every instance and sums them, so nothing here needs to be shared between processes.
 */
export const registry = new Registry();

export const holdAttempts = new Counter({
  name: 'booking_hold_attempts_total',
  help: 'Seat hold attempts by strategy and outcome (gate_rejected never reached the database)',
  labelNames: ['strategy', 'outcome'] as const,
  registers: [registry],
});
