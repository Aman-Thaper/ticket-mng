import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { hasZodFastifySchemaValidationErrors, isResponseSerializationError } from 'fastify-type-provider-zod';

/**
 * Every error response has the same shape:
 *   { "error": { "code": "NOT_FOUND", "message": "Event not found", "details": ... } }
 * Clients branch on `code`, which is stable. `message` is for humans and may change.
 */
export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (resource: string) => new AppError(404, 'NOT_FOUND', `${resource} not found`);

/** 401: the caller isn't (validly) authenticated. */
export const unauthorized = (code = 'UNAUTHENTICATED', message = 'Authentication required') =>
  new AppError(401, code, message);

/** 403: authenticated, but not allowed to do this. */
export const forbidden = (message = 'You do not have permission to perform this action') =>
  new AppError(403, 'FORBIDDEN', message);

export const conflict = (code: string, message: string, details?: unknown) =>
  new AppError(409, code, message, details);

export const unprocessable = (code: string, message: string, details?: unknown) =>
  new AppError(422, code, message, details);

// https://www.postgresql.org/docs/current/errcodes-appendix.html
const PG_ERRORS: Record<string, { status: number; code: string; message: string }> = {
  '23505': { status: 409, code: 'DUPLICATE', message: 'Resource already exists' },
  '23503': {
    status: 409,
    code: 'REFERENCE_CONFLICT',
    message: 'Operation violates a reference to another resource',
  },
  '23P01': {
    status: 409,
    code: 'EXCLUSION_CONFLICT',
    message: 'Operation conflicts with an existing resource',
  },
  '23514': { status: 422, code: 'CONSTRAINT_VIOLATION', message: 'Operation violates a data constraint' },
};

const CLIENT_ERROR_CODES: Record<number, string> = {
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
};

type PgError = { code: string; constraint?: string };

function asPgError(err: unknown): PgError | null {
  return typeof err === 'object' && err !== null && 'code' in err && 'severity' in err
    ? (err as PgError)
    : null;
}

export function errorHandler(err: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  if (hasZodFastifySchemaValidationErrors(err)) {
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: `Invalid request ${err.validationContext ?? 'input'}`,
        details: err.validation.map((v) => ({
          path: `${err.validationContext ?? ''}${v.instancePath.replaceAll('/', '.')}`,
          message: v.message,
        })),
      },
    });
  }

  if (err instanceof AppError) {
    // RFC 6750: tell clients which auth scheme to use (and why a token was rejected).
    if (err.statusCode === 401) {
      reply.header('www-authenticate', `Bearer error="invalid_token", error_description="${err.code}"`);
    }
    return reply.status(err.statusCode).send({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }

  // A constraint the handler didn't check up front (or a race the check lost) still gets
  // a clean 4xx. The database is the final safety net.
  const pgErr = asPgError(err);
  const mapped = pgErr && PG_ERRORS[pgErr.code];
  if (mapped) {
    req.log.info({ constraint: pgErr.constraint }, 'constraint violation');
    return reply.status(mapped.status).send({
      error: { code: mapped.code, message: mapped.message, details: { constraint: pgErr.constraint } },
    });
  }

  // Deadlock victim / serialization failure that survived withTransaction's retries (or
  // came from code that doesn't retry). The request was fine; the client should try again.
  if (pgErr && (pgErr.code === '40P01' || pgErr.code === '40001')) {
    req.log.warn({ code: pgErr.code }, 'transient database conflict');
    reply.header('retry-after', 1);
    return reply.status(503).send({
      error: {
        code: 'TRANSIENT_CONFLICT',
        message: 'The request conflicted with a concurrent one; please retry',
      },
    });
  }

  if (isResponseSerializationError(err)) {
    req.log.error({ err }, 'response failed schema validation');
    return reply.status(500).send({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  }

  // Fastify's own client errors: malformed JSON, wrong content-type, body too large, ...
  // Their FST_ERR_* codes are framework internals, so clients get a stable code instead.
  if (err.statusCode && err.statusCode < 500) {
    return reply.status(err.statusCode).send({
      error: { code: CLIENT_ERROR_CODES[err.statusCode] ?? 'BAD_REQUEST', message: err.message },
    });
  }

  req.log.error({ err }, 'unhandled error');
  return reply.status(500).send({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  });
}
