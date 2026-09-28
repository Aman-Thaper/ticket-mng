import type { FastifyReply, FastifyRequest } from 'fastify';
import type { CachedBody } from './cache.js';

/**
 * Send an already-serialized JSON body with an ETag. A client (or CDN) that sends the ETag
 * back in If-None-Match gets 304 Not Modified with no body, which saves bandwidth when a
 * seat map is polled and hasn't changed.
 *
 * The body is a string, so Fastify sends it as-is: it's cached pre-serialized, precisely so
 * a cache hit costs no JSON work at all.
 */
export function sendCachedJson(
  req: FastifyRequest,
  reply: FastifyReply,
  { body, etag }: CachedBody,
  cacheControl: string,
): FastifyReply {
  reply.header('etag', etag).header('cache-control', cacheControl).header('vary', 'authorization');
  if (req.headers['if-none-match'] === etag) return reply.status(304).send();
  return reply.type('application/json; charset=utf-8').send(body);
}
