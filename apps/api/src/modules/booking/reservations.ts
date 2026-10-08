import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import type { AppContext, Ctx } from '../../platform/context.js';
import { systemCtx } from '../../platform/context.js';
import type { Actor } from '../../platform/auth.js';
import { isStaff } from '../../platform/auth.js';
import { audit } from '../../platform/audit.js';
import { AppError, badRequest, conflict, forbidden, gone, notFound, unprocessable } from '../../platform/errors.js';
import { emit } from '../../platform/outbox.js';
import { notify } from '../../platform/notify.js';
import { assertEnabled } from '../../platform/flags.js';
import { acquireBlock, convertBlock, releaseBlock } from '../../platform/inventory.js';
import { recordTransition, type ActorType } from '../../platform/fsm.js';
import type { PayableSnapshot, PaymentSubjectHandler } from '../../platform/payment-subjects.js';
import { assertPaidBookingAllowed } from '../compliance/service.js';
import { ensureConversation } from '../messaging/service.js';
import { holdMachine, reservationMachine, ADDRESS_VISIBLE, PRE_CONFIRMATION, type ReservationStatus } from './fsm.js';
import { loadProperty, quoteDto, validateStayRequest, type QuoteRow } from './pricing.js';
import { localToday } from './dates.js';
import { staffDenied, staffOk, type StaffCapability } from './availability.js';

export const PAID_BOOKING_FLAG = 'stay.paid_booking';
/** Concurrent live holds one guest may have across all listings (inventory-squatting guard, SECURITY §2.3). */
export const MAX_ACTIVE_HOLDS_PER_GUEST = 3;
/** Holds one guest may place on the same listing per rolling 24 h (re-hold after release/expiry is capped). */
export const MAX_HOLDS_PER_GUEST_PROPERTY_PER_DAY = 6;

