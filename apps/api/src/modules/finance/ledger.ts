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
 * Shares of a component refund over the approval credits, taken from what is still unreversed per account (`open`).
 * The approval's FEE_REVENUE credit holds two components: the payees' commission (part of their gross) and the buyer
 * platform fee (amount − Σ gross − tax). The gross part of the refund is shared over [payee accounts…, commission],
 * the fee part over [platform fee, TAX_PAYABLE]; a part larger than its component's remainder spills into the other,
 * so the refund that completes the payment reverses exactly the remainder of every account.
 */
function componentShares(
  credits: CreditLine[],
  open: number[],
  p: { amountMinor: number; feeRefundMinor: number; approvedMinor: number; grossMinor: number; currency: string },
): number[] {
  const iFee = credits.findIndex((c) => c.code === PlatformAccount.feeRevenue(p.currency).code);
  const iTax = credits.findIndex((c) => c.code === PlatformAccount.taxPayable(p.currency).code);
  const payees = credits.map((_, i) => i).filter((i) => i !== iFee && i !== iTax);
  const feeCredit = iFee >= 0 ? credits[iFee].credit_minor : 0;
  const taxCredit = iTax >= 0 ? credits[iTax].credit_minor : 0;
  const platformFee = Math.min(feeCredit, Math.max(0, p.approvedMinor - p.grossMinor - taxCredit));
  const commission = feeCredit - platformFee;
  const openFee = iFee >= 0 ? open[iFee] : 0;
  const netTotal = payees.reduce((a, i) => a + credits[i].credit_minor, 0);
  const netOpen = payees.reduce((a, i) => a + open[i], 0);
  // commission still unreversed moves in step with the payees' unreversed net (both are shares of the same gross)
  const estimate = netTotal > 0 ? allocate(commission, [netOpen, netTotal - netOpen])[0] : commission;
  const commissionOpen = Math.min(Math.max(estimate, openFee - platformFee, 0), commission, openFee);
  const grossPool = [...payees.map((i) => ({ i, w: open[i] })), { i: iFee, w: commissionOpen }];
  const feePool = [{ i: iFee, w: openFee - commissionOpen }, { i: iTax, w: iTax >= 0 ? open[iTax] : 0 }];
  const cap = (pool: Array<{ w: number }>) => pool.reduce((a, x) => a + x.w, 0);
  let fee = Math.min(p.feeRefundMinor, p.amountMinor);
  let gross = p.amountMinor - fee;
  if (gross > cap(grossPool)) [gross, fee] = [cap(grossPool), p.amountMinor - cap(grossPool)];
  if (fee > cap(feePool)) [fee, gross] = [cap(feePool), p.amountMinor - cap(feePool)];
  const parts = credits.map(() => 0);
  for (const [pool, amount] of [[grossPool, gross], [feePool, fee]] as const) {
    const shares = allocate(amount, pool.map((x) => x.w));
    pool.forEach((x, k) => { if (x.i >= 0) parts[x.i] += shares[k]; });
  }
  return parts;
}

/**
 * Refund: compensating entries against the credits of the original approval.
 *  Dr credited accounts of the approval (shares below)   Cr PG_CLEARING refund amount
 *
 * Unspecified refund (`feeRefundMinor` null — staff, provider-console and full refunds): proportional to all approval
 * credits (allocate()); cumulative allocation guarantees a sequence of partial refunds sums exactly to the full reversal.
 *
 * Component refund: the selling domain states which part of the refund returns the buyer-paid service fee + tax
 * (`feeRefundMinor`, computed under its snapshotted cancellation terms); the rest returns the payees' gross. The gross
 * part reverses the payee payable / pass-through and the commission (FEE_REVENUE) pro rata to the approval split; only
 * the fee part reverses the buyer platform fee (FEE_REVENUE) and TAX_PAYABLE. A non-refundable service fee therefore
 * keeps its fee revenue and output VAT, and the payee bears exactly its share of the refunded gross.
 */
export async function postRefundReversal(
  db: Db,
  ctx: Pick<Ctx, 'correlationId'>,
  r: {
    paymentId: string;
    refundId: string;
    amountMinor: number;
    refundedBeforeMinor: number;
    feeRefundMinor?: number | null;
    split?: PayableSnapshot['split'];
  },
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
  const idempotencyKey = `refund:${r.refundId}`;
  const weights = credits.map((c) => c.credit_minor);
  // what earlier refunds of this payment already reversed, per account
  const prior = await q<{ account_id: string; debit_minor: number }>(
    db,
    `SELECT e.account_id, sum(e.debit_minor)::bigint AS debit_minor
       FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
      WHERE t.reverses_transaction_id = $1 AND t.transaction_type = 'REFUND' AND t.idempotency_key <> $2
      GROUP BY e.account_id`,
    [approval.id, idempotencyKey],
  );
  const done = credits.map((c) => prior.find((x) => x.account_id === c.account_id)?.debit_minor ?? 0);
  const open = weights.map((w, i) => Math.max(0, w - done[i]));
  const openTotal = open.reduce((a, b) => a + b, 0);
  let parts: number[];
  if (r.feeRefundMinor != null && r.amountMinor <= openTotal) {
    const grossMinor = (r.split ?? []).reduce((a, s) => a + Math.trunc(s.grossMinor), 0);
    parts = componentShares(credits, open, { amountMinor: r.amountMinor, feeRefundMinor: r.feeRefundMinor, approvedMinor: debitLine.debit_minor, grossMinor, currency: cur });
  } else {
    // pro rata: cumulative over the approval credits while every earlier reversal was pro rata, else over what is left
    const proRataSoFar = allocate(r.refundedBeforeMinor, weights).every((x, i) => x === done[i]);
    parts = proRataSoFar || r.amountMinor > openTotal ? incrementalAllocation(r.refundedBeforeMinor, r.amountMinor, weights) : allocate(r.amountMinor, open);
  }
  const lines: LedgerLine[] = credits.map((c, i) => ({ account: specOf(c), debit: parts[i] }));
  lines.push({ account: PlatformAccount.cashClearing(cur), credit: r.amountMinor });
  return postLedger(db, ctx, {
    type: 'REFUND',
    sourceType: 'REFUND',
    sourceId: r.refundId,
    idempotencyKey,
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
