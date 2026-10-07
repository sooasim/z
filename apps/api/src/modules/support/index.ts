import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAuth, requireRole } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { q, withTx } from '../../platform/db.js';
import { conflict } from '../../platform/errors.js';
import { decodeCursor, idParams, page, pagination } from '../../platform/http.js';
import { grantElevatedAccess } from '../disputes/service.js';
import * as svc from './service.js';

const TAG = ['OPS-01'];
const CATEGORIES = ['ACCOUNT', 'BOOKING', 'EXCHANGE', 'GUIDE', 'PAYMENT', 'REFUND', 'HOSTING', 'SAFETY', 'TECHNICAL', 'OTHER'] as const;
const STATUSES = ['OPEN', 'PENDING_CUSTOMER', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

/** OPS-01 Customer Support / Case Desk. */
export default async function supportModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  // ---- requester -----------------------------------------------------------------------------------------------
  r.post('/v1/support/cases', {
    schema: {
      tags: TAG,
      body: z.object({
        category: z.enum(CATEGORIES),
        subject: z.string().trim().min(3).max(200),
        description: z.string().trim().min(1).max(10_000),
        priority: z.enum(['LOW', 'NORMAL', 'HIGH']).optional(),
        contextType: z.enum(svc.CONTEXT_TYPES).optional(),
        contextId: z.uuid().optional(),
      }),
    },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const c = await withTx(pool, (tx) => svc.openCase(tx, ctx, req.body));
    return reply.status(201).send({ item: svc.presentCase(c, ctx) });
  });

  r.get('/v1/support/cases', { schema: { tags: TAG, querystring: pagination.extend({ status: z.enum(STATUSES).optional() }) }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    const c = decodeCursor(req.query.cursor);
    const rows = await q(
      pool,
      `SELECT * FROM support_cases WHERE requester_id = $1 AND ($2::text IS NULL OR status = $2)
          AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid)) ORDER BY created_at DESC, id DESC LIMIT $5`,
      [getActor(req).userId, req.query.status ?? null, c?.createdAt ?? null, c?.id ?? null, req.query.limit + 1],
    );
    const p = page(rows, req.query.limit);
    return { items: p.items.map((x) => svc.presentCase(x, ctx)), nextCursor: p.nextCursor };
  });

  r.get('/v1/support/cases/:id', { schema: { tags: TAG, params: idParams }, preHandler: requireAuth }, async (req) => ({ item: await svc.caseDetail(pool, ctxFromRequest(req), req.params.id) }));

  r.post('/v1/support/cases/:id/comments', {
    schema: { tags: TAG, params: idParams, body: z.object({ body: z.string().trim().min(1).max(10_000) }) },
    preHandler: requireAuth,
  }, async (req, reply) => reply.status(201).send({ item: await withTx(pool, (tx) => svc.comment(tx, ctxFromRequest(req), req.params.id, req.body.body)) }));

  r.post('/v1/support/cases/:id/close', { schema: { tags: TAG, params: idParams }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    return {
      item: svc.presentCase(
        await withTx(pool, async (tx) => {
          const { requester } = await svc.loadCase(tx, ctx, req.params.id);
          if (!requester) throw conflict('NOT_REQUESTER', 'Only the requester can close a case here');
          return svc.changeStatus(tx, ctx, req.params.id, 'CLOSED', 'closed by requester');
        }),
        ctx,
      ),
    };
  });

  // ---- staff desk (SUPPORT / ADMIN, AAL2) -----------------------------------------------------------------------
  const staff = requireRole('SUPPORT', 'ADMIN');

  r.get('/v1/admin/support/cases', {
    schema: {
      tags: TAG,
      summary: 'Support queue ordered by SLA due time',
      querystring: z.object({
        status: z.enum(STATUSES).optional(),
        priority: z.enum(PRIORITIES).optional(),
        assigneeId: z.uuid().optional(),
        mine: z.coerce.boolean().optional(),
        overdue: z.coerce.boolean().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    },
    preHandler: staff,
  }, async (req) => {
    const ctx = ctxFromRequest(req);
    const f = req.query;
    const rows = await q(
      pool,
      `SELECT * FROM support_cases
        WHERE (($1::text IS NULL AND status NOT IN ('RESOLVED','CLOSED')) OR status = $1)
          AND ($2::text IS NULL OR priority = $2) AND ($3::uuid IS NULL OR assignee_id = $3)
          AND (NOT $4 OR sla_due_at < now())
        ORDER BY sla_due_at NULLS LAST, created_at LIMIT $5`,
      [f.status ?? null, f.priority ?? null, f.mine ? getActor(req).userId : f.assigneeId ?? null, !!f.overdue, f.limit],
    );
    return { items: rows.map((x) => svc.presentCase(x, ctx)) };
  });

  r.get('/v1/admin/support/cases/:id', { schema: { tags: TAG, params: idParams }, preHandler: staff }, async (req) => ({ item: await svc.caseDetail(pool, ctxFromRequest(req), req.params.id) }));

  r.post('/v1/admin/support/cases/:id/assign', { schema: { tags: TAG, params: idParams, body: z.object({ assigneeId: z.uuid().optional() }).nullish() }, preHandler: staff }, async (req) => {
    const ctx = ctxFromRequest(req);
    return { item: svc.presentCase(await withTx(pool, (tx) => svc.assign(tx, ctx, req.params.id, req.body?.assigneeId ?? ctx.actor!.userId)), ctx) };
  });

  r.post('/v1/admin/support/cases/:id/notes', {
    schema: { tags: TAG, summary: 'Internal note (never visible to the requester)', params: idParams, body: z.object({ body: z.string().trim().min(1).max(10_000) }) },
    preHandler: staff,
  }, async (req, reply) => reply.status(201).send({ item: await withTx(pool, (tx) => svc.internalNote(tx, ctxFromRequest(req), req.params.id, req.body.body)) }));

  r.post('/v1/admin/support/cases/:id/comments', {
    schema: { tags: TAG, params: idParams, body: z.object({ body: z.string().trim().min(1).max(10_000) }) },
    preHandler: staff,
  }, async (req, reply) => reply.status(201).send({ item: await withTx(pool, (tx) => svc.comment(tx, ctxFromRequest(req), req.params.id, req.body.body)) }));

  r.post('/v1/admin/support/cases/:id/status', {
    schema: { tags: TAG, params: idParams, body: z.object({ to: z.enum(['IN_PROGRESS', 'PENDING_CUSTOMER', 'RESOLVED', 'CLOSED']), note: z.string().max(2000).optional() }) },
    preHandler: staff,
  }, async (req) => {
    const ctx = ctxFromRequest(req);
    return { item: svc.presentCase(await withTx(pool, (tx) => svc.changeStatus(tx, ctx, req.params.id, req.body.to, req.body.note)), ctx) };
  });

  r.post('/v1/admin/support/cases/:id/priority', { schema: { tags: TAG, params: idParams, body: z.object({ priority: z.enum(PRIORITIES) }) }, preHandler: staff }, async (req) => {
    const ctx = ctxFromRequest(req);
    return { item: svc.presentCase(await withTx(pool, (tx) => svc.setPriority(tx, ctx, req.params.id, req.body.priority)), ctx) };
  });

  r.post('/v1/admin/support/cases/:id/elevated-access', {
    schema: { tags: TAG, params: idParams, body: z.object({ conversationId: z.uuid(), reason: z.string().trim().min(10).max(1000), durationMinutes: z.number().int().min(1).max(1440).optional() }) },
    preHandler: staff,
  }, async (req, reply) => {
    const item = await withTx(pool, (tx) => grantElevatedAccess(tx, ctxFromRequest(req), { caseType: 'SUPPORT_CASE', caseId: req.params.id, ...req.body }));
    return reply.status(201).send({ item });
  });
}
