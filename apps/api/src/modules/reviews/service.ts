import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { StateMachine } from '../../platform/fsm.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { notify } from '../../platform/notify.js';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { reviewTargetOwners } from '../disputes/parties.js';

export const TRANSACTION_TYPES = ['RESERVATION', 'EXCHANGE', 'GUIDE_BOOKING', 'ORDER'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export const TARGET_TYPES = ['PROPERTY', 'HOST', 'GUEST', 'EXCHANGE_PARTNER', 'GUIDE', 'TRAVELER', 'TRAVEL_PRODUCT'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];
export const REVIEW_WINDOW_DAYS = 30;

export type ReviewStatus = 'PENDING' | 'PUBLISHED' | 'HIDDEN' | 'REMOVED';
export const reviewMachine = new StateMachine<ReviewStatus>('review', {
  PENDING: ['PUBLISHED', 'HIDDEN', 'REMOVED'],
  PUBLISHED: ['HIDDEN', 'REMOVED'],
  HIDDEN: ['PUBLISHED', 'REMOVED'],
  REMOVED: [],
});

interface Eligibility {
  targetId: string;
  completedAt: Date;
}

/** Latest transition time into one of `states` for an aggregate (aggregate type naming is owned by each domain). */
async function transitionTime(db: Db, aggregateId: string, states: string[]): Promise<Date | null> {
  const r = await maybeOne<{ created_at: Date }>(db, `SELECT created_at FROM state_transitions WHERE aggregate_id = $1 AND to_state = ANY($2) ORDER BY id DESC LIMIT 1`, [aggregateId, states]);
  return r?.created_at ?? null;
}

const asDate = (v: unknown): Date | null => (v ? new Date(v as string) : null);

/**
 * Resolve the review target server-side from the transaction and check eligibility:
 * the author must be the right party, the transaction COMPLETED, and the 30-day window open.
 * `to_jsonb(row)` is used to read optional lifecycle columns other domains may add (completed_at, fulfilled_at).
 */
export async function checkEligibility(db: Db, authorId: string, transactionType: TransactionType, transactionId: string, targetType: TargetType, targetId?: string): Promise<Eligibility> {
  const notParty = () => forbidden('NOT_A_PARTY', 'You were not a party to this transaction in a role that can write this review');
  const notCompleted = () => unprocessable('TRANSACTION_NOT_COMPLETED', 'Reviews are allowed only for completed transactions');
  let derived: string | null = null;
  let completedAt: Date | null = null;

  switch (transactionType) {
    case 'RESERVATION': {
      const r = await maybeOne(db, `SELECT r.guest_id, r.host_id, r.property_id, r.status, r.check_out, to_jsonb(r) AS j FROM reservations r WHERE r.id = $1`, [transactionId]);
      if (!r) throw notFound('Reservation');
      if (authorId === r.guest_id && targetType === 'PROPERTY') derived = r.property_id;
      else if (authorId === r.guest_id && targetType === 'HOST') derived = r.host_id;
      else if (authorId === r.host_id && targetType === 'GUEST') derived = r.guest_id;
      else throw notParty();
      if (r.status !== 'COMPLETED') throw notCompleted();
      completedAt = asDate(r.j.completed_at) ?? (await transitionTime(db, transactionId, ['COMPLETED'])) ?? asDate(`${r.check_out}T00:00:00Z`);
      break;
    }
    case 'EXCHANGE': {
      const e = await maybeOne(db, `SELECT e.requester_id, e.responder_id, e.status, greatest(upper(e.dates_a), upper(e.dates_b)) AS ended, to_jsonb(e) AS j FROM exchange_requests e WHERE e.id = $1`, [transactionId]);
      if (!e) throw notFound('Exchange');
      if (targetType !== 'EXCHANGE_PARTNER' || (authorId !== e.requester_id && authorId !== e.responder_id)) throw notParty();
      derived = authorId === e.requester_id ? e.responder_id : e.requester_id;
      if (!['COMPLETED', 'REVIEWED'].includes(e.status)) throw notCompleted();
      completedAt = asDate(e.j.completed_at) ?? (await transitionTime(db, transactionId, ['COMPLETED'])) ?? asDate(`${e.ended}T00:00:00Z`);
      break;
    }
    case 'GUIDE_BOOKING': {
      const b = await maybeOne(db, `SELECT b.traveler_id, b.guide_id, b.status, b.end_at, to_jsonb(b) AS j FROM guide_bookings b WHERE b.id = $1`, [transactionId]);
      if (!b) throw notFound('Guide booking');
      if (authorId === b.traveler_id && targetType === 'GUIDE') derived = b.guide_id;
      else if (authorId === b.guide_id && targetType === 'TRAVELER') derived = b.traveler_id;
      else throw notParty();
      if (!['COMPLETED', 'REVIEWED'].includes(b.status)) throw notCompleted();
      completedAt = asDate(b.j.completed_at) ?? (await transitionTime(db, transactionId, ['COMPLETED'])) ?? asDate(b.end_at);
      break;
    }
    case 'ORDER': {
      const o = await maybeOne(db, `SELECT o.buyer_id, o.status, o.updated_at, to_jsonb(o) AS j FROM orders o WHERE o.id = $1`, [transactionId]);
      if (!o) throw notFound('Order');
      if (authorId !== o.buyer_id || targetType !== 'TRAVEL_PRODUCT') throw notParty();
      if (!targetId) throw unprocessable('TARGET_REQUIRED', 'targetId (travel product) is required for ORDER reviews');
      const inOrder = await maybeOne(
        db,
        `SELECT 1 FROM order_items i
           LEFT JOIN travel_departures d ON i.sellable_type = 'TRAVEL_DEPARTURE' AND d.id = i.sellable_id
           LEFT JOIN travel_product_options po ON i.sellable_type = 'TRAVEL_OPTION' AND po.id = i.sellable_id
          WHERE i.order_id = $1 AND i.status = 'ACTIVE' AND coalesce(d.product_id, po.product_id) = $2 LIMIT 1`,
        [transactionId, targetId],
      );
      if (!inOrder) throw unprocessable('TARGET_NOT_IN_TRANSACTION', 'This product was not part of the order');
      derived = targetId;
      if (o.status !== 'FULFILLED') throw notCompleted();
      completedAt = asDate(o.j.fulfilled_at) ?? (await transitionTime(db, transactionId, ['FULFILLED'])) ?? asDate(o.updated_at);
      break;
    }
  }
  if (targetId && targetId !== derived) throw unprocessable('TARGET_NOT_IN_TRANSACTION', 'targetId does not match the transaction');
  if (!completedAt || Date.now() - completedAt.getTime() > REVIEW_WINDOW_DAYS * 86400_000) {
    throw unprocessable('REVIEW_WINDOW_CLOSED', `Reviews must be written within ${REVIEW_WINDOW_DAYS} days of completion`);
  }
  return { targetId: derived!, completedAt };
}

/**
 * Recompute the reputation projection for a target from PUBLISHED reviews (idempotent).
 * Writers are serialized per target (transaction-scoped advisory lock) so the aggregate is computed after any
 * concurrent writer for the same target has committed; otherwise the last upsert wins with a stale count/avg.
 */
export async function recomputeReputation(db: Db, targetType: string, targetId: string) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`reputation:${targetType}:${targetId}`]);
  await db.query(
    `INSERT INTO reputation_scores(target_type, target_id, review_count, rating_avg, updated_at)
     SELECT $1, $2, count(*)::int, round(avg(rating)::numeric, 2), now() FROM reviews WHERE target_type = $1 AND target_id = $2 AND status = 'PUBLISHED'
     ON CONFLICT (target_type, target_id) DO UPDATE SET review_count = EXCLUDED.review_count, rating_avg = EXCLUDED.rating_avg, updated_at = now()`,
    [targetType, targetId],
  );
}

