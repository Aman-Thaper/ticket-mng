import { describe, expect, it } from 'vitest';
import { calendarEvent, escapeText, fold } from '../../src/lib/ical.js';

const event = {
  uid: 'booking-42@tickets.example',
  start: new Date('2026-10-09T18:30:00Z'),
  end: new Date('2026-10-09T21:00:00Z'),
  stamp: new Date('2026-10-01T12:00:00Z'),
  summary: 'Hamlet',
};

/** Undo folding, as a calendar app reading the file would. */
const unfold = (ics: string) => ics.replace(/\r\n /g, '');

describe('iCalendar', () => {
  it('writes one VEVENT with UTC times and CRLF line endings', () => {
    const ics = calendarEvent(event);
    expect(ics.split('\r\n')).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Ticket MNG//Tickets//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'BEGIN:VEVENT',
      'UID:booking-42@tickets.example',
      'DTSTAMP:20261001T120000Z',
      'DTSTART:20261009T183000Z',
      'DTEND:20261009T210000Z',
      'SUMMARY:Hamlet',
      'STATUS:CONFIRMED',
      'END:VEVENT',
      'END:VCALENDAR',
      '', // the file ends with CRLF too
    ]);
    expect(ics).not.toMatch(/[^\r]\n/); // no bare LF anywhere
  });

  it('escapes text values: backslash, semicolon, comma and newlines', () => {
    expect(escapeText('Rock, Paper; Scissors\\Lizard\nSpock')).toBe(
      'Rock\\, Paper\\; Scissors\\\\Lizard\\nSpock',
    );
    const ics = calendarEvent({ ...event, location: 'Hall 1, Berlin', description: 'Seats:\nA1; A2' });
    expect(ics).toContain('LOCATION:Hall 1\\, Berlin\r\n');
    expect(ics).toContain('DESCRIPTION:Seats:\\nA1\\; A2\r\n');
  });

  it('folds long lines at 75 octets without splitting a UTF-8 character', () => {
    const summary = `Ünïcödé 🎭 ${'Shakespeare in the Park, '.repeat(6)}`;
    const ics = calendarEvent({ ...event, summary });
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    // Unfolding gives back the escaped value exactly: no character was cut in half.
    expect(unfold(ics)).toContain(`SUMMARY:${escapeText(summary)}\r\n`);
  });

  it('folds by bytes, not characters', () => {
    const folded = fold(`SUMMARY:${'é'.repeat(40)}`); // 8 + 80 bytes, 48 characters
    const [first, second] = folded.split('\r\n');
    expect(Buffer.byteLength(first!)).toBe(74); // 8 + 33 × 2; one more "é" would make 76
    expect(second!.startsWith(' é')).toBe(true);
    expect(fold('SHORT:line')).toBe('SHORT:line');
  });

  it('adds an optional reminder and a URL', () => {
    const ics = calendarEvent({
      ...event,
      alarmMinutesBefore: 120,
      url: 'https://tickets.example/my-tickets',
    });
    expect(ics).toContain('URL:https://tickets.example/my-tickets\r\n');
    expect(ics).toContain(
      'BEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Hamlet\r\nTRIGGER:-PT120M\r\nEND:VALARM',
    );
  });
});
