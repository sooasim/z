import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
let docs: Record<string, string>;
const asUser = (s: { accessToken: string }) => ({ headers: { authorization: `Bearer ${s.accessToken}` } }) as unknown as TestUser;

beforeAll(async () => {
  t = await createTestApp();
  t.app.ctx.adapters.set('identity.codeSender', async () => {});
  docs = Object.fromEntries((await call(t, null, 'GET', '/v1/consent-documents')).body.items.map((d: any) => [d.type, d.version]));
});
afterAll(async () => t.close());

async function signup(email: string) {
  const r = await call(t, null, 'POST', '/v1/auth/signup', {
    email,
    password: 'Priv4cy-password',
    consents: [
      { type: 'TERMS', version: docs.TERMS, granted: true },
      { type: 'PRIVACY', version: docs.PRIVACY, granted: true },
    ],
  });
  expect(r.status).toBe(201);
  return r.body;
}

describe('CORE-04 consents', () => {
  it('lists current documents and records append-only consents with evidence', async () => {
    const d = await call(t, null, 'GET', '/v1/consent-documents?type=TERMS');
    expect(d.body.items).toHaveLength(1);
    expect(d.body.items[0].required).toBe(true);
    const user = await createUser(t);
    const rec = await call(t, user, 'POST', '/v1/consents', { consents: [{ type: 'MARKETING', version: docs.MARKETING, granted: true }] }, { 'user-agent': 'vitest-agent' });
    expect(rec.status).toBe(201);
    expect(rec.body.items[0].evidence).toMatchObject({ userAgent: 'vitest-agent', version: docs.MARKETING });
    await call(t, user, 'POST', '/v1/consents', { consents: [{ type: 'MARKETING', version: docs.MARKETING, granted: false }] });
    const state = await call(t, user, 'GET', '/v1/consents');
    expect(state.body.current.find((c: any) => c.consent_type === 'MARKETING').granted).toBe(false);
    expect(state.body.history).toHaveLength(2);
    expect((await call(t, user, 'POST', '/v1/consents', { consents: [{ type: 'MARKETING', version: 'nope', granted: true }] })).body.code).toBe('CONSENT_DOCUMENT_NOT_FOUND');
    await expect(t.pool.query(`UPDATE consent_records SET granted = true WHERE user_id = $1`, [user.id])).rejects.toThrow(/append-only/);
    const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'consent.recorded' AND aggregate_id = $1`, [user.id]);
    expect(rows[0].n).toBe(2);
    expect((await t.pool.query(`SELECT marketing_opt_in FROM user_preferences WHERE user_id = $1`, [user.id])).rows[0].marketing_opt_in).toBe(false);
  });

  it('a published document version supersedes drafts', async () => {
    await t.pool.query(`INSERT INTO consent_documents(consent_type, version, title, body_md, required, published_at) VALUES ('TERMS','2026-11','Terms v2','...', true, now() - interval '1 minute')`);
    const d = await call(t, null, 'GET', '/v1/consent-documents?type=TERMS');
    expect(d.body.items[0].version).toBe('2026-11');
    // signup with the old draft is now refused
    const r = await call(t, null, 'POST', '/v1/auth/signup', {
      email: 'late@example.com',
      password: 'Priv4cy-password',
      consents: [{ type: 'TERMS', version: docs.TERMS, granted: true }, { type: 'PRIVACY', version: docs.PRIVACY, granted: true }],
    });
    expect(r.body.code).toBe('CONSENT_REQUIRED');
    docs.TERMS = '2026-11';
  });
});

describe('CORE-04 export & deletion', () => {
  it('exports only the requester\'s own data, without secrets', async () => {
    const s = await signup('export@example.com');
    const other = await createUser(t);
    await call(t, asUser(s), 'PATCH', '/v1/me/profile', { bio: 'my bio' });
    const ex = await call(t, asUser(s), 'POST', '/v1/privacy/export');
    expect(ex.status).toBe(201);
    const result = ex.body.item.result;
    expect(ex.body.item.status).toBe('COMPLETED');
    expect(result.account.email).toBe('export@example.com');
    expect(result.profile.bio).toBe('my bio');
    expect(result.consents.length).toBeGreaterThanOrEqual(2);
    const json = JSON.stringify(result);
    expect(json).not.toContain('password_hash');
    expect(json).not.toContain('scrypt$');
    expect(json).not.toContain('refresh_token_hash');
    expect(json).not.toContain(other.email);
    const list = await call(t, asUser(s), 'GET', '/v1/privacy/requests');
    expect(list.body.items[0].request_type).toBe('EXPORT');
    expect((await call(t, other, 'GET', `/v1/privacy/requests/${ex.body.item.id}`)).status).toBe(404);
    const { rows } = await t.pool.query(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at`, [ex.body.item.id]);
    expect(rows.map((r) => r.event_type)).toEqual(['privacy.requested', 'privacy.completed']);
  });

  it('deletion: re-auth, sessions revoked, grace period, cancellable, then PII scrub keeping financial records', async () => {
    const s = await signup('delete.me@example.com');
    const uid = s.user.id;
    const host = await createUser(t, { roles: ['HOST'] });
    const { rows: p } = await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'P','HOUSE') RETURNING id`, [host.id]);
    const { rows: res } = await t.pool.query(
      `INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, total_minor, currency, quote_snapshot)
       VALUES ($1,$2,$3,'COMPLETED', current_date - 5, current_date - 2, 100000, 'KRW', '{}') RETURNING id`,
      [p[0].id, host.id, uid],
    );
    expect((await call(t, asUser(s), 'POST', '/v1/privacy/delete', { confirm: 'DELETE', password: 'wrong-password-x' })).status).toBe(401);
    expect((await call(t, asUser(s), 'POST', '/v1/privacy/delete', { confirm: 'NO', password: 'Priv4cy-password' })).status).toBe(400);
    const del = await call(t, asUser(s), 'POST', '/v1/privacy/delete', { confirm: 'DELETE', password: 'Priv4cy-password', reason: 'leaving' });
    expect(del.status).toBe(202);
    expect(del.body.item.scheduled_for).toBeTruthy();
    expect((await call(t, asUser(s), 'GET', '/v1/me')).status).toBe(401);

    // user may log back in during the grace period and cancel
    const login = await call(t, null, 'POST', '/v1/auth/login', { email: 'delete.me@example.com', password: 'Priv4cy-password' });
    expect(login.body.user.status).toBe('PENDING_DELETION');
    expect((await call(t, asUser(login.body), 'POST', '/v1/privacy/delete/cancel')).body.cancelled).toBe(true);
    expect((await t.pool.query(`SELECT status FROM users WHERE id = $1`, [uid])).rows[0].status).toBe('ACTIVE');

    // request again; job does nothing inside the grace period
    const login2 = await call(t, null, 'POST', '/v1/auth/login', { email: 'delete.me@example.com', password: 'Priv4cy-password' });
    const del2 = await call(t, asUser(login2.body), 'POST', '/v1/privacy/delete', { confirm: 'DELETE', password: 'Priv4cy-password' });
    expect(del2.status).toBe(202);
    await t.runJobs();
    expect((await t.pool.query(`SELECT status FROM users WHERE id = $1`, [uid])).rows[0].status).toBe('PENDING_DELETION');
    // after the grace period the scrub job runs
    await t.pool.query(`UPDATE privacy_requests SET requested_at = now() - interval '8 days' WHERE id = $1`, [del2.body.item.id]);
    await t.runJobs();
    const { rows: u } = await t.pool.query(`SELECT email, phone, display_name, password_hash, status, deleted_at FROM users WHERE id = $1`, [uid]);
    expect(u[0]).toMatchObject({ phone: null, display_name: 'Deleted user', password_hash: null, status: 'DELETED' });
    expect(u[0].email).toMatch(/^deleted\+.*@deleted\.invalid$/);
    expect(u[0].deleted_at).toBeTruthy();
    // financial / legal records retained
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM reservations WHERE id = $1`, [res[0].id])).rows[0].n).toBe(1);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM consent_records WHERE user_id = $1`, [uid])).rows[0].n).toBeGreaterThanOrEqual(2);
    const { rows: pr } = await t.pool.query(`SELECT status FROM privacy_requests WHERE id = $1`, [del2.body.item.id]);
    expect(pr[0].status).toBe('COMPLETED');
    expect((await call(t, null, 'POST', '/v1/auth/login', { email: 'delete.me@example.com', password: 'Priv4cy-password' })).status).toBe(401);
    // the original email can be reused for a fresh account
    expect((await signup('delete.me@example.com')).user.id).not.toBe(uid);
    const { rows: a } = await t.pool.query(`SELECT action FROM audit_logs WHERE resource_id = $1 AND category = 'PRIVACY' ORDER BY created_at`, [uid]);
    expect(a.map((x) => x.action)).toEqual(expect.arrayContaining(['privacy.delete_requested', 'privacy.delete_cancelled', 'privacy.user_scrubbed']));
  });

  it('duplicate deletion requests are refused; staff can list privacy requests (AAL2)', async () => {
    const s = await signup('dup.delete@example.com');
    const login = await call(t, null, 'POST', '/v1/auth/login', { email: 'dup.delete@example.com', password: 'Priv4cy-password' });
    await call(t, asUser(s), 'POST', '/v1/privacy/delete', { confirm: 'DELETE', password: 'Priv4cy-password' });
    const login2 = await call(t, null, 'POST', '/v1/auth/login', { email: 'dup.delete@example.com', password: 'Priv4cy-password' });
    void login;
    expect((await call(t, asUser(login2.body), 'POST', '/v1/privacy/delete', { confirm: 'DELETE', password: 'Priv4cy-password' })).body.code).toBe('DELETION_ALREADY_REQUESTED');
    const compliance = await createUser(t, { roles: ['COMPLIANCE'] });
    const list = await call(t, compliance, 'GET', '/v1/admin/privacy/requests?status=REQUESTED');
    expect(list.body.items.some((r: any) => r.user_id === s.user.id)).toBe(true);
    expect((await call(t, asUser(login2.body), 'GET', '/v1/admin/privacy/requests')).status).toBe(403);
  });
});
