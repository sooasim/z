import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, call, type TestApp } from './helpers.js';
import { loadConfig } from '../src/platform/config.js';
import { DEMO_ACCOUNTS } from '../src/modules/identity/demo-accounts.js';

/**
 * CORE-01 demo sign-in. The login page offers one button per seeded role on a demo deployment; the gate is the
 * environment, so the test that matters is what an environment WITHOUT the gate answers.
 */
let on: TestApp;
let off: TestApp;

async function seedDemoUser(t: TestApp, email: string, roles: string[] = []) {
  const u = await t.pool.query(`INSERT INTO users(email, display_name, status, email_verified_at) VALUES ($1,$2,'ACTIVE',now()) RETURNING id`, [email, `데모 ${email.split('@')[0]}`]);
  for (const role of roles) await t.pool.query(`INSERT INTO user_roles(user_id, role) VALUES ($1,$2)`, [u.rows[0].id, role]);
  return u.rows[0].id as string;
}

beforeAll(async () => {
  on = await createTestApp({ DEMO_LOGINS: true });
  off = await createTestApp({ DEMO_LOGINS: false });
  for (const t of [on, off]) {
    await seedDemoUser(t, 'guest@jetpool.dev');
    await seedDemoUser(t, 'host.seoul@jetpool.dev', ['HOST']);
    await seedDemoUser(t, 'admin@jetpool.dev', ['ADMIN', 'SUPPORT']);
  }
});
afterAll(async () => Promise.all([on.close(), off.close()]));

describe('CORE-01 demo sign-in', () => {
  it('lists only the demo accounts the environment actually has, in registry order', async () => {
    const res = await call(on, null, 'GET', '/v1/auth/demo-accounts');
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: any) => i.key)).toEqual(['guest', 'host-seoul', 'admin']);
    expect(res.body.items[1]).toMatchObject({ email: 'host.seoul@jetpool.dev', roles: ['HOST'] });
    // no password, hash or token is offered anywhere in the listing
    expect(JSON.stringify(res.body)).not.toMatch(/password|hash|secret|token/i);
  });

  it('opens a session for a listed account without any credential', async () => {
    const res = await call(on, null, 'POST', '/v1/auth/demo-login', { key: 'host-seoul' });
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('host.seoul@jetpool.dev');
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    // the token it returns is a usable session for that account
    const me = await call(on, null, 'GET', '/v1/me', undefined, { authorization: `Bearer ${res.body.accessToken}` });
    expect(me.status).toBe(200);
    expect(me.body.user?.email ?? me.body.email).toBe('host.seoul@jetpool.dev');
  });

  it('records the session as TEST so it is not mistaken for a password login', async () => {
    const res = await call(on, null, 'POST', '/v1/auth/demo-login', { key: 'guest' });
    const row = await on.pool.query(`SELECT auth_method FROM sessions WHERE id = $1`, [res.body.sessionId]);
    expect(row.rows[0].auth_method).toBe('TEST');
    const a = await on.pool.query(`SELECT after_state FROM audit_logs WHERE action = 'auth.login' ORDER BY created_at DESC LIMIT 1`);
    expect(a.rows[0].after_state).toMatchObject({ method: 'TEST', demoAccount: 'guest' });
  });

  it('refuses a key that is not a seeded demo account', async () => {
    expect((await call(on, null, 'POST', '/v1/auth/demo-login', { key: 'not-a-persona' })).status).toBe(400);
    expect((await call(on, null, 'POST', '/v1/auth/demo-login', { key: 'accounting' })).status).toBe(404);
  });

  it('does not exist at all when the environment has not enabled it', async () => {
    expect((await call(off, null, 'GET', '/v1/auth/demo-accounts')).body.items).toEqual([]);
    const res = await call(off, null, 'POST', '/v1/auth/demo-login', { key: 'guest' });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});

describe('CORE-01 demo sign-in configuration', () => {
  it('follows OAUTH_MOCK when it is not set, so a demo box needs no second switch', () => {
    expect(loadConfig({ OAUTH_MOCK: true }).DEMO_LOGINS).toBe(true);
    expect(loadConfig({ OAUTH_MOCK: false }).DEMO_LOGINS).toBe(false);
    expect(loadConfig({ OAUTH_MOCK: true, DEMO_LOGINS: false }).DEMO_LOGINS).toBe(false);
    // compose writes `DEMO_LOGINS: ${DEMO_LOGINS:-}`, so an untouched .env arrives as an empty string
    expect(loadConfig({ OAUTH_MOCK: true, DEMO_LOGINS: '' }).DEMO_LOGINS).toBe(true);
  });

  it('is refused in production', () => {
    const prod = { NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(48), DATA_ENCRYPTION_KEY: 'a'.repeat(64), PAYMENT_PROVIDER: 'TOSS', OAUTH_MOCK: false };
    expect(() => loadConfig({ ...prod, DEMO_LOGINS: true })).toThrow(/DEMO_LOGINS is forbidden in production/);
    expect(loadConfig({ ...prod }).DEMO_LOGINS).toBe(false);
  });

  it('keeps the registry in step with the dev seed', () => {
    expect(new Set(DEMO_ACCOUNTS.map((a) => a.key)).size).toBe(DEMO_ACCOUNTS.length);
    for (const a of DEMO_ACCOUNTS) expect(a.email).toMatch(/@jetpool\.dev$/);
  });
});
