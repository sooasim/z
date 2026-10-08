import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { defaultCodeSender, type CodeMessage } from '../src/modules/identity/service.js';
import { getRegistry, type OutboundMessage } from '../src/modules/notifications/providers.js';
import { encrypt } from '../src/platform/crypto.js';
import { trustProxySetting } from '../src/app.js';

/**
 * Regression tests for the trust r1 identity findings: codes in notifications, pre-account-takeover,
 * email-derived display names, refresh race, concurrent OTP issuance and OTP brute force.
 */
let t: TestApp;
const codes: CodeMessage[] = [];
const lastCode = (email: string, purpose: CodeMessage['purpose']) => [...codes].reverse().find((c) => c.email === email.toLowerCase() && c.purpose === purpose)?.code;
let docs: { TERMS: string; PRIVACY: string };
const consents = () => [
  { type: 'TERMS', version: docs.TERMS, granted: true },
  { type: 'PRIVACY', version: docs.PRIVACY, granted: true },
];
const asUser = (s: { accessToken: string }) => ({ headers: { authorization: `Bearer ${s.accessToken}` } }) as unknown as TestUser;
const capture = async (_tx: unknown, _ctx: unknown, m: CodeMessage) => {
  codes.push(m);
};
const signup = (email: string, extra: Record<string, unknown> = {}) =>
  call(t, null, 'POST', '/v1/auth/signup', { email, password: 'Sup3r-secret-pw', consents: consents(), ...extra });

async function oauth(provider: string, code: string, user: TestUser | null = null, withConsents = true) {
  const start = await call(t, user, 'POST', `/v1/auth/oauth/${provider}/start`, withConsents ? { consents: consents() } : {});
  expect(start.status).toBe(200);
  return call(t, user, 'POST', `/v1/auth/oauth/${provider}/callback`, { code, state: start.body.state });
}

beforeAll(async () => {
  t = await createTestApp();
  t.app.ctx.adapters.set('identity.codeSender', capture);
  const res = await call(t, null, 'GET', '/v1/consent-documents');
  const byType = Object.fromEntries(res.body.items.map((d: any) => [d.type, d.version]));
  docs = { TERMS: byType.TERMS, PRIVACY: byType.PRIVACY };
});
afterAll(async () => t.close());

