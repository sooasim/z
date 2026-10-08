/**
 * FIN-02 settlement & payout. Settlement amounts are derived from the ledger:
 *  - base items (completed reservations / guide bookings / fulfilled orders, plus NO_SHOW / CANCELLED /
 *    PARTIALLY_REFUNDED stays once their check-out date has passed): fee = gross − payee credit of the
 *    approval transaction (a fully REFUNDED stay nets to 0 and is not listed);
 *  - refund items (LEDGER_REFUND): each refund ledger transaction debiting the payee's account, settled
 *    once (so refunds after a payout become negative adjustments on the next statement).
 * FSM: DRAFT → READY → APPROVAL_PENDING → APPROVED → PAYOUT_PENDING → PAID → RECONCILED | HELD.
 */
import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { StateMachine, recordTransition } from '../../platform/fsm.js';
import { emit } from '../../platform/outbox.js';
import { notify } from '../../platform/notify.js';
import { audit } from '../../platform/audit.js';
import { isEnabled } from '../../platform/flags.js';
import { badRequest, conflict, forbidden, notFound } from '../../platform/errors.js';
import { approvalKey, payeeAccount, postPayout, type MerchantOfRecord } from './ledger.js';
import { ManualPayoutProvider, type PayoutProvider } from './payouts.js';

export type SettlementStatus = 'DRAFT' | 'READY' | 'APPROVAL_PENDING' | 'APPROVED' | 'PAYOUT_PENDING' | 'PAID' | 'RECONCILED' | 'HELD' | 'CARRIED_FORWARD';

/**
 * CARRIED_FORWARD (terminal): a statement with a negative net (the payee owes refunds made after an earlier payout).
 * Nothing is paid; its net is pulled into the payee's next statement as a CARRY_FORWARD item. A legacy negative
 * statement still pending approval / approved / held is closed the same way when its balance is carried.
 */
export const SettlementFSM = new StateMachine<SettlementStatus>('settlement', {
  DRAFT: ['READY', 'HELD', 'CARRIED_FORWARD'],
  READY: ['APPROVAL_PENDING', 'HELD', 'CARRIED_FORWARD'],
  APPROVAL_PENDING: ['APPROVED', 'HELD', 'READY', 'CARRIED_FORWARD'],
  APPROVED: ['PAYOUT_PENDING', 'HELD', 'CARRIED_FORWARD'],
  PAYOUT_PENDING: ['PAID', 'APPROVED'],
  PAID: ['RECONCILED'],
  HELD: ['READY', 'CARRIED_FORWARD'],
  RECONCILED: [],
  CARRIED_FORWARD: [],
});

type PayeeType = 'HOST' | 'GUIDE' | 'SUPPLIER';
const PAYEE_TYPE_OF: Record<string, PayeeType> = { RESERVATION: 'HOST', GUIDE_BOOKING: 'GUIDE', ORDER: 'SUPPLIER' };

export interface SettlementRow {
  id: string;
  payee_id: string;
  payee_type: PayeeType;
  period_start: string;
  period_end: string;
  gross_minor: number;
  fee_minor: number;
  refund_minor: number;
  tax_adjustment_minor: number;
  net_minor: number;
  currency: string;
  status: SettlementStatus;
  payout_account_id: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  paid_at: Date | null;
  payout_ref: string | null;
  hold_reason: string | null;
  generated_by: string | null;
  created_at: Date;
}

export function settlementDto(s: SettlementRow) {
  return {
    id: s.id,
    payeeId: s.payee_id,
    payeeType: s.payee_type,
    periodStart: s.period_start,
    periodEnd: s.period_end,
    grossMinor: s.gross_minor,
    feeMinor: s.fee_minor,
    refundMinor: s.refund_minor,
    taxAdjustmentMinor: s.tax_adjustment_minor,
    netMinor: s.net_minor,
    currency: s.currency,
    status: s.status,
    holdReason: s.hold_reason,
    generatedBy: s.generated_by,
    approvedBy: s.approved_by,
    approvedAt: s.approved_at,
    paidAt: s.paid_at,
    payoutRef: s.payout_ref,
    createdAt: s.created_at,
  };
}

