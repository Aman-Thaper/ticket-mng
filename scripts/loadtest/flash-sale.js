// k6 flash sale: thousands of buyers arrive per minute, look at the seat map, and try to
// hold one or two seats. Most seats sell out within seconds; after that, buyers get 409s.
//
//   npm run loadtest:setup && k6 run scripts/loadtest/flash-sale.js
//   RATE=800 k6 run scripts/loadtest/flash-sale.js       # more pressure
//
// Success means: no 5xx at all, latency within thresholds, and afterwards
// `npm run check:invariants` confirms no seat was sold twice.
import http from 'k6/http';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter } from 'k6/metrics';

const data = JSON.parse(open(__ENV.LOADTEST_FILE || '../../.dev/loadtest.json'));
const BASE = __ENV.BASE_URL || data.baseUrl;
const RATE = Number(__ENV.RATE || 400);
// Shrink or stretch the whole run (CI uses 0.5 for a ~30 s smoke test).
const SCALE = Number(__ENV.DURATION_SCALE || 1);
const secs = (s) => `${Math.max(1, Math.round(s * SCALE))}s`;
const tokens = new SharedArray('tokens', () => data.tokens);
const seatIds = new SharedArray('seats', () => data.seatIds);

export const options = {
  scenarios: {
    onsale: {
      // Arrival rate, not a fixed number of VUs: new buyers keep arriving whether or not the
      // server keeps up, which is what real on-sale traffic does.
      executor: 'ramping-arrival-rate',
      startRate: 20,
      timeUnit: '1s',
      preAllocatedVUs: 200,
      maxVUs: 2000,
      stages: [
        { duration: secs(10), target: RATE },
        { duration: secs(40), target: RATE },
        { duration: secs(10), target: 0 },
      ],
    },
  },
  thresholds: {
    server_errors: ['count==0'],
    // Latency limits are for measuring on a known machine. Shared CI runners (2 vCPUs running
    // k6 and the whole stack) set looser ones: there, correctness is the gate, not speed.
    'http_req_duration{name:hold}': [`p(95)<${__ENV.HOLD_P95_MS || 750}`],
    'http_req_duration{name:seatmap}': [`p(95)<${__ENV.SEATMAP_P95_MS || 500}`],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

const seatsHeld = new Counter('seats_held');
const holdConflicts = new Counter('hold_conflicts');
const throttled = new Counter('throttled');
const serverErrors = new Counter('server_errors');

// 409 (seat taken / already holding) and 429 (throttled) are correct answers under load.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 299 }, 304, 409, 429));

export default function () {
  const i = exec.scenario.iterationInTest;
  const token = tokens[i % tokens.length];

  // Read the seat map like a real client (no need to parse it here).
  const map = http.get(`${BASE}/api/v1/events/${data.eventId}/seats`, {
    tags: { name: 'seatmap' },
    responseType: 'none',
  });
  if (map.status >= 500) serverErrors.add(1);

  const wanted = [];
  const count = 1 + (i % 2);
  while (wanted.length < count) {
    const id = seatIds[Math.floor(Math.random() * seatIds.length)];
    if (!wanted.includes(id)) wanted.push(id);
  }

  const res = http.post(
    `${BASE}/api/v1/events/${data.eventId}/bookings`,
    JSON.stringify({ seatIds: wanted }),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `k6-${exec.vu.idInTest}-${i}`,
      },
      tags: { name: 'hold' },
    },
  );
  if (res.status === 201) seatsHeld.add(wanted.length);
  else if (res.status === 409) holdConflicts.add(1);
  else if (res.status === 429) throttled.add(1);
  else if (res.status >= 500) serverErrors.add(1);
}
