import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import type { Config } from './config.js';
import type { Db } from './db.js';
import { maybeOne } from './db.js';
import { forbidden, unauthorized } from './errors.js';

export const ROLES = ['USER', 'HOST', 'GUIDE', 'SUPPLIER', 'ADMIN', 'ACCOUNTING', 'SUPPORT', 'EDITOR', 'COMPLIANCE'] as const;
export type Role = (typeof ROLES)[number];
/** Staff roles must use AAL2 (MFA) sessions for any staff action (CORE-01 acceptance). */
export const STAFF_ROLES: Role[] = ['ADMIN', 'ACCOUNTING', 'SUPPORT', 'EDITOR', 'COMPLIANCE'];

export interface Actor {
  userId: string;
  sessionId: string;
  roles: Role[];
  aal: 'aal1' | 'aal2';
  status: string;
}

export async function signAccessToken(cfg: Config, claims: { sub: string; sid: string; aal: 'aal1' | 'aal2' }): Promise<string> {
  return new SignJWT({ sid: claims.sid, aal: claims.aal })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(cfg.JWT_ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${cfg.ACCESS_TOKEN_TTL_SEC}s`)
    .sign(new TextEncoder().encode(cfg.JWT_SECRET));
}

/**
 * Resolve the actor from a bearer token. Roles and session revocation are read from the DB on
 * every request so a revoked role or session takes effect immediately (CORE-03 acceptance).
 */
export async function resolveActor(cfg: Config, db: Db, authorization: string | undefined): Promise<Actor | null> {
  if (!authorization?.startsWith('Bearer ')) return null;
  let payload: any;
  try {
    ({ payload } = await jwtVerify(authorization.slice(7), new TextEncoder().encode(cfg.JWT_SECRET), { issuer: cfg.JWT_ISSUER }));
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
  const row = await maybeOne<{ status: string; roles: Role[]; aal: 'aal1' | 'aal2'; revoked: boolean }>(
    db,
    `SELECT u.status, s.aal, (s.revoked_at IS NOT NULL OR s.expires_at < now()) AS revoked,
            coalesce(array_agg(r.role) FILTER (WHERE r.role IS NOT NULL), '{}') AS roles
       FROM users u JOIN sessions s ON s.id = $2 AND s.user_id = u.id
       LEFT JOIN user_roles r ON r.user_id = u.id
      WHERE u.id = $1 GROUP BY u.status, s.aal, s.revoked_at, s.expires_at`,
    [payload.sub, payload.sid],
  );
  if (!row || row.revoked) throw unauthorized('Session is no longer valid');
  if (row.status === 'SUSPENDED' || row.status === 'DELETED') throw forbidden('ACCOUNT_SUSPENDED', 'Account is not active');
  const roles = Array.from(new Set<Role>(['USER', ...row.roles]));
  return { userId: payload.sub, sessionId: payload.sid, roles, aal: row.aal, status: row.status };
}

export function getActor(req: FastifyRequest): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}

export const hasRole = (actor: Actor | null | undefined, ...roles: Role[]) => !!actor && roles.some((r) => actor.roles.includes(r));
export const isStaff = (actor: Actor | null | undefined) => hasRole(actor, ...STAFF_ROLES);

/** preHandler: authenticated user required. */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply) {
  getActor(req);
}

/** preHandler factory: any of the roles; staff roles additionally require AAL2. */
export function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const actor = getActor(req);
    if (!hasRole(actor, ...roles)) throw forbidden('ROLE_REQUIRED', `Requires one of: ${roles.join(', ')}`);
    const staffOnly = roles.every((r) => STAFF_ROLES.includes(r));
    if (staffOnly && actor.aal !== 'aal2') throw forbidden('AAL2_REQUIRED', 'Multi-factor authentication is required for this action');
  };
}

export async function requireAal2(req: FastifyRequest, _reply: FastifyReply) {
  const actor = getActor(req);
  if (actor.aal !== 'aal2') throw forbidden('AAL2_REQUIRED', 'Multi-factor authentication is required for this action');
}
