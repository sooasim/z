import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import type { AppContext, Ctx } from '../../platform/context.js';
import { systemCtx } from '../../platform/context.js';
import type { Actor } from '../../platform/auth.js';
import { hasRole } from '../../platform/auth.js';
import { emit, type DomainEvent } from '../../platform/outbox.js';
import { recordTransition } from '../../platform/fsm.js';
import { notify } from '../../platform/notify.js';
import { audit } from '../../platform/audit.js';
import { applyBps } from '../../platform/money.js';
import { assertEnabled } from '../../platform/flags.js';
import { conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { decodeCursor, page } from '../../platform/http.js';
import type { PayableSnapshot, PaymentSubjectHandler } from '../../platform/payment-subjects.js';
import { ensureConversation } from '../messaging/service.js';
import { quoteFees } from '../finance/rules.js';
import {
  CANCELLABLE_BOOKING_STATUSES, DISPUTABLE_BOOKING_STATUSES, GuideBookingFsm, type GuideBookingStatus,
} from './fsm.js';

export interface GuideBookingRow {
  id: string;
  request_id: string | null;
  offer_id: string | null;
  guide_id: string;
  traveler_id: string;
  guide_type: string;
  start_at: Date;
  end_at: Date;
  status: GuideBookingStatus;
  paid: boolean;
  price_minor: number;
  refunded_minor: number;
  currency: string;
  conversation_id: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const T = 'guide_bookings';
/** Unpaid paid-bookings release the guide's time after this long (or at start). */
export const UNPAID_BOOKING_TTL_MS = 24 * 3600_000;
/** Guide may start up to this long before the scheduled start. */
export const EARLY_START_MS = 30 * 60_000;
/** Auto-complete grace after the scheduled end. */
export const AUTO_COMPLETE_GRACE_MS = 2 * 3600_000;

const ev = (db: Db, ctx: Ctx, b: { id: string }, eventType: string, payload: Record<string, unknown>) =>
  emit(db, ctx, { aggregateType: 'guide_booking', aggregateId: b.id, eventType, payload: { bookingId: b.id, ...payload } });

export async function lockBooking(db: Db, id: string): Promise<GuideBookingRow> {
  const b = await maybeOne<GuideBookingRow>(db, `SELECT * FROM ${T} WHERE id = $1 FOR UPDATE`, [id]);
  if (!b) throw notFound('Guide booking');
  return b;
}

const partyOf = (b: GuideBookingRow, userId: string): 'TRAVELER' | 'GUIDE' | null =>
  b.traveler_id === userId ? 'TRAVELER' : b.guide_id === userId ? 'GUIDE' : null;

// ---------------------------------------------------------------- refund policy

/**
 * GUIDE-05 refund policy (business policy from the build spec, not a legal rule):
 * guide/system cancellation → full; traveler ≥ 24h before start → full; otherwise 50%.
 * Never refunds more than what remains un-refunded.
 */
export function computeGuideRefund(args: { priceMinor: number; refundedMinor?: number; startAt: Date; cancelledAt?: Date; cancelledBy: 'TRAVELER' | 'GUIDE' | 'SYSTEM' }) {
  const remaining = Math.max(0, args.priceMinor - (args.refundedMinor ?? 0));
  const at = args.cancelledAt ?? new Date();
  const hoursBefore = (args.startAt.getTime() - at.getTime()) / 3600_000;
  let pct = 100;
  let policy = 'GUIDE_OR_SYSTEM_CANCEL_FULL';
  if (args.cancelledBy === 'TRAVELER') {
    if (hoursBefore >= 24) policy = 'TRAVELER_24H_PLUS_FULL';
    else { pct = 50; policy = 'TRAVELER_LATE_HALF'; }
  }
  const refundMinor = Math.min(remaining, pct === 100 ? args.priceMinor : applyBps(args.priceMinor, pct * 100));
  return { refundMinor, refundPct: pct, policy, hoursBefore: Math.round(hoursBefore * 100) / 100 };
}

const PAYMENTS_SERVICE = '../payments/service.js';

/**
 * Ask payments for a refund. Uses `requestRefund` from modules/payments/service.ts when that module exports
 * it; otherwise emits the `refund.requested` outbox event for the payments module to consume.
 */
export async function requestGuideRefund(tx: Tx, ctx: Ctx, b: GuideBookingRow, amountMinor: number, reason: string): Promise<'PAYMENTS_SERVICE' | 'OUTBOX'> {
  if (amountMinor <= 0) return 'OUTBOX';
  let mod: any = null;
  try {
    mod = await import(/* @vite-ignore */ PAYMENTS_SERVICE);
  } catch {
    mod = null;
  }
  if (mod && typeof mod.requestRefund === 'function') {
    await mod.requestRefund(tx, ctx, { subjectType: 'GUIDE_BOOKING', subjectId: b.id, amountMinor, reason });
    return 'PAYMENTS_SERVICE';
  }
  await emit(tx, ctx, {
    aggregateType: 'guide_booking', aggregateId: b.id, eventType: 'refund.requested',
    payload: { subjectType: 'GUIDE_BOOKING', subjectId: b.id, amountMinor, currency: b.currency, reason },
  });
  return 'OUTBOX';
}

// ---------------------------------------------------------------- creation & confirmation

async function onConfirmed(db: Db, ctx: Ctx, b: GuideBookingRow): Promise<GuideBookingRow> {
  const conv: any = await ensureConversation(db as any, ctx, {
    contextType: 'GUIDE_BOOKING',
    contextId: b.id,
    members: [{ userId: b.traveler_id, role: 'TRAVELER' }, { userId: b.guide_id, role: 'GUIDE' }],
  } as any);
  const conversationId: string | null = typeof conv === 'string' ? conv : conv?.id ?? null;
  const row = await one<GuideBookingRow>(db, `UPDATE ${T} SET conversation_id = $2 WHERE id = $1 RETURNING *`, [b.id, conversationId]);
  await ev(db, ctx, row, 'guide.booking.confirmed', {
    guideId: row.guide_id, travelerId: row.traveler_id, paid: row.paid, priceMinor: row.price_minor, currency: row.currency,
    startAt: row.start_at, endAt: row.end_at, conversationId,
  });
  for (const [userId, other] of [[row.traveler_id, 'guide'], [row.guide_id, 'traveler']] as const) {
    await notify(db, ctx, {
      userId, templateKey: 'guide.booking.confirmed', title: '가이드 일정이 확정되었습니다',
      body: `Your guide booking with the ${other} is confirmed.`, data: { bookingId: row.id, conversationId }, dedupeKey: `guide-booking:${row.id}:confirmed`,
    });
  }
  return row;
}

/**
 * Create the booking for an accepted offer inside the caller's tx. The DB exclusion constraint
 * `no_overlapping_guide_bookings` prevents double booking even under concurrency (→ 409 GUIDE_UNAVAILABLE).
 * Free bookings are CONFIRMED immediately with no payment object; paid ones wait in ACCEPTED for payment.
 */
export async function createBookingFromOffer(
  tx: Tx,
  ctx: Ctx,
  a: { requestId: string; offerId: string; guideId: string; travelerId: string; guideType: string; startAt: Date; endAt: Date; paid: boolean; priceMinor: number; currency: string },
): Promise<GuideBookingRow> {
  await tx.query('SAVEPOINT guide_booking_insert');
  let b: GuideBookingRow;
  try {
    b = await one<GuideBookingRow>(
      tx,
      `INSERT INTO ${T}(request_id, offer_id, guide_id, traveler_id, guide_type, start_at, end_at, status, paid, price_minor, currency)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'ACCEPTED',$8,$9,$10) RETURNING *`,
      [a.requestId, a.offerId, a.guideId, a.travelerId, a.guideType, a.startAt, a.endAt, a.paid, a.paid ? a.priceMinor : 0, a.currency],
    );
    await tx.query('RELEASE SAVEPOINT guide_booking_insert');
  } catch (err: any) {
    await tx.query('ROLLBACK TO SAVEPOINT guide_booking_insert');
    if (err?.code === '23P01') throw conflict('GUIDE_UNAVAILABLE', 'The guide is already booked for an overlapping time');
    throw err;
  }
  await recordTransition(tx, ctx, { aggregateType: 'GUIDE_BOOKING', aggregateId: b.id, from: null, to: 'ACCEPTED', reason: 'offer accepted', metadata: { offerId: a.offerId } });
  await ev(tx, ctx, b, 'guide.booking.created', { guideId: b.guide_id, travelerId: b.traveler_id, paid: b.paid, priceMinor: b.price_minor, currency: b.currency, status: b.status });
  if (!b.paid) {
    const { row } = await GuideBookingFsm.transition(tx, ctx, { table: T, id: b.id, from: 'ACCEPTED', to: 'CONFIRMED', reason: 'free booking confirmed on acceptance', versioned: true });
    b = await onConfirmed(tx, ctx, row);
  } else {
    await notify(tx, ctx, {
      userId: b.traveler_id, templateKey: 'guide.booking.payment_required', title: '결제를 진행해 주세요',
      body: 'Your guide accepted. Complete payment to confirm the booking.', data: { bookingId: b.id, amountMinor: b.price_minor, currency: b.currency },
      dedupeKey: `guide-booking:${b.id}:payment_required`,
    });
  }
  return b;
}

// ---------------------------------------------------------------- payment subject (GUIDE_BOOKING)

export const guideBookingPaymentSubject: PaymentSubjectHandler = {
  async payable(tx, ctx, subjectId): Promise<PayableSnapshot> {
    const b = await lockBooking(tx, subjectId);
    if (!b.paid) throw conflict('NOT_PAYABLE', 'Free guide bookings have no payment');
    await assertEnabled(tx, 'guide.paid', { userId: b.traveler_id });
    if (!['ACCEPTED', 'PAYMENT_FAILED'].includes(b.status)) throw conflict('NOT_PAYABLE', `Guide booking is ${b.status}`);
    if (ctx.actor && ctx.actor.userId !== b.traveler_id) throw forbidden('NOT_PAYER', 'Only the traveler can pay for this booking');
    if (b.start_at.getTime() <= Date.now()) throw conflict('NOT_PAYABLE', 'The activity has already started');
    const fees = await quoteFees(tx, { domain: 'GUIDE', amountMinor: b.price_minor, currency: b.currency });
    return {
      payerId: b.traveler_id,
      amountMinor: b.price_minor,
      currency: b.currency,
      orderName: `JETPOOL guide booking ${b.id.slice(0, 8)}`,
      // the traveler pays the guide's price; platform + guide-side fees and tax are withheld from the guide's gross
      split: [{ payeeId: b.guide_id, payeeType: 'GUIDE', grossMinor: b.price_minor, feeMinor: fees.platformFeeMinor + fees.hostFeeMinor, taxMinor: fees.taxMinor }],
      merchantOfRecord: 'JETPOOL',
    };
  },

  async onPaymentCreated(tx, ctx, subjectId, paymentId) {
    const b = await lockBooking(tx, subjectId);
    if (b.status === 'PAYMENT_PENDING') return;
    await GuideBookingFsm.transition(tx, ctx, { table: T, id: b.id, from: ['ACCEPTED', 'PAYMENT_FAILED'], to: 'PAYMENT_PENDING', reason: 'payment created', actorType: 'SYSTEM', metadata: { paymentId }, versioned: true });
  },

  async onPaymentApproved(tx, ctx, subjectId, payment) {
    let b = await lockBooking(tx, subjectId);
    if (['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED', 'DISPUTED'].includes(b.status)) return; // idempotent replay
    if (!b.paid) throw conflict('NOT_PAYABLE', 'Free guide bookings have no payment');
    // invariant 3: confirm only when the provider-confirmed amount/currency equal the server-side price
    if (payment.amountMinor !== b.price_minor || payment.currency !== b.currency) {
      throw conflict('PAYMENT_AMOUNT_MISMATCH', 'Approved payment does not match the booking amount', { expected: { amountMinor: b.price_minor, currency: b.currency }, got: { amountMinor: payment.amountMinor, currency: payment.currency } });
    }
    if (b.status === 'CANCELLED') {
      // paid after cancellation (late approval): refund in full, keep the booking cancelled
      await requestGuideRefund(tx, ctx, b, payment.amountMinor - b.refunded_minor, 'payment approved after cancellation');
      return;
    }
    if (b.status === 'ACCEPTED' || b.status === 'PAYMENT_FAILED') {
      ({ row: b } = await GuideBookingFsm.transition(tx, ctx, { table: T, id: b.id, to: 'PAYMENT_PENDING', reason: 'payment approved (implicit create)', actorType: 'PROVIDER', metadata: { paymentId: payment.id }, versioned: true }));
    }
    const { row } = await GuideBookingFsm.transition(tx, ctx, { table: T, id: b.id, from: 'PAYMENT_PENDING', to: 'CONFIRMED', reason: 'payment approved', actorType: 'PROVIDER', metadata: { paymentId: payment.id }, versioned: true });
    await onConfirmed(tx, ctx, row);
  },

  async onPaymentFailed(tx, ctx, subjectId, payment) {
    const b = await lockBooking(tx, subjectId);
    if (b.status !== 'PAYMENT_PENDING') return;
    await GuideBookingFsm.transition(tx, ctx, { table: T, id: b.id, from: 'PAYMENT_PENDING', to: 'PAYMENT_FAILED', reason: payment.reason, actorType: 'PROVIDER', metadata: { paymentId: payment.id }, versioned: true });
    await ev(tx, ctx, b, 'guide.booking.payment_failed', { travelerId: b.traveler_id, paymentId: payment.id });
  },

  async onRefunded(tx, ctx, subjectId, refund) {
    const b = await lockBooking(tx, subjectId);
    const total = Math.max(b.refunded_minor, refund.totalRefundedMinor);
    await tx.query(`UPDATE ${T} SET refunded_minor = $2 WHERE id = $1`, [b.id, total]);
    if (refund.fullyRefunded && GuideBookingFsm.can(b.status, 'CANCELLED')) {
      await GuideBookingFsm.transition(tx, ctx, { table: T, id: b.id, to: 'CANCELLED', reason: 'fully refunded', actorType: 'PROVIDER', metadata: { refundId: refund.refundId }, versioned: true });
      await ev(tx, ctx, b, 'guide.booking.cancelled', { cancelledBy: 'SYSTEM', reason: 'fully refunded', refundMinor: refund.amountMinor });
    }
    await ev(tx, ctx, b, 'guide.booking.refunded', { refundId: refund.refundId, amountMinor: refund.amountMinor, totalRefundedMinor: total, fullyRefunded: refund.fullyRefunded });
  },
};

// ---------------------------------------------------------------- read

export async function getBookingFor(db: Db, actor: Actor, id: string) {
  const b = await maybeOne<GuideBookingRow>(db, `SELECT * FROM ${T} WHERE id = $1`, [id]);
  if (!b) throw notFound('Guide booking');
  const staff = hasRole(actor, 'ADMIN', 'SUPPORT', 'ACCOUNTING') && actor.aal === 'aal2';
  if (!partyOf(b, actor.userId) && !staff) throw notFound('Guide booking');
  const history = await q(
    db,
    `SELECT from_state, to_state, actor_type, reason, created_at FROM state_transitions WHERE aggregate_type = 'GUIDE_BOOKING' AND aggregate_id = $1 ORDER BY created_at, id`,
    [id],
  );
  return { ...b, history };
}

export async function listBookings(db: Db, actor: Actor, f: { role?: 'traveler' | 'guide'; status?: string; limit: number; cursor?: string }) {
  const c = decodeCursor(f.cursor);
  const statuses = f.status ? f.status.split(',').map((s) => s.trim()) : null;
  const rows = await q<GuideBookingRow>(
    db,
    `SELECT * FROM ${T}
      WHERE (($2::text IS NULL AND (traveler_id = $1 OR guide_id = $1)) OR ($2 = 'traveler' AND traveler_id = $1) OR ($2 = 'guide' AND guide_id = $1))
        AND ($3::text[] IS NULL OR status = ANY($3))
        AND ($4::timestamptz IS NULL OR (created_at, id) < ($4, $5::uuid))
      ORDER BY created_at DESC, id DESC LIMIT $6`,
    [actor.userId, f.role ?? null, statuses, c?.createdAt ?? null, c?.id ?? null, f.limit + 1],
  );
  return page(rows, f.limit);
}

// ---------------------------------------------------------------- lifecycle actions

export async function startBooking(tx: Tx, ctx: Ctx, actor: Actor, id: string) {
  const b = await lockBooking(tx, id);
  if (partyOf(b, actor.userId) !== 'GUIDE') throw forbidden('NOT_BOOKING_GUIDE', 'Only the guide can start the activity');
  if (Date.now() < b.start_at.getTime() - EARLY_START_MS) throw unprocessable('TOO_EARLY', 'The activity cannot start yet');
  const { row } = await GuideBookingFsm.transition(tx, ctx, { table: T, id, from: 'CONFIRMED', to: 'IN_PROGRESS', reason: 'started by guide', versioned: true });
  await ev(tx, ctx, row, 'guide.booking.started', { guideId: row.guide_id, travelerId: row.traveler_id });
  return row;
}

async function completeInternal(tx: Tx, ctx: Ctx, b: GuideBookingRow, reason: string) {
  const { row } = await GuideBookingFsm.transition(tx, ctx, { table: T, id: b.id, from: 'IN_PROGRESS', to: 'COMPLETED', reason, versioned: true });
  await ev(tx, ctx, row, 'guide.booking.completed', { guideId: row.guide_id, travelerId: row.traveler_id, paid: row.paid, priceMinor: row.price_minor, currency: row.currency });
  for (const userId of [row.traveler_id, row.guide_id]) {
    await notify(tx, ctx, {
      userId, templateKey: 'guide.booking.review_invite', title: '후기를 남겨 주세요', body: 'Your guide activity is complete. Leave a review.',
      data: { bookingId: row.id, transactionType: 'GUIDE_BOOKING' }, dedupeKey: `guide-booking:${row.id}:review_invite`,
    });
  }
  return row;
}

export async function completeBooking(tx: Tx, ctx: Ctx, actor: Actor, id: string) {
  const b = await lockBooking(tx, id);
  if (!partyOf(b, actor.userId)) throw forbidden('NOT_BOOKING_PARTY', 'Only booking parties can complete it');
  return completeInternal(tx, ctx, b, `completed by ${partyOf(b, actor.userId)!.toLowerCase()}`);
}

export async function cancelBooking(tx: Tx, ctx: Ctx, actor: Actor | null, id: string, reason?: string) {
  const b = await lockBooking(tx, id);
  const party = actor ? partyOf(b, actor.userId) : 'SYSTEM';
  if (!party) throw forbidden('NOT_BOOKING_PARTY', 'Only booking parties can cancel it');
  const by: 'TRAVELER' | 'GUIDE' | 'SYSTEM' = party;
  if (!CANCELLABLE_BOOKING_STATUSES.includes(b.status)) {
    throw conflict('INVALID_STATE_TRANSITION', `Guide booking is ${b.status} and cannot be cancelled`, { from: b.status, to: 'CANCELLED' });
  }
  // money captured only once CONFIRMED (or later); PAYMENT_PENDING approvals after cancel are refunded in onPaymentApproved
  const captured = b.paid && ['CONFIRMED', 'IN_PROGRESS'].includes(b.status);
  const refund = captured ? computeGuideRefund({ priceMinor: b.price_minor, refundedMinor: b.refunded_minor, startAt: b.start_at, cancelledBy: by }) : null;
  const { row } = await GuideBookingFsm.transition(tx, ctx, {
    table: T, id, to: 'CANCELLED', reason: reason ?? `cancelled by ${by.toLowerCase()}`, actorType: by === 'SYSTEM' ? 'SYSTEM' : 'USER',
    metadata: { cancelledBy: by, refund }, versioned: true,
  });
  let refundChannel: string | null = null;
  if (refund && refund.refundMinor > 0) refundChannel = await requestGuideRefund(tx, ctx, b, refund.refundMinor, `guide booking cancelled by ${by.toLowerCase()} (${refund.policy})`);
  if (refund) {
    await audit(tx, ctx, { action: 'guide.booking.refund_requested', resourceType: 'guide_booking', resourceId: id, after: { refundMinor: refund.refundMinor, policy: refund.policy, currency: b.currency }, category: 'MONEY' });
  }
  await ev(tx, ctx, row, 'guide.booking.cancelled', { cancelledBy: by, reason: reason ?? null, refundMinor: refund?.refundMinor ?? 0, refundPolicy: refund?.policy ?? null, refundChannel });
  const other = by === 'TRAVELER' ? b.guide_id : by === 'GUIDE' ? b.traveler_id : null;
  for (const userId of other ? [other] : [b.guide_id, b.traveler_id]) {
    await notify(tx, ctx, {
      userId, templateKey: 'guide.booking.cancelled', title: '가이드 예약이 취소되었습니다', body: 'A guide booking was cancelled.',
      data: { bookingId: id, cancelledBy: by }, dedupeKey: `guide-booking:${id}:cancelled`,
    });
  }
  return { booking: row, refund };
}

export async function disputeBooking(tx: Tx, ctx: Ctx, actor: Actor, id: string, reason: string) {
  const b = await lockBooking(tx, id);
  const party = partyOf(b, actor.userId);
  if (!party) throw forbidden('NOT_BOOKING_PARTY', 'Only booking parties can open a dispute');
  if (!DISPUTABLE_BOOKING_STATUSES.includes(b.status)) throw conflict('INVALID_STATE_TRANSITION', `Guide booking is ${b.status} and cannot be disputed`, { from: b.status, to: 'DISPUTED' });
  const { row } = await GuideBookingFsm.transition(tx, ctx, { table: T, id, to: 'DISPUTED', reason, metadata: { openedBy: party }, versioned: true });
  await ev(tx, ctx, row, 'guide.booking.disputed', { openedBy: party, openedById: actor.userId, reason, guideId: b.guide_id, travelerId: b.traveler_id, paid: b.paid });
  await notify(tx, ctx, {
    userId: party === 'TRAVELER' ? b.guide_id : b.traveler_id, templateKey: 'guide.booking.disputed', title: '분쟁이 접수되었습니다',
    body: 'A dispute was opened for your guide booking.', data: { bookingId: id }, dedupeKey: `guide-booking:${id}:disputed`,
  });
  return row;
}

// ---------------------------------------------------------------- events & jobs

/** review.created (TRUST-02) → REVIEWED once the traveler has reviewed a COMPLETED booking; refresh guide rating. */
export async function handleReviewCreated(tx: Tx, event: DomainEvent, ctx: Ctx) {
  const p = event.payload ?? {};
  const txType = p.transactionType ?? p.transaction_type;
  const txId = p.transactionId ?? p.transaction_id;
  if (txType !== 'GUIDE_BOOKING' || !txId) return;
  const b = await maybeOne<GuideBookingRow>(tx, `SELECT * FROM ${T} WHERE id = $1 FOR UPDATE`, [txId]);
  if (!b) return;
  const authors = new Set(
    (await q<{ author_id: string }>(tx, `SELECT DISTINCT author_id FROM reviews WHERE transaction_type = 'GUIDE_BOOKING' AND transaction_id = $1`, [b.id])).map((r) => r.author_id),
  );
  const authorId = p.authorId ?? p.author_id;
  if (authorId) authors.add(authorId);
  await tx.query(
    `UPDATE guide_profiles g SET rating_avg = s.avg FROM (
       SELECT round(avg(rating)::numeric, 2) AS avg FROM reviews WHERE target_type = 'GUIDE' AND target_id = $1 AND status = 'PUBLISHED') s
     WHERE g.user_id = $1 AND s.avg IS NOT NULL`,
    [b.guide_id],
  );
  if (b.status === 'COMPLETED' && authors.has(b.traveler_id)) {
    const both = authors.has(b.guide_id);
    await GuideBookingFsm.transition(tx, ctx, { table: T, id: b.id, from: 'COMPLETED', to: 'REVIEWED', reason: both ? 'reviewed by both parties' : 'reviewed by traveler', actorType: 'SYSTEM', versioned: true });
    await ev(tx, ctx, b, 'guide.booking.reviewed', { guideId: b.guide_id, travelerId: b.traveler_id, bothReviewed: both });
  }
}

/** Job: CONFIRMED→IN_PROGRESS at start; IN_PROGRESS→COMPLETED after end+2h; unpaid paid bookings → CANCELLED. */
export async function runBookingLifecycle(app: AppContext): Promise<{ started: number; completed: number; expired: number }> {
  const res = { started: 0, completed: 0, expired: 0 };
  const each = async (sql: string, params: unknown[], fn: (tx: Tx, ctx: Ctx, b: GuideBookingRow) => Promise<unknown>, key: keyof typeof res) => {
    const ids = await q<{ id: string }>(app.pool, sql, params);
    for (const { id } of ids) {
      try {
        await withTx(app.pool, async (tx) => {
          const ctx = systemCtx(app, `job-guide-booking-${id}`);
          const b = await maybeOne<GuideBookingRow>(tx, `SELECT * FROM ${T} WHERE id = $1 FOR UPDATE SKIP LOCKED`, [id]);
          if (b) { await fn(tx, ctx, b); res[key]++; }
        });
      } catch (err) {
        app.log.warn({ err, bookingId: id }, 'guide booking lifecycle step failed');
      }
    }
  };
  await each(`SELECT id FROM ${T} WHERE status = 'CONFIRMED' AND start_at <= now() LIMIT 200`, [], async (tx, ctx, b) => {
    if (b.status !== 'CONFIRMED') return;
    const { row } = await GuideBookingFsm.transition(tx, ctx, { table: T, id: b.id, from: 'CONFIRMED', to: 'IN_PROGRESS', reason: 'scheduled start', actorType: 'SYSTEM', versioned: true });
    await ev(tx, ctx, row, 'guide.booking.started', { guideId: row.guide_id, travelerId: row.traveler_id, auto: true });
  }, 'started');
  await each(`SELECT id FROM ${T} WHERE status = 'IN_PROGRESS' AND end_at + make_interval(secs => $1) <= now() LIMIT 200`, [AUTO_COMPLETE_GRACE_MS / 1000], async (tx, ctx, b) => {
    if (b.status !== 'IN_PROGRESS') return;
    await completeInternal(tx, ctx, b, 'auto-completed after end + grace');
  }, 'completed');
  await each(
    `SELECT id FROM ${T} WHERE paid AND status IN ('ACCEPTED','PAYMENT_FAILED') AND (created_at + make_interval(secs => $1) <= now() OR start_at <= now()) LIMIT 200`,
    [UNPAID_BOOKING_TTL_MS / 1000],
    async (tx, ctx, b) => {
      if (!['ACCEPTED', 'PAYMENT_FAILED'].includes(b.status)) return;
      await GuideBookingFsm.transition(tx, ctx, { table: T, id: b.id, to: 'CANCELLED', reason: 'payment not completed in time', actorType: 'SYSTEM', versioned: true });
      await ev(tx, ctx, b, 'guide.booking.cancelled', { cancelledBy: 'SYSTEM', reason: 'payment_timeout', refundMinor: 0 });
    },
    'expired',
  );
  return res;
}
