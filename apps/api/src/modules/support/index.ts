import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAuth, requireRole } from '../../platform/auth.js';
import { ctxFromRequest, type Ctx } from '../../platform/context.js';
import { q, withTx, type Tx } from '../../platform/db.js';
import { badRequest, conflict } from '../../platform/errors.js';
import { onEvent } from '../../platform/outbox.js';
import { registerJob } from '../../platform/jobs.js';
import { decodeCursor, idParams, page, pagination } from '../../platform/http.js';
import { grantElevatedAccess } from '../disputes/service.js';
import { recordAdminAction } from '../admin/actions.js';
import * as svc from './service.js';

const TAG = ['OPS-01'];
const CATEGORIES = ['ACCOUNT', 'BOOKING', 'EXCHANGE', 'GUIDE', 'PAYMENT', 'REFUND', 'HOSTING', 'SAFETY', 'TECHNICAL', 'OTHER'] as const;
const STATUSES = ['OPEN', 'PENDING_CUSTOMER', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'] as const;

/** OPS-01 Customer Support / Case Desk. */
export default async function supportModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  /** Staff console mutation: domain change + `admin.action.performed` in one transaction (OPS-02 contract). */
  const staffTx = <T>(req: FastifyRequest, action: string, fn: (tx: Tx, ctx: Ctx) => Promise<T>, details?: (out: T) => Record<string, unknown>) => {
    const ctx = ctxFromRequest(req);
    const caseId = (req.params as { id: string }).id;
    return withTx(pool, async (tx) => {
      const out = await fn(tx, ctx);
      await recordAdminAction(tx, ctx, { action, resourceType: 'support_case', resourceId: caseId, details: details?.(out) });
      return out;
    });
  };

  // ---- external desk mirror (Chatwoot when configured; no-op otherwise) -------------------------------------------
  // The consumer only marks the case; the desk is called by the job outside the outbox dispatch transaction.
  onEvent('support.case.opened', 'support.desk-sync', async (tx, ev, ctx) => {
    if (ev.payload?.caseId) await svc.markCaseForDeskSync(tx, ctx, ev.payload.caseId);
  });
  registerJob('support.desk-sync', 15_000, (ac) => svc.runDeskSync(ac));

  // ---- requester -----------------------------------------------------------------------------------------------
  r.post('/v1/support/cases', {
    schema: { summary: 'Open a support case',
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

  r.get('/v1/support/cases', { schema: { summary: 'List support cases of the current user', tags: TAG, querystring: pagination.extend({ status: z.enum(STATUSES).optional() }) }, preHandler: requireAuth }, async (req) => {
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

  r.get('/v1/support/cases/:id', { schema: { summary: 'Get a support case', tags: TAG, params: idParams }, preHandler: requireAuth }, async (req) => ({ item: await svc.caseDetail(pool, ctxFromRequest(req), req.params.id) }));

  r.post('/v1/support/cases/:id/comments', {
    schema: { summary: 'Comment on a support case', tags: TAG, params: idParams, body: z.object({ body: z.string().trim().min(1).max(10_000) }) },
    preHandler: requireAuth,
  }, async (req, reply) => reply.status(201).send({ item: await withTx(pool, (tx) => svc.comment(tx, ctxFromRequest(req), req.params.id, req.body.body)) }));

  r.post('/v1/support/cases/:id/close', { schema: { summary: 'Close a support case', tags: TAG, params: idParams }, preHandler: requireAuth }, async (req) => {
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
        linkType: z.enum(svc.LINK_TYPES).optional(),
        linkId: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    },
    preHandler: staff,
  }, async (req) => {
    const ctx = ctxFromRequest(req);
    const f = req.query;
    if (!!f.linkType !== !!f.linkId) throw badRequest('LINK_FILTER_INCOMPLETE', 'linkType and linkId must be provided together');
    // a link filter ("all cases about this reservation") includes resolved/closed cases unless a status is given
    const rows = await q(
      pool,
      `SELECT * FROM support_cases c
        WHERE (($1::text IS NULL AND ($6::text IS NOT NULL OR status NOT IN ('RESOLVED','CLOSED'))) OR status = $1)
          AND ($2::text IS NULL OR priority = $2) AND ($3::uuid IS NULL OR assignee_id = $3)
          AND (NOT $4 OR sla_due_at < now())
          AND ($6::text IS NULL OR EXISTS (SELECT 1 FROM support_case_links l WHERE l.case_id = c.id AND l.link_type = $6 AND l.link_id = $7::uuid))
        ORDER BY sla_due_at NULLS LAST, created_at LIMIT $5`,
      [f.status ?? null, f.priority ?? null, f.mine ? getActor(req).userId : f.assigneeId ?? null, !!f.overdue, f.limit, f.linkType ?? null, f.linkId ?? null],
    );
    return { items: rows.map((x) => svc.presentCase(x, ctx)) };
  });

  r.get('/v1/admin/support/cases/:id', { schema: { summary: 'Get a support case with its internal history', tags: TAG, params: idParams }, preHandler: staff }, async (req) => ({ item: await svc.caseDetail(pool, ctxFromRequest(req), req.params.id) }));

  r.post('/v1/admin/support/cases/:id/assign', { schema: { summary: 'Assign a support case to an agent', tags: TAG, params: idParams, body: z.object({ assigneeId: z.uuid().optional() }).nullish() }, preHandler: staff }, async (req) => {
    const ctx = ctxFromRequest(req);
    const assigneeId = req.body?.assigneeId ?? ctx.actor!.userId;
    return { item: svc.presentCase(await staffTx(req, 'support.case.assigned', (tx) => svc.assign(tx, ctx, req.params.id, assigneeId), () => ({ assigneeId })), ctx) };
  });

  r.post('/v1/admin/support/cases/:id/notes', {
    schema: { tags: TAG, summary: 'Internal note (never visible to the requester)', params: idParams, body: z.object({ body: z.string().trim().min(1).max(10_000) }) },
    preHandler: staff,
  }, async (req, reply) => reply.status(201).send({ item: await staffTx(req, 'support.case.internal_note', (tx, ctx) => svc.internalNote(tx, ctx, req.params.id, req.body.body), (ev) => ({ eventId: ev.id })) }));

  r.post('/v1/admin/support/cases/:id/comments', {
    schema: { summary: 'Add a comment to a support case', tags: TAG, params: idParams, body: z.object({ body: z.string().trim().min(1).max(10_000) }) },
    preHandler: staff,
  }, async (req, reply) => reply.status(201).send({ item: await staffTx(req, 'support.case.replied', (tx, ctx) => svc.comment(tx, ctx, req.params.id, req.body.body), (ev) => ({ eventId: ev.id })) }));

  r.post('/v1/admin/support/cases/:id/status', {
    schema: { summary: 'Change the status of a support case', tags: TAG, params: idParams, body: z.object({ to: z.enum(['IN_PROGRESS', 'PENDING_CUSTOMER', 'RESOLVED', 'CLOSED']), note: z.string().max(2000).optional() }) },
    preHandler: staff,
  }, async (req) => {
    const ctx = ctxFromRequest(req);
    return { item: svc.presentCase(await staffTx(req, 'support.case.status_changed', (tx) => svc.changeStatus(tx, ctx, req.params.id, req.body.to, req.body.note), () => ({ to: req.body.to })), ctx) };
  });

  r.post('/v1/admin/support/cases/:id/priority', { schema: { summary: 'Change the priority of a support case', tags: TAG, params: idParams, body: z.object({ priority: z.enum(PRIORITIES) }) }, preHandler: staff }, async (req) => {
    const ctx = ctxFromRequest(req);
    return { item: svc.presentCase(await staffTx(req, 'support.case.priority_changed', (tx) => svc.setPriority(tx, ctx, req.params.id, req.body.priority), () => ({ priority: req.body.priority })), ctx) };
  });

  r.post('/v1/admin/support/cases/:id/elevated-access', {
    schema: { summary: 'Grant audited elevated access for a support case', tags: TAG, params: idParams, body: z.object({ conversationId: z.uuid(), reason: z.string().trim().min(10).max(1000), durationMinutes: z.number().int().min(1).max(1440).optional() }) },
    preHandler: staff,
  }, async (req, reply) => {
    const item = await staffTx(
      req,
      'support.case.elevated_access_granted',
      (tx, ctx) => grantElevatedAccess(tx, ctx, { caseType: 'SUPPORT_CASE', caseId: req.params.id, ...req.body }),
      (g) => ({ grantId: g.id, conversationId: req.body.conversationId, expiresAt: g.expires_at }),
    );
    return reply.status(201).send({ item });
  });

  // ---- context links (support_case_links) ---------------------------------------------------------------------
  const linkBody = z.object({ linkType: z.enum(svc.LINK_TYPES), linkId: z.uuid() });

  r.get('/v1/admin/support/cases/:id/links', { schema: { summary: 'List the records linked to a support case', tags: TAG, params: idParams }, preHandler: staff }, async (req) => {
    const { c } = await svc.loadCase(pool, ctxFromRequest(req), req.params.id);
    return { items: await svc.listLinks(pool, req.params.id, c.requester_id) };
  });

  r.post('/v1/admin/support/cases/:id/links', {
    schema: { tags: TAG, summary: 'Link a reservation/exchange/booking/order/dispute/payment/user/conversation to the case (idempotent)', params: idParams, body: linkBody },
    preHandler: staff,
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const res = await withTx(pool, async (tx) => {
      const out = await svc.linkCase(tx, ctx, req.params.id, req.body);
      if (out.created) await recordAdminAction(tx, ctx, { action: 'support.case.linked', resourceType: 'support_case', resourceId: req.params.id, details: { linkType: req.body.linkType, linkId: req.body.linkId } });
      return out;
    });
    return reply.status(res.created ? 201 : 200).send({ item: res.item });
  });

  r.delete('/v1/admin/support/cases/:id/links/:linkType/:linkId', {
    schema: { summary: 'Unlink a record from a support case', tags: TAG, params: z.object({ id: z.uuid(), linkType: z.enum(svc.LINK_TYPES), linkId: z.uuid() }) },
    preHandler: staff,
  }, async (req) => ({
    item: await staffTx(req, 'support.case.unlinked', (tx, ctx) => svc.unlinkCase(tx, ctx, req.params.id, { linkType: req.params.linkType, linkId: req.params.linkId }), () => ({
      linkType: req.params.linkType,
      linkId: req.params.linkId,
    })),
  }));
}