export async function createReview(
  tx: Tx,
  ctx: Ctx,
  input: { transactionType: TransactionType; transactionId: string; targetType: TargetType; targetId?: string; rating: number; subRatings?: Record<string, number>; body?: string },
) {
  const authorId = ctx.actor!.userId;
  const el = await checkEligibility(tx, authorId, input.transactionType, input.transactionId, input.targetType, input.targetId);
  if (input.transactionType === 'EXCHANGE') {
    // both partners may review at the same moment: serialize per exchange so the second writer's "both reviewed?"
    // count sees the first writer's committed review and exchange.reviews.completed is emitted exactly once
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`review:EXCHANGE:${input.transactionId}`]);
  }
  await tx.query('SAVEPOINT review_insert');
  let review: any;
  try {
    review = await one(
      tx,
      `INSERT INTO reviews(author_id, target_type, target_id, transaction_type, transaction_id, rating, sub_ratings, body, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PUBLISHED') RETURNING *`,
      [authorId, input.targetType, el.targetId, input.transactionType, input.transactionId, input.rating, JSON.stringify(input.subRatings ?? {}), input.body ?? null],
    );
    await tx.query('RELEASE SAVEPOINT review_insert');
  } catch (e: any) {
    await tx.query('ROLLBACK TO SAVEPOINT review_insert');
    if (e?.code === '23505') throw conflict('REVIEW_EXISTS', 'You already reviewed this target for this transaction');
    throw e;
  }
  await recomputeReputation(tx, review.target_type, review.target_id);
  await emit(tx, ctx, {
    aggregateType: 'review',
    aggregateId: review.id,
    eventType: 'review.created',
    payload: {
      reviewId: review.id,
      authorId,
      targetType: review.target_type,
      targetId: review.target_id,
      transactionType: review.transaction_type,
      transactionId: review.transaction_id,
      rating: review.rating,
    },
  });
  if (input.transactionType === 'EXCHANGE') {
    const authors = await one<{ n: number }>(
      tx,
      `SELECT count(DISTINCT author_id)::int AS n FROM reviews WHERE transaction_type = 'EXCHANGE' AND transaction_id = $1 AND target_type = 'EXCHANGE_PARTNER'`,
      [input.transactionId],
    );
    if (authors.n >= 2) {
      await emit(tx, ctx, { aggregateType: 'exchange', aggregateId: input.transactionId, eventType: 'exchange.reviews.completed', payload: { exchangeId: input.transactionId } });
    }
  }
  for (const owner of await reviewTargetOwners(tx, review.target_type, review.target_id)) {
    if (owner === authorId) continue;
    await notify(tx, ctx, { userId: owner, templateKey: 'review.received', title: '새 리뷰가 등록되었습니다', body: `You received a ${review.rating}-star review.`, data: { reviewId: review.id }, dedupeKey: `review.received:${review.id}` });
  }
  return review;
}

