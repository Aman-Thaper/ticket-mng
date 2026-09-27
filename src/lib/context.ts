import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context that follows async calls without being passed around explicitly.
 * Fastify's onRequest hook enters it (see app.ts), so deep code like the outbox can stamp the
 * request id onto jobs. The worker then logs that id, and one grep follows a request from
 * the HTTP call through every background job it caused.
 */
export interface RequestContext {
  requestId: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export const currentRequestId = (): string | undefined => requestContext.getStore()?.requestId;