export interface ReservationRow {
  id: string;
  code: string;
  property_id: string;
  host_id: string;
  guest_id: string;
  hold_id: string | null;
  quote_id: string | null;
  inventory_block_id: string | null;
  status: ReservationStatus;
  check_in: string;
  check_out: string;
  guests: number;
  total_minor: number;
  refunded_minor: number;
  currency: string;
  quote_snapshot: any;
  cancellation_policy_snapshot: any;
  guest_message: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  confirmed_at: string | null;
  checked_in_at: string | null;
  completed_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

const RES_COLS = `r.id, r.code, r.property_id, r.host_id, r.guest_id, r.hold_id, r.quote_id, r.inventory_block_id, r.status,
  r.check_in::text AS check_in, r.check_out::text AS check_out, r.guests, r.total_minor, r.refunded_minor, r.currency, r.quote_snapshot,
  r.cancellation_policy_snapshot, r.guest_message, r.cancelled_at, r.cancel_reason, r.confirmed_at, r.checked_in_at, r.completed_at,
  r.version, r.created_at, r.updated_at`;

export async function lockReservation(tx: Db, id: string): Promise<ReservationRow> {
  const row = await maybeOne<ReservationRow>(tx, `SELECT ${RES_COLS} FROM reservations r WHERE r.id = $1 FOR UPDATE`, [id]);
  if (!row) throw notFound('Reservation');
  return row;
}

export type ReservationRole = 'GUEST' | 'HOST' | 'STAFF';
/** Party role of the actor, or STAFF only when the actor holds the staff capability `cap` (see STAFF_CAPABILITIES). */
export function roleOf(actor: Actor | null, r: Pick<ReservationRow, 'guest_id' | 'host_id'>, cap: StaffCapability = 'READ'): ReservationRole | null {
  if (!actor) return null;
  if (actor.userId === r.guest_id) return 'GUEST';
  if (actor.userId === r.host_id) return 'HOST';
  if (staffOk(actor, cap)) return 'STAFF';
  return null;
}
export function requireRoleOn(actor: Actor | null, r: Pick<ReservationRow, 'guest_id' | 'host_id'>, allowed: ReservationRole[], cap: StaffCapability = 'LIFECYCLE'): ReservationRole {
  const role = roleOf(actor, r, cap);
  if (!role) throw staffDenied(actor, cap);
  if (!allowed.includes(role)) throw forbidden();
  return role;
}
const actorTypeOf = (ctx: Ctx, fallback: ActorType = 'SYSTEM'): ActorType =>
  !ctx.actor ? fallback : isStaff(ctx.actor) && ctx.actor.aal === 'aal2' ? 'ADMIN' : 'USER';

/** A staff override of a party action: a reason is mandatory and the act is audited (MONEY: it moves payouts/refunds). */
async function auditStaffAction(db: Db, ctx: Ctx, r: Pick<ReservationRow, 'id' | 'status' | 'host_id' | 'guest_id'>, action: string, reason: string | undefined, after: Record<string, unknown> = {}) {
  await audit(db, ctx, {
    action, resourceType: 'reservation', resourceId: r.id, before: { status: r.status }, after: { hostId: r.host_id, guestId: r.guest_id, ...after },
    reason: reason ?? null, category: 'MONEY',
  });
}
function requireStaffReason(reason: string | undefined) {
  if (!reason || !reason.trim()) throw badRequest('REASON_REQUIRED', 'Staff actions on a reservation require a reason');
}

export function reservationDto(r: ReservationRow, extra: Record<string, unknown> = {}) {
  return {
    id: r.id,
    code: r.code,
    propertyId: r.property_id,
    hostId: r.host_id,
    guestId: r.guest_id,
    holdId: r.hold_id,
    quoteId: r.quote_id,
    status: r.status,
    checkIn: r.check_in,
    checkOut: r.check_out,
    guests: r.guests,
    totalMinor: r.total_minor,
    refundedMinor: r.refunded_minor,
    currency: r.currency,
    quote: r.quote_snapshot,
    cancellationPolicy: r.cancellation_policy_snapshot,
    cancelledAt: r.cancelled_at,
    cancelReason: r.cancel_reason,
    confirmedAt: r.confirmed_at,
    checkedInAt: r.checked_in_at,
    completedAt: r.completed_at,
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    ...extra,
  };
}

const holdDto = (h: any) => ({ id: h.id, quoteId: h.quote_id, propertyId: h.property_id, inventoryBlockId: h.inventory_block_id, guestId: h.guest_id, status: h.status, expiresAt: h.expires_at, createdAt: h.created_at });

// ---------------------------------------------------------------- STAY-08 hold

/**
 * Inventory-squatting guard: a guest may keep at most MAX_ACTIVE_HOLDS_PER_GUEST live holds at once and place at most
 * MAX_HOLDS_PER_GUEST_PROPERTY_PER_DAY holds on one listing per rolling 24 h (release + re-hold loops are capped).
 * Serialized per guest with a transaction-scoped advisory lock so parallel requests cannot both pass the count.
 */
async function assertHoldQuota(tx: Tx, guestId: string, propertyId: string) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('booking.hold-quota:' || $1::text, 0))`, [guestId]);
  const c = await one<{ active: number; recent: number }>(
    tx,
    `SELECT count(*) FILTER (WHERE status = 'ACTIVE' AND expires_at > now())::int AS active,
            count(*) FILTER (WHERE property_id = $2 AND created_at > now() - interval '24 hours')::int AS recent
       FROM reservation_holds WHERE guest_id = $1`,
    [guestId, propertyId],
  );
  if (c.active >= MAX_ACTIVE_HOLDS_PER_GUEST) {
    throw new AppError(429, 'HOLD_LIMIT', `You can hold at most ${MAX_ACTIVE_HOLDS_PER_GUEST} stays at a time; pay for or release a hold first`, { activeHolds: c.active, limit: MAX_ACTIVE_HOLDS_PER_GUEST });
  }
  if (c.recent >= MAX_HOLDS_PER_GUEST_PROPERTY_PER_DAY) {
    throw new AppError(429, 'HOLD_RATE_LIMIT', 'Too many holds on this listing in the last 24 hours', { holds24h: c.recent, limit: MAX_HOLDS_PER_GUEST_PROPERTY_PER_DAY });
  }
}

export async function createHold(tx: Tx, ctx: Ctx, quoteId: string) {
  const actor = ctx.actor!;
  const quote = await maybeOne<QuoteRow & { expired: boolean }>(
    tx,
    `SELECT id, property_id, guest_id, check_in::text, check_out::text, guests, subtotal_minor, cleaning_fee_minor, platform_fee_minor,
            tax_minor, discount_minor, total_minor, currency, breakdown, rules_version, expires_at, created_at, expires_at <= now() AS expired
       FROM booking_quotes WHERE id = $1 FOR UPDATE`,
    [quoteId],
  );
  if (!quote || quote.guest_id !== actor.userId) throw notFound('Quote');
  if (quote.expired) throw gone('QUOTE_EXPIRED', 'The quote has expired; request a new quote');
  await assertEnabled(tx, PAID_BOOKING_FLAG, { userId: actor.userId, roles: actor.roles });
  await assertPaidBookingAllowed(tx, quote.property_id);
  const existing = await maybeOne(tx, `SELECT id FROM reservation_holds WHERE quote_id = $1 AND status IN ('ACTIVE','CONVERTED')`, [quoteId]);
  if (existing) throw conflict('HOLD_EXISTS', 'This quote already has an active hold');
  await assertHoldQuota(tx, actor.userId, quote.property_id);

  const prop = await loadProperty(tx, quote.property_id, true);
  // invariant 5: recheck all availability predicates inside the hold transaction
  await validateStayRequest(tx, prop, { checkIn: quote.check_in, checkOut: quote.check_out, guests: quote.guests, guestId: actor.userId });
  if (prop.currency !== quote.currency) throw conflict('QUOTE_STALE', 'Property currency changed; request a new quote');
  const policy = prop.cancellation_policy_id
    ? await maybeOne(tx, `SELECT id, code, name, tiers, service_fee_refundable FROM cancellation_policies WHERE id = $1`, [prop.cancellation_policy_id])
    : null;
  if (!policy) throw unprocessable('CANCELLATION_POLICY_REQUIRED', 'Property has no cancellation policy');

  const { t: expiresAt } = await one<{ t: Date }>(tx, `SELECT now() + make_interval(secs => $1) AS t`, [ctx.app.config.HOLD_TTL_SEC]);
  const holdId = randomUUID();
  const block = await acquireBlock(tx, {
    propertyId: prop.id, start: quote.check_in, end: quote.check_out, blockType: 'HOLD', sourceType: 'RESERVATION_HOLD',
    sourceId: holdId, expiresAt, createdBy: actor.userId,
  });
  const hold = await one(
    tx,
    `INSERT INTO reservation_holds(id, quote_id, property_id, inventory_block_id, guest_id, status, expires_at)
     VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6) RETURNING *`,
    [holdId, quoteId, prop.id, block.id, actor.userId, expiresAt],
  );
  const quoteSnapshot = { ...quoteDto(quote), hostFeeMinor: quote.breakdown.hostFeeMinor ?? 0 };
  const policySnapshot = { ...policy, timezone: prop.timezone, checkInTime: prop.check_in_time, capturedAt: new Date().toISOString() };
  const res = await one<ReservationRow>(
    tx,
    `INSERT INTO reservations(property_id, host_id, guest_id, hold_id, quote_id, inventory_block_id, status, check_in, check_out, guests,
                              total_minor, currency, quote_snapshot, cancellation_policy_snapshot)
     VALUES ($1,$2,$3,$4,$5,$6,'HELD',$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [prop.id, prop.host_id, actor.userId, holdId, quoteId, block.id, quote.check_in, quote.check_out, quote.guests, quote.total_minor, quote.currency,
      JSON.stringify(quoteSnapshot), JSON.stringify(policySnapshot)],
  );
  const meta = { quoteId, holdId };
  await recordTransition(tx, ctx, { aggregateType: 'RESERVATION', aggregateId: res.id, from: null, to: 'DRAFT', reason: 'reservation created', metadata: meta });
  await recordTransition(tx, ctx, { aggregateType: 'RESERVATION', aggregateId: res.id, from: 'DRAFT', to: 'QUOTED', reason: 'quote attached', metadata: meta });
  await recordTransition(tx, ctx, { aggregateType: 'RESERVATION', aggregateId: res.id, from: 'QUOTED', to: 'HELD', reason: 'inventory hold acquired', metadata: { ...meta, blockId: block.id } });
  await emit(tx, ctx, {
    aggregateType: 'reservation',
    aggregateId: res.id,
    eventType: 'reservation.held',
    payload: { reservationId: res.id, holdId, quoteId, propertyId: prop.id, guestId: actor.userId, checkIn: quote.check_in, checkOut: quote.check_out, totalMinor: quote.total_minor, currency: quote.currency, expiresAt },
  });
  const full = await lockReservation(tx, res.id);
  return { hold: holdDto(hold), reservation: reservationDto(full) };
}