interface Item { sourceType: string; sourceId: string; payeeId: string; payeeType: PayeeType; currency: string; accountCode: string; gross: number; fee: number; refund: number }

/** Reason a payee's payout must be held (open dispute or active PAYOUT_HOLD sanction), or null. */
export async function holdReason(db: Db, payeeId: string, sourceIds: string[]): Promise<string | null> {
  const sanction = await maybeOne<{ reason: string }>(
    db,
    `SELECT reason FROM sanctions WHERE user_id = $1 AND sanction_type = 'PAYOUT_HOLD' AND lifted_at IS NULL
        AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()) LIMIT 1`,
    [payeeId],
  );
  if (sanction) return `PAYOUT_HOLD_SANCTION: ${sanction.reason}`.slice(0, 300);
  const dispute = await maybeOne<{ id: string }>(
    db,
    `SELECT id FROM disputes WHERE status IN ('OPEN','IN_REVIEW','AWAITING_PARTY','ESCALATED')
        AND (counterparty_id = $1 OR context_id = ANY($2::uuid[])) LIMIT 1`,
    [payeeId, sourceIds],
  );
  if (dispute) return `OPEN_DISPUTE: ${dispute.id}`;
  return null;
}

/** A kept payment of the subject that was not refunded in full (fully refunded subjects net to 0: nothing to settle). */
const KEPT_PAYMENT = (type: string, idCol: string) =>
  `EXISTS (SELECT 1 FROM payments p WHERE p.subject_type = '${type}' AND p.subject_id = ${idCol} AND p.status IN ('APPROVED','PARTIALLY_REFUNDED'))`;
/** No refund of the subject is still open (requested / executing / failed): settle only what the buyer will not get back. */
const NO_OPEN_REFUND = (type: string, idCol: string) =>
  `NOT EXISTS (SELECT 1 FROM payments p JOIN refunds rf ON rf.payment_id = p.id
                WHERE p.subject_type = '${type}' AND p.subject_id = ${idCol} AND rf.status IN ('REQUESTED','PROVIDER_PENDING','FAILED'))`;