describe('auth codes are delivered out-of-band only (never as notifications)', () => {
  it('default sender: no notification row holds a code; a session cannot read codes to verify an inbox it does not own', async () => {
    t.app.ctx.adapters.delete('identity.codeSender');
    try {
      const s = await signup('someone-else@example.com');
      expect(s.status).toBe(201);
      await call(t, null, 'POST', '/v1/auth/otp/request', { email: 'someone-else@example.com' });
      await call(t, null, 'POST', '/v1/auth/password/reset/request', { email: 'someone-else@example.com' });
      await t.drain();
      const list = await call(t, asUser(s.body), 'GET', '/v1/notifications');
      expect(list.status).toBe(200);
      expect(list.body.items.filter((n: any) => String(n.templateKey ?? n.template_key ?? '').match(/^auth\.(email_otp|password_reset|email_verify)$/))).toHaveLength(0);
      expect(JSON.stringify(list.body)).not.toMatch(/\b\d{6}\b \(valid until/);
      const { rows } = await t.pool.query(
        `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND template_key IN ('auth.email_otp','auth.password_reset','auth.email_verify')`,
        [s.body.user.id],
      );
      expect(rows[0].n).toBe(0);
      // without the out-of-band code the attacker cannot confirm someone else's inbox
      const guess = await call(t, asUser(s.body), 'POST', '/v1/auth/email/verify/confirm', { code: '000000' });
      expect(guess.status).toBe(400);
      expect((await call(t, asUser(s.body), 'GET', '/v1/me')).body.user.emailVerified).toBe(false);
    } finally {
      t.app.ctx.adapters.set('identity.codeSender', capture);
    }
  });

  it('default sender delivers through the EMAIL provider directly (not via notifications) and the code works', async () => {
    const sent: OutboundMessage[] = [];
    const reg = getRegistry(t.app.ctx);
    const previous = reg.get('EMAIL')!;
    reg.register('EMAIL', { name: 'email:test', send: async (m: OutboundMessage) => (sent.push(m), { providerRef: 'x' }) });
    t.app.ctx.adapters.delete('identity.codeSender');
    try {
      const u = await createUser(t, { email: 'mailbox.owner@example.com' });
      expect((await call(t, null, 'POST', '/v1/auth/otp/request', { email: u.email })).status).toBe(202);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ channel: 'EMAIL', templateKey: 'auth.email_otp', category: 'SECURITY', to: { email: u.email, userId: u.id } });
      const code = /^(\d{6}) /.exec(sent[0].body)![1];
      const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND body LIKE '%' || $2 || '%'`, [u.id, code]);
      expect(rows[0].n).toBe(0);
      const ok = await call(t, null, 'POST', '/v1/auth/otp/verify', { email: u.email, code });
      expect(ok.status).toBe(200);
      // a provider outage does not change the anti-enumeration answer
      reg.register('EMAIL', { name: 'email:down', send: async () => { throw new Error('smtp 421'); } });
      expect((await call(t, null, 'POST', '/v1/auth/otp/request', { email: u.email })).status).toBe(202);
    } finally {
      reg.register('EMAIL', previous);
      t.app.ctx.adapters.set('identity.codeSender', capture);
    }
  });

  it('production without an out-of-band email provider fails closed, independent of account existence', async () => {
    const fakeCtx: any = { app: { config: { NODE_ENV: 'production' }, adapters: new Map(), log: { info: () => {}, warn: () => {} } }, actor: null, correlationId: 'x' };
    await expect(defaultCodeSender(null as any, fakeCtx, { userId: null, email: 'a@b.c', purpose: 'EMAIL_OTP', code: '123456', expiresAt: new Date() })).rejects.toMatchObject({
      status: 503,
      code: 'CODE_DELIVERY_UNAVAILABLE',
    });
    await createUser(t, { email: 'prod.user@example.com' });
    const cfg = t.app.ctx.config as any;
    t.app.ctx.adapters.delete('identity.codeSender');
    cfg.NODE_ENV = 'production';
    try {
      const known = await call(t, null, 'POST', '/v1/auth/otp/request', { email: 'prod.user@example.com' });
      const unknown = await call(t, null, 'POST', '/v1/auth/otp/request', { email: 'nobody.at.all@example.com' });
      expect(known.status).toBe(503);
      expect(unknown.status).toBe(503);
      expect(known.body.code).toBe('CODE_DELIVERY_UNAVAILABLE');
      expect((await signup('prod.new@example.com')).body.code).toBe('CODE_DELIVERY_UNAVAILABLE');
    } finally {
      cfg.NODE_ENV = 'test';
      t.app.ctx.adapters.set('identity.codeSender', capture);
    }
  });

  it('migration 0950 purges stored code notifications and their deliveries', async () => {
    const u = await createUser(t);
    const { rows } = await t.pool.query(
      `INSERT INTO notifications(user_id, template_key, category, title, body) VALUES ($1,'auth.email_otp','SECURITY','code','123456 (valid until x)'),
              ($1,'auth.password_changed','SECURITY','changed','Your password was changed') RETURNING id, template_key`,
      [u.id],
    );
    const otpId = rows.find((r) => r.template_key === 'auth.email_otp').id;
    await t.pool.query(`INSERT INTO notification_deliveries(notification_id, channel, provider, status) VALUES ($1,'EMAIL','log','SENT')`, [otpId]);
    const sql = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/db/migrations/0950_trust_r1_identity_privacy.sql'), 'utf8');
    await t.pool.query(sql);
    const left = await t.pool.query(`SELECT template_key FROM notifications WHERE user_id = $1`, [u.id]);
    expect(left.rows.map((r) => r.template_key)).toEqual(['auth.password_changed']);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM notification_deliveries WHERE notification_id = $1`, [otpId])).rows[0].n).toBe(0);
  });
});