async function paymentInFlight(db: Db, reservationId: string): Promise<boolean> {
  const r = await q(db, `SELECT 1 FROM payments WHERE subject_type = 'RESERVATION' AND subject_id = $1 AND status IN ('CONFIRMING','APPROVED') LIMIT 1`, [reservationId]);
  return r.length > 0;
}

async function endHold(tx: Tx, ctx: Ctx, hold: { id: string; inventory_block_id: string }, to: 'RELEASED' | 'EXPIRED', reason: string) {
  await holdMachine.transition(tx, ctx, { table: 'reservation_holds', id: hold.id, from: 'ACTIVE', to, reason, actorType: actorTypeOf(ctx) });
  await releaseBlock(tx, hold.inventory_block_id, to);
  const res = await maybeOne<{ id: string; status: ReservationStatus }>(tx, `SELECT id, status FROM reservations WHERE hold_id = $1 FOR UPDATE`, [hold.id]);
  if (res && ['HELD', 'PAYMENT_PENDING', 'PAYMENT_FAILED'].includes(res.status)) {
    await reservationMachine.transition(tx, ctx, { table: 'reservations', id: res.id, to: 'EXPIRED', reason, actorType: actorTypeOf(ctx), versioned: true, metadata: { holdId: hold.id } });
  }
  return res?.id ?? null;
}

