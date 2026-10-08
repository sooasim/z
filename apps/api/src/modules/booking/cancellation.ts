import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { audit } from '../../platform/audit.js';
import { notFound } from '../../platform/errors.js';
import { emit } from '../../platform/outbox.js';
import { notify } from '../../platform/notify.js';
import { applyBps } from '../../platform/money.js';
import { releaseBlock } from '../../platform/inventory.js';
import { requestRefund } from '../payments/service.js';
import { reservationMachine } from './fsm.js';
import { lockReservation, roleOf, type ReservationRole, type ReservationRow } from './reservations.js';
import { staffDenied, staffOk } from './availability.js';

export interface CancellationEvaluation {
  actorRole: ReservationRole;
  policyCode: string | null;
  hoursBeforeCheckIn: number;
  checkInAt: string;
  timezone: string;
  tier: { min_hours_before: number; refund_pct: number } | null;
  refundPct: number;
  serviceFeeRefundable: boolean;
  totalMinor: number;
  alreadyRefundedMinor: number;
  platformFeeMinor: number;
  /** tax charged on the service fee (part of the fee component) */
  serviceFeeTaxMinor: number;
  refundableBaseMinor: number;
  refundMinor: number;
  /** the part of refundMinor that returns the service fee + its tax (PAY-02 component refund; the rest is payee gross) */
  feeRefundMinor: number;
  nonRefundableMinor: number;
  currency: string;
  basis: 'GUEST_POLICY' | 'HOST_CANCELLATION' | 'STAFF_CANCELLATION';
  evaluatedAt: string;
}

/**
 * STAY-10 policy evaluation from the immutable cancellation_policy_snapshot (never the live policy).
 * Guest: refund % of the first tier whose min_hours_before ≤ hours remaining until check-in
 * (check-in date + check-in time in the property timezone). The refund has two components that the ledger reverses
 * separately (finance postRefundReversal): the stay gross (nights + cleaning = total − service fee − its tax) and the
 * service fee + its tax. A guest gets pct of the gross, and pct of the fee component only when the policy marks the
 * service fee refundable (a kept fee keeps its fee revenue AND its output VAT). Host/staff: 100 % of both.
 */
export async function evaluateCancellation(db: Db, r: ReservationRow, role: ReservationRole, at?: Date): Promise<CancellationEvaluation> {
  const snap = r.cancellation_policy_snapshot ?? {};
  const timezone: string = snap.timezone ?? 'Asia/Seoul';
  const checkInTime: string = snap.checkInTime ?? '15:00';
  const t = await one<{ hours: number; check_in_at: Date; now: Date }>(
    db,
    `SELECT extract(epoch FROM ((($1::date + $2::time) AT TIME ZONE $3) - coalesce($4::timestamptz, now()))) / 3600.0 AS hours,
            (($1::date + $2::time) AT TIME ZONE $3) AS check_in_at, coalesce($4::timestamptz, now()) AS now`,
    [r.check_in, checkInTime, timezone, at ?? null],
  );
  const hours = Number(t.hours);
  const total = r.total_minor;
  const remaining = Math.max(0, total - r.refunded_minor);
  const platformFee = Math.max(0, Math.trunc(Number(r.quote_snapshot?.platformFeeMinor ?? 0)));
  const feeTax = Math.max(0, Math.trunc(Number(r.quote_snapshot?.taxMinor ?? 0)));
  const feePart = Math.min(total, platformFee + feeTax);
  const grossPart = total - feePart;
  const serviceFeeRefundable = snap.service_fee_refundable === true;
  let tier: CancellationEvaluation['tier'] = null;
  let pct = 100;
  let base = total;
  let feeRefund = feePart;
  let grossRefund = grossPart;
  const basis: CancellationEvaluation['basis'] = role === 'HOST' ? 'HOST_CANCELLATION' : role === 'STAFF' ? 'STAFF_CANCELLATION' : 'GUEST_POLICY';
  if (role === 'GUEST') {
    const tiers: Array<{ min_hours_before: number; refund_pct: number }> = Array.isArray(snap.tiers) ? [...snap.tiers] : [];
    tiers.sort((a, b) => b.min_hours_before - a.min_hours_before);
    tier = tiers.find((x) => hours >= x.min_hours_before) ?? null;
    pct = tier ? Math.max(0, Math.min(100, Math.trunc(tier.refund_pct))) : 0;
    base = serviceFeeRefundable ? total : grossPart;
    grossRefund = applyBps(grossPart, pct * 100);
    feeRefund = serviceFeeRefundable ? applyBps(feePart, pct * 100) : 0;
  }
  const refund = Math.max(0, Math.min(remaining, grossRefund + feeRefund));
  const feeRefundMinor = Math.min(feeRefund, refund);
  return {
    actorRole: role,
    policyCode: snap.code ?? null,
    hoursBeforeCheckIn: Math.round(hours * 100) / 100,
    checkInAt: new Date(t.check_in_at).toISOString(),
    timezone,
    tier,
    refundPct: pct,
    serviceFeeRefundable: role === 'GUEST' ? serviceFeeRefundable : true,
    totalMinor: total,
    alreadyRefundedMinor: r.refunded_minor,
    platformFeeMinor: platformFee,
    serviceFeeTaxMinor: feeTax,
    refundableBaseMinor: base,
    refundMinor: refund,
    feeRefundMinor,
    nonRefundableMinor: remaining - refund,
    currency: r.currency,
    basis,
    evaluatedAt: new Date(t.now).toISOString(),
  };
}

