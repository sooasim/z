import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAuth, requireRole } from '../../platform/auth.js';
import { ctxFromRequest, systemCtx, type AppContext } from '../../platform/context.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { registerJob } from '../../platform/jobs.js';
import { verifyPassword } from '../../platform/crypto.js';
import { AppError, conflict, forbidden, notFound } from '../../platform/errors.js';
import { idParams } from '../../platform/http.js';
import { revokeAllSessions, userStatusMachine } from '../identity/users.js';
import * as svc from './service.js';

const TAG = ['CORE-04'];
const consentInput = z.object({ type: z.enum(svc.CONSENT_TYPES), version: z.string().min(1).max(64), granted: z.boolean() });

/** Processes deletion requests whose grace period has passed: PII scrub, financial/legal records kept. */
export async function processDeletionRequests(app: AppContext): Promise<number> {
  const grace = await svc.deletionGraceDays(app.pool);
  const due = await q<{ id: string; user_id: string }>(
    app.pool,
    `SELECT id, user_id FROM privacy_requests WHERE request_type = 'DELETE' AND status = 'REQUESTED'
        AND requested_at <= now() - make_interval(days => $1)
      ORDER BY coalesce((result->>'checkedAt')::timestamptz, requested_at) LIMIT 50`,
    [grace],
  );
  let n = 0;
  for (const r of due) {
    const ctx = systemCtx(app, `privacy-delete-${r.id}`);
    await withTx(app.pool, async (tx) => {
      const locked = await maybeOne(tx, `SELECT status, result FROM privacy_requests WHERE id = $1 FOR UPDATE SKIP LOCKED`, [r.id]);
      if (!locked || locked.status !== 'REQUESTED') return;
      const u = await one(tx, `SELECT status FROM users WHERE id = $1 FOR UPDATE`, [r.user_id]);
      if (u.status !== 'PENDING_DELETION') {
        await tx.query(`UPDATE privacy_requests SET status = 'REJECTED', reason = coalesce(reason, '') || ' [account not pending deletion]', completed_at = now() WHERE id = $1`, [r.id]);
        return;
      }
      // obligations may have appeared during the grace period (the user can still sign in): defer, re-check next run
      const blockers = await svc.deletionBlockers(tx, r.user_id);
      if (blockers.length) {
        await tx.query(`UPDATE privacy_requests SET result = $2 WHERE id = $1`, [r.id, JSON.stringify({ deferred: true, blockers, checkedAt: new Date().toISOString() })]);
        if (!locked.result?.deferred) {
          await audit(tx, ctx, { action: 'privacy.delete_deferred', resourceType: 'user', resourceId: r.user_id, after: { requestId: r.id, blockers }, category: 'PRIVACY' });
        }
        return;
      }
      await tx.query(`UPDATE privacy_requests SET status = 'PROCESSING' WHERE id = $1`, [r.id]);
      await svc.scrubUser(tx, ctx, r.user_id);
      await tx.query(`UPDATE privacy_requests SET status = 'COMPLETED', completed_at = now(), result = $2 WHERE id = $1`, [
        r.id,
        JSON.stringify({ scrubbed: true, retained: ['reservations', 'payments', 'ledger', 'consent_records', 'audit_logs', 'disputes'] }),
      ]);
      await emit(tx, ctx, { aggregateType: 'privacy_request', aggregateId: r.id, eventType: 'privacy.completed', payload: { requestId: r.id, userId: r.user_id, type: 'DELETE' } });
      n++;
    });
  }
  return n;
}

