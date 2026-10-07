import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { assertHostCanPublish, hostPublishBlockers } from '../src/modules/hosts/service.js';

let t: TestApp;
let applicant: TestUser, compliance: TestUser, admin: TestUser;

beforeAll(async () => {
  t = await createTestApp();
  applicant = await createUser(t);
  compliance = await createUser(t, { roles: ['COMPLIANCE'] });
  admin = await createUser(t, { roles: ['ADMIN'] });
});
afterAll(async () => t.close());

describe('HOST-01 onboarding', () => {
  let appId: string;

  it('applies with a computed checklist; duplicate open application refused', async () => {
    const r = await call(t, applicant, 'POST', '/v1/host-applications', { displayName: 'Jeju Host', about: 'Ocean view' });
    expect(r.status).toBe(201);
    appId = r.body.item.id;
    expect(r.body.item.checklist).toMatchObject({ emailVerified: true, identityVerified: false, hostVerified: false, payoutAccount: 'MISSING' });
    expect((await call(t, applicant, 'POST', '/v1/host-applications', {})).body.code).toBe('APPLICATION_OPEN');
    const { rows } = await t.pool.query(`SELECT status, verification_status FROM host_profiles WHERE user_id = $1`, [applicant.id]);
    expect(rows[0]).toEqual({ status: 'APPLIED', verification_status: 'PENDING' });
    expect((await call(t, null, 'GET', `/v1/hosts/${applicant.id}`)).status).toBe(404); // not public until approved
    const dash = await call(t, applicant, 'GET', '/v1/host/me');
    expect(dash.body.canPublish).toBe(false);
    expect(dash.body.publishBlockers).toEqual(expect.arrayContaining(['HOST_NOT_APPROVED', 'HOST_NOT_VERIFIED', 'HOST_ROLE_MISSING']));
  });

  it('admin queue permissions; approval grants HOST role and emits host.approved', async () => {
    expect((await call(t, applicant, 'GET', '/v1/admin/host-applications')).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['ADMIN'], aal: 'aal1' });
    expect((await call(t, aal1, 'POST', `/v1/admin/host-applications/${appId}/approve`)).body.code).toBe('AAL2_REQUIRED');
    expect((await call(t, compliance, 'GET', '/v1/admin/host-applications')).body.items.map((a: any) => a.id)).toContain(appId);
    const ap = await call(t, compliance, 'POST', `/v1/admin/host-applications/${appId}/approve`, { reason: 'looks good' });
    expect(ap.body.item.status).toBe('APPROVED');
    expect((await call(t, applicant, 'GET', '/v1/me/roles')).body.roles).toContain('HOST');
    const { rows } = await t.pool.query(`SELECT event_type FROM outbox_events WHERE event_type IN ('host.applied','host.approved','role.granted') ORDER BY created_at`);
    expect(rows.map((r) => r.event_type)).toEqual(['host.applied', 'role.granted', 'host.approved']);
    expect((await call(t, compliance, 'POST', `/v1/admin/host-applications/${appId}/reject`, { reason: 'too late' })).body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await call(t, applicant, 'POST', '/v1/host-applications', {})).body.code).toBe('ALREADY_HOST');
    const pub = await call(t, null, 'GET', `/v1/hosts/${applicant.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.item).toMatchObject({ displayName: 'Jeju Host', verified: false });
    expect(JSON.stringify(pub.body)).not.toContain('@');
  });

  it('cannot publish until verified; HOST verification approval unlocks; sanctions block again', async () => {
    expect(await hostPublishBlockers(t.pool, applicant.id)).toEqual(['HOST_NOT_VERIFIED']);
    await expect(assertHostCanPublish(t.pool, applicant.id)).rejects.toMatchObject({ status: 403, code: 'HOST_NOT_ELIGIBLE', details: { reasons: ['HOST_NOT_VERIFIED'] } });
    const v = await call(t, applicant, 'POST', '/v1/verifications', { subjectType: 'HOST', documents: [{ documentType: 'OWNERSHIP', sha256: 'f'.repeat(64) }] });
    await call(t, compliance, 'POST', `/v1/admin/verifications/${v.body.item.id}/approve`);
    await expect(assertHostCanPublish(t.pool, applicant.id)).resolves.toBeUndefined();
    expect((await call(t, applicant, 'GET', '/v1/host/me')).body.canPublish).toBe(true);
    expect((await call(t, null, 'GET', `/v1/hosts/${applicant.id}`)).body.item.verified).toBe(true);
    const s = await call(t, admin, 'POST', '/v1/admin/sanctions', { userId: applicant.id, sanctionType: 'LISTING_SUSPENSION', reason: 'safety investigation' });
    expect(s.status).toBe(201);
    expect(await hostPublishBlockers(t.pool, applicant.id)).toEqual(['SANCTIONED']);
    await call(t, admin, 'POST', `/v1/admin/sanctions/${s.body.item.id}/lift`, { reason: 'cleared' });
    expect(await hostPublishBlockers(t.pool, applicant.id)).toEqual([]);
  });

  it('rejection requires a reason; rejected applicants may reapply; withdraw works only for own applications', async () => {
    const u = await createUser(t);
    const a = await call(t, u, 'POST', '/v1/host-applications', {});
    expect((await call(t, admin, 'POST', `/v1/admin/host-applications/${a.body.item.id}/reject`, {})).status).toBe(400);
    expect((await call(t, admin, 'POST', `/v1/admin/host-applications/${a.body.item.id}/reject`, { reason: 'incomplete documents' })).body.item.status).toBe('REJECTED');
    expect((await t.pool.query(`SELECT status FROM host_profiles WHERE user_id = $1`, [u.id])).rows[0].status).toBe('REJECTED');
    const again = await call(t, u, 'POST', '/v1/host-applications', { about: 'now complete' });
    expect(again.status).toBe(201);
    expect((await t.pool.query(`SELECT status FROM host_profiles WHERE user_id = $1`, [u.id])).rows[0].status).toBe('APPLIED');
    expect((await call(t, applicant, 'POST', `/v1/host-applications/${again.body.item.id}/withdraw`)).status).toBe(404);
    expect((await call(t, u, 'POST', `/v1/host-applications/${again.body.item.id}/withdraw`)).body.item.status).toBe('WITHDRAWN');
    expect((await call(t, u, 'GET', '/v1/host-applications')).body.items).toHaveLength(2);
    // reviewers cannot approve their own application
    const selfApp = await call(t, compliance, 'POST', '/v1/host-applications', {});
    expect((await call(t, compliance, 'POST', `/v1/admin/host-applications/${selfApp.body.item.id}/approve`)).body.code).toBe('SELF_REVIEW_FORBIDDEN');
  });
});
