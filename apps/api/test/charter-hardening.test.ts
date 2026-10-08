/**
 * QA hardening r1 — JET-01 regressions (money group):
 *  - the per-IP lead limit cannot be bypassed by rotating a client-supplied X-Forwarded-For;
 *  - an impossible preferredDate is 400 (not a 500);
 *  - the admin lead pipeline pages rows created in one transaction exactly once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
let admin: TestUser;

const lead = { contactName: 'A', contactEmail: 'a@example.com', origin: 'Seoul', destination: 'Jeju', partySize: 2 };

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
});
afterAll(async () => t.close());

describe('JET-01 lead capture abuse', () => {
  it('rotating the client-chosen left-most X-Forwarded-For entry does not reset the per-IP limit', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      // what a proxy forwards after appending the address it actually saw (5.6.7.8)
      const r = await call(t, null, 'POST', '/v1/charter/requests', lead, { 'x-forwarded-for': `10.9.${i}.1, 5.6.7.8` });
      statuses.push(r.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });

  it('an impossible preferredDate is rejected as invalid input', async () => {
    const r = await call(t, null, 'POST', '/v1/charter/requests', { ...lead, preferredDate: '2099-02-30' }, { 'x-forwarded-for': '203.0.113.9' });
    expect(r.status).toBe(400);
  });
});

describe('JET-01 admin lead pipeline', () => {
  it('pages leads created in one transaction exactly once', async () => {
    const ins = await t.pool.query(
      `INSERT INTO charter_requests(contact_name, contact_email, origin, destination, party_size, status)
       SELECT 'Batch ' || g, 'batch@example.com', 'GMP', 'CJU', 2, 'QUALIFIED' FROM generate_series(1,3) g RETURNING id`,
    );
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r: any = await call(t, admin, 'GET', `/v1/admin/charter/requests?status=QUALIFIED&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.status).toBe(200);
      seen.push(...r.body.items.map((x: any) => x.id));
      cursor = r.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(ins.rows.map((r) => r.id).sort());
  });
});
