// G6 — No-oversell under concurrency (STAY-08 acceptance). Every VU quotes the SAME dates on the SAME
// property, then all VUs race to place a hold at once. Exactly one hold may succeed per round; all others
// must get 409 (INVENTORY_UNAVAILABLE). Requires FIXTURE. Also: hold p95 < 500 ms.
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import exec from 'k6/execution';
import { BASE, summary, loadFixture, isoDay, uuid } from './common.js';

const fx = loadFixture();
const VUS = Number(__ENV.HOLD_VUS || (fx ? Math.min(fx.tokens.length, 50) : 50));
const ROUNDS = Number(__ENV.HOLD_ROUNDS || 5);
const holdsCreated = new Counter('holds_created');
const holdsRejected = new Counter('holds_conflict');
const holdsUnexpected = new Counter('holds_unexpected_status');

export const options = {
  scenarios: { race: { executor: 'per-vu-iterations', vus: VUS, iterations: ROUNDS, maxDuration: '5m' } },
  thresholds: {
    // ROUNDS distinct date ranges -> at most ROUNDS successful holds in total
    holds_created: [`count<=${ROUNDS}`],
    holds_unexpected_status: ['count==0'],
    'http_req_duration{name:hold}': ['p(95)<500'],
  },
};

export default function () {
  if (!fx) throw new Error('FIXTURE env is required');
  const round = exec.vu.iterationInScenario;
  const token = fx.tokens[(exec.vu.idInTest - 1) % fx.tokens.length];
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const start = 400 + round * 3; // a fresh, non-overlapping range per round
  const q = http.post(`${BASE}/v1/booking/quotes`,
    JSON.stringify({ propertyId: fx.propertyId, checkIn: isoDay(start), checkOut: isoDay(start + 2), guests: 2 }),
    { headers, tags: { name: 'quote' } });
  if (!check(q, { 'quote 201': (r) => r.status === 201 })) return;
  const quoteId = q.json('item.id');
  const h = http.post(`${BASE}/v1/booking/holds`, JSON.stringify({ quoteId }),
    { headers: { ...headers, 'idempotency-key': uuid() }, tags: { name: 'hold' } });
  if (h.status === 201) holdsCreated.add(1);
  else if (h.status === 409) holdsRejected.add(1);
  else holdsUnexpected.add(1);
}

export function handleSummary(data) { return summary('hold-concurrency', data); }
