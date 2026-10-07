import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { isEnabled } from '../src/platform/flags.js';
import { getEffectiveConfig } from '../src/modules/admin/service.js';

let t: TestApp;
let admin: TestUser, admin2: TestUser, support: TestUser, user: TestUser;

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  admin2 = await createUser(t, { roles: ['ADMIN'] });
  support = await createUser(t, { roles: ['SUPPORT'] });
  user = await createUser(t);
});
afterAll(async () => t.close());

describe('OPS-02 overview', () => {
  it('reports GMV net of refunds, backlogs and outbox health', async () => {
    const { rows } = await t.pool.query(
      `INSERT INTO payments(provider, provider_order_id, payer_id, subject_type, subject_id, status, amount_minor, refunded_minor, currency, approved_at, expires_at)
       VALUES ('MOCK','o1',$1,'RESERVATION',gen_random_uuid(),'PARTIALLY_REFUNDED',100000,30000,'KRW',now(),now()),
              ('MOCK','o2',$1,'ORDER',gen_random_uuid(),'APPROVED',50000,0,'KRW',now(),now()),
              ('MOCK','o3',$1,'ORDER',gen_random_uuid(),'FAILED',70000,0,'KRW',NULL,now()) RETURNING id`,
      [user.id],
    );
    expect(rows).toHaveLength(3);
    await t.pool.query(`INSERT INTO outbox_events(aggregate_type, aggregate_id, event_type, payload, correlation_id, dead_lettered_at, attempts, last_error) VALUES ('x','1','test.dead','{}','c',now(),8,'boom')`);
    const r = await call(t, support, 'GET', '/v1/admin/overview');
    expect(r.status).toBe(200);
    expect(r.body.gmv).toEqual([{ currency: 'KRW', gmvMinor: 120000, grossMinor: 150000, refundedMinor: 30000 }]);
    expect(r.body.outbox.deadLetters).toBe(1);
    expect(r.body).toHaveProperty('verificationBacklog.pending');
    expect(r.body).toHaveProperty('complianceBacklog.permitsPending');
  });

  it('requires a staff role with AAL2', async () => {
    expect((await call(t, user, 'GET', '/v1/admin/overview')).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['ADMIN'], aal: 'aal1' });
    expect((await call(t, aal1, 'GET', '/v1/admin/overview')).body.code).toBe('AAL2_REQUIRED');
  });
});