describe('pre-account-takeover: unverified pre-registered credentials do not survive the real owner', () => {
  it('password squat: no credentials can be added before verification; OTP proof evicts the squatter (sessions + password)', async () => {
    const attacker = await signup('victim1@example.com', { password: 'Att4cker-pw-xyz' });
    expect(attacker.status).toBe(201);
    const atk = asUser(attacker.body);
    expect((await call(t, atk, 'POST', '/v1/auth/mfa/totp/enroll')).body.code).toBe('EMAIL_NOT_VERIFIED');
    expect((await call(t, atk, 'POST', '/v1/auth/oauth/google/link/start')).body.code).toBe('EMAIL_NOT_VERIFIED');

    // the real owner is told the email is taken and recovers it through the inbox
    expect((await signup('victim1@example.com')).body.code).toBe('EMAIL_TAKEN');
    await call(t, null, 'POST', '/v1/auth/otp/request', { email: 'victim1@example.com' });
    const owner = await call(t, null, 'POST', '/v1/auth/otp/verify', { email: 'victim1@example.com', code: lastCode('victim1@example.com', 'EMAIL_OTP') });
    expect(owner.status).toBe(200);
    expect(owner.body.user).toMatchObject({ id: attacker.body.user.id, emailVerified: true, hasPassword: false });

    expect((await call(t, atk, 'GET', '/v1/me')).status).toBe(401);
    expect((await call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: attacker.body.refreshToken })).status).toBe(401);
    expect((await call(t, null, 'POST', '/v1/auth/login', { email: 'victim1@example.com', password: 'Att4cker-pw-xyz' })).status).toBe(401);
    expect((await call(t, asUser(owner.body), 'GET', '/v1/me')).status).toBe(200);
    const { rows } = await t.pool.query(`SELECT action FROM audit_logs WHERE action = 'identity.unverified_credentials_removed' AND resource_id = $1`, [owner.body.user.id]);
    expect(rows).toHaveLength(1);
  });

  it('planted OAuth identity + TOTP (pre-existing data) are removed when the owner resets the password', async () => {
    const attacker = await signup('victim2@example.com', { password: 'Att4cker-pw-xyz' });
    const uid = attacker.body.user.id;
    // credentials planted while the address was unverified (e.g. before the verification gate existed)
    await t.pool.query(`INSERT INTO oauth_identities(user_id, provider, provider_subject, email) VALUES ($1,'google','atk-google-sub','attacker@gmail.example')`, [uid]);
    await t.pool.query(`INSERT INTO mfa_factors(user_id, factor_type, secret_encrypted, status, verified_at) VALUES ($1,'TOTP',$2,'VERIFIED', now())`, [
      uid,
      encrypt('JBSWY3DPEHPK3PXP', t.app.ctx.config.DATA_ENCRYPTION_KEY),
    ]);
    await call(t, null, 'POST', '/v1/auth/password/reset/request', { email: 'victim2@example.com' });
    const reset = await call(t, null, 'POST', '/v1/auth/password/reset/confirm', { email: 'victim2@example.com', token: lastCode('victim2@example.com', 'PASSWORD_RESET'), newPassword: 'V1ctim-owns-it' });
    expect(reset.status).toBe(204);
    const login = await call(t, null, 'POST', '/v1/auth/login', { email: 'victim2@example.com', password: 'V1ctim-owns-it' });
    expect(login.body.user).toMatchObject({ id: uid, emailVerified: true, linkedProviders: [], mfaEnabled: false });
    // the attacker's Google login no longer lands on the victim's account
    const viaGoogle = await oauth('google', 'mock:atk-google-sub:attacker@gmail.example');
    expect(viaGoogle.status).toBe(201);
    expect(viaGoogle.body.user.id).not.toBe(uid);
  });

  it('OAuth signup with an unverified provider email does not claim the address', async () => {
    const atk = await oauth('naver', 'mock:att-naver-1:victim3@example.com:unverified');
    expect(atk.status).toBe(201);
    expect(atk.body.user.email).toBeNull();
    expect(atk.body.user.emailVerified).toBe(false);
    const { rows } = await t.pool.query(`SELECT email FROM oauth_identities WHERE provider = 'naver' AND provider_subject = 'att-naver-1'`);
    expect(rows[0].email).toBe('victim3@example.com');
    // the real owner can sign up normally; the squatter's Naver login stays on the squatter's own account
    const victim = await signup('victim3@example.com');
    expect(victim.status).toBe(201);
    expect(victim.body.user.id).not.toBe(atk.body.user.id);
    const again = await oauth('naver', 'mock:att-naver-1:victim3@example.com:unverified', null, false);
    expect(again.status).toBe(200);
    expect(again.body.user.id).toBe(atk.body.user.id);
  });

  it('verified accounts keep their credentials on OTP login', async () => {
    const s = await signup('kept@example.com');
    await call(t, asUser(s.body), 'POST', '/v1/auth/email/verify/confirm', { code: lastCode('kept@example.com', 'EMAIL_VERIFY') });
    await call(t, null, 'POST', '/v1/auth/otp/request', { email: 'kept@example.com' });
    const otp = await call(t, null, 'POST', '/v1/auth/otp/verify', { email: 'kept@example.com', code: lastCode('kept@example.com', 'EMAIL_OTP') });
    expect(otp.body.user.hasPassword).toBe(true);
    expect((await call(t, asUser(s.body), 'GET', '/v1/me')).status).toBe(200);
    expect((await call(t, null, 'POST', '/v1/auth/login', { email: 'kept@example.com', password: 'Sup3r-secret-pw' })).status).toBe(200);
  });
});

