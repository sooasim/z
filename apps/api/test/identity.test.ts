import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Secret, TOTP } from 'otpauth';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import type { CodeMessage } from '../src/modules/identity/service.js';

let t: TestApp;
const codes: CodeMessage[] = [];
const lastCode = (email: string, purpose: CodeMessage['purpose']) => [...codes].reverse().find((c) => c.email === email.toLowerCase() && c.purpose === purpose)?.code;
let docs: { TERMS: string; PRIVACY: string };

const consents = () => [
  { type: 'TERMS', version: docs.TERMS, granted: true },
  { type: 'PRIVACY', version: docs.PRIVACY, granted: true },
];
const asUser = (s: { accessToken: string }) => ({ headers: { authorization: `Bearer ${s.accessToken}` } }) as unknown as TestUser;
const totpNow = (secret: string, offsetSteps = 0) =>
  new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate({ timestamp: Date.now() + offsetSteps * 30_000 });

async function signup(email: string, password = 'Sup3r-secret-pw') {
  return call(t, null, 'POST', '/v1/auth/signup', { email, password, consents: consents() });
}

beforeAll(async () => {
  t = await createTestApp();
  t.app.ctx.adapters.set('identity.codeSender', async (_tx: unknown, _ctx: unknown, m: CodeMessage) => {
    codes.push(m);
  });
  const res = await call(t, null, 'GET', '/v1/consent-documents');
  const byType = Object.fromEntries(res.body.items.map((d: any) => [d.type, d.version]));
  docs = { TERMS: byType.TERMS, PRIVACY: byType.PRIVACY };
});
afterAll(async () => t.close());

