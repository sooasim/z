/**
 * PAY-01 Payment orchestrator + PAY-02 Refund orchestrator (domain logic; no req/reply here).
 *
 * Invariants enforced here:
 *  3  – a browser success redirect never confirms: only provider.confirm/get results with matching
 *       orderId / amount / currency / status move a payment to APPROVED.
 *  4  – webhooks are authenticated (provider re-fetch + optional HMAC), deduped and idempotent.
 *  9  – no PAN/CVC anywhere: only paymentKey/orderId/amount and PG metadata are stored.
 *  11 – ledger postings are append-only (finance/ledger.ts), refunds are compensating entries.
 */
import type pg from 'pg';
import type { Tx, Db } from '../../platform/db.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import type { AppContext, Ctx } from '../../platform/context.js';
import { getAdapter } from '../../platform/context.js';
import { StateMachine, recordTransition } from '../../platform/fsm.js';
import { emit } from '../../platform/outbox.js';
import { notify } from '../../platform/notify.js';
import { audit } from '../../platform/audit.js';
import { AppError, badRequest, conflict, forbidden, gone, notFound, unprocessable } from '../../platform/errors.js';
import { paymentSubject, type PayableSnapshot, type PaymentSubjectType } from '../../platform/payment-subjects.js';
import { canonicalJson, randomToken, sha256 } from '../../platform/crypto.js';
import { postPaymentApproval, postRefundReversal } from '../finance/ledger.js';
import { ProviderError, type PaymentProvider, type ProviderPayment } from './provider.js';

export type PaymentStatus = 'CREATED' | 'CONFIRMING' | 'APPROVED' | 'FAILED' | 'CANCELLED' | 'PARTIALLY_REFUNDED' | 'REFUNDED';
export type RefundStatus = 'REQUESTED' | 'PROVIDER_PENDING' | 'PARTIAL' | 'REFUNDED' | 'FAILED';

export const PaymentFSM = new StateMachine<PaymentStatus>('payment', {
  CREATED: ['CONFIRMING', 'APPROVED', 'FAILED', 'CANCELLED'],
  CONFIRMING: ['APPROVED', 'FAILED', 'CANCELLED'],
  FAILED: ['CONFIRMING', 'APPROVED', 'CANCELLED'],
  APPROVED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED'],
  REFUNDED: [],
  CANCELLED: [],
});

export const RefundFSM = new StateMachine<RefundStatus>('refund', {
  REQUESTED: ['PROVIDER_PENDING', 'FAILED'],
  PROVIDER_PENDING: ['REFUNDED', 'PARTIAL', 'FAILED'],
  FAILED: ['PROVIDER_PENDING'],
  PARTIAL: [],
  REFUNDED: [],
});

