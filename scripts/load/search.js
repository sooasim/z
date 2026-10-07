// G6 — Stay search read path. SLO: p95 < 300 ms, error rate < 1% (docs/OPERATIONS.md).
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE, profile, summary } from './common.js';

export const options = profile(Number(__ENV.SEARCH_P95_MS || 300));
const CITIES = ['Seoul', 'Busan', 'Jeju', 'Gangneung', 'Gyeongju'];

export default function () {
  const city = CITIES[Math.floor(Math.random() * CITIES.length)];
  const res = http.get(`${BASE}/v1/search/properties?city=${encodeURIComponent(city)}&guests=2&limit=20`, { tags: { name: 'search' } });
  check(res, { 'search 200': (r) => r.status === 200 });
  sleep(0.2);
}

export function handleSummary(data) { return summary('search', data); }