describe('CORE-01 signup & login', () => {
  it('signs up with required consents, records evidence, emits identity.user.created', async () => {
    const res = await signup('Alice@Example.com');
    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.user.email).toBe('alice@example.com');
    expect(res.body.user.emailVerified).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('password');
    const uid = res.body.user.id;
    const { rows: c } = await t.pool.query(`SELECT consent_type, version, granted, evidence FROM consent_records WHERE user_id = $1 ORDER BY consent_type`, [uid]);
    expect(c.map((r) => r.consent_type)).toEqual(['PRIVACY', 'TERMS']);
    expect(c[0].evidence.version).toBe(docs.PRIVACY);
    const { rows: ev } = await t.pool.query(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1`, [uid]);
    expect(ev.map((e) => e.event_type)).toContain('identity.user.created');
    // verification code delivered out-of-band, never in the response
    const code = lastCode('alice@example.com', 'EMAIL_VERIFY');
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(res.body)).not.toContain(code);
    const me = await call(t, asUser(res.body), 'GET', '/v1/me');
    expect(me.status).toBe(200);
    expect(me.body.user.roles).toEqual(['USER']);
    expect(me.body.session.aal).toBe('aal1');
    // verify email
    const bad = await call(t, asUser(res.body), 'POST', '/v1/auth/email/verify/confirm', { code: code === '000000' ? '111111' : '000000' });
    expect(bad.status).toBe(400);
    const ok = await call(t, asUser(res.body), 'POST', '/v1/auth/email/verify/confirm', { code });
    expect(ok.status).toBe(200);
    expect((await call(t, asUser(res.body), 'GET', '/v1/me')).body.user.emailVerified).toBe(true);
  });

  it('rejects signup without required consents, wrong versions, weak passwords and duplicates', async () => {
    const noConsent = await call(t, null, 'POST', '/v1/auth/signup', { email: 'x1@example.com', password: 'Sup3r-secret-pw', consents: [{ type: 'TERMS', version: docs.TERMS, granted: true }] });
    expect(noConsent.status).toBe(422);
    expect(noConsent.body.code).toBe('CONSENT_REQUIRED');
    const wrongVer = await call(t, null, 'POST', '/v1/auth/signup', {
      email: 'x2@example.com',
      password: 'Sup3r-secret-pw',
      consents: [{ type: 'TERMS', version: 'old', granted: true }, { type: 'PRIVACY', version: docs.PRIVACY, granted: true }],
    });
    expect(wrongVer.status).toBe(422);
    const weak = await call(t, null, 'POST', '/v1/auth/signup', { email: 'x3@example.com', password: 'short', consents: consents() });
    expect(weak.body.code).toBe('WEAK_PASSWORD');
    const dup = await signup('alice@example.com');
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('EMAIL_TAKEN');
  });

  it('logs in with password; wrong password is 401; lockout after repeated failures', async () => {
    await signup('bob@example.com');
    const ok = await call(t, null, 'POST', '/v1/auth/login', { email: 'BOB@example.com', password: 'Sup3r-secret-pw' });
    expect(ok.status).toBe(200);
    expect(ok.body.user.email).toBe('bob@example.com');
    const unknown = await call(t, null, 'POST', '/v1/auth/login', { email: 'nobody@example.com', password: 'whatever-pw-1' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.code).toBe('INVALID_CREDENTIALS');
    for (let i = 0; i < 4; i++) {
      const r = await call(t, null, 'POST', '/v1/auth/login', { email: 'bob@example.com', password: 'wrong-password-1' });
      expect(r.status).toBe(401);
    }
    const fifth = await call(t, null, 'POST', '/v1/auth/login', { email: 'bob@example.com', password: 'wrong-password-1' });
    expect(fifth.status).toBe(429);
    expect(fifth.body.code).toBe('ACCOUNT_LOCKED');
    // even the right password is refused while locked
    const locked = await call(t, null, 'POST', '/v1/auth/login', { email: 'bob@example.com', password: 'Sup3r-secret-pw' });
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
    const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.login_failed' AND category = 'SECURITY'`);
    expect(rows[0].n).toBeGreaterThanOrEqual(5);
    // unlock (time passes)
    await t.pool.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE email = 'bob@example.com'`);
    const after = await call(t, null, 'POST', '/v1/auth/login', { email: 'bob@example.com', password: 'Sup3r-secret-pw' });
    expect(after.status).toBe(200);
  });

  it('suspended users cannot log in or use existing tokens', async () => {
    const s = await signup('suspended@example.com');
    await t.pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [s.body.user.id]);
    const login = await call(t, null, 'POST', '/v1/auth/login', { email: 'suspended@example.com', password: 'Sup3r-secret-pw' });
    expect(login.status).toBe(403);
    expect((await call(t, asUser(s.body), 'GET', '/v1/me')).status).toBe(403);
  });
});

describe('CORE-01 email OTP', () => {
  it('requests (202 always) and verifies an OTP; codes never appear in responses', async () => {
    await signup('otp@example.com');
    const unknown = await call(t, null, 'POST', '/v1/auth/otp/request', { email: 'ghost@example.com' });
    expect(unknown.status).toBe(202);
    const req = await call(t, null, 'POST', '/v1/auth/otp/request', { email: 'otp@example.com' });
    expect(req.status).toBe(202);
    expect(req.body).toEqual({ accepted: true });
    const code = lastCode('otp@example.com', 'EMAIL_OTP')!;
    expect(code).toMatch(/^\d{6}$/);
    const wrong = await call(t, null, 'POST', '/v1/auth/otp/verify', { email: 'otp@example.com', code: code === '123456' ? '654321' : '123456' });
    expect(wrong.status).toBe(400);
    const ok = await call(t, null, 'POST', '/v1/auth/otp/verify', { email: 'otp@example.com', code });
    expect(ok.status).toBe(200);
    expect(ok.body.user.emailVerified).toBe(true);
    // single use
    const replay = await call(t, null, 'POST', '/v1/auth/otp/verify', { email: 'otp@example.com', code });
    expect(replay.status).toBe(400);
  });

  it('invalidates an OTP after too many wrong attempts', async () => {
    await signup('otp2@example.com');
    await call(t, null, 'POST', '/v1/auth/otp/request', { email: 'otp2@example.com' });
    const code = lastCode('otp2@example.com', 'EMAIL_OTP')!;
    const wrong = code === '000000' ? '111111' : '000000';
    let last: any;
    for (let i = 0; i < 5; i++) last = await call(t, null, 'POST', '/v1/auth/otp/verify', { email: 'otp2@example.com', code: wrong });
    expect(last.body.code).toBe('TOO_MANY_ATTEMPTS');
    const right = await call(t, null, 'POST', '/v1/auth/otp/verify', { email: 'otp2@example.com', code });
    expect(right.status).toBe(400);
  });
});

describe('CORE-01 refresh rotation & logout', () => {
  it('rotates refresh tokens and detects reuse (revokes every session of the user)', async () => {
    const s = await signup('rot@example.com');
    const other = await call(t, null, 'POST', '/v1/auth/login', { email: 'rot@example.com', password: 'Sup3r-secret-pw' });
    const r1 = await call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: s.body.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(s.body.refreshToken);
    expect(r1.body.sessionId).toBe(s.body.sessionId);
    expect((await call(t, asUser(r1.body), 'GET', '/v1/me')).status).toBe(200);
    const r2 = await call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(200);
    // replay the first (rotated) token -> theft assumed
    const reuse = await call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: s.body.refreshToken });
    expect(reuse.status).toBe(401);
    expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');
    // the current token of the family and the other device are dead too
    expect((await call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: r2.body.refreshToken })).status).toBe(401);
    expect((await call(t, asUser(r2.body), 'GET', '/v1/me')).status).toBe(401);
    expect((await call(t, asUser(other.body), 'GET', '/v1/me')).status).toBe(401);
    const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'auth.refresh_token_reuse'`);
    expect(rows[0].n).toBe(1);
  });

  it('rejects garbage refresh tokens', async () => {
    const r = await call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: 'x'.repeat(43) });
    expect(r.status).toBe(401);
    expect(r.body.code).toBe('REFRESH_TOKEN_INVALID');
  });

  it('logout revokes the current session; logout-all revokes every session', async () => {
    const a = await signup('lo@example.com');
    const b = await call(t, null, 'POST', '/v1/auth/login', { email: 'lo@example.com', password: 'Sup3r-secret-pw' });
    const c = await call(t, null, 'POST', '/v1/auth/login', { email: 'lo@example.com', password: 'Sup3r-secret-pw' });
    const list = await call(t, asUser(b.body), 'GET', '/v1/auth/sessions');
    expect(list.body.items).toHaveLength(3);
    expect(list.body.items.filter((s: any) => s.current)).toHaveLength(1);
    expect((await call(t, asUser(a.body), 'POST', '/v1/auth/logout')).status).toBe(204);
    expect((await call(t, asUser(a.body), 'GET', '/v1/me')).status).toBe(401);
    expect((await call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: a.body.refreshToken })).status).toBe(401);
    expect((await call(t, asUser(b.body), 'GET', '/v1/me')).status).toBe(200);
    const all = await call(t, asUser(b.body), 'POST', '/v1/auth/logout-all');
    expect(all.body.revoked).toBe(2);
    expect((await call(t, asUser(c.body), 'GET', '/v1/me')).status).toBe(401);
  });

  it('cannot revoke another user\'s session', async () => {
    const a = await createUser(t);
    const b = await createUser(t);
    expect((await call(t, a, 'DELETE', `/v1/auth/sessions/${b.sessionId}`)).status).toBe(404);
    expect((await call(t, b, 'GET', '/v1/me')).status).toBe(200);
  });
});