export async function cancellationPreview(db: Db, ctx: Ctx, id: string) {
  const actor = ctx.actor!;
  const r = await maybeOne<ReservationRow>(
    db,
    `SELECT id, property_id, host_id, guest_id, status, check_in::text AS check_in, check_out::text AS check_out, total_minor, refunded_minor,
            currency, quote_snapshot, cancellation_policy_snapshot FROM reservations WHERE id = $1`,
    [id],
  );
  if (!r) throw notFound('Reservation');
  const role = roleOf(actor, r, 'READ');
  if (!role) throw staffDenied(actor, 'READ');
  const evaluation = await evaluateCancellation(db, r, role);
  if (role === 'STAFF') {
    await audit(db, ctx, { action: 'reservation.cancellation_preview.read', resourceType: 'reservation', resourceId: id, category: 'ELEVATED_ACCESS' });
  }
  // a staff member without the CANCEL capability sees the evaluation but cannot execute it
  const cancellable = reservationMachine.can(r.status, 'CANCELLED') && (role !== 'STAFF' || staffOk(actor, 'CANCEL'));
  return { reservationId: id, status: r.status, cancellable, evaluation };
}

/**
 * Cancel a CONFIRMED reservation. Guest → policy refund; host → full refund + penalty record; staff (CANCEL capability:
 * ADMIN/ACCOUNTING — the PAY-02 staff-refund roles, since it refunds 100 % incl. the service fee) → full refund, MONEY audit.
 */