/** CORE-04 Consent & Privacy Lifecycle. */
export default async function privacyModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  registerJob('privacy.deletion', 60 * 60 * 1000, processDeletionRequests);
  registerJob('privacy.retention', 6 * 60 * 60 * 1000, async (ctx) => {
    // auth challenges & revoked sessions retention (CORE-04 retention_jobs)
    const a = await ctx.pool.query(`DELETE FROM auth_challenges WHERE expires_at < now() - interval '7 days'`);
    await ctx.pool.query(`UPDATE retention_jobs SET last_run_at = now(), last_result = $1 WHERE data_class = 'auth_challenges'`, [JSON.stringify({ deleted: a.rowCount })]);
  });

  r.get('/v1/consent-documents', {
    schema: { tags: TAG, summary: 'Current consent documents (latest published version per type)', querystring: z.object({ type: z.enum(svc.CONSENT_TYPES).optional() }) },
  }, async (req) => {
    const docs = await svc.currentConsentDocuments(pool, ctxFromRequest(req), req.query.type);
    return { items: docs.map((d) => ({ type: d.consent_type, version: d.version, title: d.title, bodyMd: d.body_md, required: d.required, publishedAt: d.published_at })) };
  });

  r.post('/v1/consents', {
    schema: { tags: TAG, summary: 'Record consent decisions (append-only, with evidence)', body: z.object({ consents: z.array(consentInput).min(1).max(20) }) },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const items = await withTx(pool, (tx) => svc.recordConsents(tx, ctx, ctx.actor!.userId, req.body.consents));
    return reply.status(201).send({ items });
  });

  r.get('/v1/consents', { schema: { summary: 'List consent records of the current user', tags: TAG }, preHandler: requireAuth }, async (req) => {
    const userId = getActor(req).userId;
    return {
      current: await svc.consentState(pool, userId),
      history: await q(pool, `SELECT id, consent_type, version, granted, created_at FROM consent_records WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`, [userId]),
    };
  });

  r.post('/v1/privacy/export', { schema: { tags: TAG, summary: 'Export my data (JSON stored on the privacy request)' }, preHandler: requireAuth }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const item = await withTx(pool, (tx) => svc.requestExport(tx, ctx, ctx.actor!.userId));
    return reply.status(201).send({ item });
  });

  r.get('/v1/privacy/requests', { schema: { summary: 'List privacy requests of the current user', tags: TAG }, preHandler: requireAuth }, async (req) => ({
    items: await q(pool, `SELECT id, request_type, status, reason, requested_at, completed_at FROM privacy_requests WHERE user_id = $1 ORDER BY requested_at DESC`, [getActor(req).userId]),
  }));

  r.get('/v1/privacy/requests/:id', { schema: { summary: 'Get a privacy request', tags: TAG, params: idParams }, preHandler: requireAuth }, async (req) => {
    const item = await maybeOne(pool, `SELECT * FROM privacy_requests WHERE id = $1 AND user_id = $2`, [req.params.id, getActor(req).userId]);
    if (!item) throw notFound('Privacy request');
    return { item };
  });

  r.post('/v1/privacy/delete', {
    schema: {
      tags: TAG,
      summary: 'Request account deletion. Sessions are revoked; PII is scrubbed after the grace period (financial/legal records retained).',
      body: z.object({ confirm: z.literal('DELETE'), password: z.string().max(256).optional(), reason: z.string().max(1000).optional() }),
    },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const actor = ctx.actor!;
    const item = await withTx(pool, async (tx) => {
      const u = await one(tx, `SELECT status, password_hash FROM users WHERE id = $1 FOR UPDATE`, [actor.userId]);
      // re-authentication: password when the account has one, otherwise AAL2 if MFA is enrolled
      if (u.password_hash) {
        if (!req.body.password || !(await verifyPassword(req.body.password, u.password_hash))) throw new AppError(401, 'INVALID_CREDENTIALS', 'Password is incorrect');
      } else if (actor.aal !== 'aal2' && (await maybeOne(tx, `SELECT 1 FROM mfa_factors WHERE user_id = $1 AND status = 'VERIFIED'`, [actor.userId]))) {
        throw forbidden('AAL2_REQUIRED', 'Multi-factor authentication is required for this action');
      }
      if (await maybeOne(tx, `SELECT 1 FROM privacy_requests WHERE user_id = $1 AND request_type = 'DELETE' AND status IN ('REQUESTED','PROCESSING')`, [actor.userId])) {
        throw conflict('DELETION_ALREADY_REQUESTED', 'A deletion request is already pending');
      }
      const blockers = await svc.deletionBlockers(tx, actor.userId);
      if (blockers.length) throw svc.deletionBlocked(blockers);
      const row = await one(tx, `INSERT INTO privacy_requests(user_id, request_type, status, reason) VALUES ($1,'DELETE','REQUESTED',$2) RETURNING *`, [actor.userId, req.body.reason ?? null]);
      await userStatusMachine.transition(tx, ctx, { table: 'users', id: actor.userId, to: 'PENDING_DELETION', reason: 'privacy deletion requested' });
      await revokeAllSessions(tx, actor.userId, 'DELETION_REQUESTED');
      await emit(tx, ctx, { aggregateType: 'privacy_request', aggregateId: row.id, eventType: 'privacy.requested', payload: { requestId: row.id, userId: actor.userId, type: 'DELETE' } });
      await audit(tx, ctx, { action: 'privacy.delete_requested', resourceType: 'user', resourceId: actor.userId, after: { requestId: row.id }, category: 'PRIVACY' });
      const grace = await svc.deletionGraceDays(tx);
      return { ...row, scheduled_for: new Date(new Date(row.requested_at).getTime() + grace * 86400_000).toISOString() };
    });
    return reply.status(202).send({ item });
  });

  r.post('/v1/privacy/delete/cancel', { schema: { tags: TAG, summary: 'Cancel a pending deletion during the grace period' }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    const actor = ctx.actor!;
    return withTx(pool, async (tx) => {
      const row = await maybeOne(tx, `SELECT id FROM privacy_requests WHERE user_id = $1 AND request_type = 'DELETE' AND status = 'REQUESTED' FOR UPDATE`, [actor.userId]);
      if (!row) throw notFound('Pending deletion request');
      await tx.query(`UPDATE privacy_requests SET status = 'REJECTED', reason = 'cancelled by user', completed_at = now() WHERE id = $1`, [row.id]);
      await userStatusMachine.transition(tx, ctx, { table: 'users', id: actor.userId, to: 'ACTIVE', from: 'PENDING_DELETION', reason: 'deletion cancelled' });
      await audit(tx, ctx, { action: 'privacy.delete_cancelled', resourceType: 'user', resourceId: actor.userId, after: { requestId: row.id }, category: 'PRIVACY' });
      return { cancelled: true };
    });
  });

  // staff view of privacy requests (DPO / compliance)
  r.get('/v1/admin/privacy/requests', {
    schema: { summary: 'List privacy requests', tags: TAG, querystring: z.object({ status: z.enum(['REQUESTED', 'PROCESSING', 'COMPLETED', 'REJECTED']).optional(), userId: z.uuid().optional() }) },
    preHandler: requireRole('ADMIN', 'COMPLIANCE'),
  }, async (req) => ({
    items: await q(
      pool,
      `SELECT id, user_id, request_type, status, reason, requested_at, completed_at FROM privacy_requests
        WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR user_id = $2) ORDER BY requested_at DESC LIMIT 200`,
      [req.query.status ?? null, req.query.userId ?? null],
    ),
  }));
}