describe('CORE-01 password reset & change', () => {
  it('resets password with an out-of-band token and revokes sessions', async () => {
    const s = await signup('reset@example.com');
    expect((await call(t, null, 'POST', '/v1/auth/password/reset/request', { email: 'reset@example.com' })).status).toBe(202);
    expect((await call(t, null, 'POST', '/v1/auth/password/reset/request', { email: 'ghost@example.com' })).status).toBe(202);
    const token = lastCode('reset@example.com', 'PASSWORD_RESET')!;
    expect(token.length).toBeGreaterThan(20);
    const bad = await call(t, null, 'POST', '/v1/auth/password/reset/confirm', { email: 'reset@example.com', token: 'not-the-token-123', newPassword: 'N3w-password-ok' });
    expect(bad.status).toBe(400);
    const ok = await call(t, null, 'POST', '/v1/auth/password/reset/confirm', { email: 'reset@example.com', token, newPassword: 'N3w-password-ok' });
    expect(ok.status).toBe(204);
    expect((await call(t, asUser(s.body), 'GET', '/v1/me')).status).toBe(401);
    expect((await call(t, null, 'POST', '/v1/auth/login', { email: 'reset@example.com', password: 'Sup3r-secret-pw' })).status).toBe(401);
    expect((await call(t, null, 'POST', '/v1/auth/login', { email: 'reset@example.com', password: 'N3w-password-ok' })).status).toBe(200);
    // token is single-use
    expect((await call(t, null, 'POST', '/v1/auth/password/reset/confirm', { email: 'reset@example.com', token, newPassword: 'An0ther-password' })).status).toBe(400);
  });

  it('changes password with the current password and keeps only the current session', async () => {
    const a = await signup('chg@example.com');
    const b = await call(t, null, 'POST', '/v1/auth/login', { email: 'chg@example.com', password: 'Sup3r-secret-pw' });
    expect((await call(t, asUser(a.body), 'POST', '/v1/auth/password/change', { currentPassword: 'wrong-pass-123', newPassword: 'Chang3d-password' })).status).toBe(401);
    expect((await call(t, asUser(a.body), 'POST', '/v1/auth/password/change', { currentPassword: 'Sup3r-secret-pw', newPassword: 'Chang3d-password' })).status).toBe(204);
    expect((await call(t, asUser(a.body), 'GET', '/v1/me')).status).toBe(200);
    expect((await call(t, asUser(b.body), 'GET', '/v1/me')).status).toBe(401);
  });
});

