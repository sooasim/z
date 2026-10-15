import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp } from './helpers.js';
import { loadConfig } from '../src/platform/config.js';

/**
 * STAFF_MFA_REQUIRED — the staff AAL2 gate (CORE-01) as a switch.
 *
 * Default on, and it stays on in production whatever the env says. Off, a staff password login can work the
 * admin console: what a demo console needs when nobody can enroll an authenticator (no mail delivery, a
 * shared handle). What it must NOT do is loosen the gates that are about the person's own second factor
 * rather than their staff role — payout accounts and MFA management.
 */

let on: TestApp;
let off: TestApp;

beforeAll(async () => {
  on = await createTestApp();
  off = await createTestApp({ STAFF_MFA_REQUIRED: false });
});
afterAll(async () => {
  await on.close();
  await off.close();
});

describe('the gate as shipped', () => {
  it('refuses an AAL1 staff session on a staff route', async () => {
    const aal1 = await createUser(on, { roles: ['ADMIN'], aal: 'aal1' });
    const r = await call(on, aal1, 'GET', '/v1/admin/overview');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('AAL2_REQUIRED');
  });

  it('reports itself on /v1/me so the console knows whether to ask for a code', async () => {
    const admin = await createUser(on, { roles: ['ADMIN'] });
    expect((await call(on, admin, 'GET', '/v1/me')).body.session).toMatchObject({ aal: 'aal2', staffMfaRequired: true });
  });
});

describe('STAFF_MFA_REQUIRED=false', () => {
  it('lets an AAL1 staff session work a staff route', async () => {
    const aal1 = await createUser(off, { roles: ['ADMIN'], aal: 'aal1' });
    expect((await call(off, aal1, 'GET', '/v1/admin/overview')).status).toBe(200);
  });

  it('still refuses a member with no staff role', async () => {
    const member = await createUser(off);
    const r = await call(off, member, 'GET', '/v1/admin/overview');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ROLE_REQUIRED');
  });

  it('still refuses an anonymous caller', async () => {
    expect((await call(off, null, 'GET', '/v1/admin/overview')).status).toBe(401);
  });

  it('keeps the account-holder AAL2 gates shut — a staff role is not a second factor', async () => {
    // requireAal2: regenerating recovery codes and registering a payout account are about this person's
    // own authenticator, so the staff switch must not open them.
    const aal1 = await createUser(off, { roles: ['ADMIN'], aal: 'aal1' });
    const r = await call(off, aal1, 'POST', '/v1/auth/mfa/recovery-codes');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('AAL2_REQUIRED');
  });

  it('tells /v1/me that the gate is off', async () => {
    const aal1 = await createUser(off, { roles: ['ADMIN'], aal: 'aal1' });
    expect((await call(off, aal1, 'GET', '/v1/me')).body.session).toMatchObject({ aal: 'aal1', staffMfaRequired: false });
  });
});

describe('config', () => {
  const prod = {
    NODE_ENV: 'production',
    JWT_SECRET: 'x'.repeat(40),
    DATA_ENCRYPTION_KEY: 'a'.repeat(64),
    PAYMENT_PROVIDER: 'TOSS',
    OAUTH_MOCK: false,
  };

  it('defaults to on, and reads the env the same way the other booleans do', () => {
    expect(loadConfig({}).STAFF_MFA_REQUIRED).toBe(true);
    expect(loadConfig({ STAFF_MFA_REQUIRED: 'false' }).STAFF_MFA_REQUIRED).toBe(false);
    expect(loadConfig({ STAFF_MFA_REQUIRED: 'off' }).STAFF_MFA_REQUIRED).toBe(false);
    expect(loadConfig({ STAFF_MFA_REQUIRED: '' }).STAFF_MFA_REQUIRED).toBe(true);
    expect(() => loadConfig({ STAFF_MFA_REQUIRED: 'maybe' })).toThrow();
  });

  it('refuses to boot with the gate off in production', () => {
    expect(() => loadConfig({ ...prod, STAFF_MFA_REQUIRED: false })).toThrow(/STAFF_MFA_REQUIRED/);
    expect(loadConfig({ ...prod, STAFF_MFA_REQUIRED: true }).STAFF_MFA_REQUIRED).toBe(true);
  });
});
