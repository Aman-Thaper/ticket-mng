import { describe, expect, it } from 'vitest';

// The browser's helpers (public/format.js), which only use Intl, so they run in Node too.
// Imported through a variable: the type checker doesn't read the site's plain JavaScript.
const formatModule = '../../public/format.js';
const { zonedTimeToUtc, utcToZonedInput } = (await import(formatModule)) as {
  zonedTimeToUtc: (local: string, timeZone: string) => string;
  utcToZonedInput: (iso: string, timeZone: string) => string;
};

describe('wall-clock times in a venue time zone', () => {
  it('turns the venue clock time into the right instant', () => {
    expect(zonedTimeToUtc('2026-10-09T19:30', 'Asia/Tokyo')).toBe('2026-10-09T10:30:00.000Z'); // UTC+9
    expect(zonedTimeToUtc('2026-10-09T19:30', 'Asia/Kolkata')).toBe('2026-10-09T14:00:00.000Z'); // UTC+5:30
    expect(zonedTimeToUtc('2026-10-09T19:30', 'America/New_York')).toBe('2026-10-09T23:30:00.000Z'); // EDT
    expect(zonedTimeToUtc('2026-12-09T19:30', 'America/New_York')).toBe('2026-12-10T00:30:00.000Z'); // EST
    expect(zonedTimeToUtc('2026-10-09T19:30', 'UTC')).toBe('2026-10-09T19:30:00.000Z');
  });

  it('gets the days the clocks change right', () => {
    // London: 01:00 UTC on 25 Oct 2026 is when BST ends; 00:30 local is still BST (UTC+1).
    expect(zonedTimeToUtc('2026-10-25T00:30', 'Europe/London')).toBe('2026-10-24T23:30:00.000Z');
    expect(zonedTimeToUtc('2026-10-25T12:00', 'Europe/London')).toBe('2026-10-25T12:00:00.000Z');
    // Sydney switches to daylight time on 4 Oct 2026 (UTC+10 → UTC+11).
    expect(zonedTimeToUtc('2026-10-03T20:00', 'Australia/Sydney')).toBe('2026-10-03T10:00:00.000Z');
    expect(zonedTimeToUtc('2026-10-04T20:00', 'Australia/Sydney')).toBe('2026-10-04T09:00:00.000Z');
  });

  it('goes back the other way, for editing', () => {
    for (const zone of ['Asia/Tokyo', 'Asia/Kolkata', 'America/New_York', 'Europe/London', 'UTC']) {
      expect(utcToZonedInput(zonedTimeToUtc('2026-11-20T08:05', zone), zone)).toBe('2026-11-20T08:05');
    }
  });
});
