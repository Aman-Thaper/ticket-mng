import type { JobData, JobName, QueueName } from '../queues.js';
import type { JobHandler } from '../runner.js';
import { expireBookingJob, sweepExpiredHolds } from './bookings.js';
import { bookingConfirmed, eventReminder, passwordReset, refundProcessed } from './email.js';
import { cleanup, sendEventReminders } from './maintenance.js';
import { processPoster } from './media.js';
import { processWebhook, refund, refundEvent } from './payments.js';

type Handlers = { [Q in QueueName]: { [N in JobName<Q>]: JobHandler<JobData<Q, N>> } };

/** Every job name declared in queues.ts must have a handler here; TypeScript enforces it. */
export const handlers: Handlers = {
  email: {
    'password-reset': passwordReset,
    'booking-confirmed': bookingConfirmed,
    'event-reminder': eventReminder,
    'refund-processed': refundProcessed,
  },
  payments: {
    'process-webhook': processWebhook,
    refund,
    'refund-event': refundEvent,
  },
  bookings: {
    'expire-booking': expireBookingJob,
    'sweep-expired-holds': sweepExpiredHolds,
  },
  media: {
    'process-poster': processPoster,
  },
  maintenance: {
    'send-event-reminders': sendEventReminders,
    cleanup,
  },
};