async function candidateItems(db: Db, periodStart: string, periodEnd: string): Promise<Item[]> {
  const cands = await q<{ source_type: string; source_id: string; payee_id: string; payee_type: PayeeType }>(
    db,
    `SELECT c.* FROM (
        SELECT 'RESERVATION' AS source_type, r.id AS source_id, r.host_id AS payee_id, 'HOST' AS payee_type
          FROM reservations r WHERE r.status = 'COMPLETED' AND r.completed_at >= $1::date AND r.completed_at < ($2::date + 1)
        UNION ALL
        -- terminal stays that never complete but keep (part of) the proceeds: no-show, 0 % cancellation, partial refund.
        -- Payable once the booked stay is over (check-out on or before the period end, never in the future). No lower
        -- bound, so a no-show reported after its period was generated is picked up by the next run (settled once).
        SELECT 'RESERVATION', r.id, r.host_id, 'HOST'
          FROM reservations r WHERE r.status IN ('NO_SHOW','CANCELLED','PARTIALLY_REFUNDED') AND r.check_out <= least($2::date, current_date)
        UNION ALL
        SELECT 'GUIDE_BOOKING', g.id, g.guide_id, 'GUIDE'
          FROM guide_bookings g WHERE g.status IN ('COMPLETED','REVIEWED') AND g.end_at >= $1::date AND g.end_at < ($2::date + 1)
        UNION ALL
        -- guide bookings that end CANCELLED (late traveller cancellation: the guide keeps part of the price) or DISPUTED
        -- with no dispute open any more: payable once the booked activity would have ended; no lower bound (settled once)
        SELECT 'GUIDE_BOOKING', g.id, g.guide_id, 'GUIDE'
          FROM guide_bookings g
         WHERE g.status IN ('CANCELLED','DISPUTED') AND g.end_at < least(($2::date + 1)::timestamptz, now())
           AND NOT EXISTS (SELECT 1 FROM disputes d WHERE d.context_id = g.id AND d.status IN ('OPEN','IN_REVIEW','AWAITING_PARTY','ESCALATED'))
           AND ${KEPT_PAYMENT('GUIDE_BOOKING', 'g.id')} AND ${NO_OPEN_REFUND('GUIDE_BOOKING', 'g.id')}
        UNION ALL
        SELECT DISTINCT 'ORDER', o.id, s.owner_user_id, 'SUPPLIER'
          FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN suppliers s ON s.id = oi.supplier_id
         WHERE o.status IN ('FULFILLED','PARTIALLY_REFUNDED','REFUNDED') AND o.fulfilled_at IS NOT NULL
           AND o.fulfilled_at >= $1::date AND o.fulfilled_at < ($2::date + 1) AND s.owner_user_id IS NOT NULL
        UNION ALL
        -- paid orders cancelled inside a 0 % / partial tier: the supplier keeps (part of) the proceeds. Payable once the
        -- last departure of the order would have started; no lower bound (settled once)
        SELECT DISTINCT 'ORDER', o.id, s.owner_user_id, 'SUPPLIER'
          FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN suppliers s ON s.id = oi.supplier_id
         WHERE o.status = 'CANCELLED' AND s.owner_user_id IS NOT NULL
           AND (SELECT max(d.starts_at) FROM order_items i2 JOIN travel_departures d ON d.id = i2.sellable_id
                 WHERE i2.order_id = o.id AND i2.sellable_type = 'TRAVEL_DEPARTURE') < least(($2::date + 1)::timestamptz, now())
           AND ${KEPT_PAYMENT('ORDER', 'o.id')} AND ${NO_OPEN_REFUND('ORDER', 'o.id')}
      ) c
      WHERE NOT EXISTS (SELECT 1 FROM settlement_items si WHERE si.source_type = c.source_type AND si.source_id = c.source_id AND si.payee_id = c.payee_id)`,
    [periodStart, periodEnd],
  );
  const items: Item[] = [];
  for (const c of cands) {
    const pay = await maybeOne<{ id: string; currency: string; payable_snapshot: any }>(
      db,
      `SELECT id, currency, payable_snapshot FROM payments WHERE subject_type = $1 AND subject_id = $2 AND status IN ('APPROVED','PARTIALLY_REFUNDED','REFUNDED')`,
      [c.source_type, c.source_id],
    );
    if (!pay) continue; // free / unpaid: nothing to settle
    const mor: MerchantOfRecord = pay.payable_snapshot?.merchantOfRecord ?? 'JETPOOL';
    const account = payeeAccount(c.payee_id, pay.currency, mor);
    const credit = await one<{ s: number }>(
      db,
      `SELECT coalesce(sum(e.credit_minor),0)::bigint AS s FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
         JOIN ledger_accounts a ON a.id = e.account_id WHERE t.idempotency_key = $1 AND a.code = $2`,
      [approvalKey(pay.id), account.code],
    );
    if (credit.s === 0) continue;
    const split: any[] = Array.isArray(pay.payable_snapshot?.split) ? pay.payable_snapshot.split : [];
    const grossFromSplit = split.filter((s) => s.payeeId === c.payee_id).reduce((a, s) => a + Number(s.grossMinor ?? 0), 0);
    const gross = Math.max(grossFromSplit, credit.s);
    items.push({ sourceType: c.source_type, sourceId: c.source_id, payeeId: c.payee_id, payeeType: c.payee_type, currency: pay.currency, accountCode: account.code, gross, fee: gross - credit.s, refund: 0 });
  }
  // refund adjustments (ledger-derived), only for subjects settled now or earlier
  const refunds = await q<{ tx_id: string; debit_minor: number; code: string; payee_id: string; currency: string; subject_type: string; subject_id: string; settled: boolean }>(
    db,
    `SELECT t.id AS tx_id, e.debit_minor, a.code, a.owner_id AS payee_id, a.currency, p.subject_type, p.subject_id,
            EXISTS (SELECT 1 FROM settlement_items si WHERE si.source_type = p.subject_type AND si.source_id = p.subject_id AND si.payee_id = a.owner_id) AS settled
       FROM ledger_transactions t
       JOIN ledger_entries e ON e.transaction_id = t.id AND e.debit_minor > 0
       JOIN ledger_accounts a ON a.id = e.account_id AND a.purpose IN ('PAYEE_PAYABLE','PASS_THROUGH') AND a.owner_id IS NOT NULL
       JOIN refunds r ON r.id = t.source_id
       JOIN payments p ON p.id = r.payment_id
      WHERE t.transaction_type = 'REFUND' AND t.created_at < ($1::date + 1)
        AND NOT EXISTS (SELECT 1 FROM settlement_items si WHERE si.source_type = 'LEDGER_REFUND' AND si.source_id = t.id AND si.payee_id = a.owner_id)`,
    [periodEnd],
  );
  const now = new Set(items.map((i) => `${i.sourceType}:${i.sourceId}:${i.payeeId}`));
  for (const r of refunds) {
    if (!r.settled && !now.has(`${r.subject_type}:${r.subject_id}:${r.payee_id}`)) continue;
    items.push({
      sourceType: 'LEDGER_REFUND',
      sourceId: r.tx_id,
      payeeId: r.payee_id,
      payeeType: PAYEE_TYPE_OF[r.subject_type] ?? 'HOST',
      currency: r.currency,
      accountCode: r.code,
      gross: 0,
      fee: 0,
      refund: r.debit_minor,
    });
  }
  return items;
}

