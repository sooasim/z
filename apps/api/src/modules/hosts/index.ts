import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAuth, requireRole } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { maybeOne, q, withTx } from '../../platform/db.js';
import { notFound } from '../../platform/errors.js';
import { decodeCursor, idParams, page, pagination } from '../../platform/http.js';
import * as svc from './service.js';

const TAG = ['HOST-01'];

/** HOST-01 Host Onboarding. */
export default async function hostsModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  r.post('/v1/host-applications', {
    schema: { tags: TAG, summary: 'Apply to become a host', body: z.object({ displayName: z.string().trim().min(1).max(80).optional(), about: z.string().max(4000).optional() }) },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const item = await withTx(pool, (tx) => svc.apply(tx, ctxFromRequest(req), req.body));
    return reply.status(201).send({ item });
  });

  r.get('/v1/host-applications', { schema: { tags: TAG }, preHandler: requireAuth }, async (req) => ({
    items: await q(pool, `SELECT id, status, checklist, decision_reason, created_at, decided_at FROM host_applications WHERE user_id = $1 ORDER BY created_at DESC`, [getActor(req).userId]),
  }));

  r.get('/v1/host-applications/:id', { schema: { tags: TAG, params: idParams }, preHandler: requireAuth }, async (req) => {
    const item = await maybeOne(pool, `SELECT id, user_id, status, checklist, decision_reason, created_at, decided_at FROM host_applications WHERE id = $1 AND user_id = $2`, [req.params.id, getActor(req).userId]);
    if (!item) throw notFound('Host application');
    return { item };
  });

  r.post('/v1/host-applications/:id/withdraw', { schema: { tags: TAG, params: idParams }, preHandler: requireAuth }, async (req) => ({
    item: await withTx(pool, (tx) => svc.withdraw(tx, ctxFromRequest(req), req.params.id)),
  }));

  r.get('/v1/hosts/:id', { schema: { tags: TAG, summary: 'Public host profile', params: idParams } }, async (req) => ({ item: await svc.publicHost(pool, req.params.id) }));

  r.get('/v1/host/me', { schema: { tags: TAG, summary: 'Host dashboard summary' }, preHandler: requireAuth }, async (req) => svc.hostDashboard(pool, getActor(req).userId));

  // ---- admin -------------------------------------------------------------------------------------------------
  const staff = requireRole('ADMIN', 'COMPLIANCE');
  r.get('/v1/admin/host-applications', {
    schema: { tags: TAG, querystring: pagination.extend({ status: z.enum(['SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN']).optional() }) },
    preHandler: staff,
  }, async (req) => {
    const c = decodeCursor(req.query.cursor);
    const rows = await q(
      pool,
      `SELECT a.*, u.display_name, h.verification_status FROM host_applications a JOIN users u ON u.id = a.user_id LEFT JOIN host_profiles h ON h.user_id = a.user_id
        WHERE (($1::text IS NULL AND a.status IN ('SUBMITTED','IN_REVIEW')) OR a.status = $1)
          AND ($2::timestamptz IS NULL OR (a.created_at, a.id) > ($2::timestamptz, $3::uuid))
        ORDER BY a.created_at, a.id LIMIT $4`,
      [req.query.status ?? null, c?.createdAt ?? null, c?.id ?? null, req.query.limit + 1],
    );
    return page(rows, req.query.limit);
  });

  r.post('/v1/admin/host-applications/:id/approve', {
    schema: { tags: TAG, params: idParams, body: z.object({ reason: z.string().max(1000).optional() }).nullish() },
    preHandler: staff,
  }, async (req) => ({ item: await withTx(pool, (tx) => svc.decide(tx, ctxFromRequest(req), req.params.id, { approve: true, reason: req.body?.reason })) }));

  r.post('/v1/admin/host-applications/:id/reject', {
    schema: { tags: TAG, params: idParams, body: z.object({ reason: z.string().trim().min(3).max(1000) }) },
    preHandler: staff,
  }, async (req) => ({ item: await withTx(pool, (tx) => svc.decide(tx, ctxFromRequest(req), req.params.id, { approve: false, reason: req.body.reason })) }));
}
