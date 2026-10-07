import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { StateMachine } from '../../platform/fsm.js';
import { signAccessToken } from '../../platform/auth.js';
import { randomToken, sha256 } from '../../platform/crypto.js';

/** CORE-01/03 account status lifecycle. SUSPENDED/DELETED accounts are rejected by resolveActor. */
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'DELETED' | 'PENDING_DELETION' | 'RESTRICTED';
export const userStatusMachine = new StateMachine<UserStatus>('user', {
  ACTIVE: ['SUSPENDED', 'RESTRICTED', 'PENDING_DELETION'],
  RESTRICTED: ['ACTIVE', 'SUSPENDED', 'PENDING_DELETION'],
  SUSPENDED: ['ACTIVE', 'RESTRICTED', 'PENDING_DELETION'],
  PENDING_DELETION: ['ACTIVE', 'DELETED', 'SUSPENDED'],
  DELETED: [],
});

export type AuthMethod = 'PASSWORD' | 'EMAIL_OTP' | 'OAUTH' | 'PASSWORD_RESET';

export interface IssuedSession {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresAt: string;
  sessionId: string;
  aal: 'aal1' | 'aal2';
}

/** Create a session (refresh token stored hashed) and sign an access token for it. */
export async function issueSession(
  tx: Tx,
  ctx: Ctx,
  args: { userId: string; aal?: 'aal1' | 'aal2'; authMethod: AuthMethod },
): Promise<IssuedSession> {
  const cfg = ctx.app.config;
  const refreshToken = randomToken(32);
  const aal = args.aal ?? 'aal1';
  const s = await one<{ id: string; expires_at: Date }>(
    tx,
    `INSERT INTO sessions(user_id, refresh_token_hash, aal, user_agent, ip, expires_at, auth_method, aal2_at)
     VALUES ($1,$2,$3,$4,$5, now() + make_interval(secs => $6), $7, CASE WHEN $3 = 'aal2' THEN now() END) RETURNING id, expires_at`,
    [args.userId, sha256(refreshToken), aal, ctx.userAgent?.slice(0, 500) ?? null, ctx.ip ?? null, cfg.REFRESH_TOKEN_TTL_SEC, args.authMethod],
  );
  await tx.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [args.userId]);
  const accessToken = await signAccessToken(cfg, { sub: args.userId, sid: s.id, aal });
  return {
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    expiresIn: cfg.ACCESS_TOKEN_TTL_SEC,
    refreshExpiresAt: new Date(s.expires_at).toISOString(),
    sessionId: s.id,
    aal,
  };
}

export async function revokeSession(db: Db, sessionId: string, reason: string) {
  await db.query(`UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL`, [sessionId, reason]);
}

/** Revoke every live session of a user (logout-all, password change, suspension, token reuse). Returns count. */
export async function revokeAllSessions(db: Db, userId: string, reason: string, exceptSessionId?: string): Promise<number> {
  const res = await db.query(
    `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
      WHERE user_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`,
    [userId, reason, exceptSessionId ?? null],
  );
  return res.rowCount ?? 0;
}

export async function userRoles(db: Db, userId: string): Promise<string[]> {
  const rows = await q<{ role: string }>(db, `SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role`, [userId]);
  return Array.from(new Set(['USER', ...rows.map((r) => r.role)]));
}

export async function hasVerifiedMfa(db: Db, userId: string): Promise<boolean> {
  return !!(await maybeOne(db, `SELECT 1 FROM mfa_factors WHERE user_id = $1 AND status = 'VERIFIED'`, [userId]));
}

/** Public-safe account summary for /v1/me and auth responses (never includes password hash or secrets). */
export async function accountSummary(db: Db, userId: string) {
  const u = await maybeOne(
    db,
    `SELECT u.id, u.email, u.phone, u.display_name, u.status, u.locale, u.email_verified_at, u.phone_verified_at,
            u.identity_verified_at, u.last_login_at, u.created_at, (u.password_hash IS NOT NULL) AS has_password
       FROM users u WHERE u.id = $1`,
    [userId],
  );
  if (!u) return null;
  const roles = await userRoles(db, userId);
  const providers = await q<{ provider: string }>(db, `SELECT provider FROM oauth_identities WHERE user_id = $1 ORDER BY provider`, [userId]);
  return {
    id: u.id,
    email: u.email,
    phone: u.phone,
    displayName: u.display_name,
    status: u.status,
    locale: u.locale,
    emailVerified: !!u.email_verified_at,
    phoneVerified: !!u.phone_verified_at,
    identityVerified: !!u.identity_verified_at,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
    hasPassword: u.has_password,
    mfaEnabled: await hasVerifiedMfa(db, userId),
    linkedProviders: providers.map((p) => p.provider),
    roles,
  };
}
