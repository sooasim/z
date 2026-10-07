import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import type { Actor, Role } from '../../platform/auth.js';
import { ROLES, STAFF_ROLES } from '../../platform/auth.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { notify } from '../../platform/notify.js';
import { conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { decodeCursor, page } from '../../platform/http.js';
import { revokeAllSessions, userStatusMachine } from '../identity/users.js';
import { ACCOUNT_BLOCKING_SANCTIONS, activeSanctions, hasActiveSanction } from '../disputes/sanctions.js';

/**
 * Permission catalogue (CORE-03). '*' = everything, 'x.*' = every permission under x.
 * Permissions that come only from staff roles count only on AAL2 sessions.
 */
export const ROLE_PERMISSIONS: Record<Role, string[]> = {
  USER: ['reviews.write', 'disputes.open', 'support.open', 'verifications.submit', 'safety.report'],
  HOST: ['properties.manage', 'reviews.respond', 'host.dashboard'],
  GUIDE: ['guide.manage', 'reviews.respond'],
  SUPPLIER: ['travel.manage', 'reviews.respond'],
  ADMIN: ['*'],
  ACCOUNTING: ['finance.*', 'payouts.*', 'users.read'],
  SUPPORT: ['users.read', 'support.*', 'disputes.*', 'reviews.moderate', 'safety.*', 'elevated_access.request'],
  EDITOR: ['cms.*', 'reviews.moderate'],
  COMPLIANCE: ['users.read', 'verifications.*', 'compliance.*', 'hosts.review', 'disputes.read', 'sanctions.*', 'elevated_access.request'],
};

const matchPerm = (granted: string, wanted: string) =>
  granted === '*' || granted === wanted || (granted.endsWith('.*') && wanted.startsWith(granted.slice(0, -1)));

/**
 * Authorization decision: role permissions, then policy_overrides (DENY beats ALLOW; expired overrides ignored).
 * `actor` may be a request Actor or `{ userId, roles, aal? }`.
 */
export async function can(db: Db, actor: Pick<Actor, 'userId' | 'roles'> & { aal?: 'aal1' | 'aal2' } | null | undefined, permission: string): Promise<boolean> {
  if (!actor) return false;
  const overrides = await q<{ effect: 'ALLOW' | 'DENY'; permission: string }>(
    db,
    `SELECT effect, permission FROM policy_overrides WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`,
    [actor.userId],
  );
  const relevant = overrides.filter((o) => matchPerm(o.permission, permission));
  if (relevant.some((o) => o.effect === 'DENY')) return false;
  if (relevant.some((o) => o.effect === 'ALLOW')) return true;
  const roles = Array.from(new Set<Role>(['USER', ...actor.roles]));
  for (const role of roles) {
    if (!ROLE_PERMISSIONS[role]?.some((p) => matchPerm(p, permission))) continue;
    if (STAFF_ROLES.includes(role) && actor.aal && actor.aal !== 'aal2') continue;
    return true;
  }
  return false;
}

export async function assertCan(db: Db, actor: Parameters<typeof can>[1], permission: string) {
  if (!(await can(db, actor, permission))) throw forbidden('PERMISSION_DENIED', `Missing permission: ${permission}`);
}

export async function grantRole(tx: Tx, ctx: Ctx, args: { userId: string; role: Role; reason?: string | null; scope?: Record<string, unknown> }) {
  if (args.role === 'USER') throw unprocessable('ROLE_IMPLICIT', 'USER is implicit for every account');
  if (!ROLES.includes(args.role)) throw unprocessable('ROLE_UNKNOWN', `Unknown role ${args.role}`);
  const u = await maybeOne(tx, `SELECT id, status FROM users WHERE id = $1`, [args.userId]);
  if (!u) throw notFound('User');
  if (u.status === 'DELETED') throw conflict('USER_DELETED', 'Cannot grant roles to a deleted account');
  const ins = await tx.query(
    `INSERT INTO user_roles(user_id, role, scope, granted_by) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id, role) DO NOTHING`,
    [args.userId, args.role, JSON.stringify(args.scope ?? {}), ctx.actor?.userId ?? null],
  );
  if (ins.rowCount === 0) return { changed: false };
  await tx.query(`INSERT INTO role_grants(user_id, role, action, actor_id, reason) VALUES ($1,$2,'GRANT',$3,$4)`, [args.userId, args.role, ctx.actor?.userId ?? null, args.reason ?? null]);
  await audit(tx, ctx, { action: 'role.granted', resourceType: 'user', resourceId: args.userId, after: { role: args.role }, reason: args.reason ?? null, category: 'PERMISSION' });
  await emit(tx, ctx, { aggregateType: 'user', aggregateId: args.userId, eventType: 'role.granted', payload: { userId: args.userId, role: args.role, actorId: ctx.actor?.userId ?? null } });
  return { changed: true };
}

export async function revokeRole(tx: Tx, ctx: Ctx, args: { userId: string; role: Role; reason?: string | null }) {
  if (args.role === 'USER') throw unprocessable('ROLE_IMPLICIT', 'USER is implicit for every account');
  if (args.role === 'ADMIN') {
    if (ctx.actor?.userId === args.userId) throw conflict('SELF_REVOKE_FORBIDDEN', 'Admins cannot revoke their own ADMIN role');
    const n = await one<{ n: number }>(tx, `SELECT count(*)::int AS n FROM user_roles r JOIN users u ON u.id = r.user_id WHERE r.role = 'ADMIN' AND u.status = 'ACTIVE'`);
    if (n.n <= 1) throw conflict('LAST_ADMIN', 'Cannot revoke the last active administrator');
  }
  const del = await tx.query(`DELETE FROM user_roles WHERE user_id = $1 AND role = $2`, [args.userId, args.role]);
  if (del.rowCount === 0) return { changed: false };
  await tx.query(`INSERT INTO role_grants(user_id, role, action, actor_id, reason) VALUES ($1,$2,'REVOKE',$3,$4)`, [args.userId, args.role, ctx.actor?.userId ?? null, args.reason ?? null]);
  await audit(tx, ctx, { action: 'role.revoked', resourceType: 'user', resourceId: args.userId, before: { role: args.role }, reason: args.reason ?? null, category: 'PERMISSION' });
  await emit(tx, ctx, { aggregateType: 'user', aggregateId: args.userId, eventType: 'role.revoked', payload: { userId: args.userId, role: args.role, actorId: ctx.actor?.userId ?? null } });
  return { changed: true };
}

export async function rolesOf(db: Db, userId: string) {
  const rows = await q(db, `SELECT role, scope, granted_at, granted_by FROM user_roles WHERE user_id = $1 ORDER BY role`, [userId]);
  const roles = Array.from(new Set(['USER', ...rows.map((r) => r.role)]));
  return { roles, grants: rows };
}

/** Effective permission list for UI hints (the server still checks every request). */
export async function effectivePermissions(db: Db, actor: Pick<Actor, 'userId' | 'roles' | 'aal'>) {
  const perms = new Set<string>();
  for (const role of new Set<Role>(['USER', ...actor.roles])) {
    if (STAFF_ROLES.includes(role) && actor.aal !== 'aal2') continue;
    ROLE_PERMISSIONS[role].forEach((p) => perms.add(p));
  }
  const overrides = await q(db, `SELECT permission, effect, expires_at FROM policy_overrides WHERE user_id = $1 AND (expires_at IS NULL OR expires_at > now())`, [actor.userId]);
  return { permissions: [...perms].sort(), overrides };
}

// ---- account suspension (sanction-aware) ---------------------------------------------------------------
export async function suspendUser(tx: Tx, ctx: Ctx, args: { userId: string; reason: string; source?: string }) {
  if (ctx.actor?.userId === args.userId) throw conflict('SELF_SUSPEND_FORBIDDEN', 'You cannot suspend your own account');
  const u = await maybeOne(tx, `SELECT status FROM users WHERE id = $1 FOR UPDATE`, [args.userId]);
  if (!u) throw notFound('User');
  if (u.status === 'SUSPENDED') return { changed: false };
  await userStatusMachine.transition(tx, ctx, { table: 'users', id: args.userId, to: 'SUSPENDED', reason: args.reason, actorType: ctx.actor ? 'ADMIN' : 'SYSTEM' });
  const revoked = await revokeAllSessions(tx, args.userId, 'ACCOUNT_SUSPENDED');
  await audit(tx, ctx, { action: 'user.suspended', resourceType: 'user', resourceId: args.userId, before: { status: u.status }, after: { status: 'SUSPENDED', sessionsRevoked: revoked, source: args.source ?? 'ADMIN' }, reason: args.reason, category: 'PERMISSION' });
  await emit(tx, ctx, { aggregateType: 'user', aggregateId: args.userId, eventType: 'user.suspended', payload: { userId: args.userId, source: args.source ?? 'ADMIN' } });
  await notify(tx, ctx, { userId: args.userId, templateKey: 'account.suspended', category: 'SECURITY', title: '계정이 정지되었습니다', body: 'Your JETPOOL account has been suspended. Contact support for details.' });
  return { changed: true };
}

/** Restore a suspended account. Refused while an ACCOUNT_SUSPENSION/BAN sanction is active (lift it first). */
export async function restoreUser(tx: Tx, ctx: Ctx, args: { userId: string; reason: string }) {
  const u = await maybeOne(tx, `SELECT status FROM users WHERE id = $1 FOR UPDATE`, [args.userId]);
  if (!u) throw notFound('User');
  if (u.status === 'ACTIVE') return { changed: false };
  if (await hasActiveSanction(tx, args.userId, ACCOUNT_BLOCKING_SANCTIONS)) {
    throw conflict('ACTIVE_SANCTION', 'An active account sanction must be lifted before restoring the account');
  }
  await userStatusMachine.transition(tx, ctx, { table: 'users', id: args.userId, to: 'ACTIVE', from: ['SUSPENDED', 'RESTRICTED'], reason: args.reason, actorType: ctx.actor ? 'ADMIN' : 'SYSTEM' });
  await audit(tx, ctx, { action: 'user.restored', resourceType: 'user', resourceId: args.userId, before: { status: u.status }, after: { status: 'ACTIVE' }, reason: args.reason, category: 'PERMISSION' });
  await emit(tx, ctx, { aggregateType: 'user', aggregateId: args.userId, eventType: 'user.restored', payload: { userId: args.userId } });
  return { changed: true };
}

// ---- admin directory -----------------------------------------------------------------------------------
export const maskEmail = (e: string | null) => {
  if (!e) return e;
  const [local, domain] = e.split('@');
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
};
export const maskPhone = (p: string | null) => (p ? `${'*'.repeat(Math.max(0, p.length - 4))}${p.slice(-4)}` : p);

/** SUPPORT-only viewers get masked contact data; ADMIN/COMPLIANCE see it in full (CORE-03 / OPS-01). */
export const shouldMask = (actor: Pick<Actor, 'roles'> | null) => !!actor && !actor.roles.includes('ADMIN') && !actor.roles.includes('COMPLIANCE');

function presentUser(row: any, mask: boolean) {
  return {
    id: row.id,
    email: mask ? maskEmail(row.email) : row.email,
    phone: mask ? maskPhone(row.phone) : row.phone,
    displayName: row.display_name,
    status: row.status,
    locale: row.locale,
    roles: row.roles ?? ['USER'],
    emailVerified: !!row.email_verified_at,
    identityVerified: !!row.identity_verified_at,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  };
}

export async function searchUsers(
  db: Db,
  viewer: Pick<Actor, 'roles'>,
  f: { q?: string; status?: string; role?: string; limit: number; cursor?: string },
) {
  const c = decodeCursor(f.cursor);
  const rows = await q(
    db,
    `SELECT u.*, array(SELECT 'USER' UNION SELECT role FROM user_roles r WHERE r.user_id = u.id ORDER BY 1) AS roles
       FROM users u
      WHERE ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%' OR u.display_name ILIKE '%' || $1 || '%' OR u.id::text = $1)
        AND ($2::text IS NULL OR u.status = $2)
        AND ($3::text IS NULL OR EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role = $3))
        AND ($4::timestamptz IS NULL OR (u.created_at, u.id) < ($4::timestamptz, $5::uuid))
      ORDER BY u.created_at DESC, u.id DESC LIMIT $6`,
    [f.q?.replace(/[%_\\]/g, (m) => `\\${m}`) ?? null, f.status ?? null, f.role ?? null, c?.createdAt ?? null, c?.id ?? null, f.limit + 1],
  );
  const p = page(rows, f.limit);
  const mask = shouldMask(viewer);
  return { items: p.items.map((r) => presentUser(r, mask)), nextCursor: p.nextCursor };
}

export async function adminUserDetail(db: Db, viewer: Pick<Actor, 'roles'>, userId: string) {
  const row = await maybeOne(
    db,
    `SELECT u.*, array(SELECT 'USER' UNION SELECT role FROM user_roles r WHERE r.user_id = u.id ORDER BY 1) AS roles FROM users u WHERE u.id = $1`,
    [userId],
  );
  if (!row) throw notFound('User');
  const [sessions, sanctions, grants, mfa] = await Promise.all([
    one<{ n: number }>(db, `SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()`, [userId]),
    activeSanctions(db, userId),
    q(db, `SELECT role, action, actor_id, reason, created_at FROM role_grants WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [userId]),
    maybeOne(db, `SELECT 1 FROM mfa_factors WHERE user_id = $1 AND status = 'VERIFIED'`, [userId]),
  ]);
  return {
    ...presentUser(row, shouldMask(viewer)),
    mfaEnabled: !!mfa,
    activeSessions: sessions.n,
    activeSanctions: sanctions.map((s) => ({ id: s.id, type: s.sanction_type, reason: s.reason, startsAt: s.starts_at, endsAt: s.ends_at })),
    roleHistory: grants,
  };
}