export async function cancelReservation(tx: Tx, ctx: Ctx, id: string, reason: string) {
  const actor = ctx.actor!;
  const r = await lockReservation(tx, id);
  const role = roleOf(actor, r, 'CANCEL');
  if (!role) throw staffDenied(actor, 'CANCEL');
  reservationMachine.assert(r.status, 'CANCELLED');
  const ev = await evaluateCancellation(tx, r, role);
  const actorType = role === 'STAFF' ? 'ADMIN' : 'USER';
  await reservationMachine.transition(tx, ctx, {
    table: 'reservations', id, from: 'CONFIRMED', to: 'CANCELLED', reason, actorType, versioned: true,
    set: { cancelled_at: new Date(), cancel_reason: reason }, metadata: { by: role, refundMinor: ev.refundMinor, policy: ev.policyCode },
  });
  if (r.inventory_block_id) await releaseBlock(tx, r.inventory_block_id, 'RELEASED');
  if (role === 'HOST') {
    // record the host-caused cancellation; the forfeited payout is the factual basis, any extra penalty is a finance rule decision
    const qs = r.quote_snapshot ?? {};
    const forfeited = Math.max(0, (qs.subtotalMinor ?? 0) + (qs.cleaningFeeMinor ?? 0) - (qs.hostFeeMinor ?? 0));
    await tx.query(
      `INSERT INTO reservation_adjustments(reservation_id, adjustment_type, amount_minor, currency, policy_evaluation, created_by)
       VALUES ($1,'HOST_CANCELLATION_PENALTY',$2,$3,$4,$5)`,
      [id, forfeited, r.currency, JSON.stringify({ basis: 'HOST_CANCELLATION', forfeitedPayoutMinor: forfeited, guestRefundMinor: ev.refundMinor, hoursBeforeCheckIn: ev.hoursBeforeCheckIn }), actor.userId],
    );
  }
  const idempotencyKey = `reservation:${id}:cancellation`;
  let refund: { refundId: string | null; status: string } | null = null;
  if (ev.refundMinor > 0) {
    await reservationMachine.transition(tx, ctx, {
      table: 'reservations', id, from: 'CANCELLED', to: 'REFUND_PENDING', reason: 'refund requested', actorType, versioned: true,
      metadata: { refundMinor: ev.refundMinor, idempotencyKey },
    });
    // PAY-02 contract: payments owns the refund FSM and calls onRefunded when the provider completes it
    // component refund: the ledger reverses only the refunded gross / fee parts (a kept service fee keeps its revenue + VAT)
    refund = await requestRefund(tx, ctx, {
      subjectType: 'RESERVATION', subjectId: id, amountMinor: ev.refundMinor, feeRefundMinor: ev.feeRefundMinor,
      reason: `cancellation: ${reason}`.slice(0, 500), idempotencyKey,
    });
  }
  if (role === 'STAFF') {
    await audit(tx, ctx, {
      action: 'reservation.staff_cancelled', resourceType: 'reservation', resourceId: id, before: { status: r.status },
      after: { refundMinor: ev.refundMinor, feeRefundMinor: ev.feeRefundMinor, currency: r.currency, refundId: refund?.refundId ?? null, hostId: r.host_id, guestId: r.guest_id },
      reason, category: 'MONEY',
    });
  }
  await tx.query(
    `INSERT INTO reservation_adjustments(reservation_id, adjustment_type, amount_minor, currency, policy_evaluation, refund_id, created_by)
     VALUES ($1,'CANCELLATION_REFUND',$2,$3,$4,$5,$6)`,
    [id, ev.refundMinor, r.currency, JSON.stringify({ ...ev, refundRequest: refund }), refund?.refundId ?? null, actor.userId],
  );
  const payload = { reservationId: id, propertyId: r.property_id, guestId: r.guest_id, hostId: r.host_id, cancelledBy: role, refundMinor: ev.refundMinor, currency: r.currency, checkIn: r.check_in, checkOut: r.check_out };
  await emit(tx, ctx, { aggregateType: 'reservation', aggregateId: id, eventType: 'reservation.cancellation_requested', payload: { ...payload, evaluation: ev } });
  await emit(tx, ctx, { aggregateType: 'reservation', aggregateId: id, eventType: 'reservation.cancelled', payload });
  await emit(tx, ctx, { aggregateType: 'property', aggregateId: r.property_id, eventType: 'availability.changed', payload: { propertyId: r.property_id, reason: 'RESERVATION_CANCELLED', start: r.check_in, end: r.check_out } });
  for (const userId of [r.guest_id, r.host_id]) {
    await notify(tx, ctx, {
      userId, templateKey: 'reservation.cancelled', title: '예약이 취소되었습니다', body: `예약 ${r.code} (${r.check_in}~${r.check_out})`,
      data: { reservationId: id, refundMinor: ev.refundMinor, currency: r.currency, cancelledBy: role }, dedupeKey: `reservation.cancelled:${id}`,
    });
  }
  const after = await lockReservation(tx, id);
  return { reservation: after, evaluation: ev };
}
