// Mixed Stillnote workload at a fixed request rate.
//   k6 run -e BASE_URL=http://localhost:8080 -e RATE=100 -e DURATION=2m loadtest/k6.js
// Mix (as in a real editing session): 70% saves (PUT), 20% open a note (GET), 10% list (GET).
// Requires the data from seed.sql. Prefer loadtest/run.mjs, which sweeps several rates.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

// Failed requests by HTTP status (0 = connection error or timeout). The thresholds below exist
// only so each status appears in the exported summary; they never fail a run.
const failures = new Counter('failed_by_status');
const STATUSES = [0, 401, 409, 429, 500, 502, 503, 504];

const BASE = __ENV.BASE_URL || 'http://localhost:8080';
const USERS = Number(__ENV.USERS || 500);
const NOTES = Number(__ENV.NOTES_PER_USER || 20);
const RATE = Number(__ENV.RATE || 100);
const DURATION = __ENV.DURATION || '2m';

export const options = {
  scenarios: {
    mixed: {
      // Open model: requests arrive at RATE per second regardless of how slow the server is,
      // so latency problems show up as latency (and dropped iterations), not as a lower rate.
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(50, Math.ceil(RATE / 4)),
      maxVUs: Math.max(200, RATE * 2),
    },
  },
  thresholds: {
    ...Object.fromEntries(STATUSES.map((status) => [`failed_by_status{status:${status}}`, ['count>=0']])),
    http_req_failed: ['rate<0.001'],
    http_req_duration: ['p(95)<150', 'p(99)<400'],
    'http_req_duration{op:save}': ['p(95)<200'],
    'http_req_duration{op:open}': ['p(95)<100'],
    'http_req_duration{op:list}': ['p(95)<150'],
    dropped_iterations: ['count==0'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  // Keep the console quiet; run.mjs reads the exported summary instead.
  discardResponseBodies: false,
};

const token = (user) => `loadtest-token-${String(user).padStart(6, '0')}-0123456789abcdef`;
const pick = (n) => Math.floor(Math.random() * n);
// ~3 KB, like a real note; varied per request so the database really rewrites the row.
const filler = 'The quick brown fox jumps over the lazy dog. '.repeat(65);

function expectOk(res, op) {
  const ok = check(res, { [`${op} 200`]: (r) => r.status === 200 });
  if (!ok) failures.add(1, { status: String(res.status) });
}

export default function () {
  const user = pick(USERS);
  const id = `ln-${user}-${pick(NOTES)}`;
  const headers = { Cookie: `sid=${token(user)}`, 'Content-Type': 'application/json' };
  const roll = Math.random();

  if (roll < 0.7) {
    const res = http.put(
      `${BASE}/api/documents/${id}`,
      JSON.stringify({ content: `${filler}${Math.random()}`, updatedAt: new Date().toISOString() }),
      { headers, tags: { op: 'save', name: 'PUT /api/documents/:id' } },
    );
    expectOk(res, 'save');
  } else if (roll < 0.9) {
    const res = http.get(`${BASE}/api/documents/${id}`, { headers, tags: { op: 'open', name: 'GET /api/documents/:id' } });
    expectOk(res, 'open');
  } else {
    const res = http.get(`${BASE}/api/documents?limit=50`, { headers, tags: { op: 'list', name: 'GET /api/documents' } });
    expectOk(res, 'list');
  }
}