export async function releaseHold(tx: Tx, ctx: Ctx, holdId: string) {
  const actor = ctx.actor!;
  const hold = await maybeOne(tx, `SELECT * FROM reservation_holds WHERE id = $1 FOR UPDATE`, [holdId]);
  if (!hold) throw notFound('Hold');
  const byStaff = hold.guest_id !== actor.userId;
  if (byStaff && !staffOk(actor, 'LIFECYCLE')) throw staffDenied(actor, 'LIFECYCLE');
  if (hold.status !== 'ACTIVE') throw conflict('HOLD_NOT_ACTIVE', `Hold is ${hold.status}`);
  const res = await maybeOne<{ id: string; status: string; host_id: string; guest_id: string }>(tx, `SELECT id, status, host_id, guest_id FROM reservations WHERE hold_id = $1`, [holdId]);
  if (res && (await paymentInFlight(tx, res.id))) throw conflict('PAYMENT_IN_PROGRESS', 'A payment for this hold is being processed');
  if (byStaff) {
    await audit(tx, ctx, { action: 'reservation.hold.staff_released', resourceType: 'reservation_hold', resourceId: holdId, after: { reservationId: res?.id ?? null, guestId: hold.guest_id }, category: 'PERMISSION' });
  }
  const reservationId = await endHold(tx, ctx, hold, 'RELEASED', byStaff ? 'hold released by staff' : 'hold released by guest');
  await emit(tx, ctx, {
    aggregateType: 'reservation',
    aggregateId: reservationId ?? holdId,
    eventType: 'reservation.hold_released',
    payload: { reservationId, holdId, propertyId: hold.property_id },
  });
}

/** Job: expire overdue holds (skips those whose payment is CONFIRMING/APPROVED and extends them briefly instead). */
export async function expireHolds(app: AppContext): Promise<number> {
  const due = await q<{ id: string }>(app.pool, `SELECT id FROM reservation_holds WHERE status = 'ACTIVE' AND expires_at <= now() ORDER BY expires_at LIMIT 200`);
  let n = 0;
  for (const { id } of due) {
    const ctx = systemCtx(app, `job-hold-expiry-${randomUUID()}`);
    n += await withTx(app.pool, async (tx) => {
      const hold = await maybeOne(tx, `SELECT * FROM reservation_holds WHERE id = $1 AND status = 'ACTIVE' AND expires_at <= now() FOR UPDATE SKIP LOCKED`, [id]);
      if (!hold) return 0;
      const res = await maybeOne<{ id: string }>(tx, `SELECT id FROM reservations WHERE hold_id = $1`, [id]);
      if (res && (await paymentInFlight(tx, res.id))) {
        // a provider confirmation is in flight: keep the dates (never let another hold steal them mid-payment)
        await tx.query(`UPDATE reservation_holds SET expires_at = now() + interval '5 minutes' WHERE id = $1`, [id]);
        await tx.query(`UPDATE inventory_blocks SET expires_at = now() + interval '5 minutes' WHERE id = $1 AND state = 'ACTIVE'`, [hold.inventory_block_id]);
        return 0;
      }
      const reservationId = await endHold(tx, ctx, hold, 'EXPIRED', 'hold TTL elapsed');
      await emit(tx, ctx, {
        aggregateType: 'reservation',
        aggregateId: reservationId ?? id,
        eventType: 'reservation.hold_expired',
        payload: { reservationId, holdId: id, propertyId: hold.property_id },
      });
      await emit(tx, ctx, { aggregateType: 'property', aggregateId: hold.property_id, eventType: 'availability.changed', payload: { propertyId: hold.property_id, reason: 'HOLD_EXPIRED', holdId: id } });
      return 1;
    });
  }
  return n;
}

/** Job: auto-complete checked-in stays once the check-out date has arrived in the property timezone. */
export async function autoCompleteStays(app: AppContext): Promise<number> {
  // the zone is joined from pg_timezone_names: a listing with a zone PostgreSQL does not know is skipped instead of
  // failing the whole platform-wide statement (and with it every host's completion and settlement)
  const due = await q<{ id: string }>(
    app.pool,
    `SELECT r.id FROM reservations r JOIN properties p ON p.id = r.property_id JOIN pg_timezone_names tz ON tz.name = p.timezone
      WHERE r.status = 'CHECKED_IN' AND r.check_out <= (now() AT TIME ZONE tz.name)::date ORDER BY r.check_out, r.id LIMIT 200`,
  );
  let completed = 0;
  for (const { id } of due) {
    const ctx = systemCtx(app, `job-auto-complete-${randomUUID()}`);
    try {
      await withTx(app.pool, (tx) => completeStay(tx, ctx, id, 'auto-completed after check-out', true));
      completed++;
    } catch (err) {
      // one failing stay must not abort the rest of the batch
      app.log.warn({ err, reservationId: id }, 'stay auto-completion failed');
    }
  }
  return completed;
}