/**
 * Unpaid statements of the payee with a negative net whose balance has not been carried into a later statement yet:
 * CARRIED_FORWARD ones, and legacy negative statements stuck before payout (payout refuses net <= 0).
 */
async function openNegativeStatements(tx: Tx, payeeId: string, payeeType: PayeeType, currency: string) {
  const rows = await q<{ id: string; net_minor: number; status: SettlementStatus }>(
    tx,
    `SELECT s.id, s.net_minor, s.status FROM settlements s
      WHERE s.payee_id = $1 AND s.payee_type = $2 AND s.currency = $3 AND s.net_minor < 0
        AND s.status IN ('DRAFT','READY','APPROVAL_PENDING','APPROVED','HELD','CARRIED_FORWARD')
        AND NOT EXISTS (SELECT 1 FROM settlement_items si WHERE si.source_type = 'CARRY_FORWARD' AND si.source_id = s.id)
      ORDER BY s.created_at, s.id FOR UPDATE`,
    [payeeId, payeeType, currency],
  );
  const out: Array<{ id: string; net: number; status: SettlementStatus; accountCode: string | null }> = [];
  for (const r of rows) {
    // the payee account that carries the debt (the most negative one of that statement)
    const acc = await maybeOne<{ code: string }>(
      tx,
      `SELECT payee_account_code AS code FROM settlement_items WHERE settlement_id = $1 AND payee_account_code IS NOT NULL
        GROUP BY payee_account_code ORDER BY sum(gross_minor - fee_minor - refund_minor), payee_account_code LIMIT 1`,
      [r.id],
    );
    out.push({ id: r.id, net: r.net_minor, status: r.status, accountCode: acc?.code ?? null });
  }
  return out;
}

