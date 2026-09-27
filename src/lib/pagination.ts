import { z } from 'zod';
import { AppError } from './errors.js';

/**
 * Keyset ("cursor") pagination. Instead of OFFSET n, which makes Postgres read and discard n
 * rows, the cursor stores the sort key of the last row seen and the next page starts with
 * WHERE (starts_at, id) > (cursor.startsAt, cursor.id). Page 5,000 costs the same as page 1,
 * and rows inserted mid-scroll don't shift the results.
 *
 * The cursor is opaque base64url, so clients can't depend on its contents and it can change later.
 */
const CursorSchema = z.object({ s: z.iso.datetime(), id: z.uuid() });

export type EventCursor = { startsAt: Date; id: string };

export function encodeCursor(c: EventCursor): string {
  return Buffer.from(JSON.stringify({ s: c.startsAt.toISOString(), id: c.id })).toString('base64url');
}

export function decodeCursor(raw: string): EventCursor {
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return { startsAt: new Date(parsed.s), id: parsed.id };
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'Cursor is malformed');
  }
}

/** Escape LIKE wildcards so a search for "100%" matches literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}
