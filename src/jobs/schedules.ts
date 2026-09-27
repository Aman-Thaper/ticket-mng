import { getQueue } from './queues.js';

/**
 * Recurring jobs. upsertJobScheduler is idempotent: every worker instance can call it at
 * startup, and Redis still holds exactly one schedule per id, so no job runs N times
 * because N workers are running.
 */
export async function registerSchedules(): Promise<void> {
  await getQueue('bookings').upsertJobScheduler(
    'sweep-expired-holds',
    { every: 30_000 },
    { name: 'sweep-expired-holds', data: {}, opts: { attempts: 1 } },
  );
  await getQueue('maintenance').upsertJobScheduler(
    'send-event-reminders',
    { every: 15 * 60_000 },
    { name: 'send-event-reminders', data: {}, opts: { attempts: 3 } },
  );
  await getQueue('maintenance').upsertJobScheduler(
    'cleanup',
    { pattern: '0 3 * * *', tz: 'UTC' },
    { name: 'cleanup', data: {}, opts: { attempts: 3 } },
  );
}
