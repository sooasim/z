import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireRole, getActor } from '../../platform/auth.js';
import { ctxFromRequest, systemCtx, type AppContext } from '../../platform/context.js';
import { withTx, q, maybeOne } from '../../platform/db.js';
import { idParams } from '../../platform/http.js';
import { idempotencyKeyFrom, withIdempotency } from '../../platform/idempotency.js';
import { onEvent } from '../../platform/outbox.js';
import { registerJob } from '../../platform/jobs.js';
import { registerPaymentSubject } from '../../platform/payment-subjects.js';
import { notFound } from '../../platform/errors.js';
import * as S from './schemas.js';
import {
  createProfile, updateProfile, publishProfile, publicationDenied, unpublishProfile, getPublicProfile, getMyProfile,
  submitQualification, decideQualification, reevaluatePaidGuide,
} from './profile.js';
import { replaceAvailability, freeIntervals, toIso } from './availability.js';
import { searchGuides, RANK_WEIGHTS } from './search.js';
import { createRequest, createOffer, counterOffer, acceptOffer, declineRequest, cancelRequest, getRequestFor, listRequests, expireRequests } from './requests.js';
import {
  guideBookingPaymentSubject, getBookingFor, listBookings, startBooking, completeBooking, cancelBooking, disputeBooking,
  handleReviewCreated, handleGuideDisputeResolved, runBookingLifecycle,
} from './bookings.js';

export { evaluateGuideEligibility } from './eligibility.js';
export { computeGuideRefund, guideBookingPaymentSubject } from './bookings.js';
export { searchGuides } from './search.js';

/** Job: mark lapsed qualifications EXPIRED and re-run the paid gate for published paid guides (invariant 7). */
export async function runQualificationExpiry(app: AppContext): Promise<number> {
  await q(
    app.pool,
    `UPDATE guide_qualifications SET status = 'EXPIRED' WHERE status = 'VERIFIED' AND valid_until IS NOT NULL AND valid_until < current_date `,
  );
  const guides = await q<{ user_id: string }>(
    app.pool,
    // every PUBLISHED paid-type profile, not only paid_enabled ones: one left published with paid selling off must be hidden too
    `SELECT user_id FROM guide_profiles WHERE status = 'PUBLISHED' AND guide_type IN ('PAID','PROFESSIONAL') LIMIT 1000`,
  );
  let disabled = 0;
  for (const g of guides) {
    await withTx(app.pool, async (tx) => {
      if (!(await reevaluatePaidGuide(tx, systemCtx(app, `job-guide-qualification-${g.user_id}`), g.user_id))) disabled++;
    }).catch((err) => app.log.warn({ err, guideId: g.user_id }, 'guide paid re-evaluation failed'));
  }
  return disabled;
}

