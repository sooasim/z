import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { ROLES, getActor, requireAuth, requireRole } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { q, withTx, one } from '../../platform/db.js';
import { audit } from '../../platform/audit.js';
import { notFound } from '../../platform/errors.js';
import { idParams, pagination } from '../../platform/http.js';
import * as svc from './service.js';

const TAG = ['CORE-03'];
const role = z.enum(ROLES);
const reason = z.string().trim().min(3).max(500);

/** CORE-03 Roles, Entitlements & Policy (+ admin user directory, suspend/restore). */
export default async function rolesModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  r.get('/v1/me/roles', { schema: { tags: TAG, summary: 'My roles and effective permissions' }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req);
    const { roles, grants } = await svc.rolesOf(pool, actor.userId);
    const eff = await svc.effectivePermissions(pool, actor);
    return { roles, grants, permissions: eff.permissions, aal: actor.aal };
  });

  // ---- admin: roles -----------------------------------------------------------------------------------------
  r.get('/v1/admin/users/:id/roles', { schema: { tags: TAG, params: idParams }, preHandler: requireRole('ADMIN') }, async (req) => {
    const { roles, grants } = await svc.rolesOf(pool, req.params.id);
    const history = await q(pool, `SELECT id, role, action, actor_id, reason, created_at FROM role_grants WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`, [req.params.id]);
    return { roles, grants, history };
  });

  r.post('/v1/admin/users/:id/roles', {
    schema: { tags: TAG, summary: 'Grant a role (ADMIN, AAL2)', params: idParams, body: z.object({ role, reason, scope: z.record(z.string(), z.unknown()).optional() }) },
    preHandler: requireRole('ADMIN'),
  }, async (req, reply) => {
    const res = await withTx(pool, (tx) => svc.grantRole(tx, ctxFromRequest(req), { userId: req.params.id, ...req.body }));
    return reply.status(res.changed ? 201 : 200).send({ ...res, ...(await svc.rolesOf(pool, req.params.id)) });
  });

  const revokeHandler = async (req: any) => {
    const res = await withTx(pool, (tx) => svc.revokeRole(tx, ctxFromRequest(req), { userId: req.params.id, role: req.params.role ?? req.query.role, reason: req.query.reason ?? req.body?.reason ?? null }));
    return { ...res, ...(await svc.rolesOf(pool, req.params.id)) };
  };
  r.delete('/v1/admin/users/:id/roles', {
    schema: { tags: TAG, summary: 'Revoke a role (ADMIN, AAL2)', params: idParams, querystring: z.object({ role, reason: reason.optional() }) },
    preHandler: requireRole('ADMIN'),
  }, revokeHandler);
  r.delete('/v1/admin/users/:id/roles/:role', {
    schema: { tags: TAG, summary: 'Revoke a role (ADMIN, AAL2)', params: z.object({ id: z.uuid(), role }), querystring: z.object({ reason: reason.optional() }) },
    preHandler: requireRole('ADMIN'),
  }, revokeHandler);

  // ---- admin: policy overrides ------------------------------------------------------------------------------
  r.get('/v1/admin/users/:id/policy-overrides', { schema: { tags: TAG, params: idParams }, preHandler: requireRole('ADMIN') }, async (req) => ({
    items: await q(pool, `SELECT * FROM policy_overrides WHERE user_id = $1 ORDER BY created_at DESC`, [req.params.id]),
  }));

  r.post('/v1/admin/users/:id/policy-overrides', {
    schema: {
      tags: TAG,
      params: idParams,
      body: z.object({ permission: z.string().regex(/^[a-z_]+(\.[a-z_*]+)*$|^\*$/).max(100), effect: z.enum(['ALLOW', 'DENY']), reason, expiresAt: z.iso.datetime().optional() }),
    },
    preHandler: requireRole('ADMIN'),
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const item = await withTx(pool, async (tx) => {
      const row = await one(
        tx,
        `INSERT INTO policy_overrides(user_id, permission, effect, reason, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [req.params.id, req.body.permission, req.body.effect, req.body.reason, req.body.expiresAt ?? null, ctx.actor!.userId],
      );
      await audit(tx, ctx, { action: 'policy_override.created', resourceType: 'user', resourceId: req.params.id, after: { id: row.id, permission: row.permission, effect: row.effect, expiresAt: row.expires_at }, reason: req.body.reason, category: 'PERMISSION' });
      return row;
    });
    return reply.status(201).send({ item });
  });

  r.delete('/v1/admin/policy-overrides/:id', { schema: { tags: TAG, params: idParams }, preHandler: requireRole('ADMIN') }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    await withTx(pool, async (tx) => {
      const row = (await q(tx, `UPDATE policy_overrides SET expires_at = now() WHERE id = $1 AND (expires_at IS NULL OR expires_at > now()) RETURNING *`, [req.params.id]))[0];
      if (!row) throw notFound('Policy override');
      await audit(tx, ctx, { action: 'policy_override.expired', resourceType: 'user', resourceId: row.user_id, before: { id: row.id, permission: row.permission, effect: row.effect }, category: 'PERMISSION' });
    });
    return reply.status(204).send();
  });

  // ---- admin: user directory --------------------------------------------------------------------------------
  r.get('/v1/admin/users', {
    schema: {
      tags: TAG,
      summary: 'Search users (ADMIN/SUPPORT/COMPLIANCE, AAL2). Contact data masked for SUPPORT.',
      querystring: pagination.extend({ q: z.string().trim().min(1).max(100).optional(), status: z.enum(['ACTIVE', 'SUSPENDED', 'DELETED', 'PENDING_DELETION', 'RESTRICTED']).optional(), role: role.optional() }),
    },
    preHandler: requireRole('ADMIN', 'SUPPORT', 'COMPLIANCE'),
  }, async (req) => svc.searchUsers(pool, getActor(req), req.query));

  r.get('/v1/admin/users/:id', { schema: { tags: TAG, params: idParams }, preHandler: requireRole('ADMIN', 'SUPPORT', 'COMPLIANCE') }, async (req) => ({
    item: await svc.adminUserDetail(pool, getActor(req), req.params.id),
  }));

  r.post('/v1/admin/users/:id/suspend', {
    schema: { tags: TAG, summary: 'Suspend an account and revoke its sessions (ADMIN, AAL2)', params: idParams, body: z.object({ reason }) },
    preHandler: requireRole('ADMIN'),
  }, async (req) => {
    const res = await withTx(pool, (tx) => svc.suspendUser(tx, ctxFromRequest(req), { userId: req.params.id, reason: req.body.reason }));
    return { ...res, item: await svc.adminUserDetail(pool, getActor(req), req.params.id) };
  });

  r.post('/v1/admin/users/:id/restore', {
    schema: { tags: TAG, summary: 'Restore a suspended account (refused while an account sanction is active)', params: idParams, body: z.object({ reason }) },
    preHandler: requireRole('ADMIN'),
  }, async (req) => {
    const res = await withTx(pool, (tx) => svc.restoreUser(tx, ctxFromRequest(req), { userId: req.params.id, reason: req.body.reason }));
    return { ...res, item: await svc.adminUserDetail(pool, getActor(req), req.params.id) };
  });
}
