import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { isVerified } from '../src/modules/verification/service.js';

let t: TestApp;
let user: TestUser, other: TestUser, compliance: TestUser, admin: TestUser;
const sha = (c: string) => c.repeat(64);

async function media(owner: string, hash: string | null = null) {
  const { rows } = await t.pool.query(
    `INSERT INTO media_assets(owner_id, storage_key, mime_type, byte_size, sha256, purpose) VALUES ($1, 'v/' || gen_random_uuid(), 'image/jpeg', 100, $2, 'VERIFICATION') RETURNING id`,
    [owner, hash],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  t = await createTestApp();
  user = await createUser(t);
  other = await createUser(t);
  compliance = await createUser(t, { roles: ['COMPLIANCE'] });
  admin = await createUser(t, { roles: ['ADMIN'] });
});
afterAll(async () => t.close());

describe('TRUST-01 verification', () => {
  it('submits an IDENTITY case, compliance approves, users.identity_verified_at set, events emitted', async () => {
    expect(await isVerified(t.pool, user.id, 'IDENTITY')).toBe(false);
    const m = await media(user.id, sha('a'));
    const sub = await call(t, user, 'POST', '/v1/verifications', { subjectType: 'IDENTITY', documents: [{ documentType: 'ID_CARD', mediaId: m, sha256: sha('a') }] });
    expect(sub.status).toBe(201);
    const id = sub.body.item.id;
    expect((await call(t, user, 'POST', '/v1/verifications', { subjectType: 'IDENTITY', documents: [{ documentType: 'ID_CARD', sha256: sha('b') }] })).body.code).toBe('VERIFICATION_ALREADY_OPEN');
    // owner can read, others cannot
    expect((await call(t, user, 'GET', `/v1/verifications/${id}`)).body.item.documents).toHaveLength(1);
    expect((await call(t, other, 'GET', `/v1/verifications/${id}`)).status).toBe(404);
    // queue access: COMPLIANCE/ADMIN with AAL2 only
    expect((await call(t, user, 'GET', '/v1/admin/verifications')).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['COMPLIANCE'], aal: 'aal1' });
    expect((await call(t, aal1, 'GET', '/v1/admin/verifications')).body.code).toBe('AAL2_REQUIRED');
    const support = await createUser(t, { roles: ['SUPPORT'] });
    expect((await call(t, support, 'POST', `/v1/admin/verifications/${id}/approve`)).status).toBe(403);
    const q = await call(t, compliance, 'GET', '/v1/admin/verifications');
    expect(q.body.items.map((x: any) => x.id)).toContain(id);
    expect((await call(t, compliance, 'POST', `/v1/admin/verifications/${id}/start-review`)).body.item.status).toBe('IN_REVIEW');
    const ap = await call(t, compliance, 'POST', `/v1/admin/verifications/${id}/approve`, { reason: 'document matches' });
    expect(ap.body.item.status).toBe('APPROVED');
    expect(await isVerified(t.pool, user.id, 'IDENTITY')).toBe(true);
    expect((await call(t, user, 'GET', '/v1/me')).body.user.identityVerified).toBe(true);
    const { rows } = await t.pool.query(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at`, [id]);
    expect(rows.map((r) => r.event_type)).toEqual(['verification.submitted', 'verification.approved']);
    // terminal
    expect((await call(t, compliance, 'POST', `/v1/admin/verifications/${id}/reject`, { reason: 'changed mind' })).body.code).toBe('INVALID_STATE_TRANSITION');
    const { rows: a } = await t.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE resource_id = $1 AND category = 'COMPLIANCE'`, [id]);
    expect(a[0].n).toBeGreaterThanOrEqual(3);
  });

  it('document checks: foreign media and hash mismatch rejected; documents are append-only', async () => {
    const foreign = await media(other.id, sha('c'));
    expect((await call(t, user, 'POST', '/v1/verifications', { subjectType: 'GUIDE', documents: [{ documentType: 'LICENSE', mediaId: foreign, sha256: sha('c') }] })).body.code).toBe('MEDIA_NOT_OWNED');
    const mine = await media(user.id, sha('d'));
    expect((await call(t, user, 'POST', '/v1/verifications', { subjectType: 'GUIDE', documents: [{ documentType: 'LICENSE', mediaId: mine, sha256: sha('e') }] })).body.code).toBe('DOCUMENT_HASH_MISMATCH');
    expect((await call(t, user, 'POST', '/v1/verifications', { subjectType: 'GUIDE', documents: [{ documentType: 'LICENSE', sha256: 'nothex' }] })).status).toBe(400);
    const ok = await call(t, user, 'POST', '/v1/verifications', { subjectType: 'GUIDE', documents: [{ documentType: 'LICENSE', mediaId: mine, sha256: sha('d') }] });
    expect(ok.status).toBe(201);
    await expect(t.pool.query(`UPDATE verification_documents SET sha256 = 'x' WHERE case_id = $1`, [ok.body.item.id])).rejects.toThrow(/append-only/);
    // rejection requires a reason and notifies; guide profile projection is updated via the outbox
    await t.pool.query(`INSERT INTO guide_profiles(user_id, guide_type) VALUES ($1,'FRIEND')`, [user.id]);
    expect((await call(t, compliance, 'POST', `/v1/admin/verifications/${ok.body.item.id}/reject`, {})).status).toBe(400);
    const rej = await call(t, compliance, 'POST', `/v1/admin/verifications/${ok.body.item.id}/reject`, { reason: 'license expired' });
    expect(rej.body.item.status).toBe('REJECTED');
    await t.drain();
    expect((await t.pool.query(`SELECT verification_status FROM guide_profiles WHERE user_id = $1`, [user.id])).rows[0].verification_status).toBe('REJECTED');
    const { rows: n } = await t.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND template_key = 'verification.rejected'`, [user.id]);
    expect(n[0].n).toBe(1);
    // resubmit and approve -> VERIFIED
    const again = await call(t, user, 'POST', '/v1/verifications', { subjectType: 'GUIDE', documents: [{ documentType: 'LICENSE', sha256: sha('f') }] });
    await call(t, admin, 'POST', `/v1/admin/verifications/${again.body.item.id}/approve`);
    await t.drain();
    expect((await t.pool.query(`SELECT verification_status FROM guide_profiles WHERE user_id = $1`, [user.id])).rows[0].verification_status).toBe('VERIFIED');
    expect(await isVerified(t.pool, user.id, 'GUIDE')).toBe(true);
  });

  it('staff cannot review their own case; expired approvals no longer count', async () => {
    const own = await call(t, compliance, 'POST', '/v1/verifications', { subjectType: 'IDENTITY', documents: [{ documentType: 'ID', sha256: sha('1') }] });
    expect((await call(t, compliance, 'POST', `/v1/admin/verifications/${own.body.item.id}/approve`)).body.code).toBe('SELF_REVIEW_FORBIDDEN');
    const u = await createUser(t);
    const c = await call(t, u, 'POST', '/v1/verifications', { subjectType: 'HOST', documents: [{ documentType: 'DEED', sha256: sha('2') }] });
    await call(t, compliance, 'POST', `/v1/admin/verifications/${c.body.item.id}/approve`, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(await isVerified(t.pool, u.id, 'HOST')).toBe(true);
    await t.pool.query(`UPDATE verification_cases SET expires_at = now() - interval '1 second' WHERE id = $1`, [c.body.item.id]);
    expect(await isVerified(t.pool, u.id, 'HOST')).toBe(false);
  });

  it('business profiles: CRUD, ownership, BUSINESS verification flips status; editing a verified profile resets it', async () => {
    expect((await call(t, user, 'POST', '/v1/business-profiles', { businessType: 'CORPORATION' })).body.code).toBe('BUSINESS_DETAILS_REQUIRED');
    const bp = await call(t, user, 'POST', '/v1/business-profiles', { businessType: 'SOLE_PROPRIETOR', businessName: 'Jeju Stay', registrationNo: '123-45-67890' });
    expect(bp.status).toBe(201);
    const id = bp.body.item.id;
    expect((await call(t, other, 'GET', `/v1/business-profiles/${id}`)).status).toBe(404);
    expect((await call(t, other, 'PATCH', `/v1/business-profiles/${id}`, { businessName: 'mine now' })).status).toBe(404);
    expect((await call(t, other, 'POST', '/v1/verifications', { subjectType: 'BUSINESS', subjectId: id, documents: [{ documentType: 'REG', sha256: sha('3') }] })).body.code).toBe('NOT_SUBJECT_OWNER');
    expect((await call(t, user, 'POST', '/v1/verifications', { subjectType: 'BUSINESS', documents: [{ documentType: 'REG', sha256: sha('3') }] })).body.code).toBe('SUBJECT_ID_REQUIRED');
    const v = await call(t, user, 'POST', '/v1/verifications', { subjectType: 'BUSINESS', subjectId: id, documents: [{ documentType: 'REG', sha256: sha('3') }] });
    await call(t, compliance, 'POST', `/v1/admin/verifications/${v.body.item.id}/approve`);
    expect((await call(t, user, 'GET', `/v1/business-profiles/${id}`)).body.item.status).toBe('VERIFIED');
    expect((await call(t, compliance, 'GET', `/v1/business-profiles/${id}`)).status).toBe(200);
    const patched = await call(t, user, 'PATCH', `/v1/business-profiles/${id}`, { registrationNo: '999-99-99999' });
    expect(patched.body.item.status).toBe('PENDING');
    const list = await call(t, user, 'GET', '/v1/verifications');
    expect(list.body.summary.IDENTITY.verified).toBe(true);
  });
});