// ---------------------------------------------------------------- STAY-09 payment subject (PAY-01 contract)

async function activeHold(tx: Db, holdId: string | null) {
  if (!holdId) return null;
  return maybeOne<{ id: string; status: string; inventory_block_id: string; live: boolean }>(
    tx,
    `SELECT id, status, inventory_block_id, expires_at > now() AS live FROM reservation_holds WHERE id = $1 FOR UPDATE`,
    [holdId],
  );
}

/**
 * A payment attempt keeps the dates for PAYMENT_TTL_SEC, but never past the hold's absolute deadline
 * (created_at + HOLD_TTL_SEC + PAYMENT_TTL_SEC): re-preparing a payment before each expiry cannot keep a hold
 * alive forever. A payment already CONFIRMING/APPROVED is still protected by the expiry job (in-flight guard).
 */
async function extendHoldForPayment(tx: Db, ctx: Ctx, r: ReservationRow) {
  const { PAYMENT_TTL_SEC: pay, HOLD_TTL_SEC: hold } = ctx.app.config;
  await tx.query(
    `UPDATE reservation_holds
        SET expires_at = greatest(expires_at, least(now() + make_interval(secs => $2), created_at + make_interval(secs => $2 + $3)))
      WHERE id = $1 AND status = 'ACTIVE'`,
    [r.hold_id, pay, hold],
  );
  // the block follows the hold exactly (copied in SQL: no millisecond truncation through JS Dates)
  await tx.query(
    `UPDATE inventory_blocks b SET expires_at = greatest(b.expires_at, h.expires_at)
       FROM reservation_holds h
      WHERE b.id = $1 AND h.id = $2 AND h.status = 'ACTIVE' AND b.state = 'ACTIVE' AND b.block_type = 'HOLD'`,
    [r.inventory_block_id, r.hold_id],
  );
}

