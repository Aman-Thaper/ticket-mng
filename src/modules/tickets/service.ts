import { sql, type Transaction } from 'kysely';
import QRCode from 'qrcode';
import { db } from '../../db/index.js';
import type { DB } from '../../db/types.js';
import { signTicket } from './signing.js';

/**
 * One ticket per seat, issued in the same transaction that confirms the booking. The
 * tickets_one_valid_per_seat index makes it impossible for a seat to get a second valid
 * ticket, even if some other logic went wrong.
 */
export async function issueTickets(trx: Transaction<DB>, bookingId: string): Promise<void> {
  await trx
    .insertInto('tickets')
    .columns(['bookingId', 'eventId', 'eventSeatId'])
    .expression(
      trx
        .selectFrom('bookingItems as bi')
        .innerJoin('bookings as b', 'b.id', 'bi.bookingId')
        .select(['bi.bookingId', 'b.eventId', 'bi.eventSeatId'])
        .where('bi.bookingId', '=', bookingId),
    )
    .execute();
}

/** Refunds void tickets: a voided QR code is rejected at the door. */
export async function voidTickets(trx: Transaction<DB>, bookingId: string): Promise<void> {
  await trx
    .updateTable('tickets')
    .set({ status: 'void', voidedAt: sql`now()` })
    .where('bookingId', '=', bookingId)
    .where('status', '=', 'valid')
    .execute();
}

export interface TicketView {
  id: string;
  eventId: string;
  status: 'valid' | 'void';
  checkedInAt: Date | null;
  section: string;
  row: string;
  number: number;
  /** The signed token encoded in the QR code. */
  token: string;
}

export async function ticketsForBooking(bookingId: string): Promise<TicketView[]> {
  const rows = await db
    .selectFrom('tickets as t')
    .innerJoin('eventSeats as es', 'es.id', 't.eventSeatId')
    .innerJoin('venueSeats as vs', 'vs.id', 'es.venueSeatId')
    .innerJoin('venueSections as sec', 'sec.id', 'vs.sectionId')
    .select([
      't.id',
      't.eventId',
      't.status',
      't.checkedInAt',
      'sec.name as section',
      'vs.rowLabel',
      'vs.seatNumber',
    ])
    .where('t.bookingId', '=', bookingId)
    .orderBy('sec.sortOrder')
    .orderBy('vs.y')
    .orderBy('vs.x')
    .execute();
  return rows.map((r) => ({
    id: r.id,
    eventId: r.eventId,
    status: r.status,
    checkedInAt: r.checkedInAt,
    section: r.section,
    row: r.rowLabel,
    number: r.seatNumber,
    token: signTicket({ ticketId: r.id, eventId: r.eventId }),
  }));
}

const QR_OPTIONS = { errorCorrectionLevel: 'M', margin: 2, width: 320 } as const;

export const qrPng = (token: string): Promise<Buffer> => QRCode.toBuffer(token, QR_OPTIONS);
export const qrDataUrl = (token: string): Promise<string> => QRCode.toDataURL(token, QR_OPTIONS);
