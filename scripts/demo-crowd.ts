/*
 * A crowd for demos: opens live seat-map connections to a few on-sale events, so "N viewing
 * now" on event pages and the catalog's "Trending now" row have something to show on a laptop.
 *
 *   npm run demo:crowd                               # 300 viewers over the 5 soonest events
 *   npm run demo:crowd -- --viewers 1000 --events 8
 *   npm run demo:crowd -- --event <id> --event <id>  # these events only
 *   npm run demo:crowd -- --url http://localhost:8080
 *
 * Each viewer is one WebSocket, exactly what a browser with the event page open holds. They
 * are spread Zipf-style (the first event gets the most), so trending has a clear order. They
 * open at ~25 a second, because the API's per-IP rate limit covers WebSocket upgrades too,
 * and reconnect if the server sends them away (a deploy, a restart).
 *
 * Ctrl-C closes them all: the counts drop at the next report, within ~5 s.
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    viewers: { type: 'string', default: '300' },
    events: { type: 'string', default: '5' },
    event: { type: 'string', multiple: true },
    url: { type: 'string', default: process.env.APP_URL ?? 'http://localhost:3000' },
  },
});

const base = values.url.replace(/\/$/, '');
const total = Number(values.viewers);
if (!Number.isInteger(total) || total < 1) throw new Error('--viewers must be a positive whole number');

interface EventSummary {
  id: string;
  title: string;
}

async function pickEvents(): Promise<EventSummary[]> {
  if (values.event?.length) {
    return Promise.all(
      values.event.map(async (id) => {
        const res = await fetch(`${base}/api/v1/events/${id}`);
        if (!res.ok) throw new Error(`event ${id}: HTTP ${res.status}`);
        return (await res.json()) as EventSummary;
      }),
    );
  }
  const res = await fetch(`${base}/api/v1/events?onSale=true&limit=${Number(values.events)}`);
  if (!res.ok) throw new Error(`listing events: HTTP ${res.status} (is the API running at ${base}?)`);
  const { data } = (await res.json()) as { data: EventSummary[] };
  if (!data.length) throw new Error('No events on sale: run npm run seed (or npm run stock) first');
  return data;
}

const events = await pickEvents();

// Zipf: event i gets a share proportional to 1 / (i + 1).
const weights = events.map((_, i) => 1 / (i + 1));
const weightSum = weights.reduce((a, b) => a + b, 0);
const plan = events.map((e, i) => ({ ...e, viewers: Math.round((total * weights[i]!) / weightSum) }));

const wsBase = base.replace(/^http/, 'ws');
const sockets = new Set<WebSocket>();
let open = 0;
let stopping = false;

/** Client-side token bucket matching the API's per-IP limit: bursts of 100, then 25 a second. */
let tokens = 100;
setInterval(() => (tokens = Math.min(100, tokens + 2.5)), 100).unref();
async function takeToken() {
  while (tokens < 1) await new Promise((resolve) => setTimeout(resolve, 40));
  tokens--;
}

function connect(eventId: string) {
  const ws = new WebSocket(`${wsBase}/api/v1/events/${eventId}/live`);
  let opened = false;
  sockets.add(ws);
  ws.addEventListener('open', () => {
    opened = true;
    open++;
  });
  ws.addEventListener('close', (e) => {
    sockets.delete(ws);
    if (opened) open--;
    if (stopping) return;
    if (e.code === 4404) {
      console.error(`\nevent ${eventId} isn't public; dropping this viewer`);
      return;
    }
    // Sent away (1001 deploy, 1013 busy) or rate-limited: come back after a jittered pause.
    setTimeout(() => void takeToken().then(() => connect(eventId)), 1_000 + Math.random() * 4_000);
  });
}

console.log(`Opening ${total} viewers on ${base}:`);
for (const e of plan) console.log(`  ${String(e.viewers).padStart(5)}  ${e.title}  (${e.id})`);

const progress = setInterval(() => {
  process.stdout.write(`\r${open} of ${total} viewers connected (Ctrl-C to stop)`);
}, 500);

process.once('SIGINT', () => {
  stopping = true;
  clearInterval(progress);
  console.log(`\nClosing ${sockets.size} connections…`);
  for (const ws of sockets) ws.close(1000, 'demo over');
  setTimeout(() => process.exit(0), 500);
});

for (const e of plan) {
  for (let i = 0; i < e.viewers && !stopping; i++) {
    await takeToken();
    connect(e.id);
  }
}