export const reservationPaymentSubject: PaymentSubjectHandler = {
  async payable(tx, ctx, subjectId): Promise<PayableSnapshot> {
    const r = await lockReservation(tx, subjectId);
    if (ctx.actor && ctx.actor.userId !== r.guest_id) throw forbidden('NOT_PAYER', 'Only the guest can pay for this reservation');
    if (!['HELD', 'PAYMENT_FAILED', 'PAYMENT_PENDING'].includes(r.status)) throw conflict('RESERVATION_NOT_PAYABLE', `Reservation is ${r.status}`);
    const hold = await activeHold(tx, r.hold_id);
    if (!hold || hold.status !== 'ACTIVE' || !hold.live) throw conflict('HOLD_EXPIRED', 'The inventory hold has expired');
    await assertEnabled(tx, PAID_BOOKING_FLAG);
    await assertPaidBookingAllowed(tx, r.property_id);
    const qs = r.quote_snapshot;
    const prop = await one<{ title: string }>(tx, `SELECT title FROM properties WHERE id = $1`, [r.property_id]);
    return {
      payerId: r.guest_id,
      amountMinor: r.total_minor,
      currency: r.currency,
      orderName: `${prop.title} ${r.check_in}~${r.check_out}`.slice(0, 100),
      split: [{ payeeId: r.host_id, payeeType: 'HOST', grossMinor: qs.subtotalMinor + qs.cleaningFeeMinor, feeMinor: qs.hostFeeMinor ?? 0, taxMinor: qs.taxMinor ?? 0 }],
      merchantOfRecord: 'JETPOOL',
    };
  },

  async onPaymentCreated(tx, ctx, subjectId, paymentId) {
    const r = await lockReservation(tx, subjectId);
    if (r.status === 'HELD' || r.status === 'PAYMENT_FAILED') {
      await reservationMachine.transition(tx, ctx, { table: 'reservations', id: r.id, to: 'PAYMENT_PENDING', reason: 'payment created', actorType: actorTypeOf(ctx), versioned: true, metadata: { paymentId } });
    } else if (r.status !== 'PAYMENT_PENDING') {
      reservationMachine.assert(r.status, 'PAYMENT_PENDING');
    }
    await extendHoldForPayment(tx, ctx, r);
    await emit(tx, ctx, { aggregateType: 'reservation', aggregateId: r.id, eventType: 'reservation.payment_pending', payload: { reservationId: r.id, paymentId } });
  },

  async onPaymentApproved(tx, ctx, subjectId, payment) {
    const r = await lockReservation(tx, subjectId);
    if (r.status === 'CONFIRMED' && r.confirmed_at) return; // idempotent replay
    if (payment.amountMinor !== r.total_minor || payment.currency !== r.currency) {
      throw conflict('PAYMENT_AMOUNT_MISMATCH', 'Approved amount/currency does not match the reservation', { expected: { amountMinor: r.total_minor, currency: r.currency }, got: payment });
    }
    const at = actorTypeOf(ctx, 'PROVIDER');
    if (r.status === 'HELD' || r.status === 'PAYMENT_FAILED') {
      await reservationMachine.transition(tx, ctx, { table: 'reservations', id: r.id, to: 'PAYMENT_PENDING', reason: 'payment approved', actorType: at, versioned: true, metadata: { paymentId: payment.id } });
    } else if (r.status !== 'PAYMENT_PENDING') {
      reservationMachine.assert(r.status, 'CONFIRMED');
    }
    const hold = await activeHold(tx, r.hold_id);
    if (!hold || hold.status !== 'ACTIVE') throw conflict('HOLD_EXPIRED', 'The inventory hold is no longer active');
    await convertBlock(tx, hold.inventory_block_id, { blockType: 'RESERVATION', sourceType: 'RESERVATION', sourceId: r.id });
    await holdMachine.transition(tx, ctx, { table: 'reservation_holds', id: hold.id, from: 'ACTIVE', to: 'CONVERTED', reason: 'payment approved', actorType: at });
    await reservationMachine.transition(tx, ctx, {
      table: 'reservations', id: r.id, from: 'PAYMENT_PENDING', to: 'CONFIRMED', reason: 'provider-confirmed payment approved', actorType: at, versioned: true,
      set: { confirmed_at: new Date() }, metadata: { paymentId: payment.id, amountMinor: payment.amountMinor, currency: payment.currency },
    });
    const conv: unknown = await ensureConversation(tx, ctx, {
      contextType: 'RESERVATION', contextId: r.id, members: [{ userId: r.guest_id, role: 'GUEST' }, { userId: r.host_id, role: 'HOST' }],
    });
    const conversationId = typeof conv === 'string' ? conv : (conv as { id?: string } | null)?.id ?? null;
    const data = { reservationId: r.id, code: r.code, propertyId: r.property_id, checkIn: r.check_in, checkOut: r.check_out, conversationId };
    await notify(tx, ctx, { userId: r.guest_id, templateKey: 'reservation.confirmed.guest', title: '예약이 확정되었습니다', body: `예약 ${r.code} (${r.check_in}~${r.check_out})`, data, dedupeKey: `reservation.confirmed:${r.id}` });
    await notify(tx, ctx, { userId: r.host_id, templateKey: 'reservation.confirmed.host', title: '새 예약이 확정되었습니다', body: `예약 ${r.code} (${r.check_in}~${r.check_out})`, data, dedupeKey: `reservation.confirmed:${r.id}` });
    await emit(tx, ctx, {
      aggregateType: 'reservation',
      aggregateId: r.id,
      eventType: 'reservation.confirmed',
      payload: { ...data, guestId: r.guest_id, hostId: r.host_id, paymentId: payment.id, totalMinor: r.total_minor, currency: r.currency },
    });
  },

  async onPaymentFailed(tx, ctx, subjectId, payment) {
    const r = await lockReservation(tx, subjectId);
    if (r.status !== 'HELD' && r.status !== 'PAYMENT_PENDING') return; // late/duplicate failure: nothing to do
    await reservationMachine.transition(tx, ctx, { table: 'reservations', id: r.id, to: 'PAYMENT_FAILED', reason: payment.reason || 'payment failed', actorType: actorTypeOf(ctx, 'PROVIDER'), versioned: true, metadata: { paymentId: payment.id } });
    await emit(tx, ctx, { aggregateType: 'reservation', aggregateId: r.id, eventType: 'reservation.payment_failed', payload: { reservationId: r.id, paymentId: payment.id, reason: payment.reason } });
  },

  async onRefunded(tx, ctx, subjectId, refund) {
    const r = await lockReservation(tx, subjectId);
    const refunded = Math.min(r.total_minor, refund.totalRefundedMinor);
    if (r.status === 'REFUND_PENDING') {
      const to: ReservationStatus = refund.fullyRefunded || refunded >= r.total_minor ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
      await reservationMachine.transition(tx, ctx, {
        table: 'reservations', id: r.id, from: 'REFUND_PENDING', to, reason: 'refund completed at provider', actorType: actorTypeOf(ctx, 'PROVIDER'), versioned: true,
        set: { refunded_minor: refunded }, metadata: { refundId: refund.refundId, paymentId: refund.paymentId, amountMinor: refund.amountMinor },
      });
    } else {
      // refunds outside the cancellation flow (e.g. dispute goodwill) only update the display amount
      await tx.query(`UPDATE reservations SET refunded_minor = $2, version = version + 1 WHERE id = $1`, [r.id, refunded]);
    }
    await emit(tx, ctx, {
      aggregateType: 'reservation',
      aggregateId: r.id,
      eventType: 'reservation.refunded',
      payload: { reservationId: r.id, refundId: refund.refundId, amountMinor: refund.amountMinor, totalRefundedMinor: refunded, fullyRefunded: refund.fullyRefunded },
    });
  },
};