describe('display names are never derived from the email address', () => {
  it('signup without displayName gets a neutral handle on public surfaces', async () => {
    const s = await signup('john.smith.1985@example.com');
    expect(s.body.user.displayName).toMatch(/^Traveler [0-9A-F]{4}$/);
    const pub = await call(t, null, 'GET', `/v1/users/${s.body.user.id}/profile`);
    expect(pub.status).toBe(200);
    expect(JSON.stringify(pub.body)).not.toContain('john.smith');
    expect((await signup('named@example.com', { displayName: 'Minji' })).body.user.displayName).toBe('Minji');
    const g = await oauth('google', 'mock:g-noname:jane.doe.77@example.com');
    expect(g.body.user.displayName).toMatch(/^Traveler [0-9A-F]{4}$/);
  });

  it('migration 0950 backfills names equal to the email local-part (users and host profiles)', async () => {
    const u = await createUser(t, { email: 'legacy.name@example.com' }); // helper derives the old default
    await t.pool.query(`INSERT INTO host_profiles(user_id, display_name, status) VALUES ($1,'legacy.name','APPLIED')`, [u.id]);
    const keep = await createUser(t, { email: 'chosen@example.com', displayName: 'Chosen Name' });
    const sql = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/db/migrations/0950_trust_r1_identity_privacy.sql'), 'utf8');
    await t.pool.query(sql);
    const { rows } = await t.pool.query(`SELECT u.display_name, h.display_name AS host_name FROM users u LEFT JOIN host_profiles h ON h.user_id = u.id WHERE u.id = $1`, [u.id]);
    expect(rows[0].display_name).toMatch(/^Traveler [0-9A-F]{4}$/);
    expect(rows[0].host_name).toBe(rows[0].display_name);
    expect((await t.pool.query(`SELECT display_name FROM users WHERE id = $1`, [keep.id])).rows[0].display_name).toBe('Chosen Name');
  });
});

