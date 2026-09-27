import { z } from 'zod';
import { AppError } from './errors.js';

/**
 * Keyset ("cursor") pagination. Instead of OFFSET n, which makes Postgres read and discard n
 * rows, the cursor stores the sort key of the last row seen, e.g. the next page of events
 * starts with WHERE (starts_at, id) > (cursor.at, cursor.id). Page 5,000 costs the same as
 * page 1, and rows inserted mid-scroll don't shift the results.
 *
 * Every listing sorts by (timestamp, id). The id breaks ties between equal timestamps, so
 * the order is total and no row is skipped or repeated.
 *
 * The cursor is opaque base64url, so clients can't depend on its contents and it can change later.
 */
const CursorSchema = z.object({ t: z.iso.datetime(), id: z.uuid() });

export type Cursor = { at: Date; id: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify({ t: c.at.toISOString(), id: c.id })).toString('base64url');
}

export function decodeCursor(raw: string): Cursor {
  try {
    const parsed = CursorSchema.parse(JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')));
    return { at: new Date(parsed.t), id: parsed.id };
  } catch {
    throw new AppError(400, 'INVALID_CURSOR', 'Cursor is malformed');
  }
}

/** Escape LIKE wildcards so a search for "100%" matches literally. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => '\\' + m);
}
