/**
 * End-to-end check in a real (headless) browser: an account from signup to tickets in the inbox.
 *
 *   npm run e2e                      # against http://localhost:8080 (docker compose / cluster)
 *   npm run e2e -- --base-url http://localhost:3000
 *
 * The buyer signs up on /signup, opens the confirmation email (read from Mailpit's API) and
 * follows its link, then picks two seats, holds them, pays with a test card and gets QR
 * tickets, and the email with those QR codes must arrive at the address they signed up with.
 * Meanwhile a second browser, the "watcher", must see the seats turn held, then sold, live
 * over the WebSocket, without reloading. Screenshots go to .dev/e2e-*.png.
 * Needs the API, the worker (it sends email and confirms payments) and Mailpit.
 */
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import { sql } from 'kysely';
import { db } from '../src/db/index.js';
import { redis } from '../src/lib/redis.js';
import { generateSeats } from '../src/modules/venues/layout.js';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:8080' },
    'mailpit-url': { type: 'string', default: 'http://localhost:8025' },
  },
});
const BASE = values['base-url'];
const MAILPIT = values['mailpit-url'];

interface MailSummary {
  ID: string;
  Subject: string;
}
interface MailDetail {
  Subject: string;
  Text: string;
  HTML: string;
  Inline: { ContentType: string; ContentID: string }[];
}

/** Wait for an email to `to` whose subject starts with `subject`, via Mailpit's API. */
async function waitForMail(to: string, subject: string, timeoutMs = 20_000): Promise<MailDetail> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
    const { messages } = (await res.json()) as { messages: MailSummary[] | null };
    const hit = messages?.find((m) => m.Subject.startsWith(subject));
    if (hit) return (await (await fetch(`${MAILPIT}/api/v1/message/${hit.ID}`)).json()) as MailDetail;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`no "${subject}" email for ${to} within ${timeoutMs / 1000} s`);
}

// ─── a fresh, small event ────────────────────────────────────────────────────────────────
const tag = `e2e-${Date.now()}`;
const organizer = await db
  .insertInto('users')
  .values({
    email: `${tag}@example.com`,
    name: 'E2E Organizer',
    role: 'organizer',
    emailVerifiedAt: new Date(),
  })
  .returning('id')
  .executeTakeFirstOrThrow();
// The buyer signs up through the UI, so the account pages are part of the test.
const buyerEmail = `${tag}-buyer@example.com`;
const buyerPassword = 'e2e password 123';
const sections = [
  { name: 'Stalls', rows: 6, seatsPerRow: 14 },
  { name: 'Circle', rows: 4, seatsPerRow: 10 },
];
const seats = generateSeats(sections);
const venue = await db
  .insertInto('venues')
  .values({
    name: `${tag} Theatre`,
    address: '1 Test St',
    city: 'Testville',
    country: 'US',
    capacity: seats.length,
  })
  .returning('id')
  .executeTakeFirstOrThrow();
const sectionRows = await db
  .insertInto('venueSections')
  .values(sections.map((s, i) => ({ venueId: venue.id, name: s.name, sortOrder: i })))
  .returning(['id', 'name'])
  .execute();
const sectionId = new Map(sectionRows.map((s) => [s.name, s.id]));
await sql`
  INSERT INTO venue_seats (section_id, row_label, seat_number, x, y)
  SELECT * FROM unnest(${seats.map((s) => sectionId.get(s.section))}::uuid[], ${seats.map((s) => s.rowLabel)}::text[],
    ${seats.map((s) => s.seatNumber)}::int[], ${seats.map((s) => s.x)}::int[], ${seats.map((s) => s.y)}::int[])
`.execute(db);
const startsAt = new Date(Date.now() + 5 * 86_400_000);
const event = await db
  .insertInto('events')
  .values({
    organizerId: organizer.id,
    venueId: venue.id,
    title: 'E2E: Live Seat Map',
    category: 'theatre',
    status: 'published',
    startsAt,
    endsAt: new Date(startsAt.getTime() + 2 * 3_600_000),
  })
  .returning('id')
  .executeTakeFirstOrThrow();
await sql`
  INSERT INTO event_seats (event_id, venue_seat_id, price_cents)
  SELECT ${event.id}::uuid, vs.id, CASE sec.sort_order WHEN 0 THEN 7500 ELSE 4000 END
  FROM venue_seats vs JOIN venue_sections sec ON sec.id = vs.section_id WHERE sec.venue_id = ${venue.id}::uuid
`.execute(db);

