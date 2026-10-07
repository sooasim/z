import type pg from 'pg';
import { createHash } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { notify } from '../../platform/notify.js';
import { signAccessToken } from '../../platform/auth.js';
import { decrypt, encrypt, hashPassword, randomDigits, randomToken, safeEqual, sha256, verifyPassword } from '../../platform/crypto.js';
import { AppError, badRequest, conflict, forbidden, notFound, unauthorized, unprocessable } from '../../platform/errors.js';
import { assertRequiredConsents, recordConsents, type ConsentInput } from '../privacy/service.js';
import { accountSummary, issueSession, revokeAllSessions, revokeSession, type AuthMethod, type IssuedSession } from './users.js';
import { oauthAdapter, oauthRedirectUri, type OAuthProvider } from './oauth.js';

// ---------------------------------------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------------------------------------
export const LOGIN_MAX_ATTEMPTS = 5; // failures before a lockout
export const LOCKOUT_BASE_SEC = 15 * 60; // first lockout; doubles for every further batch of failures (cap 24h)
export const LOCKOUT_MAX_SEC = 24 * 3600;
export const OTP_TTL_SEC = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_MAX_PER_HOUR = 5;
export const RESET_TTL_SEC = 30 * 60;
export const OAUTH_STATE_TTL_SEC = 10 * 60;
export const RECOVERY_CODE_COUNT = 10;
const TOTP_PERIOD = 30;

const ACCOUNT_LOCKED = (until: Date) =>
  new AppError(429, 'ACCOUNT_LOCKED', 'Too many failed attempts; try again later', { lockedUntil: until.toISOString() });
const INVALID_CREDENTIALS = () => new AppError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');

export function lockoutSeconds(failures: number): number | null {
  if (failures < LOGIN_MAX_ATTEMPTS || failures % LOGIN_MAX_ATTEMPTS !== 0) return null;
  const batch = failures / LOGIN_MAX_ATTEMPTS - 1;
  return Math.min(LOCKOUT_BASE_SEC * 2 ** batch, LOCKOUT_MAX_SEC);
}

export function validatePasswordPolicy(password: string, email?: string | null) {
  if (password.length < 10 || password.length > 128) throw badRequest('WEAK_PASSWORD', 'Password must be 10-128 characters');
  if (!/[A-Za-z]/.test(password) || !/[^A-Za-z]/.test(password)) throw badRequest('WEAK_PASSWORD', 'Password must contain letters and at least one digit or symbol');
  if (email && password.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length >= 4) {
    throw badRequest('WEAK_PASSWORD', 'Password must not contain your email name');
  }
}

const normEmail = (e: string) => e.trim().toLowerCase();

let dummyHash: Promise<string> | null = null;
/** Equalize timing for unknown accounts. */
const burnPasswordCheck = async (password: string) => {
  dummyHash ??= hashPassword('dummy-password-for-timing-0');
  await verifyPassword(password, await dummyHash);
};

// ---------------------------------------------------------------------------------------------------------
// Out-of-band code delivery. Codes are NEVER returned in API responses. Override with
// app.ctx.adapters.set('identity.codeSender', fn) (e.g. a Novu/SMTP adapter, or a capture in tests).
// ---------------------------------------------------------------------------------------------------------
export interface CodeMessage {
  userId: string | null;
  email: string;
  purpose: 'EMAIL_OTP' | 'PASSWORD_RESET' | 'EMAIL_VERIFY';
  code: string;
  expiresAt: Date;
}
export type CodeSender = (tx: Tx, ctx: Ctx, msg: CodeMessage) => Promise<void>;

const TEMPLATES: Record<CodeMessage['purpose'], { key: string; title: string }> = {
  EMAIL_OTP: { key: 'auth.email_otp', title: 'JETPOOL 로그인 코드' },
  PASSWORD_RESET: { key: 'auth.password_reset', title: 'JETPOOL 비밀번호 재설정' },
  EMAIL_VERIFY: { key: 'auth.email_verify', title: 'JETPOOL 이메일 인증' },
};

export const defaultCodeSender: CodeSender = async (tx, ctx, msg) => {
  if (ctx.app.config.NODE_ENV !== 'production') {
    // dev-only log line; production never logs the code.
    ctx.app.log.info({ devAuthCode: { purpose: msg.purpose, email: msg.email, value: msg.code } }, 'dev auth code issued');
  }
  if (msg.userId) {
    await notify(tx, ctx, {
      userId: msg.userId,
      templateKey: TEMPLATES[msg.purpose].key,
      category: 'SECURITY',
      title: TEMPLATES[msg.purpose].title,
      body: `${msg.code} (valid until ${msg.expiresAt.toISOString()})`,
      data: { purpose: msg.purpose, channel: 'EMAIL' },
    });
  }
};

async function sendCode(tx: Tx, ctx: Ctx, msg: CodeMessage) {
  const sender = (ctx.app.adapters.get('identity.codeSender') as CodeSender | undefined) ?? defaultCodeSender;
  await sender(tx, ctx, msg);
}

// ---------------------------------------------------------------------------------------------------------
// Challenges (auth_challenges)
// ---------------------------------------------------------------------------------------------------------
async function createChallenge(
  tx: Tx,
  c: { purpose: 'EMAIL_OTP' | 'PASSWORD_RESET' | 'EMAIL_VERIFY' | 'OAUTH_STATE' | 'ACCOUNT_LINK'; subject: string; secret: string; ttlSec: number; data?: unknown },
) {
  // invalidate earlier open challenges of the same purpose/subject (only the latest code works)
  await tx.query(
    `UPDATE auth_challenges SET consumed_at = now() WHERE purpose = $1 AND subject = $2 AND consumed_at IS NULL AND purpose <> 'OAUTH_STATE'`,
    [c.purpose, c.subject],
  );
  return one<{ id: string; expires_at: Date }>(
    tx,
    `INSERT INTO auth_challenges(purpose, subject, code_hash, data, expires_at) VALUES ($1,$2,$3,$4, now() + make_interval(secs => $5)) RETURNING id, expires_at`,
    [c.purpose, c.subject, sha256(c.secret), JSON.stringify(c.data ?? {}), c.ttlSec],
  );
}