// ---------------------------------------------------------------- STAY-09/10 lifecycle

async function propertyTz(db: Db, propertyId: string) {
  return (await one<{ timezone: string }>(db, `SELECT timezone FROM properties WHERE id = $1`, [propertyId])).timezone;
}

export async function checkIn(tx: Tx, ctx: Ctx, id: string, reason?: string) {
  const r = await lockReservation(tx, id);
  const role = requireRoleOn(ctx.actor, r, ['GUEST', 'HOST', 'STAFF'], 'LIFECYCLE');
  reservationMachine.assert(r.status, 'CHECKED_IN');
  if (role === 'STAFF') requireStaffReason(reason);
  const today = await localToday(tx, await propertyTz(tx, r.property_id));
  if (today < r.check_in || today >= r.check_out) throw conflict('CHECK_IN_NOT_ALLOWED', 'Check-in is only possible from the check-in date until check-out', { checkIn: r.check_in, today });
  const { row } = await reservationMachine.transition(tx, ctx, {
    table: 'reservations', id, from: 'CONFIRMED', to: 'CHECKED_IN', reason: reason ?? 'checked in', actorType: actorTypeOf(ctx), versioned: true, set: { checked_in_at: new Date() },
  });
  if (role === 'STAFF') await auditStaffAction(tx, ctx, r, 'reservation.staff_checked_in', reason);
  await emit(tx, ctx, { aggregateType: 'reservation', aggregateId: id, eventType: 'reservation.checked_in', payload: { reservationId: id, propertyId: r.property_id } });
  return row;
}

/**
 * CHECKED_IN → COMPLETED. A party/staff completion is allowed only once the check-out date has arrived in the property
 * timezone (COMPLETED makes the stay settlement-eligible and ends the guest's cancellation path); the system job
 * selects only due stays.
 */
export async function completeStay(tx: Tx, ctx: Ctx, id: string, reason?: string, system = false) {
  const r = await lockReservation(tx, id);
  const role = system ? null : requireRoleOn(ctx.actor, r, ['HOST', 'STAFF'], 'LIFECYCLE');
  reservationMachine.assert(r.status, 'COMPLETED');
  if (role === 'STAFF') requireStaffReason(reason);
  if (!system) {
    const today = await localToday(tx, await propertyTz(tx, r.property_id));
    if (today < r.check_out) throw conflict('STAY_NOT_ENDED', 'A stay can be completed only on or after its check-out date', { checkOut: r.check_out, today });
  }
  const { row } = await reservationMachine.transition(tx, ctx, {
    table: 'reservations', id, from: 'CHECKED_IN', to: 'COMPLETED', reason: reason ?? 'stay completed', actorType: actorTypeOf(ctx), versioned: true, set: { completed_at: new Date() },
  });
  if (role === 'STAFF') await auditStaffAction(tx, ctx, r, 'reservation.staff_completed', reason);
  await emit(tx, ctx, {
    aggregateType: 'reservation',
    aggregateId: id,
    eventType: 'reservation.completed',
    payload: { reservationId: id, propertyId: r.property_id, guestId: r.guest_id, hostId: r.host_id, checkOut: r.check_out },
  });
  return row;
}

export async function markNoShow(tx: Tx, ctx: Ctx, id: string, reason?: string) {
  const r = await lockReservation(tx, id);
  const role = requireRoleOn(ctx.actor, r, ['HOST', 'STAFF'], 'LIFECYCLE');
  reservationMachine.assert(r.status, 'NO_SHOW');
  if (role === 'STAFF') requireStaffReason(reason);
  const today = await localToday(tx, await propertyTz(tx, r.property_id));
  if (today <= r.check_in) throw conflict('NO_SHOW_TOO_EARLY', 'No-show can be reported only after the check-in day', { checkIn: r.check_in, today });
  const { row } = await reservationMachine.transition(tx, ctx, {
    table: 'reservations', id, from: 'CONFIRMED', to: 'NO_SHOW', reason: reason ?? 'guest did not arrive', actorType: actorTypeOf(ctx), versioned: true,
  });
  if (role === 'STAFF') await auditStaffAction(tx, ctx, r, 'reservation.staff_no_show', reason);
  await tx.query(
    `INSERT INTO reservation_adjustments(reservation_id, adjustment_type, amount_minor, currency, policy_evaluation, created_by)
     VALUES ($1,'NO_SHOW',0,$2,$3,$4)`,
    [id, r.currency, JSON.stringify({ rule: 'no refund on no-show', reportedOn: today }), ctx.actor?.userId ?? null],
  );
  await emit(tx, ctx, { aggregateType: 'reservation', aggregateId: id, eventType: 'reservation.no_show', payload: { reservationId: id, propertyId: r.property_id, guestId: r.guest_id } });
  return row;
}

