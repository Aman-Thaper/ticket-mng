import { z } from 'zod';

export const ErrorResponse = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: 'Error' });

export const IdParams = z.object({ id: z.uuid() });

export const Timestamp = z.iso.datetime();
/** Input timestamps must carry an explicit offset (or Z), so they're never ambiguous. */
export const TimestampInput = z.iso.datetime({ offset: true });

export const Limit = z.coerce.number().int().min(1).max(100).default(20);

/** Standard error responses to attach to a route's `response` map. */
export const errors = {
  400: ErrorResponse,
  404: ErrorResponse,
  409: ErrorResponse,
  422: ErrorResponse,
} as const;
