import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAuth, requireRole } from '../../platform/auth.js';
import { ctxFromRequest, systemCtx } from '../../platform/context.js';
import { maybeOne, q, withTx } from '../../platform/db.js';
import { registerJob } from '../../platform/jobs.js';
import { notFound } from '../../platform/errors.js';
import { decodeCursor, idParams, page, pagination } from '../../platform/http.js';
import * as svc from './service.js';

const TAG = ['TRUST-03'];
const CONTEXT_TYPES = ['RESERVATION', 'EXCHANGE', 'GUIDE_BOOKING', 'ORDER', 'MESSAGE', 'REVIEW', 'OTHER'] as const;
const SEVERITY = ['LOW', 'NORMAL', 'HIGH', 'CRITICAL'] as const;
const reason = z.string().trim().min(3).max(1000);
const elevatedBody = z.object({ conversationId: z.uuid(), reason: z.string().trim().min(10).max(1000), durationMinutes: z.number().int().min(1).max(svc.ELEVATED_MAX_MINUTES).optional() });

/** TRUST-03 Safety, Reports & Disputes. */
export default async function disputesModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  registerJob('disputes.sanction-expiry', 5 * 60 * 1000, async (ac) => withTx(ac.pool, (tx) => svc.sweepExpiredSanctions(tx, systemCtx(ac, `sanction-sweep-${Date.now()}`))));

  // ---- parties ------------------------------------------------------------------------------------------------
  r.post('/v1/disputes', {
    schema: {
      tags: TAG,
      summary: 'Open a dispute (parties of the context only)',
      body: z.object({
        contextType: z.enum(CONTEXT_TYPES),
        contextId: z.uuid(),
        reason: z.string().trim().min(3).max(200),
        description: z.string().max(10_000).optional(),
        severity: z.enum(SEVERITY).optional(),
        counterpartyId: z.uuid().optional(),
      }),
    },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const item = await withTx(pool, (tx) => svc.openDispute(tx, ctxFromRequest(req), req.body));
    return reply.status(201).send({ item });
  });

  r.get('/v1/disputes', { schema: { tags: TAG, querystring: pagination }, preHandler: requireAuth }, async (req) => {
    const uid = getActor(req).userId;
    const c = decodeCursor(req.query.cursor);
    const rows = await q(
      pool,
      `SELECT id, context_type, context_id, status, severity, reason, opened_by, counterparty_id, resolution, created_at, resolved_at
         FROM disputes WHERE (opened_by = $1 OR counterparty_id = $1)
          AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::uuid))
        ORDER BY created_at DESC, id DESC LIMIT $4`,
      [uid, c?.createdAt ?? null, c?.id ?? null, req.query.limit + 1],
    );
    return page(rows, req.query.limit);
  });

  r.get('/v1/disputes/:id', { schema: { tags: TAG, params: idParams }, preHandler: requireAuth }, async (req) => ({ item: await svc.disputeDetail(pool, ctxFromRequest(req), req.params.id) }));

  r.post('/v1/disputes/:id/evidence', {
    schema: {
      tags: TAG,
      summary: 'Append evidence (immutable, sha256-hashed)',
      params: idParams,
      body: z.object({
        evidenceType: z.enum(['TEXT', 'MEDIA', 'MESSAGE_REF', 'DOCUMENT']),
        content: z.string().min(1).max(10_000).optional(),
        mediaId: z.uuid().optional(),
        sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
      }),
    },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const item = await withTx(pool, (tx) => svc.addEvidence(tx, ctxFromRequest(req), req.params.id, req.body));
    return reply.status(201).send({ item });
  });

  r.post('/v1/safety-reports', {
    schema: {
      tags: TAG,
      summary: 'Report a safety concern',
      body: z.object({
        subjectType: z.enum(['USER', 'PROPERTY', 'MESSAGE', 'REVIEW', 'TRAVEL_PRODUCT', 'GUIDE', 'RESERVATION', 'EXCHANGE', 'GUIDE_BOOKING', 'ORDER', 'OTHER']),
        subjectId: z.uuid(),
        category: z.enum(['HARASSMENT', 'FRAUD', 'SCAM', 'SAFETY_THREAT', 'DISCRIMINATION', 'PROPERTY_MISREPRESENTATION', 'ILLEGAL_ACTIVITY', 'SPAM', 'OTHER']),
        description: z.string().max(10_000).optional(),
        urgent: z.boolean().optional(),
      }),
    },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const item = await withTx(pool, (tx) => svc.createSafetyReport(tx, ctxFromRequest(req), req.body));
    return reply.status(201).send({ item });
  });

  r.get('/v1/safety-reports', { schema: { tags: TAG }, preHandler: requireAuth }, async (req) => ({
    items: await q(pool, `SELECT id, subject_type, subject_id, category, urgent, status, created_at FROM safety_reports WHERE reporter_id = $1 ORDER BY created_at DESC LIMIT 200`, [getActor(req).userId]),
  }));

  // ---- staff workbench (ADMIN / SUPPORT write, COMPLIANCE read; AAL2) ----------------------------------------
  const staffRead = requireRole('ADMIN', 'SUPPORT', 'COMPLIANCE');
  const staffWrite = requireRole('ADMIN', 'SUPPORT');

  r.get('/v1/admin/disputes', {
    schema: {
      tags: TAG,
      querystring: pagination.extend({
        status: z.enum(['OPEN', 'IN_REVIEW', 'AWAITING_PARTY', 'RESOLVED', 'REJECTED', 'ESCALATED']).optional(),
        severity: z.enum(SEVERITY).optional(),
        assigneeId: z.uuid().optional(),
        unassigned: z.coerce.boolean().optional(),
      }),
    },
    preHandler: staffRead,
  }, async (req) => {
    const f = req.query;
    const c = decodeCursor(f.cursor);
    const rows = await q(
      pool,
      `SELECT d.*, (SELECT count(*)::int FROM dispute_evidence e WHERE e.dispute_id = d.id) AS evidence_count
         FROM disputes d
        WHERE (($1::text IS NULL AND d.status NOT IN ('RESOLVED','REJECTED')) OR d.status = $1)
          AND ($2::text IS NULL OR d.severity = $2) AND ($3::uuid IS NULL OR d.assignee_id = $3) AND (NOT $4 OR d.assignee_id IS NULL)
          AND ($5::timestamptz IS NULL OR (d.created_at, d.id) > ($5::timestamptz, $6::uuid))
        ORDER BY d.created_at, d.id LIMIT $7`,
      [f.status ?? null, f.severity ?? null, f.assigneeId ?? null, !!f.unassigned, c?.createdAt ?? null, c?.id ?? null, f.limit + 1],
    );
    return page(rows, f.limit);
  });

  r.get('/v1/admin/disputes/:id', { schema: { tags: TAG, params: idParams }, preHandler: staffRead }, async (req) => ({ item: await svc.disputeDetail(pool, ctxFromRequest(req), req.params.id) }));

  r.post('/v1/admin/disputes/:id/assign', { schema: { tags: TAG, params: idParams, body: z.object({ assigneeId: z.uuid().optional() }).optional() }, preHandler: staffWrite }, async (req) => ({
    item: await withTx(pool, (tx) => svc.assignDispute(tx, ctxFromRequest(req), req.params.id, req.body?.assigneeId ?? getActor(req).userId)),
  }));

  r.post('/v1/admin/disputes/:id/status', {
    schema: { tags: TAG, params: idParams, body: z.object({ to: z.enum(['IN_REVIEW', 'AWAITING_PARTY']), note: z.string().max(2000).optional() }) },
    preHandler: staffWrite,
  }, async (req) => ({ item: await withTx(pool, (tx) => svc.changeDisputeStatus(tx, ctxFromRequest(req), req.params.id, req.body.to, req.body.note)) }));

  r.post('/v1/admin/disputes/:id/escalate', {
    schema: { tags: TAG, params: idParams, body: z.object({ reason, severity: z.enum(['HIGH', 'CRITICAL']).optional() }) },
    preHandler: staffWrite,
  }, async (req) => ({ item: await withTx(pool, (tx) => svc.escalateDispute(tx, ctxFromRequest(req), req.params.id, req.body)) }));

  r.post('/v1/admin/disputes/:id/resolve', {
    schema: {
      tags: TAG,
      params: idParams,
      body: z.object({ outcome: z.enum(['RESOLVED', 'REJECTED']), resolution: reason, detail: z.record(z.string(), z.unknown()).optional() }),
    },
    preHandler: staffWrite,
  }, async (req) => ({ item: await withTx(pool, (tx) => svc.resolveDispute(tx, ctxFromRequest(req), req.params.id, req.body)) }));

  r.post('/v1/admin/disputes/:id/notes', { schema: { tags: TAG, params: idParams, body: z.object({ note: z.string().trim().min(1).max(5000) }) }, preHandler: staffWrite }, async (req, reply) => {
    await withTx(pool, (tx) => svc.addInternalNote(tx, ctxFromRequest(req), req.params.id, req.body.note));
    return reply.status(201).send({ ok: true });
  });

  r.post('/v1/admin/disputes/:id/evidence', {
    schema: { tags: TAG, params: idParams, body: z.object({ evidenceType: z.enum(['TEXT', 'MEDIA', 'MESSAGE_REF', 'DOCUMENT']), content: z.string().min(1).max(10_000).optional(), mediaId: z.uuid().optional(), sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional() }) },
    preHandler: staffWrite,
  }, async (req, reply) => reply.status(201).send({ item: await withTx(pool, (tx) => svc.addEvidence(tx, ctxFromRequest(req), req.params.id, req.body)) }));

  // ---- elevated access ---------------------------------------------------------------------------------------
  r.post('/v1/admin/disputes/:id/elevated-access', {
    schema: { tags: TAG, summary: 'Case-scoped, time-limited (<=24h), audited access to a related private conversation', params: idParams, body: elevatedBody },
    preHandler: staffWrite,
  }, async (req, reply) => {
    const item = await withTx(pool, (tx) => svc.grantElevatedAccess(tx, ctxFromRequest(req), { caseType: 'DISPUTE', caseId: req.params.id, ...req.body }));
    return reply.status(201).send({ item });
  });

  r.post('/v1/admin/safety-reports/:id/elevated-access', {
    schema: { tags: TAG, params: idParams, body: elevatedBody },
    preHandler: staffWrite,
  }, async (req, reply) => {
    const item = await withTx(pool, (tx) => svc.grantElevatedAccess(tx, ctxFromRequest(req), { caseType: 'SAFETY_REPORT', caseId: req.params.id, ...req.body }));
    return reply.status(201).send({ item });
  });

  r.get('/v1/admin/elevated-access', { schema: { tags: TAG }, preHandler: staffWrite }, async (req) => ({
    items: await q(pool, `SELECT * FROM elevated_access_grants WHERE admin_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY expires_at`, [getActor(req).userId]),
  }));

  r.delete('/v1/admin/elevated-access/:id', { schema: { tags: TAG, params: idParams }, preHandler: staffWrite }, async (req, reply) => {
    await withTx(pool, (tx) => svc.revokeElevatedAccess(tx, ctxFromRequest(req), req.params.id));
    return reply.status(204).send();
  });

  // ---- sanctions ---------------------------------------------------------------------------------------------
  const sanctionStaff = requireRole('ADMIN', 'COMPLIANCE', 'SUPPORT');
  r.post('/v1/admin/sanctions', {
    schema: {
      tags: TAG,
      summary: 'Apply a sanction (SUPPORT: WARNING only). ACCOUNT_SUSPENSION/BAN suspend the account and revoke sessions.',
      body: z.object({ userId: z.uuid(), sanctionType: z.enum(svc.SANCTION_TYPES), reason, disputeId: z.uuid().optional(), endsAt: z.iso.datetime().optional() }),
    },
    preHandler: sanctionStaff,
  }, async (req, reply) => reply.status(201).send({ item: await withTx(pool, (tx) => svc.applySanction(tx, ctxFromRequest(req), req.body)) }));

  r.post('/v1/admin/sanctions/:id/lift', { schema: { tags: TAG, params: idParams, body: z.object({ reason }) }, preHandler: requireRole('ADMIN', 'COMPLIANCE') }, async (req) => ({
    item: await withTx(pool, (tx) => svc.liftSanction(tx, ctxFromRequest(req), req.params.id, req.body.reason)),
  }));

  r.get('/v1/admin/sanctions', {
    schema: { tags: TAG, querystring: z.object({ userId: z.uuid().optional(), active: z.coerce.boolean().optional() }) },
    preHandler: sanctionStaff,
  }, async (req) => ({
    items: await q(
      pool,
      `SELECT * FROM sanctions WHERE ($1::uuid IS NULL OR user_id = $1)
          AND (NOT $2 OR (lifted_at IS NULL AND (ends_at IS NULL OR ends_at > now()))) ORDER BY starts_at DESC LIMIT 200`,
      [req.query.userId ?? null, !!req.query.active],
    ),
  }));

  // ---- safety queue ------------------------------------------------------------------------------------------
  r.get('/v1/admin/safety-reports', {
    schema: { tags: TAG, querystring: z.object({ status: z.enum(['OPEN', 'TRIAGED', 'ACTIONED', 'CLOSED']).optional(), urgent: z.coerce.boolean().optional() }) },
    preHandler: staffRead,
  }, async (req) => ({
    items: await q(
      pool,
      `SELECT * FROM safety_reports WHERE (($1::text IS NULL AND status IN ('OPEN','TRIAGED')) OR status = $1) AND (NOT $2 OR urgent)
        ORDER BY urgent DESC, created_at LIMIT 200`,
      [req.query.status ?? null, !!req.query.urgent],
    ),
  }));

  r.get('/v1/admin/safety-reports/:id', { schema: { tags: TAG, params: idParams }, preHandler: staffRead }, async (req) => {
    const item = await maybeOne(pool, `SELECT * FROM safety_reports WHERE id = $1`, [req.params.id]);
    if (!item) throw notFound('Safety report');
    return { item };
  });

  r.post('/v1/admin/safety-reports/:id/status', {
    schema: { tags: TAG, params: idParams, body: z.object({ to: z.enum(['TRIAGED', 'ACTIONED', 'CLOSED']), note: z.string().max(2000).optional() }) },
    preHandler: staffWrite,
  }, async (req) => ({ item: await withTx(pool, (tx) => svc.changeSafetyStatus(tx, ctxFromRequest(req), req.params.id, req.body.to, req.body.note)) }));
}
