import { afterAll, beforeAll, describe, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers.js';
let t: TestApp;
beforeAll(async () => { t = await createTestApp(); });
afterAll(async () => t.close());
describe('probe2', () => {
  it('xff', async () => {
    let same429 = 0, spoof429 = 0;
    for (let i = 0; i < 125; i++) {
      const r = await t.app.inject({ method: 'GET', url: '/v1/geo/geocode?q=seoul' + i, headers: { 'x-forwarded-for': '9.9.9.9' } });
      if (r.statusCode === 429) same429++;
    }
    for (let i = 0; i < 125; i++) {
      const r = await t.app.inject({ method: 'GET', url: '/v1/geo/geocode?q=busan' + i, headers: { 'x-forwarded-for': `10.0.${i}.1, 9.9.9.9` } });
      if (r.statusCode === 429) spoof429++;
    }
    console.log('same-ip 429s', same429, 'spoofed 429s', spoof429);
  });
});
