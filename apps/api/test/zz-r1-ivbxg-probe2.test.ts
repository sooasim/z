import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, call, type TestApp } from './helpers.js';
let t: TestApp;
beforeAll(async () => { t = await createTestApp({ RATE_LIMIT_PER_MIN: 3 }); });
afterAll(async () => t?.close());
describe('probe2', () => {
  it('xff rotation bypasses app rate limit', async () => {
    const plain: number[] = [];
    for (let i = 0; i < 5; i++) plain.push((await call(t, null, 'GET', '/v1/amenities')).status);
    const rotated: number[] = [];
    for (let i = 0; i < 5; i++) rotated.push((await call(t, null, 'GET', '/v1/amenities', undefined, { 'x-forwarded-for': `9.9.9.${i}, 10.0.0.1` })).status);
    console.log('plain', plain.join(','), 'rotated', rotated.join(','));
  });
});
