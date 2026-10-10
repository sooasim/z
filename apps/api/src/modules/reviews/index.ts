import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAuth, requireRole } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { maybeOne, q, withTx } from '../../platform/db.js';
import { notFound } from '../../platform/errors.js';
import { decodeCursor, idParams, page, pagination } from '../../platform/http.js';
import { contentLocale, contentTranslation, localize } from '../../platform/content-locale.js';
import * as svc from './service.js';

const TAG = ['TRUST-02'];

/** Member-written text in the review DTOs. */
const REVIEW_TEXT = ['items[].body', 'items[].response.body'] as const;
const ITEM_TEXT = ['item.body', 'item.response.body'] as const;

const SELECT = `SELECT r.*, u.display_name AS author_name, rr.body AS response_body, rr.created_at AS response_created_at
                  FROM reviews r JOIN users u ON u.id = r.author_id LEFT JOIN review_responses rr ON rr.review_id = r.id`;

/** TRUST-02 Reviews & Reputation. */
export default async function reviewsModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  r.post('/v1/reviews', {
    schema: {
      tags: TAG,
      summary: 'Write a review for a completed transaction you were a party to (30-day window, one per target)',
      body: z.object({
        transactionType: z.enum(svc.TRANSACTION_TYPES),
        transactionId: z.uuid(),
        targetType: z.enum(svc.TARGET_TYPES),
        targetId: z.uuid().optional(),
        rating: z.number().int().min(1).max(5),
        subRatings: z.record(z.string().regex(/^[a-z_]{2,30}$/), z.number().int().min(1).max(5)).optional(),
        body: z.string().trim().min(1).max(5000).optional(),
      }),
    },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const item = await withTx(pool, (tx) => svc.createReview(tx, ctxFromRequest(req), req.body));
    return reply.status(201).send({ item: svc.presentReview(item) });
  });

  r.get('/v1/reviews', {
    schema: { tags: TAG, summary: 'Published reviews for a target with reputation summary', querystring: pagination.extend({ targetType: z.enum(svc.TARGET_TYPES), targetId: z.uuid() }) },
  }, async (req) => {
    const { targetType, targetId, limit, cursor } = req.query;
    const c = decodeCursor(cursor);
    const rows = await q(
      pool,
      `${SELECT} WHERE r.target_type = $1 AND r.target_id = $2 AND r.status = 'PUBLISHED'
          AND ($3::timestamptz IS NULL OR (r.created_at, r.id) < ($3::timestamptz, $4::uuid))
        ORDER BY r.created_at DESC, r.id DESC LIMIT $5`,
      [targetType, targetId, c?.createdAt ?? null, c?.id ?? null, limit + 1],
    );
    const p = page(rows, limit);
    const rep = await maybeOne(pool, `SELECT review_count, rating_avg, updated_at FROM reputation_scores WHERE target_type = $1 AND target_id = $2`, [targetType, targetId]);
    // Review bodies and host replies are member-written, so a reader in another language gets them
    // translated (TRUST-02 + content.auto_translate); uncached text stays in the source language.
    const body = { items: p.items.map(svc.presentReview), nextCursor: p.nextCursor, summary: { reviewCount: rep?.review_count ?? 0, ratingAvg: rep?.rating_avg ?? null } };
    const locale = contentLocale(req);
    return localize(await contentTranslation(ctxFromRequest(req), locale), body, REVIEW_TEXT, locale);
  });

  r.get('/v1/reviews/:id', { schema: { summary: 'Get a review', tags: TAG, params: idParams } }, async (req) => {
    const row = await maybeOne(pool, `${SELECT} WHERE r.id = $1 AND r.status = 'PUBLISHED'`, [req.params.id]);
    if (!row) throw notFound('Review');
    const locale = contentLocale(req);
    return localize(await contentTranslation(ctxFromRequest(req), locale), { item: svc.presentReview(row) }, ITEM_TEXT, locale);
  });

  r.get('/v1/me/reviews', { schema: { tags: TAG, summary: 'Reviews I wrote and reviews I can still write' }, preHandler: requireAuth }, async (req) => {
    const uid = getActor(req).userId;
    const written = await q(pool, `${SELECT} WHERE r.author_id = $1 ORDER BY r.created_at DESC LIMIT 200`, [uid]);
    return { written: written.map(svc.presentReview), pending: await svc.pendingReviewTasks(pool, uid) };
  });

  r.post('/v1/reviews/:id/response', {
    schema: { tags: TAG, summary: 'Public response by the reviewed party (one per review)', params: idParams, body: z.object({ body: z.string().trim().min(1).max(3000) }) },
    preHandler: requireAuth,
  }, async (req, reply) => reply.status(201).send({ item: await withTx(pool, (tx) => svc.respond(tx, ctxFromRequest(req), req.params.id, req.body.body)) }));

  r.post('/v1/reviews/:id/report', {
    schema: { summary: 'Report a review', tags: TAG, params: idParams, body: z.object({ reason: z.string().trim().min(3).max(1000) }) },
    preHandler: requireAuth,
  }, async (req, reply) => reply.status(201).send({ item: await withTx(pool, (tx) => svc.report(tx, ctxFromRequest(req), req.params.id, req.body.reason)) }));

  // ---- moderation (ADMIN / SUPPORT, AAL2) ----------------------------------------------------------------------
  const mod = requireRole('ADMIN', 'SUPPORT');
  r.get('/v1/admin/review-reports', {
    schema: { summary: 'List review reports', tags: TAG, querystring: z.object({ status: z.enum(['OPEN', 'UPHELD', 'DISMISSED']).default('OPEN') }) },
    preHandler: mod,
  }, async (req) => ({
    items: await q(
      pool,
      `SELECT rp.*, r.status AS review_status, r.rating, r.body AS review_body, r.target_type, r.target_id
         FROM review_reports rp JOIN reviews r ON r.id = rp.review_id WHERE rp.status = $1 ORDER BY rp.created_at LIMIT 200`,
      [req.query.status],
    ),
  }));

  r.post('/v1/admin/reviews/:id/moderate', {
    schema: { summary: 'Moderate a review', tags: TAG, params: idParams, body: z.object({ action: z.enum(['HIDE', 'REMOVE', 'RESTORE']), reason: z.string().trim().min(3).max(1000) }) },
    preHandler: mod,
  }, async (req) => ({ item: svc.presentReview(await withTx(pool, (tx) => svc.moderate(tx, ctxFromRequest(req), req.params.id, req.body))) }));

  r.post('/v1/admin/review-reports/:id/dismiss', { schema: { summary: 'Dismiss a review report', tags: TAG, params: idParams }, preHandler: mod }, async (req) => ({
    item: await withTx(pool, (tx) => svc.dismissReport(tx, ctxFromRequest(req), req.params.id)),
  }));
}
