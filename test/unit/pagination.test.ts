import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, escapeLike } from '../../src/lib/pagination.js';

describe('cursor', () => {
  it('round-trips', () => {
    const c = { startsAt: new Date('2026-10-01T19:30:00.123Z'), id: '6f1c7f59-4a8e-4c7e-9a0b-0b7d1c2e3f40' };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it.each(['garbage', Buffer.from('{"s":"nope","id":"x"}').toString('base64url'), ''])(
    'rejects malformed cursor %j with a 400',
    (raw) => expect(() => decodeCursor(raw)).toThrow(expect.objectContaining({ statusCode: 400, code: 'INVALID_CURSOR' })),
  );
});

describe('escapeLike', () => {
  it('escapes wildcards', () => expect(escapeLike('100%_off\\')).toBe('100\\%\\_off\\\\'));
});
