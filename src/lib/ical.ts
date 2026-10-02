/*
 * iCalendar (RFC 5545) for one event: what "Add to calendar" downloads and the ticket email
 * attaches. Apple Calendar, Google Calendar and Outlook all read it.
 *
 * The format's sharp edges, all handled here:
 *   - lines end in CRLF, not LF;
 *   - a line may not exceed 75 octets (bytes, not characters). Longer ones are folded onto
 *     continuation lines that start with a space, never splitting a UTF-8 character;
 *   - text values escape backslash, semicolon, comma and newline;
 *   - times are UTC ("…Z"): an absolute instant that each calendar shows in its owner's
 *     zone. (A venue-zone TZID would need a full VTIMEZONE definition to be portable.)
 */

export interface CalendarEvent {
  /** Globally unique and stable: adding the same event again updates it instead of duplicating it. */
  uid: string;
  start: Date;
  end: Date;
  summary: string;
  location?: string;
  description?: string;
  url?: string;
  /** Add a reminder this many minutes before the start. */
  alarmMinutesBefore?: number;
  /** When this version of the entry was created. Pass a fixed time to make the output repeatable. */
  stamp?: Date;
}

/** 2026-10-09T18:30:00.000Z → 20261009T183000Z */
const utc = (d: Date) =>
  d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');

/** Escape a TEXT value (RFC 5545 §3.3.11). */
export const escapeText = (s: string) =>
  s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

const utf8Length = (codePoint: number) =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

/** Fold a content line at 75 octets (§3.1). Continuation lines start with one space. */
export function fold(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const ch of line) {
    // `for…of` walks code points, so a character's bytes always stay on one line.
    const size = utf8Length(ch.codePointAt(0)!);
    const limit = parts.length ? 74 : 75; // the leading space counts on continuation lines
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += ch;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/** A complete calendar file holding one event. */
export function calendarEvent(e: CalendarEvent): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Ticket MNG//Tickets//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeText(e.uid)}`,
    `DTSTAMP:${utc(e.stamp ?? new Date())}`,
    `DTSTART:${utc(e.start)}`,
    `DTEND:${utc(e.end)}`,
    `SUMMARY:${escapeText(e.summary)}`,
    ...(e.location ? [`LOCATION:${escapeText(e.location)}`] : []),
    ...(e.description ? [`DESCRIPTION:${escapeText(e.description)}`] : []),
    ...(e.url ? [`URL:${e.url}`] : []), // a URI, not text: no escaping
    'STATUS:CONFIRMED',
    ...(e.alarmMinutesBefore
      ? [
          'BEGIN:VALARM',
          'ACTION:DISPLAY',
          `DESCRIPTION:${escapeText(e.summary)}`,
          `TRIGGER:-PT${e.alarmMinutesBefore}M`,
          'END:VALARM',
        ]
      : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