describe('CORE-01 TOTP MFA & step-up', () => {
  it('enrolls, verifies (AAL2 + recovery codes), steps up a new session, rejects replays, uses recovery codes', async () => {
    const s = await signup('mfa@example.com');
    const user = asUser(s.body);
    const enroll = await call(t, user, 'POST', '/v1/auth/mfa/totp/enroll');
    expect(enroll.status).toBe(201);
    expect(enroll.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\/JETPOOL/);
    const { rows: f } = await t.pool.query(`SELECT secret_encrypted, status FROM mfa_factors WHERE id = $1`, [enroll.body.factorId]);
    expect(f[0].status).toBe('UNVERIFIED');
    expect(f[0].secret_encrypted).not.toContain(enroll.body.secret); // encrypted at rest
    const wrong = await call(t, user, 'POST', '/v1/auth/mfa/totp/verify', { factorId: enroll.body.factorId, code: '000000' === totpNow(enroll.body.secret) ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    const code = totpNow(enroll.body.secret);
    const verify = await call(t, user, 'POST', '/v1/auth/mfa/totp/verify', { factorId: enroll.body.factorId, code });
    expect(verify.status).toBe(200);
    expect(verify.body.recoveryCodes).toHaveLength(10);
    expect(verify.body.aal).toBe('aal2');
    expect((await call(t, user, 'GET', '/v1/me')).body.session.aal).toBe('aal2');
    const { rows: ev } = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'identity.mfa.changed' AND aggregate_id = $1`, [s.body.user.id]);
    expect(ev[0].payload.change).toBe('ENROLLED');
    // second enroll refused
    expect((await call(t, user, 'POST', '/v1/auth/mfa/totp/enroll')).body.code).toBe('MFA_ALREADY_ENROLLED');

    // a new login is AAL1 until step-up
    const login = await call(t, null, 'POST', '/v1/auth/login', { email: 'mfa@example.com', password: 'Sup3r-secret-pw' });
    expect(login.body.aal).toBe('aal1');
    expect(login.body.user.mfaEnabled).toBe(true);
    const u2 = asUser(login.body);
    // the code already used for enrollment cannot be replayed
    const replay = await call(t, u2, 'POST', '/v1/auth/mfa/challenge', { code });
    expect(replay.status).toBe(400);
    const stepUp = await call(t, u2, 'POST', '/v1/auth/mfa/challenge', { code: totpNow(enroll.body.secret, 1) });
    expect(stepUp.status).toBe(200);
    expect(stepUp.body.aal).toBe('aal2');
    expect((await call(t, u2, 'GET', '/v1/me')).body.session.aal).toBe('aal2');

    // recovery code on a third session, single-use
    const login3 = await call(t, null, 'POST', '/v1/auth/login', { email: 'mfa@example.com', password: 'Sup3r-secret-pw' });
    const rc = verify.body.recoveryCodes[0];
    const viaRc = await call(t, asUser(login3.body), 'POST', '/v1/auth/mfa/challenge', { recoveryCode: rc.toUpperCase() });
    expect(viaRc.status).toBe(200);
    expect(viaRc.body.recoveryCodesRemaining).toBe(9);
    const login4 = await call(t, null, 'POST', '/v1/auth/login', { email: 'mfa@example.com', password: 'Sup3r-secret-pw' });
    expect((await call(t, asUser(login4.body), 'POST', '/v1/auth/mfa/challenge', { recoveryCode: rc })).status).toBe(400);

    // disabling requires AAL2
    expect((await call(t, asUser(login4.body), 'DELETE', '/v1/auth/mfa/totp', { recoveryCode: verify.body.recoveryCodes[1] })).body.code).toBe('AAL2_REQUIRED');
    const regen = await call(t, u2, 'POST', '/v1/auth/mfa/recovery-codes');
    expect(regen.body.recoveryCodes).toHaveLength(10);
    const dis = await call(t, u2, 'DELETE', '/v1/auth/mfa/totp', { recoveryCode: regen.body.recoveryCodes[0] });
    expect(dis.status).toBe(204);
    expect((await call(t, u2, 'GET', '/v1/me')).body.session.aal).toBe('aal1');
    expect((await call(t, u2, 'GET', '/v1/auth/mfa')).body.enabled).toBe(false);
  });

  it('step-up without enrollment is refused; repeated bad codes lock MFA', async () => {
    const s = await signup('mfa2@example.com');
    const user = asUser(s.body);
    expect((await call(t, user, 'POST', '/v1/auth/mfa/challenge', { code: '123456' })).body.code).toBe('MFA_NOT_ENROLLED');
    const enroll = await call(t, user, 'POST', '/v1/auth/mfa/totp/enroll');
    await call(t, user, 'POST', '/v1/auth/mfa/totp/verify', { factorId: enroll.body.factorId, code: totpNow(enroll.body.secret) });
    const login = await call(t, null, 'POST', '/v1/auth/login', { email: 'mfa2@example.com', password: 'Sup3r-secret-pw' });
    const valid = new Set([-1, 0, 1].map((o) => totpNow(enroll.body.secret, o)));
    const bad = ['000000', '111111', '222222', '333333'].find((c) => !valid.has(c))!;
    let last: any;
    for (let i = 0; i < 5; i++) last = await call(t, asUser(login.body), 'POST', '/v1/auth/mfa/challenge', { code: bad });
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('ACCOUNT_LOCKED');
    const good = await call(t, asUser(login.body), 'POST', '/v1/auth/mfa/challenge', { code: totpNow(enroll.body.secret, 1) });
    expect(good.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('staff with an AAL1 session get 403 AAL2_REQUIRED on admin routes until step-up', async () => {
    const admin = await createUser(t, { roles: ['ADMIN'], aal: 'aal1' });
    const res = await call(t, admin, 'GET', '/v1/admin/users');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('AAL2_REQUIRED');
    // enroll + step up on the same session
    const enroll = await call(t, admin, 'POST', '/v1/auth/mfa/totp/enroll');
    await call(t, admin, 'POST', '/v1/auth/mfa/totp/verify', { factorId: enroll.body.factorId, code: totpNow(enroll.body.secret) });
    expect((await call(t, admin, 'GET', '/v1/admin/users')).status).toBe(200);
  });
});

describe('CORE-01 OAuth', () => {
  async function oauthLogin(provider: string, code: string, extra: Record<string, unknown> = {}, user: TestUser | null = null) {
    const start = await call(t, user, 'POST', `/v1/auth/oauth/${provider}/start`, extra);
    expect(start.status).toBe(200);
    return call(t, user, 'POST', `/v1/auth/oauth/${provider}/callback`, { code, state: start.body.state });
  }

  it('signs up a new user via mock google, then logs the same identity in again', async () => {
    const first = await oauthLogin('google', 'mock:g-sub-1:gina@example.com', { consents: consents() });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    expect(first.body.user.emailVerified).toBe(true);
    expect(first.body.user.linkedProviders).toEqual(['google']);
    expect(first.body.user.hasPassword).toBe(false);
    const again = await oauthLogin('google', 'mock:g-sub-1:gina@example.com');
    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(again.body.user.id).toBe(first.body.user.id);
  });

  it('requires consents for a first-time OAuth signup', async () => {
    const r = await oauthLogin('kakao', 'mock:k-sub-9:kim@example.com');
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('CONSENT_REQUIRED');
  });

  it('rejects invalid, reused and cross-provider state', async () => {
    const bogus = await call(t, null, 'POST', '/v1/auth/oauth/google/callback', { code: 'mock:x:y@example.com', state: 'z'.repeat(32) });
    expect(bogus.body.code).toBe('OAUTH_STATE_INVALID');
    const start = await call(t, null, 'POST', '/v1/auth/oauth/naver/start', { consents: consents() });
    const wrongProvider = await call(t, null, 'POST', '/v1/auth/oauth/google/callback', { code: 'mock:n1:n1@example.com', state: start.body.state });
    expect(wrongProvider.body.code).toBe('OAUTH_STATE_INVALID');
    const ok = await call(t, null, 'POST', '/v1/auth/oauth/naver/callback', { code: 'mock:n1:n1@example.com', state: start.body.state });
    expect(ok.status).toBe(201);
    expect(ok.body.user.emailVerified).toBe(true);
    const reused = await call(t, null, 'POST', '/v1/auth/oauth/naver/callback', { code: 'mock:n1:n1@example.com', state: start.body.state });
    expect(reused.body.code).toBe('OAUTH_STATE_INVALID');
  });

  it('never auto-links to an existing email account; explicit linking works for the signed-in owner only', async () => {
    const s = await signup('linker@example.com');
    const auto = await oauthLogin('google', 'mock:g-link:linker@example.com', { consents: consents() });
    expect(auto.status).toBe(409);
    expect(auto.body.code).toBe('ACCOUNT_LINK_REQUIRED');
    const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM oauth_identities WHERE provider_subject = 'g-link'`);
    expect(rows[0].n).toBe(0);

    const owner = asUser(s.body);
    const linkStart = await call(t, owner, 'POST', '/v1/auth/oauth/google/link/start');
    expect(linkStart.status).toBe(200);
    // another user cannot complete my link flow
    const mallory = await createUser(t);
    const hijack = await call(t, mallory, 'POST', '/v1/auth/oauth/google/callback', { code: 'mock:g-link:linker@example.com', state: linkStart.body.state });
    expect(hijack.status).toBe(403);
    const linkStart2 = await call(t, owner, 'POST', '/v1/auth/oauth/google/link/start');
    const linked = await call(t, owner, 'POST', '/v1/auth/oauth/google/callback', { code: 'mock:g-link:linker@example.com', state: linkStart2.body.state });
    expect(linked.status).toBe(200);
    expect(linked.body.linked).toBe(true);
    // now OAuth login lands on the linked account
    const viaGoogle = await oauthLogin('google', 'mock:g-link:linker@example.com');
    expect(viaGoogle.status).toBe(200);
    expect(viaGoogle.body.user.id).toBe(s.body.user.id);
    // an identity linked to someone else cannot be linked again
    const ls = await call(t, mallory, 'POST', '/v1/auth/oauth/google/link/start');
    const taken = await call(t, mallory, 'POST', '/v1/auth/oauth/google/callback', { code: 'mock:g-link:linker@example.com', state: ls.body.state });
    expect(taken.body.code).toBe('OAUTH_IDENTITY_IN_USE');
    // unlink
    expect((await call(t, owner, 'GET', '/v1/me/identities')).body.items).toHaveLength(1);
    expect((await call(t, owner, 'DELETE', '/v1/me/identities/google')).status).toBe(204);
    expect((await call(t, owner, 'GET', '/v1/me/identities')).body.items).toHaveLength(0);
  });

  it('refuses to unlink the last login method of a password-less account', async () => {
    const r = await oauthLogin('kakao', 'mock:k-only:konly@example.com', { consents: consents() });
    const res = await call(t, asUser(r.body), 'DELETE', '/v1/me/identities/kakao');
    expect(res.body.code).toBe('LAST_LOGIN_METHOD');
  });

  it('link start requires authentication', async () => {
    expect((await call(t, null, 'POST', '/v1/auth/oauth/google/link/start')).status).toBe(401);
  });
});