describe('refresh token rotation under concurrency', () => {
  it('two tabs refreshing with the same token: one wins, the other gets 409, nothing is revoked', async () => {
    await createUser(t, { email: 'tabs@example.com' });
    const a = await call(t, null, 'POST', '/v1/auth/login', { email: 'tabs@example.com', password: 'Passw0rd!long' });
    const other = await call(t, null, 'POST', '/v1/auth/login', { email: 'tabs@example.com', password: 'Passw0rd!long' });
    const both = await Promise.all([0, 1].map(() => call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: a.body.refreshToken })));
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(both.find((r) => r.status === 409)!.body.code).toBe('REFRESH_TOKEN_SUPERSEDED');
    const winner = both.find((r) => r.status === 200)!.body;
    expect((await call(t, asUser(winner), 'GET', '/v1/me')).status).toBe(200);
    expect((await call(t, asUser(other.body), 'GET', '/v1/me')).status).toBe(200);
    const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'identity.session.compromised' AND aggregate_id = $1`, [a.body.user.id]);
    expect(rows[0].n).toBe(0);
    // a genuine replay outside the race window is still treated as theft
    await t.pool.query(`UPDATE session_refresh_history SET rotated_at = rotated_at - interval '1 minute' WHERE session_id = $1`, [a.body.sessionId]);
    const replay = await call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: a.body.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('REFRESH_TOKEN_REUSED');
    expect((await call(t, asUser(other.body), 'GET', '/v1/me')).status).toBe(401);
  });
});

describe('email OTP abuse', () => {
  it('concurrent OTP requests cannot exceed the hourly cap or leave several codes open', async () => {
    const u = await createUser(t, { email: 'burst@example.com' });
    const before = codes.length;
    const res = await Promise.all(Array.from({ length: 30 }, () => call(t, null, 'POST', '/v1/auth/otp/request', { email: u.email })));
    expect(res.every((r) => r.status === 202)).toBe(true);
    const { rows } = await t.pool.query(
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE consumed_at IS NULL)::int AS open FROM auth_challenges WHERE purpose = 'EMAIL_OTP' AND subject = $1`,
      [u.email],
    );
    expect(rows[0].n).toBe(5);
    expect(rows[0].open).toBe(1);
    expect(codes.length - before).toBe(5);
  });

  it('wrong OTP guesses count toward the per-account lockout across codes', async () => {
    const u = await createUser(t, { email: 'guess@example.com' });
    await call(t, null, 'POST', '/v1/auth/otp/request', { email: u.email });
    const c1 = lastCode(u.email, 'EMAIL_OTP')!;
    const wrong = (c: string) => (c === '000000' ? '111111' : '000000');
    for (let i = 0; i < 4; i++) expect((await call(t, null, 'POST', '/v1/auth/otp/verify', { email: u.email, code: wrong(c1) })).status).toBe(400);
    await call(t, null, 'POST', '/v1/auth/otp/request', { email: u.email });
    const c2 = lastCode(u.email, 'EMAIL_OTP')!;
    const fifth = await call(t, null, 'POST', '/v1/auth/otp/verify', { email: u.email, code: wrong(c2) });
    expect(fifth.status).toBe(429);
    expect(fifth.body.code).toBe('ACCOUNT_LOCKED');
    const right = await call(t, null, 'POST', '/v1/auth/otp/verify', { email: u.email, code: c2 });
    expect(right.body.code).toBe('ACCOUNT_LOCKED');
    const { rows } = await t.pool.query(`SELECT failed_login_attempts, locked_until FROM users WHERE id = $1`, [u.id]);
    expect(rows[0].failed_login_attempts).toBe(5);
    expect(rows[0].locked_until).toBeTruthy();
  });
});

describe('client IP is not client-controlled (trustProxy)', () => {
  it('rotating a spoofed left-most X-Forwarded-For does not reset auth rate limits; direct clients cannot pick their IP', async () => {
    expect(trustProxySetting('true')).toBe(true);
    expect(trustProxySetting('false')).toBe(false);
    expect((trustProxySetting('1') as (a: string, i: number) => boolean)('10.0.0.1', 0)).toBe(true);
    expect((trustProxySetting('1') as (a: string, i: number) => boolean)('10.0.0.1', 1)).toBe(false);
    const t2 = await createTestApp({ RATE_LIMIT_PER_MIN: 200 }); // authLimit = 10/min
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 14; i++) {
        const r = await t2.app.inject({
          method: 'POST',
          url: '/v1/auth/otp/verify',
          payload: { email: 'nobody@test.jetpool.kr', code: '123456' },
          // what a request looks like after a private-network proxy appended the real client address
          headers: { 'x-forwarded-for': `11.0.0.${i}, 203.0.113.7` },
        });
        statuses.push(r.statusCode);
      }
      expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(4);

      const u = await createUser(t2, { email: 'ip.owner@example.com' });
      const direct = await t2.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: u.email, password: u.password },
        headers: { 'x-forwarded-for': '1.2.3.4' },
        remoteAddress: '198.51.100.9',
      });
      expect(direct.statusCode).toBe(200);
      const { rows } = await t2.pool.query(`SELECT host(ip) AS ip FROM sessions WHERE id = $1`, [direct.json().sessionId]);
      expect(rows[0].ip).toBe('198.51.100.9');
      const { rows: a } = await t2.pool.query(`SELECT host(ip) AS ip FROM audit_logs WHERE action = 'auth.login' AND resource_id = $1`, [direct.json().sessionId]);
      expect(a[0].ip).toBe('198.51.100.9');
    } finally {
      await t2.close();
    }
  });
});
