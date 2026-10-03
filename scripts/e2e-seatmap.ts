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
 * over the WebSocket, without reloading, along with "2 sold in the last hour" and the
 * viewer count. The catalog must then list the event under "Trending now". My tickets must
 * download a calendar file, and reopen with its QR codes with the network off. Finally the
 * organizer works the door: scans the buyer's QR codes (camera and photos), with a repeat
 * caught on the device, a second door told "already used", and an offline admission that
 * syncs later. Then the organizer's dashboard (numbers, chart, live seat map, attendees, CSV),
 * and a new event created step by step in the browser, published, and found in the catalog.
 * Screenshots go to .dev/e2e-*.png.
 * Needs the API, the worker (it sends email and confirms payments) and Mailpit.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import { sql } from 'kysely';
import sharp from 'sharp';
import { db } from '../src/db/index.js';
import { redis } from '../src/lib/redis.js';
import { hashPassword } from '../src/modules/auth/passwords.js';
import { generateSeats } from '../src/modules/venues/layout.js';

const { values } = parseArgs({
  options: {
    'base-url': { type: 'string', default: 'http://localhost:8080' },
    'mailpit-url': { type: 'string', default: 'http://localhost:8025' },
  },
});
const BASE = values['base-url'];
await mkdir('.dev', { recursive: true }); // screenshots, ticket images and the fake camera's video
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
  Attachments: { ContentType: string; FileName: string }[];
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
// The organizer logs in at the door, so they get a real password.
const organizerEmail = `${tag}@example.com`;
const organizerPassword = 'e2e organizer 123';
const organizer = await db
  .insertInto('users')
  .values({
    email: organizerEmail,
    passwordHash: await hashPassword(organizerPassword),
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

// ─── browsers ────────────────────────────────────────────────────────────────────────────
const browser = await chromium.launch();
/** Launched at the door: a browser whose camera shows a ticket (a video file stands in for it). */
let cameraBrowser: Browser | undefined;
/** The event the organizer creates in the browser, taken off the catalog again at the end. */
let createdEventId: string | undefined;
const consoleErrors: string[] = [];
/** While the test has a browser offline on purpose, its failed requests are expected. */
let offlineOnPurpose = false;
/** allow: console errors this page is expected to log (browsers log every 4xx response). */
const newPage = async (
  name: string,
  { allow = [] as string[], viewport = { width: 1280, height: 900 }, using = browser } = {},
) => {
  const page = await (await using.newContext({ viewport })).newPage();
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (offlineOnPurpose && m.text().includes('net::ERR_INTERNET_DISCONNECTED')) return;
    if (allow.some((text) => m.text().includes(text))) return;
    consoleErrors.push(`${name}: ${m.text()}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${name}: ${e.message}`));
  return page;
};
const openMap = async (page: Page) => {
  await page.goto(`${BASE}/events/${event.id}`);
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
  await buyer.goto(`${BASE}/signup?next=${encodeURIComponent(`/events/${event.id}`)}`);
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

  // Seat 2 of an empty row alone would leave seat 1 stranded: the page says so.
  await buyer.locator(`rect[data-id="${ids[1]}"]`).click();
  await buyer.locator('#message', { hasText: 'on its own' }).waitFor();
  await buyer.locator(`rect[data-id="${ids[1]}"]`).click();
  await buyer.locator('#message', { hasText: /^$/ }).waitFor();
  step('picking seat 2 of a free row warns that seat 1 would be left on its own');

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
  // The QR images as the buyer sees them: the door will scan photos of these.
  const qrImages = await buyer
    .locator('#tickets .ticket img')
    .evaluateAll((imgs) => imgs.map((img) => (img as HTMLImageElement).src));
  const qrFiles = await Promise.all(
    qrImages.map(async (src, i) => {
      const file = `.dev/e2e-ticket-${i + 1}.png`;
      await writeFile(file, Buffer.from(src.split(',')[1]!, 'base64'));
      return file;
    }),
  );
  await buyer.locator('#message', { hasText: buyerEmail }).waitFor();

  // ── the tickets, by email, to the address the buyer signed up with ──
  const ticketsMail = await waitForMail(buyerEmail, 'Your tickets:');
  const qrCodes = ticketsMail.Inline.filter((part) => part.ContentType === 'image/png');
  if (qrCodes.length !== 2) throw new Error(`expected 2 QR codes in the email, got ${qrCodes.length}`);
  if (!qrCodes.every((qr) => ticketsMail.HTML.includes(`cid:${qr.ContentID}`)))
    throw new Error('QR images are not embedded in the email body');
  const calendarFile = ticketsMail.Attachments.find((a) => a.ContentType.startsWith('text/calendar'));
  if (!calendarFile) throw new Error('the ticket email has no calendar (.ics) attachment');
  step(
    `"${ticketsMail.Subject}" arrived at ${buyerEmail} with ${qrCodes.length} QR codes embedded and ${calendarFile.FileName}`,
  );
  await buyer.screenshot({ path: '.dev/e2e-buyer-tickets.png', fullPage: true });

  await watcher.waitForFunction(
    (id) => document.querySelector(`rect[data-id="${id}"]`)?.classList.contains('booked'),
    ids[0],
    {
      timeout: 5_000,
    },
  );
  step(`watcher saw seat ${ids[0]} become "booked" live`);

  // ── live numbers: sales counted from the seat updates, viewers across instances ──
  await watcher
    .locator('#event-live-text', { hasText: '2 sold in the last hour' })
    .waitFor({ timeout: 5_000 });
  // The watcher and the buyer are both on the page. Each instance reports every 5 s, so with
  // them on different instances the total can take two rounds to reach both.
  await watcher.waitForFunction(
    () =>
      Number(
        /([\d,]+) viewing now/
          .exec(document.querySelector('#event-live-text')?.textContent ?? '')?.[1]
          ?.replace(/,/g, ''),
      ) >= 2,
    undefined,
    { timeout: 15_000 },
  );
  step(`watcher's header reads "${await watcher.locator('#event-live-text').textContent()}"`);
  await watcher.screenshot({ path: '.dev/e2e-watcher-sold.png' });

  // ── best available: a block of seats together, in one click ──
  await openMap(buyer);
  await buyer.selectOption('#best-quantity', '2');
  await buyer.locator('#best-button').click();
  await buyer.locator('#message', { hasText: 'seats together' }).waitFor();
  step(`best available: "${await buyer.locator('#message').textContent()}"`);
  await buyer.locator('#cancel-button').click();
  await buyer.locator('#booking').waitFor({ state: 'hidden' });

  // ── My tickets: the booking, with its QR codes ──
  await buyer.goto(`${BASE}/my-tickets`);
  const booking = buyer.locator('.booking', { hasText: 'E2E: Live Seat Map' }).first();
  await booking.locator('button', { hasText: 'Show tickets' }).click();
  await booking.locator('.qr-ticket img').nth(1).waitFor();
  step(`My tickets lists the booking with its ${await booking.locator('.qr-ticket img').count()} QR codes`);
  await buyer.screenshot({ path: '.dev/e2e-my-tickets.png', fullPage: true });

  // ── add to calendar ──
  const [download] = await Promise.all([
    buyer.waitForEvent('download'),
    booking.locator('button', { hasText: 'Add to calendar' }).click(),
  ]);
  const ics = await readFile(await download.path(), 'utf8');
  if (!ics.includes('BEGIN:VEVENT') || !ics.includes('SUMMARY:E2E: Live Seat Map'))
    throw new Error(`unexpected calendar file:\n${ics}`);
  step(`"Add to calendar" downloads ${download.suggestedFilename()}`);

  // ── offline: the page and the tickets were saved on this device ──
  await buyer.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 10_000,
  });
  offlineOnPurpose = true;
  await buyer.context().setOffline(true);
  await buyer.reload();
  await buyer.locator('.offline-banner', { hasText: "You're offline" }).waitFor();
  await buyer.locator('#offline-pill').waitFor(); // not "Log in": the session just can't be checked
  const saved = buyer.locator('.booking', { hasText: 'E2E: Live Seat Map' }).first();
  await saved.locator('button', { hasText: 'Show tickets' }).click();
  await saved.locator('.qr-ticket img').nth(1).waitFor();
  step(
    `offline: My tickets reopens from the device, with ${await saved.locator('.qr-ticket img').count()} QR codes`,
  );
  await buyer.screenshot({ path: '.dev/e2e-offline-tickets.png', fullPage: true });
  await buyer.context().setOffline(false);
  await buyer.locator('.offline-banner').waitFor({ state: 'detached', timeout: 10_000 });
  offlineOnPurpose = false;
  step('back online: the page reloads its live version by itself');

  // ── logging out deletes the saved tickets ──
  await buyer.locator('#menu-button').click();
  await buyer.locator('#logout').click();
  await buyer.waitForURL(`${BASE}/`);
  // Read IndexedDB directly, not through the page's own code.
  const left = await buyer.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('ticket-mng');
        open.onerror = () => resolve('could not open IndexedDB');
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('saved')) return resolve(null);
          const get = db.transaction('saved').objectStore('saved').get('my-tickets');
          get.onsuccess = () => resolve(get.result ?? null);
          get.onerror = () => resolve('could not read IndexedDB');
        };
      }),
  );
  if (left !== null) throw new Error('saved tickets survived logout');
  step('logging out deleted the tickets saved on the device');

  // ── the catalog: trending, category rows, a category grid, and on to an event's seat map ──
  const visitor = await newPage('visitor');
  await visitor.goto(`${BASE}/`);
  await visitor.locator('.event-row .card:not(.skeleton)').first().waitFor();
  // The watcher still has the test event open, so it's trending, with a viewer badge.
  const trendingCard = visitor.locator(`.event-row.trending .card[href="/events/${event.id}"]`);
  await trendingCard.locator('.viewers-tag').waitFor({ timeout: 5_000 });
  step(
    `catalog: "Trending now" lists the event with "${await trendingCard.locator('.viewers-tag').textContent()}"`,
  );
  const rows = (await visitor.locator('.event-row').count()) - 1;
  await visitor.locator('.chip[data-category="theatre"]').click();
  await visitor.locator('.grid .card:not(.skeleton)').first().click();
  await visitor.locator('rect.seat').first().waitFor();
  step(`catalog shows ${rows} category row(s); the Theatre grid opens ${new URL(visitor.url()).pathname}`);

  // ── the door: the organizer scans the buyer's tickets ──
  const openScanner = async (
    name: string,
    { viewport, using }: { viewport?: { width: number; height: number }; using?: Browser } = {},
  ) => {
    // "Already used" is a 409 from POST /check-in: an answer, not a failure.
    const page = await newPage(name, { allow: ['status of 409'], viewport, using });
    await page.goto(`${BASE}/login?next=${encodeURIComponent(`/scan?event=${event.id}`)}`);
    await page.locator('#email').fill(organizerEmail);
    await page.locator('#password').fill(organizerPassword);
    await page.locator('#submit').click();
    await page.locator('#scanner').waitFor();
    return page;
  };
  // The first door uses its camera. Chromium can play a video file as the camera: one frame
  // showing ticket 1's QR code, the way a phone would see it held up at the entrance.
  const frame = await sharp({ create: { width: 640, height: 480, channels: 3, background: '#9aa0a6' } })
    .composite([{ input: await sharp(qrFiles[0]).resize(300, 300).toBuffer(), left: 170, top: 90 }])
    .jpeg({ quality: 90 })
    .toBuffer();
  await writeFile('.dev/e2e-camera.mjpeg', Buffer.concat(Array<Buffer>(30).fill(frame))); // MJPEG: frames back to back
  cameraBrowser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream', // grant the camera without a prompt
      '--use-fake-device-for-media-stream',
      '--use-file-for-fake-video-capture=.dev/e2e-camera.mjpeg',
    ],
  });
  const door = await openScanner('door', { using: cameraBrowser });
  await door.locator('#camera-button').click();
  await door.locator('#result.good', { hasText: 'Welcome, E2E Buyer' }).waitFor({ timeout: 15_000 });
  step(
    `door camera: ticket 1 → "${await door.locator('#result-title').textContent()}, ${await door.locator('#result-detail').textContent()}"`,
  );
  await door.locator('#camera-button').click(); // stop the camera
  await door.locator('#camera-button', { hasText: 'Start camera' }).waitFor();
  await door.locator('#photo').setInputFiles(qrFiles[0]!);
  await door.locator('#result.bad', { hasText: 'Already scanned' }).waitFor();
  step('door: the same ticket again → "Already scanned" (caught on the device)');

  const otherDoor = await openScanner('other door', { viewport: { width: 390, height: 844 } }); // a phone
  await otherDoor.locator('#photo').setInputFiles(qrFiles[0]!);
  await otherDoor.locator('#result.bad', { hasText: 'Already used' }).waitFor();
  step(`another door: ticket 1 → "Already used", ${await otherDoor.locator('#result-detail').textContent()}`);
  await otherDoor.waitForTimeout(400); // let the verdict's animation finish
  await otherDoor.screenshot({ path: '.dev/e2e-door-phone.png', fullPage: true });
  await otherDoor.locator('#code').fill('not-a-ticket');
  await otherDoor.locator('#manual button').click();
  await otherDoor.locator('#result.bad', { hasText: 'Not a Ticket MNG ticket' }).waitFor();
  step('another door: a typed code that isn\'t a ticket → "Not a Ticket MNG ticket"');

  offlineOnPurpose = true;
  await door.context().setOffline(true);
  await door.locator('#photo').setInputFiles(qrFiles[1]!);
  await door.locator('#result.offline', { hasText: 'Admitted (offline)' }).waitFor();
  await door.locator('#sync-status', { hasText: '1 check-in waiting to sync' }).waitFor();
  // The first ticket shows as checked in, from this device's own scan, without a poll.
  await door.locator('#checked-in', { hasText: '1' }).waitFor();
  step('door, offline: ticket 2 → "Admitted (offline)", signature checked on the device; 1 waiting to sync');
  await door.screenshot({ path: '.dev/e2e-door-offline.png', fullPage: true });
  await door.context().setOffline(false);
  await door.locator('#sync-status').waitFor({ state: 'hidden', timeout: 20_000 });
  offlineOnPurpose = false;
  await door.locator('#checked-in', { hasText: '2' }).waitFor({ timeout: 10_000 });
  step(`door, back online: synced; attendance reads "${await door.locator('.attendance p').textContent()}"`);
  await door.waitForTimeout(500); // the progress bar animates
  await door.screenshot({ path: '.dev/e2e-door.png', fullPage: true });

  // ── the organizer's dashboard ──
  const office = await newPage('office');
  await office.goto(`${BASE}/login?next=${encodeURIComponent('/organizer')}`);
  await office.locator('#email').fill(organizerEmail);
  await office.locator('#password').fill(organizerPassword);
  await office.locator('#submit').click();
  const listed = office.locator(`.org-event[href="/organizer/events/${event.id}"]`);
  await listed.waitFor();
  step(
    `organizer: "Your events" lists the show, "${await listed.locator('.numbers span').first().textContent()}"`,
  );
  await listed.click();
  await office.locator('#stat-sold', { hasText: /^2$/ }).waitFor();
  await office.locator('#stat-revenue', { hasText: '$150' }).waitFor();
  await office.locator('#stat-checked', { hasText: /^2$/ }).waitFor();
  await office.locator('#chart .chart-bar').first().waitFor();
  await office.locator('#seat-map rect.seat.booked').nth(1).waitFor();
  await office.locator('#attendee-rows tr').nth(1).waitFor();
  step('dashboard: 2 sold, $150, 2 checked in; a sales bar, sold seats on the live map, 2 attendees');
  const [csv] = await Promise.all([office.waitForEvent('download'), office.locator('#download-csv').click()]);
  const csvRows = (await readFile(await csv.path(), 'utf8')).trim().split('\r\n');
  if (csvRows.length !== 3 || !csvRows[1]!.includes('E2E Buyer'))
    throw new Error(`unexpected CSV:\n${csvRows.join('\n')}`);
  step(`"Download CSV" saves ${csv.suggestedFilename()}: a header and 2 attendees`);
  await office.evaluate(() => window.scrollTo(0, 0)); // the sticky header belongs at the top
  await office.waitForTimeout(500); // the meters animate
  await office.screenshot({ path: '.dev/e2e-dashboard.png', fullPage: true });

  // ── a new event, created step by step ──
  const poster = await sharp({ create: { width: 900, height: 1200, channels: 3, background: '#7c3aed' } })
    .png()
    .toBuffer();
  await writeFile('.dev/e2e-poster.png', poster);
  const createdTitle = `E2E Browserfest ${tag}`;
  await office.goto(`${BASE}/organizer/events/new`);
  await office.locator('#new-venue summary').click();
  await office.locator('#v-name').fill(`${tag} Hall`);
  await office.locator('#v-address').fill('2 Test Ave');
  await office.locator('#v-city').fill('Testville');
  await office.locator('#v-country').fill('US');
  await office.locator('#v-timezone').fill('America/New_York');
  await office.locator('#create-venue').click();
  await office.locator('.venue-option input:checked').waitFor();
  await office.locator('#step-1 button[type="submit"]').click();
  await office.locator('#e-title').fill(createdTitle);
  await office.locator('#step-2 button[type="submit"]').click();
  await office.locator('#create-draft').click();
  await office.locator('#poster-file').setInputFiles('.dev/e2e-poster.png');
  await office.locator('#upload-poster').click();
  await office.locator('#poster-status', { hasText: 'Poster ready' }).waitFor({ timeout: 30_000 });
  await office.locator('#review dd', { hasText: createdTitle }).waitFor();
  step('wizard: a new venue (2 sections), times in its zone, prices, a poster uploaded straight to storage');
  await office.locator('#publish').click();
  await office.waitForURL(/\/organizer\/events\/[0-9a-f-]{36}\?published=1$/);
  createdEventId = /events\/([0-9a-f-]{36})/.exec(office.url())![1];
  await office.locator('#status', { hasText: 'On sale' }).waitFor();
  await office.locator('#seat-map rect.seat.available').first().waitFor();
  step(`published: its dashboard is live (${await office.locator('#stat-sold-sub').textContent()})`);

  await visitor.goto(`${BASE}/?q=Browserfest`);
  await visitor.locator(`.card[href="/events/${createdEventId}"] .card-poster`).waitFor();
  step('catalog: a search finds the new event, with its poster');

  if (consoleErrors.length) throw new Error(`browser console errors:\n${consoleErrors.join('\n')}`);
  step('no browser console errors');
  console.log(
    '\nE2E passed. Screenshots: .dev/e2e-watcher-held.png, .dev/e2e-buyer-tickets.png, .dev/e2e-watcher-sold.png, .dev/e2e-my-tickets.png, .dev/e2e-offline-tickets.png, .dev/e2e-door.png, .dev/e2e-dashboard.png',
  );
} catch (err) {
  console.error('E2E FAILED:', err);
  process.exitCode = 1;
} finally {
  await Promise.all([browser.close(), cameraBrowser?.close()]);
  // Take the test event off the public catalog (its bookings stay, for inspection).
  await db.updateTable('events').set({ status: 'draft' }).where('id', '=', event.id).execute();
  if (createdEventId) {
    await db.updateTable('events').set({ status: 'draft' }).where('id', '=', createdEventId).execute();
  }
  await Promise.all([db.destroy(), redis.quit()]);
}
