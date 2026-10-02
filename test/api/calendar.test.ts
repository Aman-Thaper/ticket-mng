import { beforeEach, describe, expect, it } from 'vitest';
import { sentMail } from '../../src/lib/mailer.js';
import { createEvent, createUser, createVenue, payFor, publish, useApp, type TestUser } from '../helpers.js';

/** "Add to calendar": the .ics download and the copy attached to the ticket email. */
describe('calendar entries', () => {
  const t = useApp();
  let buyer: TestUser;
  let event: { id: string; startsAt: string; endsAt: string };

  beforeEach(async () => {
    const organizer = await createUser('organizer');
    buyer = await createUser('attendee');
    const venueId = (await createVenue(t.app, organizer)).id;
    event = (await createEvent(t.app, organizer, venueId)).json();
    await publish(t.app, organizer, event.id);
  });

  const hold = async (user: TestUser, seats = 2) => {
    const map = (await t.app.inject({ url: `/api/v1/events/${event.id}/seats` })).json();
    const ids = map.sections[0].seats.slice(0, seats).map((s: { id: number }) => s.id);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/v1/events/${event.id}/bookings`,
      headers: user.auth,
      payload: { seatIds: ids },
    });
    return res.json<{ id: string }>().id;
  };

  const calendar = (bookingId: string, user?: TestUser) =>
    t.app.inject({ url: `/api/v1/bookings/${bookingId}/calendar.ics`, headers: user?.auth });

  const icsTime = (iso: string) =>
    new Date(iso)
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');

  it('gives the buyer an iCalendar file for a confirmed booking', async () => {
    const bookingId = await hold(buyer);
    await payFor(t.app, buyer, bookingId);

    const res = await calendar(bookingId, buyer);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="test-concert.ics"');
    expect(res.headers['cache-control']).toBe('private, no-store');
    const ics = res.body.replace(/\r\n /g, ''); // unfold
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain(`UID:booking-${bookingId}@localhost\r\n`);
    expect(ics).toContain(`DTSTART:${icsTime(event.startsAt)}\r\n`);
    expect(ics).toContain(`DTEND:${icsTime(event.endsAt)}\r\n`);
    expect(ics).toContain('SUMMARY:Test Concert\r\n');
    expect(ics).toContain('LOCATION:Test Arena\\, 1 Main St\\, Berlin\r\n');
    expect(ics).toContain('DESCRIPTION:Your seats: Floor\\, row A\\, seat 1\\; Floor\\, row A\\, seat 2\\n');
    expect(ics).toContain('TRIGGER:-PT120M');

    // The same booking always gives the same file, so calendar apps see one entry.
    expect((await calendar(bookingId, buyer)).body).toBe(res.body);
  });

  it('attaches the same entry to the ticket email', async () => {
    const bookingId = await hold(buyer);
    await payFor(t.app, buyer, bookingId);
    const mail = sentMail.find((m) => m.subject === 'Your tickets: Test Concert');
    const attachment = mail?.attachments?.find((a) => String(a.contentType).startsWith('text/calendar'));
    expect(attachment).toMatchObject({
      filename: 'test-concert.ics',
      contentType: 'text/calendar; charset=utf-8; method=PUBLISH',
    });
    expect(attachment!.content).toBe((await calendar(bookingId, buyer)).body);
    expect(mail!.text).toContain('open the attached .ics file');
  });

  it('is only for the buyer, and only once the booking is paid', async () => {
    const bookingId = await hold(buyer);

    const pending = await calendar(bookingId, buyer);
    expect(pending.statusCode).toBe(409);
    expect(pending.json().error.code).toBe('BOOKING_NOT_CONFIRMED');

    await payFor(t.app, buyer, bookingId);
    // Someone else's booking doesn't exist, as far as they can tell.
    expect((await calendar(bookingId, await createUser('attendee'))).statusCode).toBe(404);
    expect((await calendar(bookingId)).statusCode).toBe(401);
  });

  it('is documented as text/calendar, with JSON errors', async () => {
    const spec = (await t.app.inject({ url: '/docs/json' })).json();
    const responses = spec.paths['/api/v1/bookings/{id}/calendar.ics'].get.responses;
    expect(Object.keys(responses['200'].content)).toEqual(['text/calendar']);
    expect(Object.keys(responses['404'].content)).toEqual(['application/json']);
  });
});
