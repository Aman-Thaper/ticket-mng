// Steady traffic through Nginx while deploy/rollout.sh replaces the API replicas. Every
// request must get its normal answer: a single 502, timeout or reset fails the run.
//
//   k6 run scripts/loadtest/rollout-probe.js &   # then, while it runs:
//   deploy/rollout.sh
//
// Two kinds of traffic: reads (GET, which Nginx may retry on another replica) and writes
// (POST, which it only retries if the request never reached a replica).
import http from 'k6/http';

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const DURATION = __ENV.DURATION || '45s';

// Expected answers: 200 for the event list, 401 for a hold attempt without a login.
http.setResponseCallback(http.expectedStatuses(200, 401));

export const options = {
  scenarios: {
    reads: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.READ_RATE || 60),
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 60,
      exec: 'reads',
    },
    writes: {
      executor: 'constant-arrival-rate',
      rate: Number(__ENV.WRITE_RATE || 5),
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: 20,
      exec: 'writes',
    },
  },
  thresholds: { http_req_failed: ['rate==0'] },
};

function report(res, expected) {
  if (res.status !== expected) console.warn(`unexpected ${res.status} ${res.error || ''}`.trim());
}

export function reads() {
  report(http.get(`${BASE}/api/v1/events?limit=5`), 200);
}

export function writes() {
  const res = http.post(
    `${BASE}/api/v1/events/00000000-0000-0000-0000-000000000000/bookings`,
    JSON.stringify({ seatIds: [1] }),
    { headers: { 'content-type': 'application/json' } },
  );
  report(res, 401);
}
