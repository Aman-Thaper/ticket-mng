import { config } from '../../config.js';
import { db } from '../../db/index.js';
import type { BookingStatus } from '../../db/types.js';
import { calendarEvent } from '../../lib/ical.js';

/** What a booking's calendar entry needs. */
export interface BookingForCalendar {
  id: string;
  confirmedAt: Date;
  /** "Stalls, row A, seat 7" */
  seats: string[];
  event: {
    title: string;
    startsAt: Date;
    endsAt: Date;
    updatedAt: Date;
    venueName: string;
    venueAddress: string;
    city: string;
  };
}

/**
 * A confirmed booking as a calendar entry. Its UID is fixed per booking, so adding it twice
 * (from the email, then from My tickets) updates one entry instead of creating two. DTSTAMP
 * is when the booking or the event last changed, so the same booking always produces the
 * same file, and a rescheduled event produces a newer one.
 */
export function bookingCalendar(b: BookingForCalendar): string {
  const ticketsUrl = `${config.APP_URL}/my-tickets`;
  return calendarEvent({
    uid: `booking-${b.id}@${new URL(config.APP_URL).hostname}`,
    start: b.event.startsAt,
    end: b.event.endsAt,
    stamp: b.event.updatedAt > b.confirmedAt ? b.event.updatedAt : b.confirmedAt,
    summary: b.event.title,
    location: `${b.event.venueName}, ${b.event.venueAddress}, ${b.event.city}`,
    description: [
      `Your seats: ${b.seats.join('; ')}`,
      `Booking reference: ${b.id}`,
      `Your QR tickets: ${ticketsUrl}`,
    ].join('\n'),
    url: ticketsUrl,
    alarmMinutesBefore: 120,
  });
}

/** "Hamlet: The Musical!" → "hamlet-the-musical.ics" */
export const calendarFilename = (title: string) =>
  `${
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'event'
  }.ics`;

export async function loadBookingForCalendar(
  bookingId: string,
): Promise<(BookingForCalendar & { status: BookingStatus }) | undefined> {
  const [booking, seats] = await Promise.all([
    db
      .selectFrom('bookings as b')
      .innerJoin('events as e', 'e.id', 'b.eventId')
      .innerJoin('venues as v', 'v.id', 'e.venueId')
      .select([
        'b.id',
        'b.status',
        'b.confirmedAt',
        'e.title',
        'e.startsAt',
        'e.endsAt',
        'e.updatedAt',
        'v.name as venueName',
        'v.address as venueAddress',
        'v.city',
      ])
      .where('b.id', '=', bookingId)
      .executeTakeFirst(),
    db
      .selectFrom('bookingItems as bi')
      .innerJoin('eventSeats as es', 'es.id', 'bi.eventSeatId')
      .innerJoin('venueSeats as vs', 'vs.id', 'es.venueSeatId')
      .innerJoin('venueSections as sec', 'sec.id', 'vs.sectionId')
      .select(['sec.name as section', 'vs.rowLabel', 'vs.seatNumber'])
      .where('bi.bookingId', '=', bookingId)
      .orderBy('sec.sortOrder')
      .orderBy('vs.y')
      .orderBy('vs.x')
      .execute(),
  ]);
  if (!booking) return undefined;
  return {
    id: booking.id,
    status: booking.status,
    // Only confirmed bookings get a calendar entry; for the others, any timestamp will do.
    confirmedAt: booking.confirmedAt ?? booking.updatedAt,
    seats: seats.map((s) => `${s.section}, row ${s.rowLabel}, seat ${s.seatNumber}`),
    event: {
      title: booking.title,
      startsAt: booking.startsAt,
      endsAt: booking.endsAt,
      updatedAt: booking.updatedAt,
      venueName: booking.venueName,
      venueAddress: booking.venueAddress,
      city: booking.city,
    },
  };
}
