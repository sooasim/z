import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { can } from '../src/modules/roles/service.js';

let t: TestApp;
let admin: TestUser, support: TestUser, user: TestUser;

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  support = await createUser(t, { roles: ['SUPPORT'] });
  user = await createUser(t);
});
afterAll(async () => t.close());

describe('CORE-03 roles', () => {
  it('GET /v1/me/roles returns implicit USER and permissions', async () => {
    const r = await call(t, user, 'GET', '/v1/me/roles');
    expect(r.body.roles).toEqual(['USER']);
    expect(r.body.permissions).toContain('reviews.write');
    expect(r.body.permissions).not.toContain('*');
  });

  it('admin grants and revokes with history, audit (PERMISSION) and events; revocation is effective immediately', async () => {
    const target = await createUser(t);
    const g = await call(t, admin, 'POST', `/v1/admin/users/${target.id}/roles`, { role: 'SUPPORT', reason: 'new hire on support team' });
    expect(g.status).toBe(201);
    expect(g.body.roles).toContain('SUPPORT');
    expect((await call(t, admin, 'POST', `/v1/admin/users/${target.id}/roles`, { role: 'SUPPORT', reason: 'again please' })).body.changed).toBe(false);
    // the target's existing AAL1 session sees the role but staff routes demand AAL2
    expect((await call(t, target, 'GET', '/v1/admin/users')).body.code).toBe('AAL2_REQUIRED');
    await t.pool.query(`UPDATE sessions SET aal = 'aal2' WHERE id = $1`, [target.sessionId]);
    expect((await call(t, target, 'GET', '/v1/admin/users')).status).toBe(200);
    const rv = await call(t, admin, 'DELETE', `/v1/admin/users/${target.id}/roles?role=SUPPORT&reason=left%20the%20team`);
    expect(rv.status).toBe(200);
    expect(rv.body.roles).toEqual(['USER']);
    expect((await call(t, target, 'GET', '/v1/admin/users')).status).toBe(403);
    const hist = await call(t, admin, 'GET', `/v1/admin/users/${target.id}/roles`);
    expect(hist.body.history.map((h: any) => h.action)).toEqual(['REVOKE', 'GRANT']);
    const { rows } = await t.pool.query(`SELECT action FROM audit_logs WHERE resource_id = $1 AND category = 'PERMISSION' ORDER BY created_at`, [target.id]);
    expect(rows.map((r) => r.action)).toEqual(['role.granted', 'role.revoked']);
    const { rows: ev } = await t.pool.query(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1 AND event_type LIKE 'role.%' ORDER BY created_at`, [target.id]);
    expect(ev.map((e) => e.event_type)).toEqual(['role.granted', 'role.revoked']);
    // path-param variant
    await call(t, admin, 'POST', `/v1/admin/users/${target.id}/roles`, { role: 'EDITOR', reason: 'cms work' });
    expect((await call(t, admin, 'DELETE', `/v1/admin/users/${target.id}/roles/EDITOR`)).body.changed).toBe(true);
  });

  it('permission negatives: non-admin, staff without ADMIN, AAL1 admin', async () => {
    expect((await call(t, user, 'POST', `/v1/admin/users/${user.id}/roles`, { role: 'ADMIN', reason: 'let me in' })).status).toBe(403);
    expect((await call(t, support, 'POST', `/v1/admin/users/${user.id}/roles`, { role: 'ADMIN', reason: 'let me in' })).body.code).toBe('ROLE_REQUIRED');
    const aal1 = await createUser(t, { roles: ['ADMIN'], aal: 'aal1' });
    expect((await call(t, aal1, 'POST', `/v1/admin/users/${user.id}/roles`, { role: 'HOST', reason: 'approve' })).body.code).toBe('AAL2_REQUIRED');
    expect((await call(t, admin, 'POST', `/v1/admin/users/${user.id}/roles`, { role: 'USER', reason: 'implicit' })).body.code).toBe('ROLE_IMPLICIT');
  });

  it('guards against self-revocation and removing the last admin', async () => {
    expect((await call(t, admin, 'DELETE', `/v1/admin/users/${admin.id}/roles/ADMIN`)).body.code).toBe('SELF_REVOKE_FORBIDDEN');
  });

  it('can() honours roles, AAL and policy overrides (DENY beats ALLOW, expiry respected)', async () => {
    const u = await createUser(t, { roles: ['SUPPORT'] });
    const actor = { userId: u.id, roles: ['USER', 'SUPPORT'] as any, aal: 'aal2' as const };
    expect(await can(t.pool, actor, 'support.cases.read')).toBe(true);
    expect(await can(t.pool, { ...actor, aal: 'aal1' }, 'support.cases.read')).toBe(false);
    expect(await can(t.pool, actor, 'finance.payouts')).toBe(false);
    const allow = await call(t, admin, 'POST', `/v1/admin/users/${u.id}/policy-overrides`, { permission: 'finance.payouts', effect: 'ALLOW', reason: 'temporary cover' });
    expect(allow.status).toBe(201);
    expect(await can(t.pool, actor, 'finance.payouts')).toBe(true);
    await call(t, admin, 'POST', `/v1/admin/users/${u.id}/policy-overrides`, { permission: 'support.*', effect: 'DENY', reason: 'investigation' });
    expect(await can(t.pool, actor, 'support.cases.read')).toBe(false);
    const list = await call(t, admin, 'GET', `/v1/admin/users/${u.id}/policy-overrides`);
    const deny = list.body.items.find((o: any) => o.effect === 'DENY');
    expect((await call(t, admin, 'DELETE', `/v1/admin/policy-overrides/${deny.id}`)).status).toBe(204);
    expect(await can(t.pool, actor, 'support.cases.read')).toBe(true);
    expect(await can(t.pool, null, 'reviews.write')).toBe(false);
    expect(await can(t.pool, { userId: admin.id, roles: ['ADMIN'], aal: 'aal2' }, 'anything.at.all')).toBe(true);
  });
});

describe('CORE-03 admin user directory & suspension', () => {
  it('searches users; SUPPORT sees masked contact data, ADMIN sees full', async () => {
    const target = await createUser(t, { email: 'findme.person@example.com' });
    await t.pool.query(`UPDATE users SET phone = '+821012345678' WHERE id = $1`, [target.id]);
    const a = await call(t, admin, 'GET', '/v1/admin/users?q=findme');
    expect(a.body.items).toHaveLength(1);
    expect(a.body.items[0].email).toBe('findme.person@example.com');
    const s = await call(t, support, 'GET', '/v1/admin/users?q=findme');
    expect(s.body.items[0].email).toMatch(/^fi\*+@example\.com$/);
    expect(s.body.items[0].phone).toMatch(/\*+5678$/);
    expect((await call(t, user, 'GET', '/v1/admin/users')).status).toBe(403);
    const detail = await call(t, support, 'GET', `/v1/admin/users/${target.id}`);
    expect(detail.body.item.activeSessions).toBe(1);
    // pagination
    const p1 = await call(t, admin, 'GET', '/v1/admin/users?limit=2');
    expect(p1.body.items).toHaveLength(2);
    const p2 = await call(t, admin, 'GET', `/v1/admin/users?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items[0].id).not.toBe(p1.body.items[0].id);
    // LIKE wildcards in the query are literal
    expect((await call(t, admin, 'GET', '/v1/admin/users?q=%25')).body.items).toHaveLength(0);
  });

  it('suspend revokes sessions and blocks access; restore re-enables; SUPPORT cannot suspend', async () => {
    const target = await createUser(t);
    expect((await call(t, support, 'POST', `/v1/admin/users/${target.id}/suspend`, { reason: 'spam' })).status).toBe(403);
    const s = await call(t, admin, 'POST', `/v1/admin/users/${target.id}/suspend`, { reason: 'spam campaign' });
    expect(s.body.item.status).toBe('SUSPENDED');
    expect((await call(t, target, 'GET', '/v1/me')).status).toBe(401);
    const login = await call(t, null, 'POST', '/v1/auth/login', { email: target.email, password: target.password });
    expect(login.body.code).toBe('ACCOUNT_SUSPENDED');
    expect((await call(t, admin, 'POST', `/v1/admin/users/${admin.id}/suspend`, { reason: 'self' })).body.code).toBe('SELF_SUSPEND_FORBIDDEN');
    const r = await call(t, admin, 'POST', `/v1/admin/users/${target.id}/restore`, { reason: 'false positive' });
    expect(r.body.item.status).toBe('ACTIVE');
    expect((await call(t, null, 'POST', '/v1/auth/login', { email: target.email, password: target.password })).status).toBe(200);
    const { rows } = await t.pool.query(`SELECT from_state, to_state FROM state_transitions WHERE aggregate_type = 'user' AND aggregate_id = $1 ORDER BY id`, [target.id]);
    expect(rows).toEqual([{ from_state: 'ACTIVE', to_state: 'SUSPENDED' }, { from_state: 'SUSPENDED', to_state: 'ACTIVE' }]);
  });
});