type ChallengeResult = { ok: true; row: any } | { ok: false; code: 'CODE_INVALID' | 'CODE_EXPIRED' | 'TOO_MANY_ATTEMPTS' };

/** Verify the latest open challenge; failed attempts are counted and committed by the caller's tx. */
async function checkChallenge(tx: Tx, purpose: string, subject: string, secret: string, maxAttempts = OTP_MAX_ATTEMPTS): Promise<ChallengeResult> {
  const row = await maybeOne(
    tx,
    `SELECT * FROM auth_challenges WHERE purpose = $1 AND subject = $2 AND consumed_at IS NULL ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [purpose, subject],
  );
  if (!row) return { ok: false, code: 'CODE_INVALID' };
  if (new Date(row.expires_at) <= new Date()) return { ok: false, code: 'CODE_EXPIRED' };
  if (!safeEqual(row.code_hash, sha256(secret))) {
    const attempts = row.attempts + 1;
    await tx.query(`UPDATE auth_challenges SET attempts = $2, consumed_at = CASE WHEN $2::int >= $3::int THEN now() END WHERE id = $1`, [row.id, attempts, maxAttempts]);
    return { ok: false, code: attempts >= maxAttempts ? 'TOO_MANY_ATTEMPTS' : 'CODE_INVALID' };
  }
  await tx.query(`UPDATE auth_challenges SET consumed_at = now() WHERE id = $1`, [row.id]);
  return { ok: true, row };
}

function challengeError(code: 'CODE_INVALID' | 'CODE_EXPIRED' | 'TOO_MANY_ATTEMPTS') {
  if (code === 'TOO_MANY_ATTEMPTS') return new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many attempts; request a new code');
  if (code === 'CODE_EXPIRED') return badRequest('CODE_EXPIRED', 'The code has expired; request a new one');
  return badRequest('CODE_INVALID', 'The code is invalid');
}

async function recentChallengeCount(db: Db, purpose: string, subject: string) {
  const r = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM auth_challenges WHERE purpose = $1 AND subject = $2 AND created_at > now() - interval '1 hour'`, [purpose, subject]);
  return r.n;
}

// ---------------------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------------------
export interface AuthResult extends IssuedSession {
  user: Awaited<ReturnType<typeof accountSummary>>;
}

async function withUser(db: Db, s: IssuedSession): Promise<AuthResult> {
  // read through the same tx so the freshly created account is visible
  return { ...s, user: await accountSummary(db, (await one<{ user_id: string }>(db, `SELECT user_id FROM sessions WHERE id = $1`, [s.sessionId])).user_id) };
}