export async function generateSettlements(tx: Tx, ctx: Ctx, args: { periodStart: string; periodEnd: string }) {
  if (args.periodEnd < args.periodStart) throw badRequest('INVALID_PERIOD', 'periodEnd must be on or after periodStart');
  await tx.query(`SELECT pg_advisory_xact_lock(hashtext('finance.settlement.generate'))`);
  const items = await candidateItems(tx, args.periodStart, args.periodEnd);
  const groups = new Map<string, Item[]>();
  for (const i of items) {
    const k = `${i.payeeId}|${i.payeeType}|${i.currency}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const created: SettlementRow[] = [];
  const skipped: Array<{ payeeId: string; reason: string }> = [];
  for (const [k, fresh] of [...groups.entries()].sort()) {
    const [payeeId, payeeType, currency] = k.split('|') as [string, PayeeType, string];
    // negative balances of earlier statements (never paid) are recovered from these new earnings
    const carried = await openNegativeStatements(tx, payeeId, payeeType, currency);
    const list: Item[] = [
      ...fresh,
      ...carried.map((c) => ({
        sourceType: 'CARRY_FORWARD',
        sourceId: c.id,
        payeeId,
        payeeType,
        currency,
        accountCode: c.accountCode ?? fresh[0].accountCode,
        gross: 0,
        fee: 0,
        refund: -c.net,
      })),
    ];
    const gross = list.reduce((a, i) => a + i.gross, 0);
    const fee = list.reduce((a, i) => a + i.fee, 0);
    const refund = list.reduce((a, i) => a + i.refund, 0);
    const ins = await q<SettlementRow>(
      tx,
      `INSERT INTO settlements(payee_id, payee_type, period_start, period_end, gross_minor, fee_minor, refund_minor, net_minor, currency, status, generated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10)
       ON CONFLICT (payee_id, payee_type, period_start, period_end, currency) DO NOTHING RETURNING *`,
      [payeeId, payeeType, args.periodStart, args.periodEnd, gross, fee, refund, gross - fee - refund, currency, ctx.actor?.userId ?? null],
    );
    if (!ins[0]) {
      skipped.push({ payeeId, reason: 'SETTLEMENT_EXISTS_FOR_PERIOD' });
      continue;
    }
    const s = ins[0];
    await recordTransition(tx, ctx, { aggregateType: 'settlement', aggregateId: s.id, from: null, to: 'DRAFT', reason: 'GENERATED' });
    for (const i of list) {
      await tx.query(
        `INSERT INTO settlement_items(settlement_id, source_type, source_id, gross_minor, fee_minor, refund_minor, payee_id, payee_account_code, currency)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [s.id, i.sourceType, i.sourceId, i.gross, i.fee, i.refund, i.payeeId, i.accountCode, i.currency],
      );
    }
    for (const c of carried) {
      // a legacy negative statement left pending / approved / held is closed now that its balance moved on
      if (c.status !== 'CARRIED_FORWARD') {
        await SettlementFSM.transition(tx, ctx, { table: 'settlements', id: c.id, to: 'CARRIED_FORWARD', reason: `CARRIED_INTO ${s.id}` });
      }
    }
    let row: SettlementRow;
    if (s.net_minor < 0) {
      // nothing is payable: keep the items (they are consumed) and carry the negative net into the next statement
      row = (await SettlementFSM.transition(tx, ctx, { table: 'settlements', id: s.id, to: 'CARRIED_FORWARD', reason: 'NEGATIVE_NET_CARRIED_FORWARD' })).row;
      await emit(tx, ctx, { aggregateType: 'settlement', aggregateId: s.id, eventType: 'settlement.carried_forward', payload: { settlementId: s.id, payeeId, payeeType, netMinor: s.net_minor, currency } });
      await audit(tx, ctx, { action: 'settlement.carried_forward', resourceType: 'settlement', resourceId: s.id, category: 'MONEY', after: { netMinor: s.net_minor, carried: carried.map((c) => c.id) } });
      created.push(row);
      continue;
    }
    const hold = await holdReason(tx, payeeId, list.map((i) => i.sourceId));
    if (hold) {
      row = (await SettlementFSM.transition(tx, ctx, { table: 'settlements', id: s.id, to: 'HELD', reason: hold, set: { hold_reason: hold } })).row;
      await emit(tx, ctx, { aggregateType: 'settlement', aggregateId: s.id, eventType: 'settlement.held', payload: { settlementId: s.id, payeeId, reason: hold } });
    } else {
      await SettlementFSM.transition(tx, ctx, { table: 'settlements', id: s.id, to: 'READY', reason: 'GENERATED' });
      row = (await SettlementFSM.transition(tx, ctx, { table: 'settlements', id: s.id, to: 'APPROVAL_PENDING', reason: 'SUBMITTED' })).row;
      await emit(tx, ctx, {
        aggregateType: 'settlement',
        aggregateId: s.id,
        eventType: 'settlement.ready',
        payload: { settlementId: s.id, payeeId, payeeType, netMinor: row.net_minor, currency },
      });
    }
    created.push(row);
  }
  await audit(tx, ctx, {
    action: 'settlement.generate',
    resourceType: 'settlement',
    category: 'MONEY',
    after: { periodStart: args.periodStart, periodEnd: args.periodEnd, created: created.map((c) => c.id), skipped },
  });
  return { items: created.map(settlementDto), skipped };
}