export async function respond(tx: Tx, ctx: Ctx, reviewId: string, body: string) {
  const r = await maybeOne(tx, `SELECT * FROM reviews WHERE id = $1`, [reviewId]);
  if (!r || r.status === 'REMOVED') throw notFound('Review');
  const owners = await reviewTargetOwners(tx, r.target_type, r.target_id);
  if (!owners.includes(ctx.actor!.userId)) throw forbidden('NOT_REVIEW_SUBJECT', 'Only the reviewed party can respond');
  const ins = await tx.query(`INSERT INTO review_responses(review_id, author_id, body) VALUES ($1,$2,$3) ON CONFLICT (review_id) DO NOTHING RETURNING *`, [reviewId, ctx.actor!.userId, body]);
  if (!ins.rows[0]) throw conflict('RESPONSE_EXISTS', 'This review already has a response');
  await audit(tx, ctx, { action: 'review.responded', resourceType: 'review', resourceId: reviewId, category: 'CONTENT' });
  await emit(tx, ctx, { aggregateType: 'review', aggregateId: reviewId, eventType: 'review.responded', payload: { reviewId, authorId: ctx.actor!.userId } });
  return ins.rows[0];
}

export async function report(tx: Tx, ctx: Ctx, reviewId: string, reason: string) {
  const r = await maybeOne(tx, `SELECT author_id, status FROM reviews WHERE id = $1`, [reviewId]);
  if (!r || r.status === 'REMOVED') throw notFound('Review');
  if (r.author_id === ctx.actor!.userId) throw unprocessable('CANNOT_REPORT_OWN', 'You cannot report your own review');
  const ins = await tx.query(`INSERT INTO review_reports(review_id, reporter_id, reason) VALUES ($1,$2,$3) ON CONFLICT (review_id, reporter_id) DO NOTHING RETURNING *`, [reviewId, ctx.actor!.userId, reason]);
  if (!ins.rows[0]) throw conflict('ALREADY_REPORTED', 'You already reported this review');
  await emit(tx, ctx, { aggregateType: 'review', aggregateId: reviewId, eventType: 'review.reported', payload: { reviewId, reportId: ins.rows[0].id } });
  return ins.rows[0];
}

/** Staff may not moderate a review they wrote or one about something they own (same rule as other staff decisions). */
async function assertNoModerationConflict(db: Db, ctx: Ctx, review: { author_id: string; target_type: string; target_id: string }) {
  const me = ctx.actor!.userId;
  if (review.author_id === me || (await reviewTargetOwners(db, review.target_type, review.target_id)).includes(me)) {
    throw forbidden('CONFLICT_OF_INTEREST', 'You cannot moderate a review you wrote or one about your own listing or profile');
  }
}

