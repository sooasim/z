/**
 * FIN-01 double-entry posting rules. All writes go through platform `postLedger` (append-only,
 * balanced, idempotent by key — invariant 11). Corrections are compensating transactions.
 */
import type { Db } from '../../platform/db.js';
import { maybeOne, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { PlatformAccount, postLedger, type AccountSpec, type LedgerLine } from '../../platform/ledger.js';
import { allocate } from '../../platform/money.js';
import type { PayableSnapshot } from '../../platform/payment-subjects.js';

export type MerchantOfRecord = 'JETPOOL' | 'SUPPLIER';

/**
 * Supplier funds collected on behalf of a supplier that is itself the merchant of record.
 * Kept per supplier (owner user) so settlements stay ledger-derived per payee.
 */
export const passThroughFor = (payeeId: string, cur: string): AccountSpec => ({
  code: `PASS_THROUGH:${payeeId}:${cur}`,
  ownerType: 'USER',
  ownerId: payeeId,
  accountType: 'LIABILITY',
  purpose: 'PASS_THROUGH',
  currency: cur,
});

export function payeeAccount(payeeId: string, cur: string, mor: MerchantOfRecord): AccountSpec {
  return mor === 'SUPPLIER' ? passThroughFor(payeeId, cur) : PlatformAccount.payeePayable(payeeId, cur);
}

export const approvalKey = (paymentId: string) => `payment:${paymentId}:approved`;

/**
 * Payment approval.
 *  Dr PG_CLEARING                total
 *  Cr PAYEE payable / PASS_THROUGH  (gross − host fee / commission) per payee
 *  Cr TAX_PAYABLE                Σ tax
 *  Cr FEE_REVENUE                remainder (guest platform fee + host fee / commission)
 */
export async function postPaymentApproval(
  db: Db,
  ctx: Pick<Ctx, 'correlationId'>,
  p: { paymentId: string; amountMinor: number; currency: string; snapshot: Pick<PayableSnapshot, 'split' | 'merchantOfRecord'> },
): Promise<{ transactionId: string; created: boolean }> {
  const cur = p.currency;
  const mor: MerchantOfRecord = p.snapshot.merchantOfRecord ?? 'JETPOOL';
  const perPayee = new Map<string, number>();
  let tax = 0;
  for (const s of p.snapshot.split ?? []) {
    const net = Math.trunc(s.grossMinor) - Math.trunc(s.feeMinor);
    if (net < 0) throw new Error(`split for payee ${s.payeeId} has fee greater than gross`);
    perPayee.set(s.payeeId, (perPayee.get(s.payeeId) ?? 0) + net);
    tax += Math.trunc(s.taxMinor ?? 0);
  }
  const payeeTotal = [...perPayee.values()].reduce((a, b) => a + b, 0);
  const fee = p.amountMinor - payeeTotal - tax;
  if (fee < 0) throw new Error(`payment ${p.paymentId}: split exceeds amount (payees ${payeeTotal} + tax ${tax} > ${p.amountMinor})`);
  const lines: LedgerLine[] = [{ account: PlatformAccount.cashClearing(cur), debit: p.amountMinor }];
  for (const [payeeId, net] of [...perPayee.entries()].sort()) lines.push({ account: payeeAccount(payeeId, cur, mor), credit: net });
  lines.push({ account: PlatformAccount.taxPayable(cur), credit: tax });
  lines.push({ account: PlatformAccount.feeRevenue(cur), credit: fee });
  return postLedger(db, ctx, {
    type: 'PAYMENT_APPROVED',
    sourceType: 'PAYMENT',
    sourceId: p.paymentId,
    idempotencyKey: approvalKey(p.paymentId),
    memo: `merchant_of_record=${mor}`,
    lines,
  });
}

interface CreditLine { account_id: string; code: string; owner_type: string; owner_id: string | null; account_type: string; purpose: string; currency: string; credit_minor: number }

const specOf = (r: CreditLine): AccountSpec => ({
  code: r.code,
  ownerType: r.owner_type,
  ownerId: r.owner_id ?? undefined,
  accountType: r.account_type,
  purpose: r.purpose,
  currency: r.currency,
});

/** Proportional split of `amount` over `weights` given `before` already allocated, never negative or above the weight. */
export function incrementalAllocation(before: number, amount: number, weights: number[]): number[] {
  const a = allocate(before, weights);
  const b = allocate(before + amount, weights);
  const diff = b.map((x, i) => x - a[i]);
  if (diff.every((d, i) => d >= 0 && a[i] + d <= weights[i])) return diff;
  const remaining = weights.map((w, i) => Math.max(0, w - a[i]));
  return allocate(amount, remaining);
}

/**
 * Refund: compensating entries proportional to the original approval credits (allocate()).
 *  Dr each credited account of the approval (proportional share)   Cr PG_CLEARING refund amount
 * Cumulative allocation guarantees a sequence of partial refunds sums exactly to the full reversal.
 */
export async function postRefundReversal(
  db: Db,
  ctx: Pick<Ctx, 'correlationId'>,
  r: { paymentId: string; refundId: string; amountMinor: number; refundedBeforeMinor: number },
): Promise<{ transactionId: string; created: boolean }> {
  const approval = await maybeOne<{ id: string }>(db, `SELECT id FROM ledger_transactions WHERE idempotency_key = $1`, [approvalKey(r.paymentId)]);
  if (!approval) throw new Error(`no approval ledger transaction for payment ${r.paymentId}`);
  const credits = await q<CreditLine>(
    db,
    `SELECT e.account_id, a.code, a.owner_type, a.owner_id, a.account_type, a.purpose, a.currency, e.credit_minor
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE e.transaction_id = $1 AND e.credit_minor > 0 ORDER BY a.code`,
    [approval.id],
  );
  const debitLine = await maybeOne<{ code: string; currency: string; debit_minor: number }>(
    db,
    `SELECT a.code, a.currency, e.debit_minor FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE e.transaction_id = $1 AND e.debit_minor > 0 LIMIT 1`,
    [approval.id],
  );
  if (!debitLine || credits.length === 0) throw new Error(`malformed approval transaction ${approval.id}`);
  const cur = debitLine.currency;
  const parts = incrementalAllocation(r.refundedBeforeMinor, r.amountMinor, credits.map((c) => c.credit_minor));
  const lines: LedgerLine[] = credits.map((c, i) => ({ account: specOf(c), debit: parts[i] }));
  lines.push({ account: PlatformAccount.cashClearing(cur), credit: r.amountMinor });
  return postLedger(db, ctx, {
    type: 'REFUND',
    sourceType: 'REFUND',
    sourceId: r.refundId,
    idempotencyKey: `refund:${r.refundId}`,
    reverses: approval.id,
    memo: `payment=${r.paymentId}`,
    lines,
  });
}

/** PG settles collected funds to the bank: Dr BANK / Cr PG_CLEARING. */
export async function postPgSettlement(
  db: Db,
  ctx: Pick<Ctx, 'correlationId'>,
  s: { currency: string; amountMinor: number; reference: string; memo?: string },
) {
  return postLedger(db, ctx, {
    type: 'PG_SETTLEMENT',
    sourceType: 'PG_SETTLEMENT',
    idempotencyKey: `pg-settlement:${s.currency}:${s.reference}`,
    memo: s.memo ?? `reference=${s.reference}`,
    lines: [
      { account: PlatformAccount.bank(s.currency), debit: s.amountMinor },
      { account: PlatformAccount.cashClearing(s.currency), credit: s.amountMinor },
    ],
  });
}

/** Payout of a settlement: Dr PAYEE payable (or PASS_THROUGH) per account / Cr BANK. */
export async function postPayout(
  db: Db,
  ctx: Pick<Ctx, 'correlationId'>,
  p: { settlementId: string; currency: string; payeeId: string; byAccountCode: Map<string, number> },
) {
  const lines: LedgerLine[] = [];
  let total = 0;
  for (const [code, amount] of [...p.byAccountCode.entries()].sort()) {
    if (amount <= 0) continue;
    const spec: AccountSpec = code.startsWith('PASS_THROUGH:') ? passThroughFor(p.payeeId, p.currency) : PlatformAccount.payeePayable(p.payeeId, p.currency);
    if (spec.code !== code) throw new Error(`unexpected payee account ${code}`);
    lines.push({ account: spec, debit: amount });
    total += amount;
  }
  lines.push({ account: PlatformAccount.bank(p.currency), credit: total });
  return postLedger(db, ctx, {
    type: 'PAYOUT',
    sourceType: 'SETTLEMENT',
    sourceId: p.settlementId,
    idempotencyKey: `settlement:${p.settlementId}:paid`,
    lines,
  });
}

export async function trialBalance(db: Db) {
  const byCurrency = await q<{ currency: string; debit_minor: number; credit_minor: number; transactions: number }>(
    db,
    `SELECT e.currency, coalesce(sum(e.debit_minor),0)::bigint AS debit_minor, coalesce(sum(e.credit_minor),0)::bigint AS credit_minor,
            count(DISTINCT e.transaction_id)::int AS transactions
       FROM ledger_entries e GROUP BY e.currency ORDER BY e.currency`,
  );
  const accounts = await q(
    db,
    `SELECT code, account_type, currency, debit_minor::bigint AS debit_minor, credit_minor::bigint AS credit_minor, balance_minor::bigint AS balance_minor
       FROM ledger_balances ORDER BY currency, account_type, code`,
  );
  const unbalanced = await q<{ transaction_id: string }>(
    db,
    `SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING sum(debit_minor) <> sum(credit_minor) LIMIT 20`,
  );
  return {
    currencies: byCurrency.map((c) => ({
      currency: c.currency,
      debitMinor: c.debit_minor,
      creditMinor: c.credit_minor,
      differenceMinor: c.debit_minor - c.credit_minor,
      transactions: c.transactions,
    })),
    balanced: byCurrency.every((c) => c.debit_minor === c.credit_minor) && unbalanced.length === 0,
    unbalancedTransactionIds: unbalanced.map((u) => u.transaction_id),
    accounts,
  };
}