async function lockSettlement(tx: Tx, id: string): Promise<SettlementRow> {
  const s = await maybeOne<SettlementRow>(tx, `SELECT * FROM settlements WHERE id = $1 FOR UPDATE`, [id]);
  if (!s) throw notFound('Settlement');
  return s;
}

async function sourceIds(tx: Tx, settlementId: string): Promise<string[]> {
  return (await q<{ source_id: string }>(tx, `SELECT source_id FROM settlement_items WHERE settlement_id = $1`, [settlementId])).map((r) => r.source_id);
}

/** Maker-checker: the approver must not be the user who generated the settlement. */
export async function approveSettlement(tx: Tx, ctx: Ctx, id: string) {
  const actor = ctx.actor!;
  const s = await lockSettlement(tx, id);
  if (s.generated_by && s.generated_by === actor.userId) throw forbidden('MAKER_CHECKER_VIOLATION', 'The generator of a settlement cannot approve it');
  if (s.status !== 'APPROVAL_PENDING') throw conflict('INVALID_STATE_TRANSITION', `settlement is ${s.status}, expected APPROVAL_PENDING`);
  const hold = await holdReason(tx, s.payee_id, await sourceIds(tx, s.id));
  if (hold) {
    const { row } = await SettlementFSM.transition(tx, ctx, { table: 'settlements', id, to: 'HELD', reason: hold, set: { hold_reason: hold } });
    await audit(tx, ctx, { action: 'settlement.held', resourceType: 'settlement', resourceId: id, category: 'MONEY', reason: hold });
    return row as SettlementRow;
  }
  const { row } = await SettlementFSM.transition(tx, ctx, {
    table: 'settlements',
    id,
    from: 'APPROVAL_PENDING',
    to: 'APPROVED',
    reason: 'APPROVED',
    set: { approved_by: actor.userId, approved_at: new Date() },
  });
  await audit(tx, ctx, { action: 'settlement.approve', resourceType: 'settlement', resourceId: id, category: 'MONEY', before: { status: s.status }, after: { status: 'APPROVED', netMinor: s.net_minor } });
  await emit(tx, ctx, { aggregateType: 'settlement', aggregateId: id, eventType: 'settlement.approved', payload: { settlementId: id, payeeId: s.payee_id } });
  return row as SettlementRow;
}

