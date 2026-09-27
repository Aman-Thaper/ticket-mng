import { executeRefund, processWebhookEvent, refundEventBookings } from '../../modules/payments/service.js';
import type { Jobs } from '../queues.js';
import type { JobHandler } from '../runner.js';

export const processWebhook: JobHandler<Jobs['payments']['process-webhook']> = async (job) =>
  processWebhookEvent(job.data.provider, job.data.eventId);

export const refund: JobHandler<Jobs['payments']['refund']> = async (job) => executeRefund(job.data.refundId);

export const refundEvent: JobHandler<Jobs['payments']['refund-event']> = async (job, log) => {
  const result = await refundEventBookings(job.data.eventId);
  log.info(result, 'event cancellation processed');
  return result;
};