// ---------------------------------------------------------------- reads

/**
 * Parties, or staff with READ (ADMIN/SUPPORT/ACCOUNTING, AAL2). A staff read is an audited ELEVATED_ACCESS read and
 * includes the exact address only for the roles that act on stays (ADMIN/SUPPORT).
 */
export async function getReservation(db: Db, actor: Actor, id: string, ctx: Ctx) {
  const r = await maybeOne<ReservationRow & { property_title: string; property_city: string | null }>(
    db,
    `SELECT ${RES_COLS}, p.title AS property_title, p.city AS property_city FROM reservations r JOIN properties p ON p.id = r.property_id WHERE r.id = $1`,
    [id],
  );
  if (!r) throw notFound('Reservation');
  const role = roleOf(actor, r, 'READ');
  if (!role) throw staffDenied(actor, 'READ');
  let address: unknown = null;
  const addressAllowed = role !== 'STAFF' || staffOk(actor, 'LIFECYCLE');
  if (ADDRESS_VISIBLE.includes(r.status) && addressAllowed) {
    address = await maybeOne(db, `SELECT line1, line2, postal_code AS "postalCode", city, region, country FROM property_addresses WHERE property_id = $1`, [r.property_id]);
  }
  if (role === 'STAFF') {
    await audit(db, ctx, {
      action: 'reservation.read', resourceType: 'reservation', resourceId: id, after: { status: r.status, addressRevealed: !!address }, category: 'ELEVATED_ACCESS',
    });
  }
  const history = await q(
    db,
    `SELECT from_state AS "from", to_state AS "to", actor_id AS "actorId", actor_type AS "actorType", reason, correlation_id AS "correlationId", created_at AS "at"
       FROM state_transitions WHERE aggregate_type = 'RESERVATION' AND aggregate_id = $1 ORDER BY id`,
    [id],
  );
  return reservationDto(r, { viewerRole: role, property: { id: r.property_id, title: r.property_title, city: r.property_city, address }, history });
}

export async function listGuestReservations(db: Db, actor: Actor, opts: { status?: ReservationStatus; limit: number }) {
  const rows = await q<ReservationRow>(
    db,
    `SELECT ${RES_COLS} FROM reservations r WHERE r.guest_id = $1 AND ($2::text IS NULL OR r.status = $2) ORDER BY r.created_at DESC, r.id LIMIT $3`,
    [actor.userId, opts.status ?? null, opts.limit],
  );
  return rows.map((r) => reservationDto(r));
}

export type HostFilter = 'upcoming' | 'current' | 'completed' | 'cancelled';

export async function listHostReservations(db: Db, actor: Actor, opts: { filter?: HostFilter; propertyId?: string; limit: number }) {
  const where: Record<HostFilter, string> = {
    upcoming: `r.status = 'CONFIRMED' AND r.check_in > (now() AT TIME ZONE p.timezone)::date`,
    current: `(r.status = 'CHECKED_IN' OR (r.status = 'CONFIRMED' AND r.check_in <= (now() AT TIME ZONE p.timezone)::date AND r.check_out > (now() AT TIME ZONE p.timezone)::date))`,
    completed: `r.status = 'COMPLETED'`,
    cancelled: `r.status IN ('CANCELLED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED')`,
  };
  const cond = opts.filter ? where[opts.filter] : `r.status <> ALL($4::text[])`;
  const rows = await q<ReservationRow>(
    db,
    `SELECT ${RES_COLS} FROM reservations r JOIN properties p ON p.id = r.property_id
      WHERE r.host_id = $1 AND ($2::uuid IS NULL OR r.property_id = $2) AND ${cond}
      ORDER BY r.check_in, r.id LIMIT $3`,
    opts.filter ? [actor.userId, opts.propertyId ?? null, opts.limit] : [actor.userId, opts.propertyId ?? null, opts.limit, PRE_CONFIRMATION],
  );
  return rows.map((r) => reservationDto(r));
}