export async function markSettlementPaid(tx: Tx, ctx: Ctx, id: string, payoutRef: string) {
  const s = await lockSettlement(tx, id);
  if (s.status !== 'PAYOUT_PENDING') throw conflict('INVALID_STATE_TRANSITION', `settlement is ${s.status}, expected PAYOUT_PENDING`);
  const items = await q<{ payee_account_code: string; gross_minor: number; fee_minor: number; refund_minor: number }>(
    tx,
    `SELECT payee_account_code, gross_minor, fee_minor, refund_minor FROM settlement_items WHERE settlement_id = $1`,
    [id],
  );
  const byAccount = new Map<string, number>();
  for (const i of items) byAccount.set(i.payee_account_code, (byAccount.get(i.payee_account_code) ?? 0) + i.gross_minor - i.fee_minor - i.refund_minor);
  for (const [code, v] of byAccount) if (v < 0) throw conflict('NEGATIVE_PAYEE_BALANCE', `Account ${code} would be paid a negative amount`);
  const ledger = await postPayout(tx, ctx, { settlementId: id, currency: s.currency, payeeId: s.payee_id, byAccountCode: byAccount });
  const { row } = await SettlementFSM.transition(tx, ctx, {
    table: 'settlements',
    id,
    from: 'PAYOUT_PENDING',
    to: 'PAID',
    reason: 'PAYOUT_SENT',
    set: { paid_at: new Date(), payout_ref: payoutRef.slice(0, 200) },
  });
  await tx.query(
    `INSERT INTO receipts(user_id, receipt_type, amount_minor, currency, data) VALUES ($1,'SETTLEMENT_STATEMENT',$2,$3,$4)`,
    [s.payee_id, s.net_minor, s.currency, JSON.stringify({ settlementId: id, periodStart: s.period_start, periodEnd: s.period_end, grossMinor: s.gross_minor, feeMinor: s.fee_minor, refundMinor: s.refund_minor })],
  );
  await emit(tx, ctx, {
    aggregateType: 'settlement',
    aggregateId: id,
    eventType: 'payout.sent',
    payload: { settlementId: id, payeeId: s.payee_id, amountMinor: s.net_minor, currency: s.currency, ledgerTransactionId: ledger.transactionId },
  });
  await notify(tx, ctx, {
    userId: s.payee_id,
    templateKey: 'payout.sent',
    title: '정산금이 지급되었습니다',
    body: `${s.period_start} ~ ${s.period_end} · ${s.net_minor} ${s.currency}`,
    data: { settlementId: id },
    dedupeKey: `payout.sent:${id}`,
  });
  await audit(tx, ctx, { action: 'settlement.paid', resourceType: 'settlement', resourceId: id, category: 'MONEY', after: { netMinor: s.net_minor, payoutRef } });
  return row as SettlementRow;
}

export async function executePayout(tx: Tx, ctx: Ctx, id: string) {
  const s = await lockSettlement(tx, id);
  if (s.status !== 'APPROVED') throw conflict('INVALID_STATE_TRANSITION', `settlement is ${s.status}, expected APPROVED`);
  if (s.net_minor <= 0) throw conflict('NOTHING_TO_PAY', 'Settlement net amount is not positive');
  const hold = await holdReason(tx, s.payee_id, await sourceIds(tx, s.id));
  if (hold) throw conflict('PAYOUT_HELD', hold);
  const account = await maybeOne<{ id: string; bank_code: string; account_token: string; holder_name: string }>(
    tx,
    `SELECT id, bank_code, account_token, holder_name FROM payout_accounts WHERE user_id = $1 AND status = 'VERIFIED' ORDER BY created_at DESC LIMIT 1`,
    [s.payee_id],
  );
  if (!account) throw conflict('PAYOUT_ACCOUNT_REQUIRED', 'Payee has no verified payout account');
  await SettlementFSM.transition(tx, ctx, { table: 'settlements', id, from: 'APPROVED', to: 'PAYOUT_PENDING', reason: 'PAYOUT_REQUESTED', set: { payout_account_id: account.id } });
  const automatic = await isEnabled(tx, 'payout.automatic');
  const provider: PayoutProvider = automatic
    ? ((ctx.app.adapters.get('payouts.provider') as PayoutProvider | undefined) ?? new ManualPayoutProvider())
    : new ManualPayoutProvider();
  const result = await provider.execute({
    settlementId: id,
    amountMinor: s.net_minor,
    currency: s.currency,
    bankCode: account.bank_code,
    accountToken: account.account_token,
    holderName: account.holder_name,
    idempotencyKey: `payout-${id}`,
  });
  await audit(tx, ctx, { action: 'settlement.payout', resourceType: 'settlement', resourceId: id, category: 'MONEY', after: { mode: provider.name, status: result.status } });
  if (result.status === 'PAID') return { item: settlementDto(await markSettlementPaid(tx, ctx, id, result.payoutRef)), mode: provider.name };
  const now = await lockSettlement(tx, id);
  return { item: settlementDto(now), mode: provider.name };
}