async function createAccount(
  tx: Tx,
  ctx: Ctx,
  a: { email: string | null; passwordHash: string | null; displayName?: string | null; locale?: string; emailVerified: boolean; consents: ConsentInput[]; method: string },
) {
  if (a.email) {
    const exists = await maybeOne(tx, `SELECT 1 FROM users WHERE email = $1`, [a.email]);
    if (exists) throw conflict('EMAIL_TAKEN', 'An account with this email already exists');
  }
  const u = await one<{ id: string }>(
    tx,
    `INSERT INTO users(email, password_hash, display_name, locale, email_verified_at, password_changed_at)
     VALUES ($1,$2,$3,$4, CASE WHEN $5 THEN now() END, CASE WHEN $2::text IS NOT NULL THEN now() END) RETURNING id`,
    [a.email, a.passwordHash, a.displayName ?? (a.email ? a.email.split('@')[0] : null), a.locale ?? 'ko-KR', a.emailVerified],
  );
  await tx.query(`INSERT INTO user_profiles(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [u.id]);
  await tx.query(`INSERT INTO user_preferences(user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [u.id]);
  await recordConsents(tx, { ...ctx, actor: null }, u.id, a.consents, `SIGNUP_${a.method}`);
  await emit(tx, ctx, { aggregateType: 'user', aggregateId: u.id, eventType: 'identity.user.created', payload: { userId: u.id, method: a.method, locale: a.locale ?? 'ko-KR' } });
  await audit(tx, ctx, { action: 'identity.user.created', resourceType: 'user', resourceId: u.id, after: { method: a.method }, category: 'SECURITY', actorId: u.id });
  return u.id;
}

export async function signup(
  pool: pg.Pool,
  ctx: Ctx,
  input: { email: string; password: string; displayName?: string; locale?: string; consents: ConsentInput[] },
): Promise<AuthResult> {
  const email = normEmail(input.email);
  validatePasswordPolicy(input.password, email);
  await assertRequiredConsents(pool, ctx, input.consents);
  const passwordHash = await hashPassword(input.password);
  return withTx(pool, async (tx) => {
    const userId = await createAccount(tx, ctx, { email, passwordHash, displayName: input.displayName, locale: input.locale, emailVerified: false, consents: input.consents, method: 'PASSWORD' });
    await requestEmailVerificationTx(tx, ctx, userId, email);
    const s = await issueSession(tx, ctx, { userId, authMethod: 'PASSWORD' });
    return withUser(tx, s);
  });
}

export async function passwordLogin(pool: pg.Pool, ctx: Ctx, input: { email: string; password: string }): Promise<AuthResult> {
  const email = normEmail(input.email);
  const r = await withTx(pool, async (tx) => {
    const u = await maybeOne(tx, `SELECT id, password_hash, status, failed_login_attempts, locked_until FROM users WHERE email = $1 FOR UPDATE`, [email]);
    if (!u || !u.password_hash) {
      await burnPasswordCheck(input.password);
      return { err: INVALID_CREDENTIALS() };
    }
    if (u.locked_until && new Date(u.locked_until) > new Date()) return { err: ACCOUNT_LOCKED(new Date(u.locked_until)) };
    const ok = await verifyPassword(input.password, u.password_hash);
    if (!ok) {
      const failures = u.failed_login_attempts + 1;
      const lockSec = lockoutSeconds(failures);
      const upd = await one(
        tx,
        `UPDATE users SET failed_login_attempts = $2, locked_until = CASE WHEN $3::int IS NULL THEN locked_until ELSE now() + make_interval(secs => $3::int) END
          WHERE id = $1 RETURNING locked_until`,
        [u.id, failures, lockSec],
      );
      await audit(tx, ctx, { action: 'auth.login_failed', resourceType: 'user', resourceId: u.id, after: { failures, locked: lockSec !== null }, category: 'SECURITY', actorId: null });
      return { err: lockSec !== null ? ACCOUNT_LOCKED(new Date(upd.locked_until)) : INVALID_CREDENTIALS() };
    }
    if (u.status === 'SUSPENDED' || u.status === 'DELETED') return { err: forbidden('ACCOUNT_SUSPENDED', 'Account is not active') };
    await tx.query(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`, [u.id]);
    const s = await issueSession(tx, ctx, { userId: u.id, authMethod: 'PASSWORD' });
    await audit(tx, ctx, { action: 'auth.login', resourceType: 'session', resourceId: s.sessionId, after: { method: 'PASSWORD' }, category: 'SECURITY', actorId: u.id });
    return { ok: await withUser(tx, s) };
  });
  if ('err' in r) throw r.err;
  return r.ok!;
}

// ---- Email OTP --------------------------------------------------------------------------------------------
export async function requestEmailOtp(pool: pg.Pool, ctx: Ctx, rawEmail: string) {
  const email = normEmail(rawEmail);
  await withTx(pool, async (tx) => {
    const u = await maybeOne(tx, `SELECT id, status FROM users WHERE email = $1`, [email]);
    // Always answer 202 (no account enumeration); silently drop for unknown/inactive accounts or over rate.
    if (!u || u.status === 'SUSPENDED' || u.status === 'DELETED') return;
    if ((await recentChallengeCount(tx, 'EMAIL_OTP', email)) >= OTP_MAX_PER_HOUR) return;
    const code = randomDigits(6);
    const ch = await createChallenge(tx, { purpose: 'EMAIL_OTP', subject: email, secret: code, ttlSec: OTP_TTL_SEC, data: { userId: u.id } });
    await sendCode(tx, ctx, { userId: u.id, email, purpose: 'EMAIL_OTP', code, expiresAt: new Date(ch.expires_at) });
  });
}

export async function verifyEmailOtp(pool: pg.Pool, ctx: Ctx, input: { email: string; code: string }): Promise<AuthResult> {
  const email = normEmail(input.email);
  const r = await withTx(pool, async (tx) => {
    const u = await maybeOne(tx, `SELECT id, status, locked_until FROM users WHERE email = $1 FOR UPDATE`, [email]);
    if (u?.locked_until && new Date(u.locked_until) > new Date()) return { err: ACCOUNT_LOCKED(new Date(u.locked_until)) };
    const c = await checkChallenge(tx, 'EMAIL_OTP', email, input.code);
    if (!c.ok || !u) {
      if (u) await audit(tx, ctx, { action: 'auth.otp_failed', resourceType: 'user', resourceId: u.id, category: 'SECURITY', actorId: null });
      return { err: challengeError(c.ok ? 'CODE_INVALID' : c.code) };
    }
    if (u.status === 'SUSPENDED' || u.status === 'DELETED') return { err: forbidden('ACCOUNT_SUSPENDED', 'Account is not active') };
    // possession of the inbox proves the email address
    await tx.query(`UPDATE users SET email_verified_at = coalesce(email_verified_at, now()), failed_login_attempts = 0, locked_until = NULL WHERE id = $1`, [u.id]);
    const s = await issueSession(tx, ctx, { userId: u.id, authMethod: 'EMAIL_OTP' });
    await audit(tx, ctx, { action: 'auth.login', resourceType: 'session', resourceId: s.sessionId, after: { method: 'EMAIL_OTP' }, category: 'SECURITY', actorId: u.id });
    return { ok: await withUser(tx, s) };
  });
  if ('err' in r) throw r.err;
  return r.ok!;
}

// ---- Email verification -----------------------------------------------------------------------------------
async function requestEmailVerificationTx(tx: Tx, ctx: Ctx, userId: string, email: string) {
  const code = randomDigits(6);
  const ch = await createChallenge(tx, { purpose: 'EMAIL_VERIFY', subject: email, secret: code, ttlSec: 24 * 3600, data: { userId } });
  await sendCode(tx, ctx, { userId, email, purpose: 'EMAIL_VERIFY', code, expiresAt: new Date(ch.expires_at) });
}

export async function requestEmailVerification(pool: pg.Pool, ctx: Ctx, userId: string) {
  await withTx(pool, async (tx) => {
    const u = await one(tx, `SELECT email, email_verified_at FROM users WHERE id = $1`, [userId]);
    if (!u.email) throw unprocessable('NO_EMAIL', 'The account has no email address');
    if (u.email_verified_at) throw conflict('ALREADY_VERIFIED', 'Email is already verified');
    if ((await recentChallengeCount(tx, 'EMAIL_VERIFY', normEmail(u.email))) >= OTP_MAX_PER_HOUR) throw new AppError(429, 'RATE_LIMITED', 'Too many codes requested');
    await requestEmailVerificationTx(tx, ctx, userId, normEmail(u.email));
  });
}

export async function confirmEmailVerification(pool: pg.Pool, ctx: Ctx, userId: string, code: string) {
  const r = await withTx(pool, async (tx) => {
    const u = await one(tx, `SELECT email FROM users WHERE id = $1`, [userId]);
    if (!u.email) return { err: unprocessable('NO_EMAIL', 'The account has no email address') };
    const c = await checkChallenge(tx, 'EMAIL_VERIFY', normEmail(u.email), code);
    if (!c.ok) return { err: challengeError(c.code) };
    if (c.row.data?.userId && c.row.data.userId !== userId) return { err: challengeError('CODE_INVALID') };
    await tx.query(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [userId]);
    await audit(tx, ctx, { action: 'identity.email_verified', resourceType: 'user', resourceId: userId, category: 'SECURITY' });
    return { ok: true };
  });
  if ('err' in r) throw r.err;
}

// ---- Password reset / change -------------------------------------------------------------------------------
export async function requestPasswordReset(pool: pg.Pool, ctx: Ctx, rawEmail: string) {
  const email = normEmail(rawEmail);
  await withTx(pool, async (tx) => {
    const u = await maybeOne(tx, `SELECT id, status FROM users WHERE email = $1`, [email]);
    if (!u || u.status === 'DELETED') return;
    if ((await recentChallengeCount(tx, 'PASSWORD_RESET', email)) >= OTP_MAX_PER_HOUR) return;
    const token = randomToken(24);
    const ch = await createChallenge(tx, { purpose: 'PASSWORD_RESET', subject: email, secret: token, ttlSec: RESET_TTL_SEC, data: { userId: u.id } });
    await sendCode(tx, ctx, { userId: u.id, email, purpose: 'PASSWORD_RESET', code: token, expiresAt: new Date(ch.expires_at) });
    await audit(tx, ctx, { action: 'auth.password_reset_requested', resourceType: 'user', resourceId: u.id, category: 'SECURITY', actorId: null });
  });
}

export async function confirmPasswordReset(pool: pg.Pool, ctx: Ctx, input: { email: string; token: string; newPassword: string }) {
  const email = normEmail(input.email);
  validatePasswordPolicy(input.newPassword, email);
  const hash = await hashPassword(input.newPassword);
  const r = await withTx(pool, async (tx) => {
    const c = await checkChallenge(tx, 'PASSWORD_RESET', email, input.token, 3);
    if (!c.ok) return { err: challengeError(c.code) };
    const u = await maybeOne(tx, `SELECT id, status FROM users WHERE email = $1 FOR UPDATE`, [email]);
    if (!u || u.id !== c.row.data?.userId || u.status === 'DELETED') return { err: challengeError('CODE_INVALID') };
    await tx.query(
      `UPDATE users SET password_hash = $2, password_changed_at = now(), failed_login_attempts = 0, locked_until = NULL,
              email_verified_at = coalesce(email_verified_at, now()) WHERE id = $1`,
      [u.id, hash],
    );
    const revoked = await revokeAllSessions(tx, u.id, 'PASSWORD_RESET');
    await audit(tx, ctx, { action: 'auth.password_reset', resourceType: 'user', resourceId: u.id, after: { sessionsRevoked: revoked }, category: 'SECURITY', actorId: u.id });
    await notify(tx, ctx, { userId: u.id, templateKey: 'auth.password_changed', category: 'SECURITY', title: '비밀번호가 변경되었습니다', body: 'Your JETPOOL password was reset. If this was not you, contact support.' });
    return { ok: true };
  });
  if ('err' in r) throw r.err;
}

export async function changePassword(pool: pg.Pool, ctx: Ctx, input: { currentPassword?: string; newPassword: string }) {
  const actor = ctx.actor!;
  const r = await withTx(pool, async (tx) => {
    const u = await one(tx, `SELECT id, email, password_hash FROM users WHERE id = $1 FOR UPDATE`, [actor.userId]);
    if (u.password_hash) {
      if (!input.currentPassword || !(await verifyPassword(input.currentPassword, u.password_hash))) return { err: INVALID_CREDENTIALS() };
    } else if (actor.aal !== 'aal2' && (await maybeOne(tx, `SELECT 1 FROM mfa_factors WHERE user_id = $1 AND status = 'VERIFIED'`, [u.id]))) {
      return { err: forbidden('AAL2_REQUIRED', 'Multi-factor authentication is required for this action') };
    }
    validatePasswordPolicy(input.newPassword, u.email);
    await tx.query(`UPDATE users SET password_hash = $2, password_changed_at = now() WHERE id = $1`, [u.id, await hashPassword(input.newPassword)]);
    const revoked = await revokeAllSessions(tx, u.id, 'PASSWORD_CHANGED', actor.sessionId);
    await audit(tx, ctx, { action: 'auth.password_changed', resourceType: 'user', resourceId: u.id, after: { otherSessionsRevoked: revoked }, category: 'SECURITY' });
    await notify(tx, ctx, { userId: u.id, templateKey: 'auth.password_changed', category: 'SECURITY', title: '비밀번호가 변경되었습니다', body: 'Your JETPOOL password was changed.' });
    return { ok: true };
  });
  if ('err' in r) throw r.err;
}

// ---- Refresh-token rotation with reuse detection ---------------------------------------------------------
export async function refreshSession(pool: pg.Pool, ctx: Ctx, refreshToken: string) {
  const h = sha256(refreshToken);
  const r = await withTx(pool, async (tx) => {
    const s = await maybeOne(
      tx,
      `SELECT s.*, u.status AS user_status FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.refresh_token_hash = $1 FOR UPDATE OF s`,
      [h],
    );
    if (!s) {
      const hist = await maybeOne(tx, `SELECT h.session_id, s.user_id FROM session_refresh_history h JOIN sessions s ON s.id = h.session_id WHERE h.token_hash = $1`, [h]);
      if (hist) {
        // A superseded token was replayed: assume theft. Revoke the whole session family (all sessions of the user).
        const n = await revokeAllSessions(tx, hist.user_id, 'REFRESH_TOKEN_REUSE');
        await audit(tx, ctx, { action: 'auth.refresh_token_reuse', resourceType: 'session', resourceId: hist.session_id, after: { sessionsRevoked: n }, category: 'SECURITY', actorId: null });
        await emit(tx, ctx, { aggregateType: 'user', aggregateId: hist.user_id, eventType: 'identity.session.compromised', payload: { userId: hist.user_id, sessionId: hist.session_id } });
        await notify(tx, ctx, { userId: hist.user_id, templateKey: 'auth.session_compromised', category: 'SECURITY', title: '보안 경고: 모든 기기에서 로그아웃되었습니다', body: 'A refresh token was reused. All sessions were signed out.' });
        return { err: new AppError(401, 'REFRESH_TOKEN_REUSED', 'Refresh token reuse detected; all sessions were revoked') };
      }
      return { err: new AppError(401, 'REFRESH_TOKEN_INVALID', 'Refresh token is invalid') };
    }
    if (s.revoked_at || new Date(s.expires_at) <= new Date()) return { err: new AppError(401, 'REFRESH_TOKEN_INVALID', 'Session has ended') };
    if (s.user_status === 'SUSPENDED' || s.user_status === 'DELETED') return { err: forbidden('ACCOUNT_SUSPENDED', 'Account is not active') };
    const next = randomToken(32);
    await tx.query(`INSERT INTO session_refresh_history(token_hash, session_id) VALUES ($1,$2)`, [h, s.id]);
    await tx.query(
      `UPDATE sessions SET refresh_token_hash = $2, last_used_at = now(), rotation_counter = rotation_counter + 1, ip = coalesce($3::inet, ip) WHERE id = $1`,
      [s.id, sha256(next), ctx.ip ?? null],
    );
    const accessToken = await signAccessToken(ctx.app.config, { sub: s.user_id, sid: s.id, aal: s.aal });
    return {
      ok: {
        accessToken,
        refreshToken: next,
        tokenType: 'Bearer' as const,
        expiresIn: ctx.app.config.ACCESS_TOKEN_TTL_SEC,
        refreshExpiresAt: new Date(s.expires_at).toISOString(),
        sessionId: s.id as string,
        aal: s.aal as 'aal1' | 'aal2',
      },
    };
  });
  if ('err' in r) throw r.err;
  return r.ok!;
}

export async function logout(pool: pg.Pool, ctx: Ctx, all: boolean) {
  const actor = ctx.actor!;
  return withTx(pool, async (tx) => {
    const n = all ? await revokeAllSessions(tx, actor.userId, 'LOGOUT_ALL') : (await revokeSession(tx, actor.sessionId, 'LOGOUT'), 1);
    await audit(tx, ctx, { action: all ? 'auth.logout_all' : 'auth.logout', resourceType: 'session', resourceId: actor.sessionId, after: { revoked: n }, category: 'SECURITY' });
    return n;
  });
}

export async function listSessions(db: Db, actor: { userId: string; sessionId: string }) {
  const rows = await q(
    db,
    `SELECT id, aal, auth_method, user_agent, host(ip) AS ip, created_at, last_used_at, expires_at FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_used_at DESC`,
    [actor.userId],
  );
  return rows.map((r) => ({ ...r, current: r.id === actor.sessionId }));
}

export async function revokeOwnSession(pool: pg.Pool, ctx: Ctx, sessionId: string) {
  await withTx(pool, async (tx) => {
    const s = await maybeOne(tx, `SELECT id FROM sessions WHERE id = $1 AND user_id = $2`, [sessionId, ctx.actor!.userId]);
    if (!s) throw notFound('Session');
    await revokeSession(tx, sessionId, 'USER_REVOKED');
    await audit(tx, ctx, { action: 'auth.session_revoked', resourceType: 'session', resourceId: sessionId, category: 'SECURITY' });
  });
}

// ---------------------------------------------------------------------------------------------------------
// TOTP MFA
// ---------------------------------------------------------------------------------------------------------
const totpFor = (secretB32: string, label: string) =>
  new TOTP({ issuer: 'JETPOOL', label, algorithm: 'SHA1', digits: 6, period: TOTP_PERIOD, secret: Secret.fromBase32(secretB32) });

const normRecovery = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, '');
const hashRecovery = (c: string) => sha256(`jetpool-recovery:${normRecovery(c)}`);

function newRecoveryCodes(): { plain: string[]; hashes: string[] } {
  const plain = Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = createHash('sha256').update(randomToken(16)).digest('hex').slice(0, 10);
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  return { plain, hashes: plain.map(hashRecovery) };
}

export async function enrollTotp(pool: pg.Pool, ctx: Ctx) {
  const actor = ctx.actor!;
  return withTx(pool, async (tx) => {
    const u = await one(tx, `SELECT email, display_name FROM users WHERE id = $1`, [actor.userId]);
    if (await maybeOne(tx, `SELECT 1 FROM mfa_factors WHERE user_id = $1 AND status = 'VERIFIED'`, [actor.userId])) {
      throw conflict('MFA_ALREADY_ENROLLED', 'A verified authenticator already exists; disable it first');
    }
    await tx.query(`DELETE FROM mfa_factors WHERE user_id = $1 AND status = 'UNVERIFIED'`, [actor.userId]);
    const secret = new Secret({ size: 20 });
    const label = u.email ?? u.display_name ?? actor.userId;
    const totp = totpFor(secret.base32, label);
    const f = await one(
      tx,
      `INSERT INTO mfa_factors(user_id, factor_type, secret_encrypted, status) VALUES ($1,'TOTP',$2,'UNVERIFIED') RETURNING id, created_at`,
      [actor.userId, encrypt(secret.base32, ctx.app.config.DATA_ENCRYPTION_KEY)],
    );
    await audit(tx, ctx, { action: 'mfa.enroll_started', resourceType: 'mfa_factor', resourceId: f.id, category: 'SECURITY' });
    // The secret is shown exactly once, to the authenticated owner, for authenticator setup.
    return { factorId: f.id as string, secret: secret.base32, otpauthUrl: totp.toString(), period: TOTP_PERIOD, digits: 6 };
  });
}

type MfaCheck = { ok: true; factor: any; via: 'TOTP' | 'RECOVERY_CODE' } | { ok: false; err: AppError };

/** Validate a TOTP code or recovery code against a factor, with replay protection and per-account lockout. */
async function checkMfa(tx: Tx, ctx: Ctx, userId: string, factor: any, input: { code?: string; recoveryCode?: string }): Promise<MfaCheck> {
  const u = await one(tx, `SELECT email, failed_mfa_attempts, mfa_locked_until FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (u.mfa_locked_until && new Date(u.mfa_locked_until) > new Date()) return { ok: false, err: ACCOUNT_LOCKED(new Date(u.mfa_locked_until)) };
  let ok = false;
  let via: 'TOTP' | 'RECOVERY_CODE' = 'TOTP';
  if (input.code) {
    const secret = decrypt(factor.secret_encrypted, ctx.app.config.DATA_ENCRYPTION_KEY);
    const delta = totpFor(secret, u.email ?? userId).validate({ token: input.code.replace(/\s/g, ''), window: 1 });
    if (delta !== null) {
      const counter = Math.floor(Date.now() / 1000 / TOTP_PERIOD) + delta;
      if (factor.last_used_counter == null || counter > Number(factor.last_used_counter)) {
        await tx.query(`UPDATE mfa_factors SET last_used_counter = $2 WHERE id = $1`, [factor.id, counter]);
        ok = true;
      }
    }
  } else if (input.recoveryCode && factor.status === 'VERIFIED') {
    via = 'RECOVERY_CODE';
    const h = hashRecovery(input.recoveryCode);
    const upd = await tx.query(
      `UPDATE mfa_factors SET recovery_codes_hash = array_remove(recovery_codes_hash, $2) WHERE id = $1 AND $2 = ANY(recovery_codes_hash)`,
      [factor.id, h],
    );
    ok = upd.rowCount === 1;
  }
  if (!ok) {
    const failures = u.failed_mfa_attempts + 1;
    const lockSec = lockoutSeconds(failures);
    const upd = await one(
      tx,
      `UPDATE users SET failed_mfa_attempts = $2, mfa_locked_until = CASE WHEN $3::int IS NULL THEN mfa_locked_until ELSE now() + make_interval(secs => $3::int) END WHERE id = $1 RETURNING mfa_locked_until`,
      [userId, failures, lockSec],
    );
    await audit(tx, ctx, { action: 'mfa.verify_failed', resourceType: 'mfa_factor', resourceId: factor.id, after: { failures }, category: 'SECURITY' });
    return { ok: false, err: lockSec !== null ? ACCOUNT_LOCKED(new Date(upd.mfa_locked_until)) : badRequest('MFA_CODE_INVALID', 'The authentication code is invalid') };
  }
  await tx.query(`UPDATE users SET failed_mfa_attempts = 0, mfa_locked_until = NULL WHERE id = $1`, [userId]);
  return { ok: true, factor, via };
}

async function elevateSession(tx: Tx, ctx: Ctx) {
  const actor = ctx.actor!;
  await tx.query(`UPDATE sessions SET aal = 'aal2', aal2_at = now() WHERE id = $1`, [actor.sessionId]);
  return signAccessToken(ctx.app.config, { sub: actor.userId, sid: actor.sessionId, aal: 'aal2' });
}

export async function verifyTotpEnrollment(pool: pg.Pool, ctx: Ctx, input: { factorId: string; code: string }) {
  const actor = ctx.actor!;
  const r = await withTx(pool, async (tx) => {
    const f = await maybeOne(tx, `SELECT * FROM mfa_factors WHERE id = $1 AND user_id = $2 FOR UPDATE`, [input.factorId, actor.userId]);
    if (!f) return { err: notFound('MFA factor') };
    if (f.status !== 'UNVERIFIED') return { err: conflict('MFA_FACTOR_NOT_PENDING', 'This factor is not awaiting verification') };
    const c = await checkMfa(tx, ctx, actor.userId, f, { code: input.code });
    if (!c.ok) return { err: c.err };
    const codes = newRecoveryCodes();
    await tx.query(`UPDATE mfa_factors SET status = 'VERIFIED', verified_at = now(), recovery_codes_hash = $2 WHERE id = $1`, [f.id, codes.hashes]);
    const accessToken = await elevateSession(tx, ctx);
    await emit(tx, ctx, { aggregateType: 'user', aggregateId: actor.userId, eventType: 'identity.mfa.changed', payload: { userId: actor.userId, factorId: f.id, factorType: 'TOTP', change: 'ENROLLED' } });
    await audit(tx, ctx, { action: 'mfa.enrolled', resourceType: 'mfa_factor', resourceId: f.id, category: 'SECURITY' });
    await notify(tx, ctx, { userId: actor.userId, templateKey: 'auth.mfa_enabled', category: 'SECURITY', title: '2단계 인증이 활성화되었습니다', body: 'Two-factor authentication was enabled on your account.' });
    return { ok: { factorId: f.id as string, recoveryCodes: codes.plain, accessToken, aal: 'aal2' as const } };
  });
  if ('err' in r) throw r.err;
  return r.ok!;
}

/** Step-up: verify TOTP (or a single-use recovery code) and upgrade the current session to AAL2. */
export async function mfaChallenge(pool: pg.Pool, ctx: Ctx, input: { code?: string; recoveryCode?: string }) {
  const actor = ctx.actor!;
  if (!input.code && !input.recoveryCode) throw badRequest('MFA_CODE_REQUIRED', 'Provide code or recoveryCode');
  const r = await withTx(pool, async (tx) => {
    const f = await maybeOne(tx, `SELECT * FROM mfa_factors WHERE user_id = $1 AND status = 'VERIFIED' FOR UPDATE`, [actor.userId]);
    if (!f) return { err: conflict('MFA_NOT_ENROLLED', 'No verified authenticator; enroll first') };
    const c = await checkMfa(tx, ctx, actor.userId, f, input);
    if (!c.ok) return { err: c.err };
    const accessToken = await elevateSession(tx, ctx);
    const remaining = await one<{ n: number }>(tx, `SELECT coalesce(array_length(recovery_codes_hash, 1), 0) AS n FROM mfa_factors WHERE id = $1`, [f.id]);
    await audit(tx, ctx, { action: 'mfa.step_up', resourceType: 'session', resourceId: actor.sessionId, after: { via: c.via }, category: 'SECURITY' });
    if (c.via === 'RECOVERY_CODE') {
      await emit(tx, ctx, { aggregateType: 'user', aggregateId: actor.userId, eventType: 'identity.mfa.changed', payload: { userId: actor.userId, factorId: f.id, factorType: 'TOTP', change: 'RECOVERY_CODE_USED' } });
    }
    return { ok: { accessToken, aal: 'aal2' as const, sessionId: actor.sessionId, recoveryCodesRemaining: remaining.n } };
  });
  if ('err' in r) throw r.err;
  return r.ok!;
}

export async function disableTotp(pool: pg.Pool, ctx: Ctx, input: { code?: string; recoveryCode?: string }) {
  const actor = ctx.actor!;
  if (actor.aal !== 'aal2') throw forbidden('AAL2_REQUIRED', 'Multi-factor authentication is required for this action');
  const r = await withTx(pool, async (tx) => {
    const f = await maybeOne(tx, `SELECT * FROM mfa_factors WHERE user_id = $1 AND status = 'VERIFIED' FOR UPDATE`, [actor.userId]);
    if (!f) return { err: notFound('MFA factor') };
    const c = await checkMfa(tx, ctx, actor.userId, f, input);
    if (!c.ok) return { err: c.err };
    await tx.query(`UPDATE mfa_factors SET status = 'REVOKED', recovery_codes_hash = '{}' WHERE id = $1`, [f.id]);
    // no factor -> no session can claim AAL2 any more
    await tx.query(`UPDATE sessions SET aal = 'aal1' WHERE user_id = $1 AND revoked_at IS NULL`, [actor.userId]);
    await emit(tx, ctx, { aggregateType: 'user', aggregateId: actor.userId, eventType: 'identity.mfa.changed', payload: { userId: actor.userId, factorId: f.id, factorType: 'TOTP', change: 'DISABLED' } });
    await audit(tx, ctx, { action: 'mfa.disabled', resourceType: 'mfa_factor', resourceId: f.id, category: 'SECURITY' });
    await notify(tx, ctx, { userId: actor.userId, templateKey: 'auth.mfa_disabled', category: 'SECURITY', title: '2단계 인증이 해제되었습니다', body: 'Two-factor authentication was disabled on your account.' });
    return { ok: true };
  });
  if ('err' in r) throw r.err;
}

export async function regenerateRecoveryCodes(pool: pg.Pool, ctx: Ctx) {
  const actor = ctx.actor!;
  if (actor.aal !== 'aal2') throw forbidden('AAL2_REQUIRED', 'Multi-factor authentication is required for this action');
  return withTx(pool, async (tx) => {
    const f = await maybeOne(tx, `SELECT id FROM mfa_factors WHERE user_id = $1 AND status = 'VERIFIED' FOR UPDATE`, [actor.userId]);
    if (!f) throw notFound('MFA factor');
    const codes = newRecoveryCodes();
    await tx.query(`UPDATE mfa_factors SET recovery_codes_hash = $2 WHERE id = $1`, [f.id, codes.hashes]);
    await emit(tx, ctx, { aggregateType: 'user', aggregateId: actor.userId, eventType: 'identity.mfa.changed', payload: { userId: actor.userId, factorId: f.id, factorType: 'TOTP', change: 'RECOVERY_CODES_REGENERATED' } });
    await audit(tx, ctx, { action: 'mfa.recovery_codes_regenerated', resourceType: 'mfa_factor', resourceId: f.id, category: 'SECURITY' });
    return { recoveryCodes: codes.plain };
  });
}

export async function mfaStatus(db: Db, userId: string) {
  const f = await maybeOne(
    db,
    `SELECT id, factor_type, verified_at, coalesce(array_length(recovery_codes_hash, 1), 0) AS recovery_codes_remaining
       FROM mfa_factors WHERE user_id = $1 AND status = 'VERIFIED'`,
    [userId],
  );
  return f
    ? { enabled: true, factorId: f.id, factorType: f.factor_type, verifiedAt: f.verified_at, recoveryCodesRemaining: f.recovery_codes_remaining }
    : { enabled: false };
}

// ---------------------------------------------------------------------------------------------------------
// OAuth (authorization-code + PKCE; state stored hashed in auth_challenges)
// ---------------------------------------------------------------------------------------------------------
const b64url = (buf: Buffer) => buf.toString('base64url');

export async function startOAuth(
  pool: pg.Pool,
  ctx: Ctx,
  provider: OAuthProvider,
  input: { mode: 'login' | 'link'; consents?: ConsentInput[]; returnTo?: string },
) {
  if (input.mode === 'link' && !ctx.actor) throw unauthorized();
  const cfg = ctx.app.config;
  const adapter = oauthAdapter(cfg, provider, ctx.app.adapters);
  const state = randomToken(24);
  const codeVerifier = randomToken(48);
  const nonce = randomToken(16);
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());
  const redirectUri = oauthRedirectUri(cfg, provider);
  const authorizationUrl = adapter.authorizationUrl({ state, redirectUri, codeChallenge, nonce });
  await withTx(pool, (tx) =>
    createChallenge(tx, {
      purpose: 'OAUTH_STATE',
      subject: provider,
      secret: state,
      ttlSec: OAUTH_STATE_TTL_SEC,
      data: { provider, mode: input.mode, userId: ctx.actor?.userId ?? null, codeVerifier, nonce, consents: input.consents ?? null, returnTo: input.returnTo ?? null },
    }),
  );
  return { authorizationUrl, state, redirectUri, expiresIn: OAUTH_STATE_TTL_SEC };
}

export async function oauthCallback(
  pool: pg.Pool,
  ctx: Ctx,
  provider: OAuthProvider,
  input: { code: string; state: string; consents?: ConsentInput[] },
): Promise<{ status: number; body: any }> {
  // 1) consume the state (committed even if the provider exchange fails: states are single use)
  const st = await withTx(pool, async (tx) => {
    const row = await maybeOne(
      tx,
      `SELECT * FROM auth_challenges WHERE purpose = 'OAUTH_STATE' AND subject = $1 AND code_hash = $2 FOR UPDATE`,
      [provider, sha256(input.state)],
    );
    if (!row || row.consumed_at || new Date(row.expires_at) <= new Date()) return null;
    await tx.query(`UPDATE auth_challenges SET consumed_at = now() WHERE id = $1`, [row.id]);
    return row.data as { mode: 'login' | 'link'; userId: string | null; codeVerifier: string; consents: ConsentInput[] | null; returnTo: string | null };
  });
  if (!st) throw badRequest('OAUTH_STATE_INVALID', 'OAuth state is invalid or expired');
  if (st.mode === 'link' && (!ctx.actor || ctx.actor.userId !== st.userId)) {
    throw forbidden('OAUTH_LINK_SESSION_MISMATCH', 'Linking must be completed by the account that started it');
  }
  // 2) exchange the code with the provider (outside any DB transaction)
  const cfg = ctx.app.config;
  const profile = await oauthAdapter(cfg, provider, ctx.app.adapters).exchange({
    code: input.code,
    redirectUri: oauthRedirectUri(cfg, provider),
    codeVerifier: st.codeVerifier,
    state: input.state,
  });
  const email = profile.email ? normEmail(profile.email) : null;

  // 3) link or log in
  return withTx(pool, async (tx) => {
    const existing = await maybeOne(tx, `SELECT user_id FROM oauth_identities WHERE provider = $1 AND provider_subject = $2`, [provider, profile.subject]);
    if (st.mode === 'link') {
      const userId = st.userId!;
      if (existing && existing.user_id !== userId) throw conflict('OAUTH_IDENTITY_IN_USE', 'This social account is linked to another JETPOOL account');
      if (existing) return { status: 200, body: { linked: true, provider, alreadyLinked: true } };
      if (await maybeOne(tx, `SELECT 1 FROM oauth_identities WHERE user_id = $1 AND provider = $2`, [userId, provider])) {
        throw conflict('PROVIDER_ALREADY_LINKED', `A different ${provider} account is already linked; unlink it first`);
      }
      await tx.query(`INSERT INTO oauth_identities(user_id, provider, provider_subject, email) VALUES ($1,$2,$3,$4)`, [userId, provider, profile.subject, email]);
      await audit(tx, ctx, { action: 'identity.provider_linked', resourceType: 'user', resourceId: userId, after: { provider }, category: 'SECURITY' });
      await emit(tx, ctx, { aggregateType: 'user', aggregateId: userId, eventType: 'identity.provider.linked', payload: { userId, provider } });
      return { status: 200, body: { linked: true, provider, alreadyLinked: false } };
    }
    if (existing) {
      const u = await one(tx, `SELECT status FROM users WHERE id = $1`, [existing.user_id]);
      if (u.status === 'SUSPENDED' || u.status === 'DELETED') throw forbidden('ACCOUNT_SUSPENDED', 'Account is not active');
      const s = await issueSession(tx, ctx, { userId: existing.user_id, authMethod: 'OAUTH' });
      await audit(tx, ctx, { action: 'auth.login', resourceType: 'session', resourceId: s.sessionId, after: { method: 'OAUTH', provider }, category: 'SECURITY', actorId: existing.user_id });
      return { status: 200, body: { ...(await withUser(tx, s)), created: false, returnTo: st.returnTo } };
    }
    // Never auto-link to an existing account by email: the user must sign in and link explicitly (proof of ownership).
    if (email && (await maybeOne(tx, `SELECT 1 FROM users WHERE email = $1`, [email]))) {
      throw conflict('ACCOUNT_LINK_REQUIRED', 'An account with this email exists. Sign in with your existing method and link this provider from account settings.', { provider });
    }
    const consents = input.consents ?? st.consents ?? [];
    await assertRequiredConsents(tx, ctx, consents);
    const userId = await createAccount(tx, ctx, {
      email,
      passwordHash: null,
      displayName: profile.displayName ?? null,
      emailVerified: !!email && profile.emailVerified,
      consents,
      method: `OAUTH_${provider.toUpperCase()}`,
    });
    await tx.query(`INSERT INTO oauth_identities(user_id, provider, provider_subject, email) VALUES ($1,$2,$3,$4)`, [userId, provider, profile.subject, email]);
    const s = await issueSession(tx, ctx, { userId, authMethod: 'OAUTH' });
    return { status: 201, body: { ...(await withUser(tx, s)), created: true, returnTo: st.returnTo } };
  });
}

export async function listIdentities(db: Db, userId: string) {
  return q(db, `SELECT provider, email, linked_at FROM oauth_identities WHERE user_id = $1 ORDER BY provider`, [userId]);
}

export async function unlinkProvider(pool: pg.Pool, ctx: Ctx, provider: OAuthProvider) {
  const actor = ctx.actor!;
  await withTx(pool, async (tx) => {
    const u = await one(tx, `SELECT password_hash FROM users WHERE id = $1 FOR UPDATE`, [actor.userId]);
    const ids = await q<{ provider: string }>(tx, `SELECT provider FROM oauth_identities WHERE user_id = $1`, [actor.userId]);
    if (!ids.some((i) => i.provider === provider)) throw notFound('Linked provider');
    if (!u.password_hash && ids.length <= 1) throw conflict('LAST_LOGIN_METHOD', 'Set a password or link another provider before unlinking the last login method');
    await tx.query(`DELETE FROM oauth_identities WHERE user_id = $1 AND provider = $2`, [actor.userId, provider]);
    await audit(tx, ctx, { action: 'identity.provider_unlinked', resourceType: 'user', resourceId: actor.userId, after: { provider }, category: 'SECURITY' });
    await emit(tx, ctx, { aggregateType: 'user', aggregateId: actor.userId, eventType: 'identity.provider.unlinked', payload: { userId: actor.userId, provider } });
  });
}

export type { AuthMethod };
