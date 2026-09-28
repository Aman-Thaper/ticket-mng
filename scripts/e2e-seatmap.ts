/**
 * End-to-end check of the live seat map in a real (headless) browser.
 *
 *   npm run e2e                      # against http://localhost:8080 (scripts/cluster.sh start)
 *   npm run e2e -- --base-url http://localhost:3000
 *
 * Two browsers open the same fresh event. The "buyer" logs in, picks two seats, holds them,
 * pays with a test card and gets QR tickets. The "watcher" must see those seats turn held,
 * then sold, live over the WebSocket, without reloading. Screenshots go to .dev/e2e-*.png.
 * Needs the API and the worker running (the worker confirms the payment).
 */
import { parseArgs } from 'node:util';
import { chromium, type Page } from 'playwright';
import { sql } from 'kysely';
import { db } from '../src/db/index.js';
import { redis } from '../src/lib/redis.js';
import { hashPassword } from '../src/modules/auth/passwords.js';
import { generateSeats } from '../src/modules/venues/layout.js';

const { values } = parseArgs({
  options: { 'base-url': { type: 'string', default: 'http://localhost:8080' } },
});
const BASE = values['base-url'];

// ─── a fresh, small event ────────────────────────────────────────────────────────────────
const tag = `e2e-${Date.now()}`;
const organizer = await db
  .insertInto('users')
  .values({ email: `${tag}@example.com`, name: 'E2E Organizer', role: 'organizer' })
  .returning('id')
  .executeTakeFirstOrThrow();
// Our own buyer with a known password, so the test works on an empty database too.
const buyerEmail = `${tag}-buyer@example.com`;
const buyerPassword = 'e2e password 123';
await db
  .insertInto('users')
  .values({
    email: buyerEmail,
    name: 'E2E Buyer',
    role: 'attendee',
    passwordHash: await hashPassword(buyerPassword),
  })
  .execute();
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
const open = async (name: string) => {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${name}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${name}: ${e.message}`));
  await page.goto(`${BASE}/?event=${event.id}`);
  await page.locator('#live-status', { hasText: 'live' }).waitFor({ timeout: 10_000 });
  await page.locator('rect.seat').first().waitFor();
  return page;
};
const seatClass = (page: Page, id: string) => page.locator(`rect[data-id="${id}"]`).getAttribute('class');
const step = (message: string) => console.log(`✓ ${message}`);

try {
  const watcher = await open('watcher');
  const buyer = await open('buyer');
  step(`both pages loaded the seat map (${await buyer.locator('rect.seat').count()} seats) and went live`);

  await buyer.locator('#login-email').fill(buyerEmail);
  await buyer.locator('#login-password').fill(buyerPassword);
  await buyer.locator('#login-form button[type=submit]').click();
  await buyer.locator('#session-name').filter({ hasText: '@' }).waitFor();
  step(`buyer logged in as ${await buyer.locator('#session-name').textContent()}`);

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
