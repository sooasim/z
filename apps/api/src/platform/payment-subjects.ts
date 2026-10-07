import type { Tx } from './db.js';
import type { Ctx } from './context.js';

/**
 * Contract between PAY-01/02 (payments module) and the domains that sell something
 * (STAY-09 reservations, GUIDE-05 paid guide bookings, TRAVEL-04 orders).
 * Payments NEVER updates another domain's tables directly; it calls these handlers in the same tx.
 */
export type PaymentSubjectType = 'RESERVATION' | 'GUIDE_BOOKING' | 'ORDER';

export interface PayableSnapshot {
  payerId: string;
  amountMinor: number;
  currency: string;
  orderName: string;
  /** Payees and their gross share for ledger posting: [{payeeId, grossMinor, feeMinor, taxMinor}] */
  split: Array<{ payeeId: string; payeeType: 'HOST' | 'GUIDE' | 'SUPPLIER'; grossMinor: number; feeMinor: number; taxMinor: number }>;
  merchantOfRecord: 'JETPOOL' | 'SUPPLIER';
}

export interface PaymentSubjectHandler {
  /** Return the server-side authoritative amount for this subject; throw if it cannot be paid now. Locks the subject row. */
  payable(tx: Tx, ctx: Ctx, subjectId: string): Promise<PayableSnapshot>;
  /** Payment created for the subject (subject should move to PAYMENT_PENDING). */
  onPaymentCreated?(tx: Tx, ctx: Ctx, subjectId: string, paymentId: string): Promise<void>;
  /** Provider-confirmed approval with amount/currency/subject already validated. */
  onPaymentApproved(tx: Tx, ctx: Ctx, subjectId: string, payment: { id: string; amountMinor: number; currency: string }): Promise<void>;
  onPaymentFailed?(tx: Tx, ctx: Ctx, subjectId: string, payment: { id: string; reason: string }): Promise<void>;
  /** Refund completed at provider; subject updates its display/refund state. */
  onRefunded?(tx: Tx, ctx: Ctx, subjectId: string, refund: { paymentId: string; refundId: string; amountMinor: number; totalRefundedMinor: number; fullyRefunded: boolean }): Promise<void>;
}

const handlers = new Map<PaymentSubjectType, PaymentSubjectHandler>();

export function registerPaymentSubject(type: PaymentSubjectType, handler: PaymentSubjectHandler) {
  handlers.set(type, handler);
}

export function paymentSubject(type: PaymentSubjectType): PaymentSubjectHandler {
  const h = handlers.get(type);
  if (!h) throw new Error(`no payment subject handler for ${type}`);
  return h;
}