// ─── two browsers ────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
const consoleErrors: string[] = [];
const newPage = async (name: string) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${name}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${name}: ${e.message}`));
  return page;
};
const openMap = async (page: Page) => {
  await page.goto(`${BASE}/?event=${event.id}`);
  await page.locator('#live-status', { hasText: 'live' }).waitFor({ timeout: 10_000 });
  await page.locator('rect.seat').first().waitFor();
};
const seatClass = (page: Page, id: string) => page.locator(`rect[data-id="${id}"]`).getAttribute('class');
const step = (message: string) => console.log(`✓ ${message}`);

try {
  const watcher = await newPage('watcher');
  await openMap(watcher);
  const buyer = await newPage('buyer');

  // ── sign up ──
  await buyer.goto(`${BASE}/signup?next=${encodeURIComponent(`/?event=${event.id}`)}`);
  await buyer.locator('#name').fill('E2E Buyer');
  await buyer.locator('#email').fill(buyerEmail);
  await buyer.locator('#password').fill(buyerPassword);
  await buyer.locator('#submit').click();
  await buyer.locator('#done-view h1', { hasText: 'Check your inbox' }).waitFor();
  step(`signed up as ${buyerEmail}; the page asks to confirm the email`);

  // Unconfirmed: can browse, can't book.
  await openMap(buyer);
  await buyer.locator('#verify-banner').waitFor();
  await buyer.locator('#hold-button', { hasText: 'Confirm your email' }).waitFor();
  step('before confirming: the seat map shows the confirmation banner and booking is disabled');

  // ── confirm the email address ──
  const confirmation = await waitForMail(buyerEmail, 'Confirm your email address');
  const link = /(https?:\/\/\S+\/verify-email#token=[\w-]+)/.exec(confirmation.Text)?.[1];
  if (!link) throw new Error(`no confirmation link in:\n${confirmation.Text}`);
  await buyer.goto(link);
  await buyer.locator('#done-view h1', { hasText: 'Email confirmed' }).waitFor();
  step('confirmation email arrived; its link confirmed the address');

  await openMap(buyer);
  await buyer.locator('#avatar', { hasText: 'EB' }).waitFor();
  if (await buyer.locator('#verify-banner').isVisible())
    throw new Error('banner still shown after confirming');
  step(`both pages loaded the seat map (${await buyer.locator('rect.seat').count()} seats) and went live`);

  const picks = buyer.locator('rect.seat.available');
  const ids = [
    await picks.nth(0).getAttribute('data-id'),
    await picks.nth(1).getAttribute('data-id'),
  ] as string[];
  await buyer.locator(`rect[data-id="${ids[0]}"]`).click();
  await buyer.locator(`rect[data-id="${ids[1]}"]`).click();
  await buyer.locator('#hold-button').click();
  await buyer.locator('#countdown', { hasText: 'left to pay' }).waitFor();
  step(`seats ${ids.join(', ')} held; countdown: "${await buyer.locator('#countdown').textContent()}"`);

  // The watcher never reloads: this only passes if the WebSocket update arrived.
  await watcher.waitForFunction(
    (id) => document.querySelector(`rect[data-id="${id}"]`)?.classList.contains('held'),
    ids[0],
    {
      timeout: 5_000,
    },
  );
  step(`watcher saw seat ${ids[0]} turn "${await seatClass(watcher, ids[0]!)}" live`);
  await watcher.screenshot({ path: '.dev/e2e-watcher-held.png' });

  await buyer.locator('#card').selectOption('4242424242424242');
  await buyer.locator('#pay-button').click();
  await buyer.locator('.ticket img').nth(1).waitFor({ timeout: 20_000 });
  step(`payment confirmed; ${await buyer.locator('.ticket img').count()} QR tickets shown`);
  await buyer.locator('#message', { hasText: buyerEmail }).waitFor();

  // ── the tickets, by email, to the address the buyer signed up with ──
  const ticketsMail = await waitForMail(buyerEmail, 'Your tickets:');
  const qrCodes = ticketsMail.Inline.filter((part) => part.ContentType === 'image/png');
  if (qrCodes.length !== 2) throw new Error(`expected 2 QR codes in the email, got ${qrCodes.length}`);
  if (!qrCodes.every((qr) => ticketsMail.HTML.includes(`cid:${qr.ContentID}`)))
    throw new Error('QR images are not embedded in the email body');
  step(`"${ticketsMail.Subject}" arrived at ${buyerEmail} with ${qrCodes.length} QR codes embedded`);
  await buyer.screenshot({ path: '.dev/e2e-buyer-tickets.png', fullPage: true });

  await watcher.waitForFunction(
    (id) => document.querySelector(`rect[data-id="${id}"]`)?.classList.contains('booked'),
    ids[0],
    {
      timeout: 5_000,
    },
  );
  step(`watcher saw seat ${ids[0]} become "booked" live`);
  await watcher.screenshot({ path: '.dev/e2e-watcher-sold.png' });

  if (consoleErrors.length) throw new Error(`browser console errors:\n${consoleErrors.join('\n')}`);
  step('no browser console errors');
  console.log(
    '\nE2E passed. Screenshots: .dev/e2e-watcher-held.png, .dev/e2e-buyer-tickets.png, .dev/e2e-watcher-sold.png',
  );
} catch (err) {
  console.error('E2E FAILED:', err);
  process.exitCode = 1;
} finally {
  await browser.close();
  await Promise.all([db.destroy(), redis.quit()]);
}