export const APPROVED_STATES: PaymentStatus[] = ['APPROVED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
/** FAILED payments with these codes were never processed by the PG and may be confirmed again. */
export const RETRYABLE_FAILURE_CODES = new Set(['CONFIRM_NOT_RECEIVED']);
export const MAX_REFUND_ATTEMPTS = 6;

export interface PaymentRow {
  id: string;
  provider: 'TOSS' | 'MOCK';
  provider_order_id: string;
  payment_key: string | null;
  payer_id: string;
  subject_type: PaymentSubjectType;
  subject_id: string;
  status: PaymentStatus;
  amount_minor: number;
  refunded_minor: number;
  currency: string;
  method: string | null;
  provider_status: string | null;
  receipt_url: string | null;
  failure_code: string | null;
  failure_message: string | null;
  approved_at: Date | null;
  expires_at: Date;
  payable_snapshot: PayableSnapshot;
  order_name: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

export interface RefundRow {
  id: string;
  payment_id: string;
  amount_minor: number;
  currency: string;
  reason: string;
  requested_by: string | null;
  status: RefundStatus;
  provider_ref: string | null;
  failure_message: string | null;
  idempotency_key: string;
  attempts: number;
  next_attempt_at: Date | null;
  source: 'PLATFORM' | 'PROVIDER_SYNC';
  /** part of the refund returning the buyer service fee + tax (null = not specified → pro rata ledger reversal) */
  fee_refund_minor: number | null;
  created_at: Date;
  completed_at: Date | null;
}

export const providerOf = (app: AppContext) => getAdapter<PaymentProvider>(app, 'payments.provider');

export function paymentDto(p: PaymentRow) {
  return {
    id: p.id,
    provider: p.provider,
    orderId: p.provider_order_id,
    paymentKey: p.payment_key,
    payerId: p.payer_id,
    subjectType: p.subject_type,
    subjectId: p.subject_id,
    status: p.status,
    amountMinor: p.amount_minor,
    refundedMinor: p.refunded_minor,
    currency: p.currency,
    orderName: p.order_name,
    method: p.method,
    providerStatus: p.provider_status,
    receiptUrl: p.receipt_url,
    failureCode: p.failure_code,
    failureMessage: p.failure_message,
    approvedAt: p.approved_at,
    expiresAt: p.expires_at,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export function refundDto(r: RefundRow) {
  return {
    id: r.id,
    paymentId: r.payment_id,
    amountMinor: r.amount_minor,
    currency: r.currency,
    reason: r.reason,
    status: r.status,
    source: r.source,
    attempts: r.attempts,
    failureMessage: r.failure_message,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

const newOrderId = () => `JP${randomToken(18)}`; // 26 url-safe chars [A-Za-z0-9_-]

function validateSnapshot(s: PayableSnapshot) {
  if (!Number.isInteger(s.amountMinor) || s.amountMinor <= 0) throw unprocessable('NOTHING_TO_PAY', 'This item has no payable amount');
  if (!/^[A-Z]{3}$/.test(s.currency)) throw new Error('payment subject returned an invalid currency');
  const payees = (s.split ?? []).reduce((a, x) => a + (x.grossMinor - x.feeMinor) + (x.taxMinor ?? 0), 0);
  if (payees > s.amountMinor) throw new Error('payment subject split exceeds the payable amount');
}

// ------------------------------------------------------------------------------------------------
// prepare
// ------------------------------------------------------------------------------------------------

export async function preparePayment(tx: Tx, ctx: Ctx, input: { subjectType: PaymentSubjectType; subjectId: string }) {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  let handler;
  try {
    handler = paymentSubject(input.subjectType);
  } catch {
    throw badRequest('SUBJECT_UNSUPPORTED', `Payments for ${input.subjectType} are not available`);
  }
  // SERVER-SIDE authoritative amount (never the client's)
  const snap = await handler.payable(tx, ctx, input.subjectId);
  if (snap.payerId !== actor.userId) throw forbidden('NOT_PAYER', 'Only the buyer can pay for this item');
  validateSnapshot(snap);
  // FAILED payments with a retryable code (the PG never received the confirm) could still be confirmed by a late
  // browser retry: a new prepare supersedes them too, so at most one payment of the subject can ever be captured.
  const existing = await q<PaymentRow>(
    tx,
    `SELECT * FROM payments WHERE subject_type = $1 AND subject_id = $2
        AND (status IN ('CREATED','CONFIRMING','APPROVED','PARTIALLY_REFUNDED','REFUNDED') OR (status = 'FAILED' AND failure_code = ANY($3::text[])))
      FOR UPDATE`,
    [input.subjectType, input.subjectId, [...RETRYABLE_FAILURE_CODES]],
  );
  if (existing.some((p) => APPROVED_STATES.includes(p.status))) throw conflict('ALREADY_PAID', 'This item has already been paid');
  if (existing.some((p) => p.status === 'CONFIRMING')) throw conflict('PAYMENT_IN_PROGRESS', 'A payment for this item is being confirmed');
  for (const p of existing.filter((x) => x.status === 'CREATED' || x.status === 'FAILED')) {
    await PaymentFSM.transition(tx, ctx, { table: 'payments', id: p.id, from: p.status, to: 'CANCELLED', reason: 'SUPERSEDED', versioned: true });
  }
  const cfg = ctx.app.config;
  const payment = await one<PaymentRow>(
    tx,
    `INSERT INTO payments(provider, provider_order_id, payer_id, subject_type, subject_id, status, amount_minor, currency, expires_at, payable_snapshot, order_name)
     VALUES ($1,$2,$3,$4,$5,'CREATED',$6,$7, now() + make_interval(secs => $8), $9, $10) RETURNING *`,
    [
      cfg.PAYMENT_PROVIDER,
      newOrderId(),
      actor.userId,
      input.subjectType,
      input.subjectId,
      snap.amountMinor,
      snap.currency,
      cfg.PAYMENT_TTL_SEC,
      JSON.stringify(snap),
      snap.orderName.slice(0, 100),
    ],
  );
  await recordTransition(tx, ctx, { aggregateType: 'payment', aggregateId: payment.id, from: null, to: 'CREATED', reason: 'PREPARE' });
  await handler.onPaymentCreated?.(tx, ctx, input.subjectId, payment.id);
  await emit(tx, ctx, {
    aggregateType: 'payment',
    aggregateId: payment.id,
    eventType: 'payment.created',
    payload: { paymentId: payment.id, subjectType: payment.subject_type, subjectId: payment.subject_id, amountMinor: payment.amount_minor, currency: payment.currency },
  });
  const web = cfg.PUBLIC_WEB_URL.replace(/\/+$/, '');
  return {
    paymentId: payment.id,
    orderId: payment.provider_order_id,
    amount: payment.amount_minor,
    currency: payment.currency,
    orderName: payment.order_name ?? snap.orderName,
    provider: payment.provider,
    clientKey: cfg.PAYMENT_PROVIDER === 'TOSS' ? cfg.TOSS_CLIENT_KEY ?? null : 'mock_client_key',
    customerKey: `JPU_${actor.userId}`,
    successUrl: `${web}/checkout/success?paymentId=${payment.id}`,
    failUrl: `${web}/checkout/fail?paymentId=${payment.id}`,
    expiresAt: payment.expires_at,
  };
}

// ------------------------------------------------------------------------------------------------
// approve / fail (shared by confirm, webhook, reconciliation)
// ------------------------------------------------------------------------------------------------

async function lockPayment(tx: Tx, id: string): Promise<PaymentRow> {
  const p = await maybeOne<PaymentRow>(tx, `SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [id]);
  if (!p) throw notFound('Payment');
  return p;
}

export async function markFailed(
  tx: Tx,
  ctx: Ctx,
  payment: PaymentRow,
  f: { code: string; message: string; notifySubject: boolean; to?: 'FAILED' | 'CANCELLED'; providerStatus?: string | null },
): Promise<PaymentRow> {
  const to = f.to ?? 'FAILED';
  const { row } = await PaymentFSM.transition(tx, ctx, {
    table: 'payments',
    id: payment.id,
    to,
    reason: f.code,
    versioned: true,
    set: { failure_code: f.code, failure_message: f.message.slice(0, 500), provider_status: f.providerStatus ?? payment.provider_status },
  });
  if (f.notifySubject) {
    await paymentSubject(payment.subject_type).onPaymentFailed?.(tx, ctx, payment.subject_id, { id: payment.id, reason: f.code });
  }
  await emit(tx, ctx, {
    aggregateType: 'payment',
    aggregateId: payment.id,
    eventType: 'payment.failed',
    payload: { paymentId: payment.id, subjectType: payment.subject_type, subjectId: payment.subject_id, code: f.code, final: f.notifySubject },
  });
  if (f.notifySubject) {
    await notify(tx, ctx, {
      userId: payment.payer_id,
      templateKey: 'payment.failed',
      title: '결제가 완료되지 않았습니다',
      body: `${payment.order_name ?? '결제'}: ${f.message}`.slice(0, 300),
      data: { paymentId: payment.id, code: f.code },
      dedupeKey: `payment.failed:${payment.id}`,
    });
  }
  return row as PaymentRow;
}

function providerMatches(payment: PaymentRow, pp: ProviderPayment): string | null {
  if (pp.orderId !== payment.provider_order_id) return 'ORDER_ID_MISMATCH';
  if (pp.totalAmount !== payment.amount_minor) return 'AMOUNT_MISMATCH';
  if (pp.currency && pp.currency !== payment.currency) return 'CURRENCY_MISMATCH';
  return null;
}

/**
 * Move a locked payment to APPROVED after the provider confirmed it (status DONE/PARTIAL_CANCELED/CANCELED
 * with matching order/amount/currency). Calls the subject, posts the ledger, issues the receipt.
 * If the subject can no longer accept the payment (e.g. order expired meanwhile), the money is captured
 * but an automatic full refund is requested.
 */
export async function approvePayment(tx: Tx, ctx: Ctx, payment: PaymentRow, pp: ProviderPayment, source: string): Promise<PaymentRow> {
  if (APPROVED_STATES.includes(payment.status)) return payment;
  const dup = await maybeOne<{ id: string }>(
    tx,
    `SELECT id FROM payments WHERE subject_type = $1 AND subject_id = $2 AND id <> $3 AND status IN ('APPROVED','PARTIALLY_REFUNDED','REFUNDED')`,
    [payment.subject_type, payment.subject_id, payment.id],
  );
  if (dup) {
    // a second, duplicate charge for an already-paid subject: record a durable void of the captured money; the PG
    // cancel runs (and is retried) outside this transaction, and provider_status says CANCELED only once it landed
    await recordVoid(tx, ctx, { payment, paymentKey: pp.paymentKey, amountMinor: pp.balanceAmount, reason: 'DUPLICATE_PAYMENT', idempotencyKey: `dup-${payment.id}` });
    return markFailed(tx, ctx, payment, { code: 'DUPLICATE_PAYMENT', message: 'Subject already paid; the duplicate charge is being voided', notifySubject: false, to: 'CANCELLED', providerStatus: pp.status });
  }
  const { row } = await PaymentFSM.transition(tx, ctx, {
    table: 'payments',
    id: payment.id,
    from: ['CREATED', 'CONFIRMING', 'FAILED'],
    to: 'APPROVED',
    reason: source,
    actorType: source === 'CONFIRM' ? undefined : 'PROVIDER',
    versioned: true,
    set: {
      payment_key: pp.paymentKey,
      method: pp.method,
      receipt_url: pp.receiptUrl,
      provider_status: pp.status,
      approved_at: pp.approvedAt ? new Date(pp.approvedAt) : new Date(),
      failure_code: null,
      failure_message: null,
    },
  });
  const approved = row as PaymentRow;
  let subjectRejected: string | null = null;
  await tx.query('SAVEPOINT pay_subject');
  try {
    await paymentSubject(approved.subject_type).onPaymentApproved(tx, ctx, approved.subject_id, {
      id: approved.id,
      amountMinor: approved.amount_minor,
      currency: approved.currency,
    });
    await tx.query('RELEASE SAVEPOINT pay_subject');
  } catch (err: any) {
    await tx.query('ROLLBACK TO SAVEPOINT pay_subject');
    // a deadlock / serialization failure / lock or statement timeout is not the subject refusing the payment: abort
    // the whole approval so withTx retries it (or the payment stays CONFIRMING for the reconciliation job)
    if (isTransientDbError(err)) throw err;
    subjectRejected = err?.code ?? err?.message ?? 'SUBJECT_REJECTED';
    ctx.app.log.warn({ paymentId: approved.id, reason: subjectRejected }, 'subject rejected approved payment; auto-refunding');
  }
  await postPaymentApproval(tx, ctx, {
    paymentId: approved.id,
    amountMinor: approved.amount_minor,
    currency: approved.currency,
    snapshot: approved.payable_snapshot,
  });
  await tx.query(
    `INSERT INTO receipts(user_id, payment_id, receipt_type, amount_minor, currency, data) VALUES ($1,$2,'PAYMENT',$3,$4,$5)`,
    [
      approved.payer_id,
      approved.id,
      approved.amount_minor,
      approved.currency,
      JSON.stringify({ orderId: approved.provider_order_id, orderName: approved.order_name, method: approved.method, receiptUrl: approved.receipt_url, subjectType: approved.subject_type, subjectId: approved.subject_id }),
    ],
  );
  await emit(tx, ctx, {
    aggregateType: 'payment',
    aggregateId: approved.id,
    eventType: 'payment.approved',
    payload: {
      paymentId: approved.id,
      subjectType: approved.subject_type,
      subjectId: approved.subject_id,
      payerId: approved.payer_id,
      amountMinor: approved.amount_minor,
      currency: approved.currency,
      source,
    },
  });
  await notify(tx, ctx, {
    userId: approved.payer_id,
    templateKey: 'payment.approved',
    title: '결제가 완료되었습니다',
    body: `${approved.order_name ?? '결제'} · ${approved.amount_minor} ${approved.currency}`,
    data: { paymentId: approved.id, subjectType: approved.subject_type, subjectId: approved.subject_id },
    dedupeKey: `payment.approved:${approved.id}`,
  });
  if (subjectRejected) {
    await requestRefund(tx, ctx, {
      subjectType: approved.subject_type,
      subjectId: approved.subject_id,
      amountMinor: approved.amount_minor,
      reason: `AUTO_REFUND:${String(subjectRejected).slice(0, 60)}`,
      idempotencyKey: `auto-refund:${approved.id}`,
      requestedBy: null,
    });
  }
  return approved;
}

/**
 * Bring a locked payment in line with the provider's authoritative state (webhook + reconciliation job).
 * Returns what was done.
 */
export async function reconcileFromProvider(tx: Tx, ctx: Ctx, payment: PaymentRow, pp: ProviderPayment, source: string): Promise<string> {
  if (pp.orderId !== payment.provider_order_id) return 'ORDER_ID_MISMATCH';
  let action = 'NOOP';
  const unapproved = ['CREATED', 'CONFIRMING', 'FAILED'].includes(payment.status);
  if (pp.status === 'DONE' || pp.status === 'PARTIAL_CANCELED' || pp.status === 'CANCELED') {
    if (unapproved) {
      const mismatch = providerMatches(payment, pp);
      if (mismatch) {
        // money captured for a payment we cannot accept: durable, retried void (never fire-and-forget)
        await recordVoid(tx, ctx, { payment, paymentKey: pp.paymentKey, amountMinor: pp.balanceAmount, reason: mismatch, idempotencyKey: `mismatch-${payment.id}` });
        await markFailed(tx, ctx, payment, { code: mismatch, message: 'Provider payment does not match the order', notifySubject: true, providerStatus: pp.status });
        action = mismatch;
      } else if (pp.balanceAmount > 0 || pp.status === 'DONE') {
        payment = await approvePayment(tx, ctx, payment, pp, source);
        action = 'APPROVED';
      } else {
        // approved then fully cancelled before we ever recorded it: nothing was delivered
        await markFailed(tx, ctx, payment, { code: 'CANCELED_AT_PROVIDER', message: 'Payment was cancelled at the provider', notifySubject: true, to: 'CANCELLED', providerStatus: pp.status });
        action = 'CANCELLED';
      }
    }
    if (APPROVED_STATES.includes(payment.status) && pp.status !== 'DONE') {
      const synced = await syncProviderCancels(tx, ctx, payment, pp);
      if (synced) action = action === 'APPROVED' ? 'APPROVED+REFUND_SYNCED' : 'REFUND_SYNCED';
    }
    if (payment.status === 'CANCELLED' && pp.balanceAmount > 0) {
      // the PG holds captured money for a payment we consider cancelled (superseded / duplicate / late capture):
      // make sure a void exists (no-op when one was already recorded, e.g. for a duplicate)
      const voidId = await recordVoid(tx, ctx, { payment, paymentKey: pp.paymentKey, amountMinor: pp.balanceAmount, reason: 'CAPTURED_AFTER_CANCEL', idempotencyKey: `late-capture-${payment.id}` });
      if (voidId) action = 'VOID_REQUESTED';
    }
  } else if (pp.status === 'ABORTED' || pp.status === 'EXPIRED') {
    if (unapproved && payment.status !== 'FAILED') {
      await markFailed(tx, ctx, payment, { code: `PROVIDER_${pp.status}`, message: `Payment ${pp.status.toLowerCase()} at provider`, notifySubject: true, providerStatus: pp.status });
      action = 'FAILED';
    }
  } else {
    await tx.query(`UPDATE payments SET provider_status = $2, method = coalesce($3, method) WHERE id = $1`, [payment.id, pp.status, pp.method]);
    action = 'PENDING';
  }
  await emit(tx, ctx, {
    aggregateType: 'payment',
    aggregateId: payment.id,
    eventType: 'payment.reconciled',
    payload: { paymentId: payment.id, providerStatus: pp.status, action, source },
  });
  return action;
}

/** Provider-side cancellations we do not know about (e.g. PG console) become completed PROVIDER_SYNC refunds. */
async function syncProviderCancels(tx: Tx, ctx: Ctx, payment: PaymentRow, pp: ProviderPayment): Promise<boolean> {
  const fresh = await lockPayment(tx, payment.id);
  const inflight = await maybeOne(
    tx,
    `SELECT 1 FROM refunds WHERE payment_id = $1 AND (status IN ('REQUESTED','PROVIDER_PENDING') OR (status = 'FAILED' AND attempts < $2)) LIMIT 1`,
    [payment.id, MAX_REFUND_ATTEMPTS],
  );
  if (inflight) return false; // the refund executor will finish those
  const providerCancelled = pp.totalAmount - pp.balanceAmount;
  const diff = providerCancelled - fresh.refunded_minor;
  if (diff <= 0) return false;
  const refund = await one<RefundRow>(
    tx,
    `INSERT INTO refunds(payment_id, amount_minor, currency, reason, requested_by, status, idempotency_key, source)
     VALUES ($1,$2,$3,'PROVIDER_CANCEL_SYNC',NULL,'PROVIDER_PENDING',$4,'PROVIDER_SYNC') RETURNING *`,
    [payment.id, diff, fresh.currency, `provider-sync:${payment.id}:${providerCancelled}`],
  );
  await recordTransition(tx, ctx, { aggregateType: 'refund', aggregateId: refund.id, from: null, to: 'PROVIDER_PENDING', reason: 'PROVIDER_SYNC', actorType: 'PROVIDER' });
  await completeRefund(tx, ctx, refund, fresh, pp.cancels.at(-1)?.transactionKey ?? null);
  return true;
}

// ------------------------------------------------------------------------------------------------
// confirm
// ------------------------------------------------------------------------------------------------

export interface ConfirmResult { status: number; body: any; replayed: boolean }

async function readIdempotent(pool: pg.Pool, scope: string, key: string, request: unknown): Promise<ConfirmResult | null> {
  const prev = await maybeOne<{ request_hash: string; response_status: number | null; response_body: any }>(
    pool,
    `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE scope = $1 AND idempotency_key = $2`,
    [scope, key],
  );
  if (!prev) return null;
  if (prev.request_hash !== sha256(canonicalJson(request ?? null))) throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different request');
  if (prev.response_status == null) throw conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this key is in progress');
  return { status: prev.response_status, body: prev.response_body, replayed: true };
}

async function storeIdempotent(tx: Tx, scope: string, key: string, request: unknown, status: number, body: unknown) {
  await tx.query(
    `INSERT INTO idempotency_keys(scope, idempotency_key, request_hash, response_status, response_body) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (scope, idempotency_key) DO NOTHING`,
    [scope, key, sha256(canonicalJson(request ?? null)), status, JSON.stringify(body ?? null)],
  );
}

/**
 * Two-phase confirm:
 *  A) lock by orderId, validate payer/state/expiry and `amount === amount_minor` (400 AMOUNT_MISMATCH, no PG call),
 *     move to CONFIRMING and COMMIT (a crash afterwards leaves CONFIRMING → reconciliation job resolves via provider.get);
 *  B) provider.confirm, verify orderId/totalAmount/currency/status, then APPROVED + subject + ledger + receipt in ONE tx.
 */
export async function confirmPayment(ctx: Ctx, input: { paymentKey: string; orderId: string; amount: number }, idempotencyKey: string): Promise<ConfirmResult> {
  const actor = ctx.actor;
  if (!actor) throw forbidden();
  const pool = ctx.app.pool;
  const scope = `payments.confirm:${actor.userId}`;
  const replay = await readIdempotent(pool, scope, idempotencyKey, input);
  if (replay) return replay;

  const finish = async (status: number, body: any): Promise<ConfirmResult> => {
    await withTx(pool, (tx) => storeIdempotent(tx, scope, idempotencyKey, input, status, body));
    return { status, body, replayed: false };
  };

  const phaseA = await withTx(pool, async (tx) => {
    const p = await maybeOne<PaymentRow>(tx, `SELECT * FROM payments WHERE provider_order_id = $1 FOR UPDATE`, [input.orderId]);
    if (!p) throw notFound('Payment');
    if (p.payer_id !== actor.userId) throw forbidden('NOT_PAYER', 'This payment belongs to another user');
    if (input.amount !== p.amount_minor) return { kind: 'mismatch' as const, payment: p };
    if (APPROVED_STATES.includes(p.status)) {
      if (p.payment_key === input.paymentKey) return { kind: 'done' as const, payment: p };
      throw conflict('ALREADY_PAID', 'This order has already been paid');
    }
    if (p.status === 'CONFIRMING') throw conflict('PAYMENT_CONFIRMING', 'This payment is being confirmed; check its status shortly');
    if (p.status === 'CANCELLED') throw conflict('PAYMENT_CANCELLED', 'This payment was cancelled; prepare a new one');
    if (p.status === 'FAILED' && !RETRYABLE_FAILURE_CODES.has(p.failure_code ?? '')) throw conflict('PAYMENT_FAILED', 'This payment failed; prepare a new one');
    if (new Date(p.expires_at).getTime() <= Date.now()) throw gone('PAYMENT_EXPIRED', 'The payment window has expired; prepare a new one');
    const { row } = await PaymentFSM.transition(tx, ctx, {
      table: 'payments',
      id: p.id,
      from: ['CREATED', 'FAILED'],
      to: 'CONFIRMING',
      reason: 'CONFIRM',
      versioned: true,
      set: { payment_key: input.paymentKey },
    });
    return { kind: 'confirm' as const, payment: row as PaymentRow };
  });

  if (phaseA.kind === 'mismatch') {
    await withTx(pool, (tx) =>
      audit(tx, ctx, {
        action: 'payment.confirm.amount_mismatch',
        resourceType: 'payment',
        resourceId: phaseA.payment.id,
        category: 'MONEY',
        after: { clientAmount: input.amount, serverAmount: phaseA.payment.amount_minor },
      }),
    );
    throw badRequest('AMOUNT_MISMATCH', 'The amount does not match the order amount');
  }
  if (phaseA.kind === 'done') return finish(200, { item: paymentDto(phaseA.payment) });

  const payment = phaseA.payment;
  const provider = providerOf(ctx.app);
  let pp: ProviderPayment;
  try {
    pp = await provider.confirm({
      paymentKey: input.paymentKey,
      orderId: payment.provider_order_id,
      amount: payment.amount_minor,
      idempotencyKey: `confirm-${payment.id}-${input.paymentKey}`.slice(0, 300),
      currency: payment.currency,
    });
  } catch (err) {
    const e = err instanceof ProviderError ? err : new ProviderError('UNKNOWN', String((err as any)?.message ?? err), true);
    if (e.code === 'ALREADY_PROCESSED_PAYMENT') {
      try {
        pp = await provider.get(input.paymentKey);
      } catch {
        return { status: 202, body: { item: paymentDto(payment), pending: true, code: 'RECONCILIATION_PENDING' }, replayed: false };
      }
    } else if (e.retryable) {
      // outcome unknown: stay CONFIRMING; the reconciliation job resolves it with provider.get
      return { status: 202, body: { item: paymentDto(payment), pending: true, code: 'RECONCILIATION_PENDING' }, replayed: false };
    } else {
      const failed = await withTx(pool, async (tx) => {
        const p = await lockPayment(tx, payment.id);
        if (p.status !== 'CONFIRMING') return p;
        return markFailed(tx, ctx, p, { code: e.code, message: e.message, notifySubject: true });
      });
      return finish(402, { item: paymentDto(failed), code: 'PAYMENT_FAILED', providerCode: e.code, message: e.message });
    }
  }

  const mismatch = providerMatches(payment, pp);
  if (mismatch || pp.paymentKey !== input.paymentKey) {
    const code = mismatch ?? 'PAYMENT_KEY_MISMATCH';
    const failed = await withTx(pool, async (tx) => {
      const p = await lockPayment(tx, payment.id);
      // the PG captured money we will not accept: durable void, executed and retried after commit
      if (!APPROVED_STATES.includes(p.status)) {
        await recordVoid(tx, ctx, { payment: p, paymentKey: input.paymentKey, amountMinor: pp.balanceAmount || pp.totalAmount, reason: code, idempotencyKey: `mismatch-${payment.id}` });
      }
      if (p.status !== 'CONFIRMING') return p;
      return markFailed(tx, ctx, p, { code, message: 'Provider response does not match the order', notifySubject: true, providerStatus: pp.status });
    });
    return finish(502, { item: paymentDto(failed), code: 'PROVIDER_MISMATCH' });
  }
  if (pp.status !== 'DONE') {
    return withTx(pool, async (tx) => {
      const p = await lockPayment(tx, payment.id);
      const action = await reconcileFromProvider(tx, ctx, p, pp, 'CONFIRM');
      const now = await lockPayment(tx, payment.id);
      const status = APPROVED_STATES.includes(now.status) ? 200 : now.status === 'CONFIRMING' ? 202 : 402;
      const body = { item: paymentDto(now), pending: now.status === 'CONFIRMING', providerStatus: pp.status, action };
      await storeIdempotent(tx, scope, idempotencyKey, input, status, body);
      return { status, body, replayed: false };
    });
  }
  return withTx(pool, async (tx) => {
    const p = await lockPayment(tx, payment.id);
    const approved = APPROVED_STATES.includes(p.status) ? p : await approvePayment(tx, ctx, p, pp, 'CONFIRM');
    const body = { item: paymentDto(approved) };
    await storeIdempotent(tx, scope, idempotencyKey, input, 200, body);
    return { status: 200, body, replayed: false };
  });
}

// ------------------------------------------------------------------------------------------------
// refunds (PAY-02)
// ------------------------------------------------------------------------------------------------

async function inflightRefundMinor(db: Db, paymentId: string): Promise<number> {
  const r = await one<{ s: number }>(
    db,
    `SELECT coalesce(sum(amount_minor),0)::bigint AS s FROM refunds
      WHERE payment_id = $1 AND (status IN ('REQUESTED','PROVIDER_PENDING') OR (status = 'FAILED' AND attempts < $2))`,
    [paymentId, MAX_REFUND_ATTEMPTS],
  );
  return r.s;
}

export async function refundableRemaining(db: Db, payment: Pick<PaymentRow, 'id' | 'amount_minor' | 'refunded_minor'>): Promise<number> {
  return payment.amount_minor - payment.refunded_minor - (await inflightRefundMinor(db, payment.id));
}

/**
 * PAY-02 contract (consumed by booking, guide, travel). Records a refund intent in the caller's tx;
 * the provider cancel runs asynchronously (outbox consumer + retry job). Idempotent by `idempotencyKey`.
 * Returns refundId null when the subject has no approved payment or the amount is 0.
 * `feeRefundMinor` (optional): the part of `amountMinor` that returns the buyer-paid service fee + tax under the
 * subject's cancellation terms; the rest returns the payees' gross. The ledger reversal then debits only the
 * components actually refunded (finance/ledger.ts postRefundReversal). Omitted → pro rata over all approval credits.
 */
export async function requestRefund(
  db: Tx,
  ctx: Ctx,
  args: { subjectType: 'RESERVATION' | 'GUIDE_BOOKING' | 'ORDER'; subjectId: string; amountMinor: number; feeRefundMinor?: number | null; reason: string; idempotencyKey: string; requestedBy?: string | null },
): Promise<{ refundId: string | null; status: string }> {
  if (!Number.isInteger(args.amountMinor) || args.amountMinor < 0) throw badRequest('INVALID_AMOUNT', 'Refund amount must be a non-negative integer (minor units)');
  const feeRefundMinor = args.feeRefundMinor ?? null;
  if (feeRefundMinor !== null && (!Number.isInteger(feeRefundMinor) || feeRefundMinor < 0 || feeRefundMinor > args.amountMinor)) {
    throw badRequest('INVALID_AMOUNT', 'Refunded fee part must be an integer between 0 and the refund amount (minor units)');
  }
  if (!args.idempotencyKey || args.idempotencyKey.length > 200) throw badRequest('IDEMPOTENCY_KEY_INVALID', 'Refund idempotency key is required');
  const existing = await maybeOne<{ id: string; status: string }>(db, `SELECT id, status FROM refunds WHERE idempotency_key = $1`, [args.idempotencyKey]);
  if (existing) return { refundId: existing.id, status: existing.status };
  const payment = await maybeOne<PaymentRow>(
    db,
    `SELECT * FROM payments WHERE subject_type = $1 AND subject_id = $2 AND status IN ('APPROVED','PARTIALLY_REFUNDED','REFUNDED') FOR UPDATE`,
    [args.subjectType, args.subjectId],
  );
  if (!payment) return { refundId: null, status: 'NOT_PAID' };
  if (args.amountMinor === 0) return { refundId: null, status: 'NOTHING_TO_REFUND' };
  const remaining = await refundableRemaining(db, payment);
  if (args.amountMinor > remaining) {
    throw unprocessable('REFUND_EXCEEDS_REFUNDABLE', `Refund exceeds the refundable balance (${remaining} ${payment.currency})`, { refundableMinor: remaining });
  }
  const requestedBy = args.requestedBy !== undefined ? args.requestedBy : ctx.actor?.userId ?? null;
  const ins = await q<RefundRow>(
    db,
    `INSERT INTO refunds(payment_id, amount_minor, currency, reason, requested_by, status, idempotency_key, fee_refund_minor)
     VALUES ($1,$2,$3,$4,$5,'REQUESTED',$6,$7) ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
    [payment.id, args.amountMinor, payment.currency, args.reason.slice(0, 500), requestedBy, args.idempotencyKey, feeRefundMinor],
  );
  const refund = ins[0];
  if (!refund) {
    const r = await one<{ id: string; status: string }>(db, `SELECT id, status FROM refunds WHERE idempotency_key = $1`, [args.idempotencyKey]);
    return { refundId: r.id, status: r.status };
  }
  await recordTransition(db, ctx, { aggregateType: 'refund', aggregateId: refund.id, from: null, to: 'REQUESTED', reason: args.reason.slice(0, 200) });
  const payload = {
    refundId: refund.id,
    paymentId: payment.id,
    subjectType: payment.subject_type,
    subjectId: payment.subject_id,
    amountMinor: refund.amount_minor,
    currency: refund.currency,
    reason: refund.reason,
  };
  await emit(db, ctx, { aggregateType: 'refund', aggregateId: refund.id, eventType: 'refund.requested', payload });
  await emit(db, ctx, { aggregateType: 'payment', aggregateId: payment.id, eventType: 'payment.refund_requested', payload });
  await audit(db, ctx, {
    action: 'refund.requested',
    resourceType: 'payment',
    resourceId: payment.id,
    category: 'MONEY',
    reason: refund.reason,
    after: { refundId: refund.id, amountMinor: refund.amount_minor, currency: refund.currency },
  });
  return { refundId: refund.id, status: 'REQUESTED' };
}

const refundTag = (refundId: string) => `[jp:${refundId}]`;
/**
 * ONE PG idempotency key per refund for every attempt: if an earlier cancel landed although we saw a timeout, the PG
 * replays that result instead of cancelling a second time.
 */
export const refundIdempotencyKey = (refundId: string) => `refund-${refundId}`;
/** While a refund is PROVIDER_PENDING its next_attempt_at is a lease: another executor only takes it over once it expired. */
const REFUND_LEASE_SEC = 300;

/** PostgreSQL errors that are transient (the operation may succeed when retried), never a business rejection. */
export function isTransientDbError(err: any): boolean {
  if (!err || err instanceof AppError) return false;
  const code = typeof err.code === 'string' ? err.code : '';
  return ['40001', '40P01', '55P03', '57014'].includes(code) || code.startsWith('08');
}

function asRetryable(err: unknown, what: string): ProviderError {
  const e = err as any;
  return new ProviderError(e?.code && typeof e.code === 'string' ? e.code : 'VERIFY_FAILED', `${what}: ${e?.message ?? String(err)}`.slice(0, 300), true, e?.httpStatus);
}

/**
 * Execute a refund at the provider (outbox consumer after commit, retry job). Three steps so no transaction or row
 * lock is held while the PG is called:
 *  1. claim (short tx, `FOR UPDATE SKIP LOCKED`): REQUESTED/FAILED(due) → PROVIDER_PENDING, attempts + 1, lease;
 *  2. PG call with no transaction open. When an earlier attempt may have reached the PG (attempts > 0 or a stale
 *     PROVIDER_PENDING) the payment is read first and a cancel carrying this refund's tag counts as done; if that
 *     verification read fails, NOTHING is sent (retryable failure). The cancel uses one stable idempotency key;
 *  3. complete (short tx): re-lock the refund; if this claim still owns it, complete or record the failure + backoff.
 * Safe to call repeatedly and concurrently; returns 'BUSY' when another executor holds the refund.
 */
export async function processRefund(app: AppContext, ctx: Ctx, refundId: string): Promise<RefundStatus | 'BUSY'> {
  const claim = await withTx(app.pool, async (tx) => {
    const refund = await maybeOne<RefundRow>(tx, `SELECT * FROM refunds WHERE id = $1 FOR UPDATE SKIP LOCKED`, [refundId]);
    if (!refund) {
      if (!(await maybeOne(tx, `SELECT 1 FROM refunds WHERE id = $1`, [refundId]))) throw notFound('Refund');
      return { skip: 'BUSY' as const };
    }
    if (refund.status === 'REFUNDED' || refund.status === 'PARTIAL') return { skip: refund.status };
    if (refund.status === 'FAILED' && refund.attempts >= MAX_REFUND_ATTEMPTS) return { skip: refund.status };
    // FAILED: backoff not elapsed; PROVIDER_PENDING: another executor's lease is still running
    if (refund.status !== 'REQUESTED' && refund.next_attempt_at && new Date(refund.next_attempt_at).getTime() > Date.now()) return { skip: refund.status };
    const payment = await maybeOne<PaymentRow>(tx, `SELECT * FROM payments WHERE id = $1`, [refund.payment_id]);
    if (!payment) throw notFound('Payment');
    const lease = new Date(Date.now() + REFUND_LEASE_SEC * 1000);
    const row =
      refund.status === 'PROVIDER_PENDING'
        ? await one<RefundRow>(tx, `UPDATE refunds SET attempts = attempts + 1, next_attempt_at = $2 WHERE id = $1 RETURNING *`, [refund.id, lease])
        : ((await RefundFSM.transition(tx, ctx, { table: 'refunds', id: refund.id, to: 'PROVIDER_PENDING', reason: 'EXECUTE', set: { attempts: refund.attempts + 1, next_attempt_at: lease } })).row as RefundRow);
    return { row, paymentKey: payment.payment_key, verifyFirst: refund.attempts > 0 || refund.status === 'PROVIDER_PENDING' };
  });
  if ('skip' in claim) return claim.skip as RefundStatus | 'BUSY';
  const refund = claim.row;

  const provider = providerOf(app);
  const tag = refundTag(refund.id);
  let outcome: { ok: true; providerRef: string | null } | { ok: false; error: ProviderError };
  try {
    if (!claim.paymentKey) throw new ProviderError('NO_PAYMENT_KEY', 'Payment has no provider key', false);
    let providerRef: string | null = null;
    let done = false;
    if (claim.verifyFirst) {
      let cur: ProviderPayment;
      try {
        cur = await provider.get(claim.paymentKey);
      } catch (err) {
        // the previous attempt may have landed: never cancel blind; retry later
        throw asRetryable(err, 'Could not verify the previous refund attempt');
      }
      const prior = cur.cancels.find((c) => (c.cancelReason ?? '').includes(tag));
      if (prior) {
        done = true;
        providerRef = prior.transactionKey;
      }
    }
    if (!done) {
      const res = await provider.cancel({
        paymentKey: claim.paymentKey,
        cancelAmount: refund.amount_minor,
        cancelReason: `${refund.reason.slice(0, 150)} ${tag}`,
        idempotencyKey: refundIdempotencyKey(refund.id),
      });
      providerRef = res.cancels.find((c) => (c.cancelReason ?? '').includes(tag))?.transactionKey ?? res.cancels.at(-1)?.transactionKey ?? null;
    }
    outcome = { ok: true, providerRef };
  } catch (err: any) {
    outcome = { ok: false, error: err instanceof ProviderError ? err : new ProviderError('UNKNOWN', String(err?.message ?? err), true) };
  }

  return withTx(app.pool, async (tx) => {
    const cur = await maybeOne<RefundRow>(tx, `SELECT * FROM refunds WHERE id = $1 FOR UPDATE`, [refund.id]);
    // finished or taken over (lease expired) by another executor meanwhile: it owns the outcome
    if (!cur || cur.status !== 'PROVIDER_PENDING' || cur.attempts !== refund.attempts) return (cur?.status ?? 'BUSY') as RefundStatus | 'BUSY';
    if (outcome.ok) return completeRefund(tx, ctx, cur, await lockPayment(tx, cur.payment_id), outcome.providerRef);
    const e = outcome.error;
    const attempts = cur.attempts;
    const delaySec = Math.min(60 * 2 ** attempts, 6 * 3600);
    await RefundFSM.transition(tx, ctx, {
      table: 'refunds',
      id: cur.id,
      from: 'PROVIDER_PENDING',
      to: 'FAILED',
      reason: e.code,
      set: { failure_message: `${e.code}: ${e.message}`.slice(0, 500), next_attempt_at: new Date(Date.now() + delaySec * 1000) },
    });
    await emit(tx, ctx, {
      aggregateType: 'refund',
      aggregateId: cur.id,
      eventType: 'refund.failed',
      payload: { refundId: cur.id, paymentId: cur.payment_id, code: e.code, attempts, final: attempts >= MAX_REFUND_ATTEMPTS },
    });
    if (attempts >= MAX_REFUND_ATTEMPTS) {
      await audit(tx, ctx, { action: 'refund.failed.final', resourceType: 'refund', resourceId: cur.id, category: 'MONEY', reason: e.code });
    }
    return 'FAILED' as const;
  });
}

// ------------------------------------------------------------------------------------------------
// voids of captured money JETPOOL must not keep (duplicate / mismatched / late captures)
// ------------------------------------------------------------------------------------------------

export const MAX_VOID_ATTEMPTS = 10;
const VOID_LEASE_SEC = 300;

export interface VoidRow {
  id: string;
  payment_id: string;
  payment_key: string;
  amount_minor: number;
  currency: string;
  reason: string;
  idempotency_key: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'FAILED';
  attempts: number;
  next_attempt_at: Date | null;
  last_error: string | null;
  provider_status: string | null;
  created_at: Date;
  completed_at: Date | null;
}

/**
 * Record (in the caller's tx) that `amountMinor` captured at the PG for `payment` must be cancelled. Idempotent per
 * payment (one void each). Executed after commit by the outbox consumer / retry job (`processVoid`).
 */
export async function recordVoid(
  tx: Tx,
  ctx: Ctx,
  v: { payment: Pick<PaymentRow, 'id' | 'currency'>; paymentKey: string | null | undefined; amountMinor: number; reason: string; idempotencyKey: string },
): Promise<string | null> {
  if (!v.paymentKey || !Number.isInteger(v.amountMinor) || v.amountMinor <= 0) return null;
  const row = await maybeOne<{ id: string }>(
    tx,
    `INSERT INTO payment_voids(payment_id, payment_key, amount_minor, currency, reason, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT DO NOTHING RETURNING id`,
    [v.payment.id, v.paymentKey, v.amountMinor, v.payment.currency, v.reason.slice(0, 100), v.idempotencyKey.slice(0, 300)],
  );
  if (!row) return null;
  await emit(tx, ctx, {
    aggregateType: 'payment',
    aggregateId: v.payment.id,
    eventType: 'payment.void_requested',
    payload: { voidId: row.id, paymentId: v.payment.id, amountMinor: v.amountMinor, currency: v.payment.currency, reason: v.reason },
  });
  await audit(tx, ctx, { action: 'payment.void.requested', resourceType: 'payment', resourceId: v.payment.id, category: 'MONEY', reason: v.reason, after: { voidId: row.id, amountMinor: v.amountMinor } });
  return row.id;
}

/** Execute a recorded void at the PG (claim → PG call outside any transaction → complete), like `processRefund`. */
export async function processVoid(app: AppContext, ctx: Ctx, voidId: string): Promise<VoidRow['status'] | 'BUSY'> {
  const claim = await withTx(app.pool, async (tx) => {
    const v = await maybeOne<VoidRow>(tx, `SELECT * FROM payment_voids WHERE id = $1 FOR UPDATE SKIP LOCKED`, [voidId]);
    if (!v) return { skip: 'BUSY' as const };
    if (v.status === 'DONE') return { skip: v.status };
    if (v.attempts >= MAX_VOID_ATTEMPTS) return { skip: v.status };
    if (v.status !== 'PENDING' && v.next_attempt_at && new Date(v.next_attempt_at).getTime() > Date.now()) return { skip: v.status };
    const row = await one<VoidRow>(
      tx,
      `UPDATE payment_voids SET status = 'IN_PROGRESS', attempts = attempts + 1, next_attempt_at = now() + make_interval(secs => $2) WHERE id = $1 RETURNING *`,
      [v.id, VOID_LEASE_SEC],
    );
    return { row, verifyFirst: v.attempts > 0 || v.status === 'IN_PROGRESS' };
  });
  if ('skip' in claim) return claim.skip as VoidRow['status'] | 'BUSY';
  const v = claim.row;
  const provider = providerOf(app);
  let outcome: { ok: true; pp: ProviderPayment } | { ok: false; error: ProviderError };
  try {
    let done: ProviderPayment | null = null;
    let amount = v.amount_minor;
    if (claim.verifyFirst) {
      let cur: ProviderPayment;
      try {
        cur = await provider.get(v.payment_key);
      } catch (err) {
        throw asRetryable(err, 'Could not verify the previous void attempt');
      }
      if (cur.balanceAmount <= 0) done = cur; // nothing captured any more
      else amount = Math.min(amount, cur.balanceAmount);
    }
    done ??= await provider.cancel({ paymentKey: v.payment_key, cancelAmount: amount, cancelReason: `${v.reason} [jp-void:${v.id}]`, idempotencyKey: v.idempotency_key });
    outcome = { ok: true, pp: done };
  } catch (err: any) {
    outcome = { ok: false, error: err instanceof ProviderError ? err : new ProviderError('UNKNOWN', String(err?.message ?? err), true) };
  }
  return withTx(app.pool, async (tx) => {
    const cur = await maybeOne<VoidRow>(tx, `SELECT * FROM payment_voids WHERE id = $1 FOR UPDATE`, [v.id]);
    if (!cur || cur.status !== 'IN_PROGRESS' || cur.attempts !== v.attempts) return cur?.status ?? 'BUSY';
    if (outcome.ok) {
      const pp = outcome.pp;
      await tx.query(
        `UPDATE payment_voids SET status = 'DONE', completed_at = now(), next_attempt_at = NULL, last_error = NULL, provider_status = $2, provider_ref = $3 WHERE id = $1`,
        [cur.id, pp.status, pp.cancels.at(-1)?.transactionKey ?? null],
      );
      // only now is it true that the PG no longer holds the money
      await tx.query(`UPDATE payments SET provider_status = $2 WHERE id = $1`, [cur.payment_id, pp.status]);
      await emit(tx, ctx, { aggregateType: 'payment', aggregateId: cur.payment_id, eventType: 'payment.voided', payload: { voidId: cur.id, paymentId: cur.payment_id, amountMinor: cur.amount_minor, providerStatus: pp.status } });
      await audit(tx, ctx, { action: 'payment.void.completed', resourceType: 'payment', resourceId: cur.payment_id, category: 'MONEY', after: { voidId: cur.id, amountMinor: cur.amount_minor, providerStatus: pp.status } });
      return 'DONE' as const;
    }
    const e = outcome.error;
    const delaySec = Math.min(60 * 2 ** cur.attempts, 6 * 3600);
    await tx.query(`UPDATE payment_voids SET status = 'FAILED', last_error = $2, next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`, [
      cur.id,
      `${e.code}: ${e.message}`.slice(0, 500),
      delaySec,
    ]);
    const final = cur.attempts >= MAX_VOID_ATTEMPTS;
    await emit(tx, ctx, { aggregateType: 'payment', aggregateId: cur.payment_id, eventType: 'payment.void_failed', payload: { voidId: cur.id, paymentId: cur.payment_id, code: e.code, attempts: cur.attempts, final } });
    if (final) await audit(tx, ctx, { action: 'payment.void.failed.final', resourceType: 'payment', resourceId: cur.payment_id, category: 'MONEY', reason: e.code });
    return 'FAILED' as const;
  });
}

/** Retry voids that were missed (PENDING), crashed mid-call (IN_PROGRESS past its lease) or failed transiently. */
export async function retryVoids(app: AppContext, ctx: Ctx, limit = 50): Promise<number> {
  const rows = await q<{ id: string }>(
    app.pool,
    `SELECT id FROM payment_voids
      WHERE attempts < $2 AND (
            (status = 'PENDING' AND created_at < now() - interval '30 seconds')
         OR (status IN ('IN_PROGRESS','FAILED') AND (next_attempt_at IS NULL OR next_attempt_at <= now())))
      ORDER BY created_at LIMIT $1`,
    [limit, MAX_VOID_ATTEMPTS],
  );
  let n = 0;
  for (const { id } of rows) {
    await processVoid(app, ctx, id).then(
      (s) => void (s !== 'BUSY' && n++),
      (err) => app.log.error({ err, voidId: id }, 'payment void retry failed'),
    );
  }
  return n;
}

/** Provider confirmed the cancel: update payment, ledger (compensating), subject, receipt, events. */
export async function completeRefund(tx: Tx, ctx: Ctx, refund: RefundRow, payment: PaymentRow, providerRef: string | null): Promise<RefundStatus> {
  const before = payment.refunded_minor;
  const after = before + refund.amount_minor;
  if (after > payment.amount_minor) throw new Error(`refund ${refund.id} would exceed payment amount`);
  const fully = after === payment.amount_minor;
  await PaymentFSM.transition(tx, ctx, {
    table: 'payments',
    id: payment.id,
    from: ['APPROVED', 'PARTIALLY_REFUNDED'],
    to: fully ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
    reason: `REFUND ${refund.id}`,
    versioned: true,
    set: { refunded_minor: after },
  });
  const to: RefundStatus = fully ? 'REFUNDED' : 'PARTIAL';
  await RefundFSM.transition(tx, ctx, {
    table: 'refunds',
    id: refund.id,
    from: 'PROVIDER_PENDING',
    to,
    reason: 'PROVIDER_CONFIRMED',
    actorType: 'PROVIDER',
    set: { provider_ref: providerRef, completed_at: new Date(), failure_message: null, next_attempt_at: null },
  });
  await postRefundReversal(tx, ctx, {
    paymentId: payment.id,
    refundId: refund.id,
    amountMinor: refund.amount_minor,
    refundedBeforeMinor: before,
    feeRefundMinor: refund.fee_refund_minor ?? null,
    split: payment.payable_snapshot?.split,
  });
  await paymentSubject(payment.subject_type).onRefunded?.(tx, ctx, payment.subject_id, {
    paymentId: payment.id,
    refundId: refund.id,
    amountMinor: refund.amount_minor,
    totalRefundedMinor: after,
    fullyRefunded: fully,
  });
  await tx.query(
    `INSERT INTO receipts(user_id, payment_id, receipt_type, amount_minor, currency, data) VALUES ($1,$2,'REFUND',$3,$4,$5)`,
    [payment.payer_id, payment.id, refund.amount_minor, refund.currency, JSON.stringify({ refundId: refund.id, reason: refund.reason, orderId: payment.provider_order_id })],
  );
  const payload = {
    refundId: refund.id,
    paymentId: payment.id,
    subjectType: payment.subject_type,
    subjectId: payment.subject_id,
    amountMinor: refund.amount_minor,
    totalRefundedMinor: after,
    fullyRefunded: fully,
    currency: refund.currency,
  };
  await emit(tx, ctx, { aggregateType: 'refund', aggregateId: refund.id, eventType: 'refund.completed', payload });
  await emit(tx, ctx, { aggregateType: 'payment', aggregateId: payment.id, eventType: 'payment.refunded', payload });
  await notify(tx, ctx, {
    userId: payment.payer_id,
    templateKey: 'payment.refunded',
    title: '환불이 완료되었습니다',
    body: `${payment.order_name ?? '결제'} · ${refund.amount_minor} ${refund.currency}`,
    data: { paymentId: payment.id, refundId: refund.id },
    dedupeKey: `refund.completed:${refund.id}`,
  });
  await audit(tx, ctx, {
    action: 'refund.completed',
    resourceType: 'payment',
    resourceId: payment.id,
    category: 'MONEY',
    after: { refundId: refund.id, amountMinor: refund.amount_minor, totalRefundedMinor: after },
  });
  return to;
}

// ------------------------------------------------------------------------------------------------
// jobs
// ------------------------------------------------------------------------------------------------

/** CREATED payments past expires_at → FAILED(EXPIRED) and the subject is told. */
export async function expirePayments(app: AppContext, ctx: Ctx, limit = 100): Promise<number> {
  const ids = await q<{ id: string }>(
    app.pool,
    `SELECT id FROM payments WHERE expires_at < now() AND (status = 'CREATED' OR (status = 'FAILED' AND failure_code = ANY($2))) ORDER BY expires_at LIMIT $1`,
    [limit, [...RETRYABLE_FAILURE_CODES]],
  );
  let n = 0;
  for (const { id } of ids) {
    await withTx(app.pool, async (tx) => {
      const p = await maybeOne<PaymentRow>(tx, `SELECT * FROM payments WHERE id = $1 FOR UPDATE SKIP LOCKED`, [id]);
      if (!p || new Date(p.expires_at).getTime() >= Date.now()) return;
      if (p.status === 'CREATED') {
        await markFailed(tx, ctx, p, { code: 'EXPIRED', message: 'Payment window expired', notifySubject: true });
        n++;
      } else if (p.status === 'FAILED' && RETRYABLE_FAILURE_CODES.has(p.failure_code ?? '')) {
        await tx.query(`UPDATE payments SET failure_code = 'EXPIRED' WHERE id = $1`, [p.id]);
        await paymentSubject(p.subject_type).onPaymentFailed?.(tx, ctx, p.subject_id, { id: p.id, reason: 'EXPIRED' });
        n++;
      }
    });
  }
  return n;
}

/** CONFIRMING older than `olderThanSec` → provider.get decides (crash between phase A and B, timeouts). */
export async function reconcileConfirming(app: AppContext, ctx: Ctx, olderThanSec = 120, limit = 50): Promise<number> {
  const rows = await q<PaymentRow>(
    app.pool,
    `SELECT * FROM payments WHERE status = 'CONFIRMING' AND updated_at < now() - make_interval(secs => $1) ORDER BY updated_at LIMIT $2`,
    [olderThanSec, limit],
  );
  const provider = providerOf(app);
  let n = 0;
  for (const row of rows) {
    if (!row.payment_key) continue;
    let pp: ProviderPayment | null = null;
    let notFoundAtPg = false;
    try {
      pp = await provider.get(row.payment_key);
    } catch (err) {
      if (err instanceof ProviderError && (err.code === 'NOT_FOUND_PAYMENT' || err.httpStatus === 404)) notFoundAtPg = true;
      else continue; // provider unavailable: retry next run
    }
    await withTx(app.pool, async (tx) => {
      const p = await maybeOne<PaymentRow>(tx, `SELECT * FROM payments WHERE id = $1 FOR UPDATE SKIP LOCKED`, [row.id]);
      if (!p || p.status !== 'CONFIRMING') return;
      if (notFoundAtPg) {
        await markFailed(tx, ctx, p, { code: 'CONFIRM_NOT_RECEIVED', message: 'The provider has no record of this confirmation; it may be retried', notifySubject: false });
      } else if (pp) {
        await reconcileFromProvider(tx, ctx, p, pp, 'RECONCILE_JOB');
      }
      n++;
    });
  }
  return n;
}

/** Retry refunds that were missed (REQUESTED), crashed mid-call (PROVIDER_PENDING) or failed transiently. */
export async function retryRefunds(app: AppContext, ctx: Ctx, limit = 50): Promise<number> {
  const rows = await q<{ id: string }>(
    app.pool,
    `SELECT id FROM refunds
      WHERE (status = 'REQUESTED' AND created_at < now() - interval '30 seconds')
         OR (status = 'PROVIDER_PENDING' AND coalesce(next_attempt_at, created_at + interval '5 minutes') <= now())
         OR (status = 'FAILED' AND attempts < $2 AND (next_attempt_at IS NULL OR next_attempt_at <= now()))
      ORDER BY created_at LIMIT $1`,
    [limit, MAX_REFUND_ATTEMPTS],
  );
  let n = 0;
  for (const { id } of rows) {
    // each refund in its own short transactions; the PG is called with no lock held (processRefund)
    await processRefund(app, ctx, id).then(
      (s) => void (s !== 'BUSY' && n++),
      (err) => app.log.error({ err, refundId: id }, 'refund retry failed'),
    );
  }
  return n;
}

// ------------------------------------------------------------------------------------------------
// reconciliation report (admin)
// ------------------------------------------------------------------------------------------------

export async function reconciliationReport(app: AppContext, opts: { checkProvider: boolean; limit: number }) {
  const rows = await q<PaymentRow & { ledger_approved_minor: number | null; ledger_refund_minor: number; refunds_done_minor: number; void_status: string | null; void_attempts: number | null }>(
    app.pool,
    `SELECT p.*,
            (SELECT sum(e.debit_minor) FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
              WHERE t.idempotency_key = 'payment:' || p.id || ':approved')::bigint AS ledger_approved_minor,
            coalesce((SELECT sum(e.credit_minor) FROM refunds r JOIN ledger_transactions t ON t.source_type = 'REFUND' AND t.source_id = r.id
                       JOIN ledger_entries e ON e.transaction_id = t.id JOIN ledger_accounts a ON a.id = e.account_id AND a.purpose = 'PG_CLEARING'
                      WHERE r.payment_id = p.id), 0)::bigint AS ledger_refund_minor,
            coalesce((SELECT sum(amount_minor) FROM refunds r WHERE r.payment_id = p.id AND r.status IN ('PARTIAL','REFUNDED')), 0)::bigint AS refunds_done_minor,
            v.status AS void_status, v.attempts AS void_attempts
       FROM payments p LEFT JOIN payment_voids v ON v.payment_id = p.id
      WHERE p.status IN ('CONFIRMING','APPROVED','PARTIALLY_REFUNDED','REFUNDED')
         -- failed / cancelled payments the PG may still hold money for (a void, or a key the PG has seen)
         OR (p.status IN ('FAILED','CANCELLED') AND (v.id IS NOT NULL OR p.payment_key IS NOT NULL))
      ORDER BY p.created_at DESC LIMIT $1`,
    [opts.limit],
  );
  const provider = providerOf(app);
  const items = [];
  for (const r of rows) {
    const issues: string[] = [];
    const approved = APPROVED_STATES.includes(r.status);
    if (approved && r.ledger_approved_minor !== r.amount_minor) issues.push('LEDGER_APPROVAL_MISSING_OR_MISMATCH');
    if (r.ledger_refund_minor !== r.refunded_minor) issues.push('LEDGER_REFUND_MISMATCH');
    if (r.refunds_done_minor !== r.refunded_minor) issues.push('REFUND_RECORDS_MISMATCH');
    if (r.status === 'CONFIRMING' && Date.now() - new Date(r.updated_at).getTime() > 10 * 60_000) issues.push('STUCK_CONFIRMING');
    const dead = r.status === 'FAILED' || r.status === 'CANCELLED';
    if (r.void_status && r.void_status !== 'DONE') issues.push((r.void_attempts ?? 0) >= MAX_VOID_ATTEMPTS ? 'VOID_FAILED' : 'VOID_PENDING');
    let providerStatus: string | null = null;
    if (opts.checkProvider && r.payment_key) {
      try {
        const pp = await provider.get(r.payment_key);
        providerStatus = pp.status;
        if (approved && pp.totalAmount - pp.balanceAmount !== r.refunded_minor) issues.push('PROVIDER_CANCEL_AMOUNT_MISMATCH');
        if (approved && pp.totalAmount !== r.amount_minor) issues.push('PROVIDER_AMOUNT_MISMATCH');
        if (approved && !['DONE', 'PARTIAL_CANCELED', 'CANCELED'].includes(pp.status)) issues.push('PROVIDER_STATUS_MISMATCH');
        // money still captured at the PG for a payment we do not keep
        if (dead && pp.balanceAmount > 0 && ['DONE', 'PARTIAL_CANCELED'].includes(pp.status)) issues.push('PROVIDER_CAPTURED_NOT_KEPT');
      } catch (err: any) {
        providerStatus = `ERROR:${err?.code ?? 'UNKNOWN'}`;
        // a failed / cancelled payment the PG never captured is usually unknown to it (404): not a discrepancy
        if (!dead) issues.push('PROVIDER_UNREACHABLE');
      }
    }
    items.push({
      paymentId: r.id,
      orderId: r.provider_order_id,
      status: r.status,
      amountMinor: r.amount_minor,
      refundedMinor: r.refunded_minor,
      currency: r.currency,
      ledgerApprovedMinor: r.ledger_approved_minor ?? 0,
      ledgerRefundMinor: r.ledger_refund_minor,
      providerStatus,
      issues,
      ok: issues.length === 0,
    });
  }
  return { generatedAt: new Date().toISOString(), checked: items.length, discrepancies: items.filter((i) => !i.ok).length, items };
}

export { AppError };
