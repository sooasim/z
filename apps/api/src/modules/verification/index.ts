import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAuth, requireRole } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import { onEvent } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { notFound, unprocessable } from '../../platform/errors.js';
import { decodeCursor, idParams, page, pagination } from '../../platform/http.js';
import * as svc from './service.js';

const TAG = ['TRUST-01'];
const sha = z.string().regex(/^[0-9a-fA-F]{64}$/, 'sha256 hex');
const documentInput = z.object({ documentType: z.string().trim().min(2).max(60), mediaId: z.uuid().optional(), sha256: sha });
const businessBody = z.object({
  businessType: z.enum(['INDIVIDUAL', 'SOLE_PROPRIETOR', 'CORPORATION']),
  businessName: z.string().trim().min(1).max(200).optional(),
  registrationNo: z.string().regex(/^[0-9-]{6,20}$/).optional(),
  representative: z.string().trim().min(1).max(120).optional(),
  address: z.string().trim().min(1).max(500).optional(),
});

/** TRUST-01 Identity / Business Verification. */
export default async function verificationModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  // Projections onto records owned by other domains (idempotent; owning modules may also consume these events).
  onEvent('verification.approved', 'verification.subject-sync', async (tx, ev) => {
    const p = ev.payload as { subjectType: string; subjectId: string | null; userId: string };
    if (p.subjectType === 'GUIDE') await tx.query(`UPDATE guide_profiles SET verification_status = 'VERIFIED' WHERE user_id = $1 AND verification_status <> 'SUSPENDED'`, [p.userId]);
    if (p.subjectType === 'PAYOUT_ACCOUNT' && p.subjectId) await tx.query(`UPDATE payout_accounts SET status = 'VERIFIED' WHERE id = $1 AND status = 'PENDING'`, [p.subjectId]);
  });
  onEvent('verification.rejected', 'verification.subject-sync', async (tx, ev) => {
    const p = ev.payload as { subjectType: string; subjectId: string | null; userId: string };
    if (p.subjectType === 'GUIDE') await tx.query(`UPDATE guide_profiles SET verification_status = 'REJECTED' WHERE user_id = $1 AND verification_status = 'PENDING'`, [p.userId]);
    if (p.subjectType === 'PAYOUT_ACCOUNT' && p.subjectId) await tx.query(`UPDATE payout_accounts SET status = 'REJECTED' WHERE id = $1 AND status = 'PENDING'`, [p.subjectId]);
  });

  // ---- user ------------------------------------------------------------------------------------------------
  r.post('/v1/verifications', {
    schema: {
      tags: TAG,
      summary: 'Submit a verification case with document references (media ids + sha256)',
      body: z.object({ subjectType: z.enum(svc.SUBJECT_TYPES), subjectId: z.uuid().optional(), documents: z.array(documentInput).min(1).max(10) }),
    },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const item = await withTx(pool, (tx) => svc.submitCase(tx, ctxFromRequest(req), req.body));
    return reply.status(201).send({ item });
  });

  r.get('/v1/verifications', { schema: { tags: TAG }, preHandler: requireAuth }, async (req) => {
    const userId = getActor(req).userId;
    return {
      items: await q(pool, `SELECT id, subject_type, subject_id, status, decision_reason, submitted_at, decided_at, expires_at FROM verification_cases WHERE user_id = $1 ORDER BY submitted_at DESC`, [userId]),
      summary: await svc.verificationSummary(pool, userId),
    };
  });

  r.get('/v1/verifications/:id', { schema: { tags: TAG, params: idParams }, preHandler: requireAuth }, async (req) => ({
    item: await svc.getCase(pool, ctxFromRequest(req), req.params.id),
  }));

  // ---- business profiles -------------------------------------------------------------------------------------
  r.post('/v1/business-profiles', { schema: { tags: TAG, body: businessBody }, preHandler: requireAuth }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const b = req.body;
    if (b.businessType !== 'INDIVIDUAL' && (!b.businessName || !b.registrationNo)) throw unprocessable('BUSINESS_DETAILS_REQUIRED', 'Business name and registration number are required');
    const item = await withTx(pool, async (tx) => {
      const row = await one(
        tx,
        `INSERT INTO business_profiles(user_id, business_type, business_name, registration_no, representative, address) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [ctx.actor!.userId, b.businessType, b.businessName ?? null, b.registrationNo ?? null, b.representative ?? null, b.address ?? null],
      );
      await audit(tx, ctx, { action: 'business_profile.created', resourceType: 'business_profile', resourceId: row.id, after: { businessType: row.business_type }, category: 'COMPLIANCE' });
      return row;
    });
    return reply.status(201).send({ item });
  });

  r.get('/v1/business-profiles', { schema: { tags: TAG }, preHandler: requireAuth }, async (req) => ({
    items: await q(pool, `SELECT * FROM business_profiles WHERE user_id = $1 ORDER BY created_at DESC`, [getActor(req).userId]),
  }));

  r.get('/v1/business-profiles/:id', { schema: { tags: TAG, params: idParams }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req);
    const item = await maybeOne(pool, `SELECT * FROM business_profiles WHERE id = $1`, [req.params.id]);
    const staff = actor.aal === 'aal2' && (actor.roles.includes('ADMIN') || actor.roles.includes('COMPLIANCE'));
    if (!item || (item.user_id !== actor.userId && !staff)) throw notFound('Business profile');
    return { item };
  });

  r.patch('/v1/business-profiles/:id', { schema: { tags: TAG, params: idParams, body: businessBody.partial().strict() }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    const item = await withTx(pool, async (tx) => {
      const cur = await maybeOne(tx, `SELECT * FROM business_profiles WHERE id = $1 FOR UPDATE`, [req.params.id]);
      if (!cur || cur.user_id !== ctx.actor!.userId) throw notFound('Business profile');
      const map: Record<string, string> = { businessType: 'business_type', businessName: 'business_name', registrationNo: 'registration_no', representative: 'representative', address: 'address' };
      const keys = Object.keys(req.body).filter((k) => (req.body as any)[k] !== undefined);
      if (!keys.length) return cur;
      const sets = keys.map((k, i) => `${map[k]} = $${i + 2}`);
      // Changing verified details invalidates the verification (must be re-reviewed).
      const row = await one(
        tx,
        `UPDATE business_profiles SET ${sets.join(', ')}, status = CASE WHEN status = 'VERIFIED' THEN 'PENDING' ELSE status END, updated_at = now() WHERE id = $1 RETURNING *`,
        [req.params.id, ...keys.map((k) => (req.body as any)[k])],
      );
      await audit(tx, ctx, { action: 'business_profile.updated', resourceType: 'business_profile', resourceId: row.id, before: { status: cur.status }, after: { status: row.status, fields: keys }, category: 'COMPLIANCE' });
      return row;
    });
    return { item };
  });

  // ---- admin queue (COMPLIANCE / ADMIN, AAL2) -----------------------------------------------------------------
  const staff = requireRole('COMPLIANCE', 'ADMIN');

  r.get('/v1/admin/verifications', {
    schema: {
      tags: TAG,
      querystring: pagination.extend({ status: z.enum(['SUBMITTED', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED']).optional(), subjectType: z.enum(svc.SUBJECT_TYPES).optional() }),
    },
    preHandler: staff,
  }, async (req) => {
    const c = decodeCursor(req.query.cursor);
    const rows = await q(
      pool,
      `SELECT v.*, v.submitted_at AS created_at, u.display_name, (SELECT count(*)::int FROM verification_documents d WHERE d.case_id = v.id) AS document_count
         FROM verification_cases v JOIN users u ON u.id = v.user_id
        WHERE (($1::text IS NULL AND v.status IN ('SUBMITTED','IN_REVIEW')) OR v.status = $1) AND ($2::text IS NULL OR v.subject_type = $2)
          AND ($3::timestamptz IS NULL OR (v.submitted_at, v.id) > ($3::timestamptz, $4::uuid))
        ORDER BY v.submitted_at, v.id LIMIT $5`,
      [req.query.status ?? null, req.query.subjectType ?? null, c?.createdAt ?? null, c?.id ?? null, req.query.limit + 1],
    );
    return page(rows, req.query.limit);
  });

  r.get('/v1/admin/verifications/:id', { schema: { tags: TAG, params: idParams }, preHandler: staff }, async (req) => ({
    item: await svc.getCase(pool, ctxFromRequest(req), req.params.id),
  }));

  r.post('/v1/admin/verifications/:id/start-review', { schema: { tags: TAG, params: idParams }, preHandler: staff }, async (req) => ({
    item: await withTx(pool, (tx) => svc.startReview(tx, ctxFromRequest(req), req.params.id)),
  }));

  r.post('/v1/admin/verifications/:id/approve', {
    schema: { tags: TAG, params: idParams, body: z.object({ reason: z.string().max(1000).optional(), expiresAt: z.iso.datetime().optional() }).nullish() },
    preHandler: staff,
  }, async (req) => ({
    item: await withTx(pool, (tx) => svc.decideCase(tx, ctxFromRequest(req), req.params.id, { approve: true, reason: req.body?.reason, expiresAt: req.body?.expiresAt })),
  }));

  r.post('/v1/admin/verifications/:id/reject', {
    schema: { tags: TAG, params: idParams, body: z.object({ reason: z.string().trim().min(3).max(1000) }) },
    preHandler: staff,
  }, async (req) => ({
    item: await withTx(pool, (tx) => svc.decideCase(tx, ctxFromRequest(req), req.params.id, { approve: false, reason: req.body.reason })),
  }));
}