describe('PLAT-06 feature flags', () => {
  it('requires ADMIN with AAL2', async () => {
    const aal1 = await createUser(t, { roles: ['ADMIN'], aal: 'aal1' });
    const body = { flagKey: 'ai.assistant', enabled: true, reason: 'pilot launch' };
    expect((await call(t, aal1, 'PATCH', '/v1/admin/feature-flags', body)).body.code).toBe('AAL2_REQUIRED');
    expect((await call(t, support, 'PATCH', '/v1/admin/feature-flags', body)).status).toBe(403);
    expect((await call(t, user, 'GET', '/v1/admin/feature-flags')).status).toBe(403);
    expect(await isEnabled(t.pool, 'ai.assistant')).toBe(false);
  });

  it('updates a flag with audit + config.changed; unknown flags 404 unless create', async () => {
    const r = await call(t, admin, 'PATCH', '/v1/admin/feature-flags', { flagKey: 'ai.assistant', enabled: true, reason: 'pilot launch' });
    expect(r.status).toBe(200);
    expect(r.body.item.enabled).toBe(true);
    expect(await isEnabled(t.pool, 'ai.assistant')).toBe(true);
    const a = await t.pool.query(`SELECT * FROM audit_logs WHERE action = 'feature_flag.updated' AND resource_id = 'ai.assistant'`);
    expect(a.rows[0].reason).toBe('pilot launch');
    expect(a.rows[0].before_state.enabled).toBe(false);
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'config.changed'`);
    expect(ev.rows[0].payload).toMatchObject({ key: 'ai.assistant', enabled: true, previous: false });
    expect((await call(t, admin, 'PATCH', '/v1/admin/feature-flags', { flagKey: 'nope.flag', enabled: true, reason: 'test test' })).status).toBe(404);
    // allowlist rules
    await call(t, admin, 'PATCH', '/v1/admin/feature-flags', { flagKey: 'guide.paid', rules: { allow_user_ids: [user.id] }, reason: 'beta tester' });
    expect(await isEnabled(t.pool, 'guide.paid', { userId: user.id })).toBe(true);
    expect(await isEnabled(t.pool, 'guide.paid')).toBe(false);
  });

  it('public config exposes evaluated flags but never allowlist rules', async () => {
    const anon = await call(t, null, 'GET', '/v1/config/public');
    expect(anon.body.flags['ai.assistant']).toBe(true);
    expect(anon.body.flags['guide.paid']).toBe(false);
    expect(JSON.stringify(anon.body)).not.toContain(user.id);
    const me = await call(t, user, 'GET', '/v1/config/public');
    expect(me.body.flags['guide.paid']).toBe(true);
  });
});

describe('PLAT-06 effective-dated config with four-eyes approval', () => {
  it('proposed values are not effective until approved by a different admin', async () => {
    const from = new Date(Date.now() - 60_000).toISOString();
    const p = await call(t, admin, 'POST', '/v1/admin/config', { key: 'fees.stay.guest_bps', value: 1200, effectiveFrom: from, note: 'legal approved 2026-10' });
    expect(p.status).toBe(201);
    expect(await getEffectiveConfig(t.pool, 'fees.stay.guest_bps')).toBeNull();
    const self = await call(t, admin, 'POST', '/v1/admin/config/approve', { key: 'fees.stay.guest_bps', effectiveFrom: from, reason: 'self approve' });
    expect(self.body.code).toBe('FOUR_EYES_REQUIRED');
    const ok = await call(t, admin2, 'POST', '/v1/admin/config/approve', { key: 'fees.stay.guest_bps', effectiveFrom: from, reason: 'reviewed by finance' });
    expect(ok.status).toBe(200);
    expect(await getEffectiveConfig(t.pool, 'fees.stay.guest_bps')).toBe(1200);
    // a future version does not apply yet
    const future = new Date(Date.now() + 86400_000).toISOString();
    await call(t, admin, 'POST', '/v1/admin/config', { key: 'fees.stay.guest_bps', value: 1500, effectiveFrom: future });
    await call(t, admin2, 'POST', '/v1/admin/config/approve', { key: 'fees.stay.guest_bps', effectiveFrom: future, reason: 'future change' });
    expect(await getEffectiveConfig(t.pool, 'fees.stay.guest_bps')).toBe(1200);
    expect(await getEffectiveConfig(t.pool, 'fees.stay.guest_bps', new Date(Date.now() + 2 * 86400_000))).toBe(1500);
    const list = await call(t, admin, 'GET', '/v1/admin/config?key=fees.stay.guest_bps');
    expect(list.body.items.filter((i: any) => i.effective)).toHaveLength(1);
    expect((await call(t, admin, 'POST', '/v1/admin/config', { key: 'payments.toss.secret_key', value: 'x' })).body.code).toBe('SECRET_IN_CONFIG');
  });

  it('public.* config appears in /v1/config/public once approved', async () => {
    const from = new Date(Date.now() - 1000).toISOString();
    await call(t, admin, 'POST', '/v1/admin/config', { key: 'public.support.hours', value: '09:00-18:00 KST', effectiveFrom: from });
    expect((await call(t, null, 'GET', '/v1/config/public')).body.config['support.hours']).toBeUndefined();
    await call(t, admin2, 'POST', '/v1/admin/config/approve', { key: 'public.support.hours', effectiveFrom: from, reason: 'ops approved' });
    expect((await call(t, null, 'GET', '/v1/config/public')).body.config['support.hours']).toBe('09:00-18:00 KST');
  });
});

describe('OPS-02 dead letters', () => {
  it('lists and re-queues dead-lettered events (audited)', async () => {
    const list = await call(t, admin, 'GET', '/v1/admin/outbox/dead-letters');
    expect(list.body.items.length).toBeGreaterThan(0);
    const id = list.body.items[0].id;
    expect((await call(t, support, 'POST', `/v1/admin/outbox/dead-letters/${id}/retry`, { reason: 'handler fixed' })).status).toBe(403);
    const r = await call(t, admin, 'POST', `/v1/admin/outbox/dead-letters/${id}/retry`, { reason: 'handler fixed' });
    expect(r.status).toBe(200);
    const ev = await t.pool.query(`SELECT dead_lettered_at, attempts FROM outbox_events WHERE id = $1`, [id]);
    expect(ev.rows[0].dead_lettered_at).toBeNull();
    expect((await call(t, admin, 'POST', `/v1/admin/outbox/dead-letters/${id}/retry`, { reason: 'handler fixed' })).body.code).toBe('NOT_DEAD_LETTERED');
    const a = await t.pool.query(`SELECT 1 FROM audit_logs WHERE action = 'outbox.dead_letter.retried' AND resource_id = $1`, [id]);
    expect(a.rows).toHaveLength(1);
  });
});
