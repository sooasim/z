import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { stripPii } from '../src/modules/analytics/service.js';

let t: TestApp;
let admin: TestUser, accounting: TestUser, user: TestUser;

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  accounting = await createUser(t, { roles: ['ACCOUNTING'] });
  user = await createUser(t);
});
afterAll(async () => t.close());

describe('OPS-04 analytics ingestion', () => {
  it('strips PII keys and redacts PII-looking values', () => {
    const r = stripPii({ email: 'a@b.com', query: '서울 문의 010-1234-5678', nested: { phone: 'x', note: 'contact me at me@x.io' }, tags: ['ok', 'b@c.kr'], guests: 2 });
    expect(r.clean).toEqual({ query: '[REDACTED]', nested: { note: '[REDACTED]' }, tags: ['ok', '[REDACTED]'], guests: 2 });
    expect(r.stripped.sort()).toEqual(['email', 'nested.note', 'nested.phone', 'query', 'tags[1]'].sort());
  });

  it('accepts batched events (anonymous or authenticated) and persists only stripped properties', async () => {
    const r = await call(t, user, 'POST', '/v1/analytics/events', {
      anonymousId: 'anon-12345678',
      events: [
        { name: 'search.performed', properties: { city: '서울', guests: 2, email: 'leak@example.com' } },
        { name: 'property.viewed', properties: { propertyId: '00000000-0000-0000-0000-000000000001', note: '+82 10 9876 5432' } },
      ],
    });
    expect(r.status).toBe(202);
    expect(r.body.accepted).toBe(2);
    expect(r.body.strippedFields).toEqual(['events[0].properties.email', 'events[1].properties.note']);
    const rows = await t.pool.query(`SELECT event_name, user_id, properties FROM analytics_events ORDER BY id`);
    expect(JSON.stringify(rows.rows)).not.toContain('leak@example.com');
    expect(JSON.stringify(rows.rows)).not.toContain('9876');
    expect(rows.rows[0].user_id).toBe(user.id);
    expect((await call(t, null, 'POST', '/v1/analytics/events', { events: [{ name: 'search.performed', properties: {} }] })).status).toBe(202);
  });

  it('rejects malformed batches (schema validation)', async () => {
    expect((await call(t, null, 'POST', '/v1/analytics/events', { events: [] })).status).toBe(400);
    expect((await call(t, null, 'POST', '/v1/analytics/events', { events: [{ name: 'Bad Name!' }] })).status).toBe(400);
    expect((await call(t, null, 'POST', '/v1/analytics/events', { events: Array.from({ length: 51 }, () => ({ name: 'x.y' })) })).status).toBe(400);
  });
});

describe('OPS-04 dashboards', () => {
  it('funnel and KPIs reconcile with source tables; staff AAL2 only', async () => {
    expect((await call(t, user, 'GET', '/v1/admin/analytics/funnel')).status).toBe(403);
    await t.pool.query(
      `INSERT INTO payments(provider, provider_order_id, payer_id, subject_type, subject_id, status, amount_minor, refunded_minor, currency, approved_at, expires_at)
       VALUES ('MOCK','k1',$1,'RESERVATION',gen_random_uuid(),'APPROVED',200000,0,'KRW',now(),now())`,
      [user.id],
    );
    const f = await call(t, accounting, 'GET', '/v1/admin/analytics/funnel');
    expect(f.status).toBe(200);
    expect(f.body.steps[0]).toMatchObject({ step: 'search', count: 2 });
    expect(f.body.steps[3]).toMatchObject({ step: 'paid', count: 1 });
    const k = await call(t, admin, 'GET', '/v1/admin/analytics/kpis');
    expect(k.body.gmv).toEqual([{ currency: 'KRW', gmvMinor: 200000, grossMinor: 200000, refundedMinor: 0, payments: 1 }]);
    expect(k.body.takeRate[0]).toMatchObject({ currency: 'KRW', feeRevenueMinor: 0, takeRateBps: 0 });
    expect(k.body).toHaveProperty('exchangeCompletion');
    expect(k.body).toHaveProperty('guideBookings.total');
  });
});

describe('OPS-04 audit logs', () => {
  it('filters audit logs, requires ADMIN/ACCOUNTING AAL2, and audits the read itself', async () => {
    await t.pool.query(`INSERT INTO audit_logs(actor_id, action, resource_type, resource_id, category) VALUES ($1,'refund.approved','refund','r1','MONEY'),($1,'role.granted','user','u1','PERMISSION')`, [admin.id]);
    expect((await call(t, user, 'GET', '/v1/admin/audit-logs')).status).toBe(403);
    const support = await createUser(t, { roles: ['SUPPORT'] });
    expect((await call(t, support, 'GET', '/v1/admin/audit-logs')).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['ACCOUNTING'], aal: 'aal1' });
    expect((await call(t, aal1, 'GET', '/v1/admin/audit-logs')).body.code).toBe('AAL2_REQUIRED');
    const r = await call(t, accounting, 'GET', '/v1/admin/audit-logs?category=MONEY');
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: any) => i.action)).toEqual(['refund.approved']);
    const meta = await t.pool.query(`SELECT * FROM audit_logs WHERE action = 'audit_logs.read'`);
    expect(meta.rows).toHaveLength(1);
    expect(meta.rows[0].actor_id).toBe(accounting.id);
    expect(meta.rows[0].category).toBe('SECURITY');
    expect(meta.rows[0].after_state.filters.category).toBe('MONEY');
    const page = await call(t, admin, 'GET', `/v1/admin/audit-logs?actorId=${admin.id}&limit=1`);
    expect(page.body.items).toHaveLength(1);
    expect(page.body.nextCursor).toBeTruthy();
    const page2 = await call(t, admin, 'GET', `/v1/admin/audit-logs?actorId=${admin.id}&limit=1&cursor=${page.body.nextCursor}`);
    expect(page2.body.items[0].id).not.toBe(page.body.items[0].id);
  });
});
