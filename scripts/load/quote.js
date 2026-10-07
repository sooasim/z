// G6 — Quote write path. SLO: p95 < 500 ms. Requires FIXTURE (scripts/load/fixtures.mjs output).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE, profile, summary, loadFixture, isoDay } from './common.js';

const fx = loadFixture();
export const options = profile(Number(__ENV.QUOTE_P95_MS || 500));

export default function () {
  if (!fx) throw new Error('FIXTURE env (path to fixture json) is required');
  const token = fx.tokens[(__VU - 1) % fx.tokens.length];
  const start = 30 + Math.floor(Math.random() * 300);
  const res = http.post(`${BASE}/v1/booking/quotes`,
    JSON.stringify({ propertyId: fx.propertyId, checkIn: isoDay(start), checkOut: isoDay(start + 2), guests: 2 }),
    { headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, tags: { name: 'quote' } });
  check(res, { 'quote 201': (r) => r.status === 201 });
  sleep(0.2);
}

export function handleSummary(data) { return summary('quote', data); }