export async function moderate(tx: Tx, ctx: Ctx, reviewId: string, input: { action: 'HIDE' | 'REMOVE' | 'RESTORE'; reason: string }) {
  const current = await maybeOne(tx, `SELECT author_id, target_type, target_id FROM reviews WHERE id = $1`, [reviewId]);
  if (!current) throw notFound('Review');
  await assertNoModerationConflict(tx, ctx, current);
  const to: ReviewStatus = input.action === 'HIDE' ? 'HIDDEN' : input.action === 'REMOVE' ? 'REMOVED' : 'PUBLISHED';
  const { row, from } = await reviewMachine.transition(tx, ctx, {
    table: 'reviews',
    id: reviewId,
    to,
    reason: input.reason,
    actorType: 'ADMIN',
    set: { moderation_reason: input.reason, moderated_by: ctx.actor!.userId, moderated_at: new Date(), updated_at: new Date() },
  });
  await tx.query(`UPDATE review_reports SET status = $2 WHERE review_id = $1 AND status = 'OPEN'`, [reviewId, to === 'PUBLISHED' ? 'DISMISSED' : 'UPHELD']);
  await recomputeReputation(tx, row.target_type, row.target_id);
  await audit(tx, ctx, { action: 'review.moderated', resourceType: 'review', resourceId: reviewId, before: { status: from }, after: { status: to }, reason: input.reason, category: 'CONTENT' });
  await emit(tx, ctx, { aggregateType: 'review', aggregateId: reviewId, eventType: 'review.moderated', payload: { reviewId, from, to, targetType: row.target_type, targetId: row.target_id, transactionType: row.transaction_type, transactionId: row.transaction_id } });
  if (to !== 'PUBLISHED') {
    await notify(tx, ctx, { userId: row.author_id, templateKey: 'review.moderated', title: '리뷰가 운영 정책에 따라 조치되었습니다', body: input.reason, data: { reviewId }, dedupeKey: `review.moderated:${reviewId}:${to}` });
  }
  return row;
}

export async function dismissReport(tx: Tx, ctx: Ctx, reportId: string) {
  const open = await maybeOne(
    tx,
    `SELECT v.author_id, v.target_type, v.target_id FROM review_reports rp JOIN reviews v ON v.id = rp.review_id WHERE rp.id = $1 AND rp.status = 'OPEN'`,
    [reportId],
  );
  if (!open) throw new AppError(404, 'NOT_FOUND', 'Open report not found');
  await assertNoModerationConflict(tx, ctx, open);
  const r = await maybeOne(tx, `UPDATE review_reports SET status = 'DISMISSED' WHERE id = $1 AND status = 'OPEN' RETURNING *`, [reportId]);
  if (!r) throw new AppError(404, 'NOT_FOUND', 'Open report not found');
  await audit(tx, ctx, { action: 'review_report.dismissed', resourceType: 'review', resourceId: r.review_id, after: { reportId }, category: 'CONTENT' });
  return r;
}

export function presentReview(r: any) {
  return {
    id: r.id,
    authorId: r.author_id,
    authorName: r.author_name ?? undefined,
    targetType: r.target_type,
    targetId: r.target_id,
    transactionType: r.transaction_type,
    rating: r.rating,
    subRatings: r.sub_ratings,
    body: r.body,
    status: r.status,
    createdAt: r.created_at,
    response: r.response_body ? { body: r.response_body, createdAt: r.response_created_at } : null,
  };
}

/** Pending review opportunities for a user (completed, unreviewed, inside the window). */
export async function pendingReviewTasks(db: Db, userId: string) {
  const since = `now() - interval '${REVIEW_WINDOW_DAYS} days'`;
  return q(
    db,
    `SELECT 'RESERVATION' AS transaction_type, r.id AS transaction_id, CASE WHEN r.guest_id = $1 THEN 'HOST' ELSE 'GUEST' END AS target_type
       FROM reservations r WHERE r.status = 'COMPLETED' AND (r.guest_id = $1 OR r.host_id = $1) AND r.updated_at > ${since}
        AND NOT EXISTS (SELECT 1 FROM reviews v WHERE v.author_id = $1 AND v.transaction_type = 'RESERVATION' AND v.transaction_id = r.id
                         AND v.target_type = CASE WHEN r.guest_id = $1 THEN 'HOST' ELSE 'GUEST' END)
     UNION ALL
     SELECT 'EXCHANGE', e.id, 'EXCHANGE_PARTNER' FROM exchange_requests e WHERE e.status IN ('COMPLETED','REVIEWED') AND (e.requester_id = $1 OR e.responder_id = $1) AND e.updated_at > ${since}
        AND NOT EXISTS (SELECT 1 FROM reviews v WHERE v.author_id = $1 AND v.transaction_type = 'EXCHANGE' AND v.transaction_id = e.id)
     UNION ALL
     SELECT 'GUIDE_BOOKING', b.id, CASE WHEN b.traveler_id = $1 THEN 'GUIDE' ELSE 'TRAVELER' END FROM guide_bookings b
      WHERE b.status IN ('COMPLETED','REVIEWED') AND (b.traveler_id = $1 OR b.guide_id = $1) AND b.end_at > ${since}
        AND NOT EXISTS (SELECT 1 FROM reviews v WHERE v.author_id = $1 AND v.transaction_type = 'GUIDE_BOOKING' AND v.transaction_id = b.id)`,
    [userId],
  );
}
