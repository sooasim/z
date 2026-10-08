import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { isVerified } from '../src/modules/verification/service.js';
import { hostPublishBlockers } from '../src/modules/hosts/service.js';

/** Regression tests for the trust r1 verification / host findings (payout SoD, verification expiry). */
let t: TestApp;
let compliance: TestUser;
const sha = (c: string) => c.repeat(64);

beforeAll(async () => {
  t = await createTestApp();
  compliance = await createUser(t, { roles: ['COMPLIANCE'] });
});
afterAll(async () => t.close());

describe('payout accounts are verified by finance only', () => {
  it('approving a PAYOUT_ACCOUNT verification case does not mark the payout account VERIFIED', async () => {
    const host = await createUser(t, { roles: ['HOST'] });
    const acc = (
      await t.pool.query(`INSERT INTO payout_accounts(user_id, bank_code, account_last4, account_token, holder_name) VALUES ($1,'004','4321','tok_attacker_ctrl_1','Mallory') RETURNING id`, [host.id])
    ).rows[0].id;
    const sub = await call(t, host, 'POST', '/v1/verifications', { subjectType: 'PAYOUT_ACCOUNT', subjectId: acc, documents: [{ documentType: 'BANKBOOK_COPY', sha256: sha('a') }] });
    expect(sub.status).toBe(201);
    expect((await call(t, compliance, 'POST', `/v1/admin/verifications/${sub.body.item.id}/approve`, {})).status).toBe(200);
    await t.drain();
    expect((await t.pool.query(`SELECT status FROM payout_accounts WHERE id = $1`, [acc])).rows[0].status).toBe('PENDING');
    // the decision is still published for finance to use as evidence
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'verification.approved' AND aggregate_id = $1`, [sub.body.item.id]);
    expect(ev.rows[0].payload).toMatchObject({ subjectType: 'PAYOUT_ACCOUNT', subjectId: acc });
  });
});

describe('verification expiry', () => {
  it('expired HOST and IDENTITY approvals stop gating paid publication and are reverted by the expiry job', async () => {
    const host = await createUser(t); // no identity verification yet
    const app = await call(t, host, 'POST', '/v1/host-applications', { about: 'quiet flat' });
    expect(app.status).toBe(201);
    expect((await call(t, compliance, 'POST', `/v1/admin/host-applications/${app.body.item.id}/approve`, {})).status).toBe(200);
    const inOneYear = new Date(Date.now() + 365 * 86400_000).toISOString();
    const cases: string[] = [];
    for (const subjectType of ['IDENTITY', 'HOST']) {
      const c = await call(t, host, 'POST', '/v1/verifications', { subjectType, documents: [{ documentType: 'ID_CARD', sha256: sha('b') }] });
      expect(c.status).toBe(201);
      const ok = await call(t, compliance, 'POST', `/v1/admin/verifications/${c.body.item.id}/approve`, { expiresAt: inOneYear });
      expect(ok.status).toBe(200);
      cases.push(c.body.item.id);
    }
    expect(await hostPublishBlockers(t.pool, host.id)).toEqual([]);
    expect(await isVerified(t.pool, host.id, 'IDENTITY')).toBe(true);
    expect((await call(t, null, 'GET', `/v1/hosts/${host.id}`)).body.item.verified).toBe(true);

    // time passes: both approvals lapse
    await t.pool.query(`UPDATE verification_cases SET expires_at = now() - interval '1 day' WHERE id = ANY($1)`, [cases]);
    // predicates are exact even before the job runs
    expect(await hostPublishBlockers(t.pool, host.id)).toContain('HOST_NOT_VERIFIED');
    expect(await isVerified(t.pool, host.id, 'IDENTITY')).toBe(false);
    expect((await call(t, null, 'GET', `/v1/hosts/${host.id}`)).body.item.verified).toBe(false);
    const dash = await call(t, host, 'GET', '/v1/host/me');
    expect(dash.body.canPublish).toBe(false);
    expect(dash.body.checklist.identityVerified).toBe(false);

    await t.runJobs();
    const { rows } = await t.pool.query(`SELECT status FROM verification_cases WHERE id = ANY($1)`, [cases]);
    expect(rows.map((r) => r.status)).toEqual(['EXPIRED', 'EXPIRED']);
    expect((await t.pool.query(`SELECT verification_status FROM host_profiles WHERE user_id = $1`, [host.id])).rows[0].verification_status).toBe('PENDING');
    expect((await t.pool.query(`SELECT identity_verified_at FROM users WHERE id = $1`, [host.id])).rows[0].identity_verified_at).toBeNull();
    const ev = await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'verification.expired' AND aggregate_id = ANY($1)`, [cases]);
    expect(ev.rows[0].n).toBe(2);
    // re-verification restores eligibility
    const again = await call(t, host, 'POST', '/v1/verifications', { subjectType: 'HOST', documents: [{ documentType: 'ID_CARD', sha256: sha('c') }] });
    await call(t, compliance, 'POST', `/v1/admin/verifications/${again.body.item.id}/approve`, {});
    expect(await hostPublishBlockers(t.pool, host.id)).toEqual([]);
  });

  it('identity verified by other means (no expiring approval) is unaffected', async () => {
    const u = await createUser(t, { verified: true });
    expect(await isVerified(t.pool, u.id, 'IDENTITY')).toBe(true);
    await t.runJobs();
    expect(await isVerified(t.pool, u.id, 'IDENTITY')).toBe(true);
  });
});