/** GUIDE-01..05 Guide Friend — routes, event handlers, payment subject and jobs. */
export default async function guideModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  registerPaymentSubject('GUIDE_BOOKING', guideBookingPaymentSubject);
  onEvent('review.created', 'guide.review-tracker', handleReviewCreated);
  // TRUST-03 dispute resolution lifts the DISPUTED freeze of a guide booking
  onEvent('dispute.resolved', 'guide.dispute-resolution', handleGuideDisputeResolved);
  registerJob('guide.request-expiry', 60_000, expireRequests);
  registerJob('guide.booking-lifecycle', 60_000, runBookingLifecycle);
  registerJob('guide.qualification-expiry', 3_600_000, runQualificationExpiry);

  // ------------------------------------------------------------ GUIDE-01 profile & type
  r.post('/v1/guides/profile', { schema: { tags: ['GUIDE-01'], body: S.profileCreateBody }, preHandler: requireAuth }, async (req, reply) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    const item = await withTx(pool, (tx) => createProfile(tx, ctx, actor, req.body));
    return reply.status(201).send({ item });
  });

  r.patch('/v1/guides/profile', { schema: { tags: ['GUIDE-01'], body: S.profilePatchBody }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    return { item: await withTx(pool, (tx) => updateProfile(tx, ctx, actor, req.body)) };
  });

  r.post('/v1/guides/profile/publish', { schema: { tags: ['GUIDE-01'] }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    const res = await withTx(pool, (tx) => publishProfile(tx, ctx, actor));
    // the DENY compliance decision is committed above; respond 422 with the unmet predicates
    if (!res.published) throw publicationDenied(res);
    return { item: res.profile, eligibility: res.eligibility };
  });

  r.post('/v1/guides/profile/unpublish', { schema: { tags: ['GUIDE-01'] }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    return { item: await withTx(pool, (tx) => unpublishProfile(tx, ctx, actor)) };
  });

  r.get('/v1/guides/me', { schema: { tags: ['GUIDE-01'] }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req);
    const res = await getMyProfile(pool, actor);
    return { item: res.profile, qualifications: res.qualifications, eligibility: res.eligibility };
  });

  r.get('/v1/guides/:id', { schema: { tags: ['GUIDE-01'], params: idParams } }, async (req) => {
    return { item: await getPublicProfile(pool, req.params.id) };
  });

  r.post('/v1/guides/qualifications', { schema: { tags: ['GUIDE-01'], body: S.qualificationBody }, preHandler: requireAuth }, async (req, reply) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    const item = await withTx(pool, (tx) => submitQualification(tx, ctx, actor, req.body));
    return reply.status(201).send({ item });
  });

  r.get(
    '/v1/admin/guide-qualifications',
    { schema: { tags: ['GUIDE-01'], querystring: z.object({ status: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'EXPIRED']).default('PENDING'), limit: z.coerce.number().int().min(1).max(100).default(50) }) }, preHandler: requireRole('COMPLIANCE', 'ADMIN') },
    async (req) => {
      const items = await q(
        pool,
        `SELECT q.id, q.guide_id, q.qualification_type, q.reference_no, q.document_media_id, q.valid_until, q.status, q.created_at, g.guide_type
           FROM guide_qualifications q LEFT JOIN guide_profiles g ON g.user_id = q.guide_id
          WHERE q.status = $1 ORDER BY q.created_at LIMIT $2`,
        [req.query.status, req.query.limit],
      );
      return { items };
    },
  );

  for (const [action, decision] of [['verify', 'VERIFIED'], ['reject', 'REJECTED']] as const) {
    r.post(
      `/v1/admin/guide-qualifications/:id/${action}`,
      { schema: { tags: ['GUIDE-01'], params: idParams, body: S.reviewDecisionBody.optional() }, preHandler: requireRole('COMPLIANCE', 'ADMIN') },
      async (req) => {
        const actor = getActor(req), ctx = ctxFromRequest(req);
        return { item: await withTx(pool, (tx) => decideQualification(tx, ctx, actor, req.params.id, decision, req.body?.reason)) };
      },
    );
  }

  // ------------------------------------------------------------ GUIDE-02 availability
  r.put('/v1/guides/me/availability', { schema: { tags: ['GUIDE-02'], body: S.availabilityBody }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    return { item: await withTx(pool, (tx) => replaceAvailability(tx, ctx, actor.userId, req.body)) };
  });

  r.get('/v1/guides/:id/availability', { schema: { tags: ['GUIDE-02'], params: idParams, querystring: S.availabilityQuery } }, async (req) => {
    const id = req.params.id;
    const visible = await maybeOne(pool, `SELECT 1 FROM guide_profiles WHERE user_id = $1 AND (status = 'PUBLISHED' OR user_id = $2)`, [id, req.actor?.userId ?? null]);
    if (!visible) throw notFound('Guide');
    const free = await freeIntervals(pool, id, new Date(req.query.from), new Date(req.query.to));
    return { items: toIso(free) };
  });

  // ------------------------------------------------------------ GUIDE-03 search & matching
  r.get('/v1/search/guides', { schema: { tags: ['GUIDE-03'], querystring: S.searchQuery } }, async (req) => {
    const items = await searchGuides(pool, { ...req.query, excludeUserId: req.actor?.userId });
    return { items, weights: RANK_WEIGHTS };
  });

  // ------------------------------------------------------------ GUIDE-04 request & offer
  r.post('/v1/guide-requests', { schema: { tags: ['GUIDE-04'], body: S.requestCreateBody }, preHandler: requireAuth }, async (req, reply) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    const res = await withIdempotency(pool, `guide.request:${actor.userId}`, idempotencyKeyFrom(req, false), req.body, async (tx) => ({
      status: 201,
      body: { item: await createRequest(tx, ctx, actor, req.body) },
    }));
    return reply.status(res.status).send(res.body);
  });

  r.get('/v1/guide-requests', { schema: { tags: ['GUIDE-04'], querystring: S.requestListQuery }, preHandler: requireAuth }, async (req) => {
    return listRequests(pool, getActor(req), req.query);
  });

  r.get('/v1/guide-requests/:id', { schema: { tags: ['GUIDE-04'], params: idParams }, preHandler: requireAuth }, async (req) => {
    return { item: await getRequestFor(pool, getActor(req), req.params.id) };
  });

  r.post('/v1/guide-requests/:id/offers', { schema: { tags: ['GUIDE-04'], params: idParams, body: S.offerBody }, preHandler: requireAuth }, async (req, reply) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    const res = await withTx(pool, (tx) => createOffer(tx, ctx, actor, req.params.id, req.body));
    return reply.status(201).send({ item: res.request, offer: res.offer });
  });

  r.post('/v1/guide-requests/:id/counter', { schema: { tags: ['GUIDE-04'], params: idParams, body: S.counterBody }, preHandler: requireAuth }, async (req, reply) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    const res = await withTx(pool, (tx) => counterOffer(tx, ctx, actor, req.params.id, req.body));
    return reply.status(201).send({ item: res.request, offer: res.offer });
  });

  r.post('/v1/guide-requests/:id/accept', { schema: { tags: ['GUIDE-04', 'GUIDE-05'], params: idParams, body: S.acceptBody }, preHandler: requireAuth }, async (req, reply) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    const key = idempotencyKeyFrom(req); // guide booking creation requires Idempotency-Key
    const res = await withIdempotency(pool, `guide.accept:${actor.userId}`, key, { id: req.params.id, ...req.body }, async (tx) => {
      const out = await acceptOffer(tx, ctx, actor, req.params.id, req.body.offerVersion);
      return { status: 201, body: { item: out.request, offer: out.offer, booking: out.booking } };
    });
    return reply.status(res.status).send(res.body);
  });

  r.post('/v1/guide-requests/:id/decline', { schema: { tags: ['GUIDE-04'], params: idParams, body: S.reasonBody.optional() }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    return { item: await withTx(pool, (tx) => declineRequest(tx, ctx, actor, req.params.id, req.body?.reason)) };
  });

  r.post('/v1/guide-requests/:id/cancel', { schema: { tags: ['GUIDE-04'], params: idParams, body: S.reasonBody.optional() }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    return { item: await withTx(pool, (tx) => cancelRequest(tx, ctx, actor, req.params.id, req.body?.reason)) };
  });

  // ------------------------------------------------------------ GUIDE-05 booking FSM
  r.get('/v1/guide-bookings', { schema: { tags: ['GUIDE-05'], querystring: S.bookingListQuery }, preHandler: requireAuth }, async (req) => {
    return listBookings(pool, getActor(req), req.query);
  });

  r.get('/v1/guide-bookings/:id', { schema: { tags: ['GUIDE-05'], params: idParams }, preHandler: requireAuth }, async (req) => {
    return { item: await getBookingFor(pool, getActor(req), req.params.id) };
  });

  r.post('/v1/guide-bookings/:id/start', { schema: { tags: ['GUIDE-05'], params: idParams }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    return { item: await withTx(pool, (tx) => startBooking(tx, ctx, actor, req.params.id)) };
  });

  r.post('/v1/guide-bookings/:id/complete', { schema: { tags: ['GUIDE-05'], params: idParams }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    return { item: await withTx(pool, (tx) => completeBooking(tx, ctx, actor, req.params.id)) };
  });

  r.post('/v1/guide-bookings/:id/cancel', { schema: { tags: ['GUIDE-05'], params: idParams, body: S.reasonBody.optional() }, preHandler: requireAuth }, async (req, reply) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    const key = idempotencyKeyFrom(req); // may create a refund request
    const res = await withIdempotency(pool, `guide.booking.cancel:${actor.userId}`, key, { id: req.params.id, ...(req.body ?? {}) }, async (tx) => {
      const out = await cancelBooking(tx, ctx, actor, req.params.id, req.body?.reason);
      return { body: { item: out.booking, refund: out.refund } };
    });
    return reply.status(res.status).send(res.body);
  });

  r.post('/v1/guide-bookings/:id/dispute', { schema: { tags: ['GUIDE-05'], params: idParams, body: S.disputeBody }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req), ctx = ctxFromRequest(req);
    const out = await withTx(pool, (tx) => disputeBooking(tx, ctx, actor, req.params.id, req.body.reason));
    return { item: out.booking, disputeId: out.disputeId };
  });
}
