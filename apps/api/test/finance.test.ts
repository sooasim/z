import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, idem, enableFlags, type TestApp, type TestUser } from './helpers.js';
import { quoteFees } from '../src/modules/finance/rules.js';
import { randomUUID } from 'node:crypto';
import { withTx } from '../src/platform/db.js';
import { incrementalAllocation, postPaymentApproval, postRefundReversal } from '../src/modules/finance/ledger.js';
import { runDepartureLifecycle } from '../src/modules/travel/service.js';

let t: TestApp;
let buyer: TestUser;
let acctA: TestUser;
let acctB: TestUser;

async function makeSupplier(mor: 'JETPOOL' | 'SUPPLIER', commissionBps: number) {
  const owner = await createUser(t, { roles: ['SUPPLIER'], aal: 'aal2' });
  const s = await t.pool.query(
    `INSERT INTO suppliers(owner_user_id, name, supplier_type, status, merchant_of_record, commission_bps) VALUES ($1,'Sup','TOUR_OPERATOR','APPROVED',$2,$3) RETURNING id`,
    [owner.id, mor, commissionBps],
  );
  const p = await t.pool.query(`INSERT INTO travel_products(supplier_id, type, title, base_price_minor, status) VALUES ($1,'TOUR','T',100000,'PUBLISHED') RETURNING id`, [s.rows[0].id]);
  return { owner, productId: p.rows[0].id as string };
}

async function paidOrder(productId: string, price: number) {
  const d = await t.pool.query(`INSERT INTO travel_departures(product_id, starts_at, capacity, price_minor) VALUES ($1, now() + interval '10 days', 10, $2) RETURNING id`, [productId, price]);
  const o = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: d.rows[0].id, qty: 1 }] }, idem());
  expect(o.status).toBe(201);
  const prep = await call(t, buyer, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: o.body.item.id }, idem());
  const c = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${o.body.item.id}`, orderId: prep.body.orderId, amount: prep.body.amount }, idem());
  expect(c.status).toBe(200);
  return { orderId: o.body.item.id as string, departureId: d.rows[0].id as string, payment: c.body.item, total: prep.body.amount as number };
}

async function fulfil(departureId: string) {
  await t.pool.query(`UPDATE travel_departures SET starts_at = now() - interval '1 hour' WHERE id = $1`, [departureId]);
  await runDepartureLifecycle(t.app.ctx, t.ctx());
}

const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  t = await createTestApp();
  buyer = await createUser(t);
  acctA = await createUser(t, { roles: ['ACCOUNTING'] });
  acctB = await createUser(t, { roles: ['ACCOUNTING'] });
  await enableFlags(t, 'travel.commerce');
});
afterAll(async () => t.close());

describe('FIN-03 fee/tax rules', () => {
  it('quoteFees returns 0 without an approved rule (no hard-coded rates)', async () => {
    expect(await quoteFees(t.pool, { domain: 'STAY', amountMinor: 100_000, currency: 'KRW' })).toEqual({ platformFeeMinor: 0, taxMinor: 0, hostFeeMinor: 0, rulesVersion: {} });
  });

  it('maker-checker approval, overlap rejection, and bps math (VAT on the service fee)', async () => {
    const mk = (body: any, u = acctA) => call(t, u, 'POST', '/v1/finance/rules', body);
    expect((await mk({ ruleType: 'PLATFORM_FEE', domain: 'STAY', params: { bps: 1200 }, effectiveFrom: '2020-01-01T00:00:00Z' }, buyer)).status).toBe(403);
    expect((await mk({ ruleType: 'PLATFORM_FEE', domain: 'STAY', params: {}, effectiveFrom: '2020-01-01T00:00:00Z' })).status).toBe(400);
    const fee = await mk({ ruleType: 'PLATFORM_FEE', domain: 'STAY', params: { bps: 1200 }, effectiveFrom: '2020-01-01T00:00:00Z', note: 'G9 approved' });
    expect(fee.status).toBe(201);
    expect(fee.body.item.status).toBe('DRAFT');
    // draft rules are not applied
    expect((await quoteFees(t.pool, { domain: 'STAY', amountMinor: 100_000, currency: 'KRW' })).platformFeeMinor).toBe(0);
    const self = await call(t, acctA, 'POST', `/v1/finance/rules/${fee.body.item.id}/approve`);
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('MAKER_CHECKER_VIOLATION');
    const ok = await call(t, acctB, 'POST', `/v1/finance/rules/${fee.body.item.id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body.item.status).toBe('APPROVED');
    expect((await call(t, acctB, 'POST', `/v1/finance/rules/${fee.body.item.id}/approve`)).body.code).toBe('INVALID_STATE_TRANSITION');

    const overlapping = await mk({ ruleType: 'PLATFORM_FEE', domain: 'STAY', params: { bps: 900 }, effectiveFrom: '2024-01-01T00:00:00Z' });
    const ov = await call(t, acctB, 'POST', `/v1/finance/rules/${overlapping.body.item.id}/approve`);
    expect(ov.status).toBe(409);
    expect(ov.body.code).toBe('RULE_OVERLAP');

    const host = await mk({ ruleType: 'HOST_FEE', domain: '*', params: { bps: 300 }, effectiveFrom: '2020-01-01T00:00:00Z' });
    await call(t, acctB, 'POST', `/v1/finance/rules/${host.body.item.id}/approve`);
    const tax = await mk({ ruleType: 'TAX', domain: '*', params: { bps: 1000 }, effectiveFrom: '2020-01-01T00:00:00Z' });
    await call(t, acctB, 'POST', `/v1/finance/rules/${tax.body.item.id}/approve`);

    const q = await quoteFees(t.pool, { domain: 'STAY', amountMinor: 123_457, currency: 'KRW' });
    expect(q.platformFeeMinor).toBe(14_815); // 123457 * 12% = 14814.84 → half-up 14815
    expect(q.hostFeeMinor).toBe(3_704); // 3% = 3703.71 → 3704
    expect(q.taxMinor).toBe(1_482); // 10% of platform fee 14815 = 1481.5 → 1482
    expect(q.rulesVersion).toEqual({ PLATFORM_FEE: fee.body.item.id, HOST_FEE: host.body.item.id, TAX: tax.body.item.id });
    // effective dating: before the window nothing applies
    expect((await quoteFees(t.pool, { domain: 'STAY', amountMinor: 100_000, currency: 'KRW', at: new Date('2019-06-01T00:00:00Z') })).platformFeeMinor).toBe(0);
    // GUIDE has no domain fee rule, only the '*' host fee
    expect((await quoteFees(t.pool, { domain: 'GUIDE', amountMinor: 100_000, currency: 'KRW' })).platformFeeMinor).toBe(0);

    const list = await call(t, acctA, 'GET', '/v1/finance/rules?status=APPROVED');
    expect(list.body.items.length).toBe(3);
    const aud = await t.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'finance.rule.approve' AND category = 'MONEY'`);
    expect(aud.rows[0].n).toBe(3);
  });
});

describe('FIN-01 ledger', () => {
  it('incrementalAllocation sums exactly to the full reversal across partial refunds', () => {
    const w = [72_001, 7_999, 1];
    const a = incrementalAllocation(0, 33_333, w);
    const b = incrementalAllocation(33_333, 33_333, w);
    const c = incrementalAllocation(66_666, 80_001 - 66_666, w);
    const sum = w.map((_, i) => a[i] + b[i] + c[i]);
    expect(sum).toEqual(w);
    for (const part of [...a, ...b, ...c]) expect(part).toBeGreaterThanOrEqual(0);
  });

  it('component refunds reverse only what was refunded; mixed sequences still sum exactly to the full reversal', async () => {
    const ctx = { correlationId: 'fin-01-component-refunds' };
    const FEE = 'PLATFORM:FEE_REVENUE:KRW';
    const TAX = 'PLATFORM:TAX_PAYABLE:KRW';
    // 2 suppliers: gross 140,000 / 70,000, commission 15 % → net 119,000 / 59,500; buyer fee 10,500 + VAT 1,050
    const p1 = randomUUID();
    const p2 = randomUUID();
    const split = [
      { payeeId: p1, payeeType: 'SUPPLIER' as const, grossMinor: 140_000, feeMinor: 21_000, taxMinor: 700 },
      { payeeId: p2, payeeType: 'SUPPLIER' as const, grossMinor: 70_000, feeMinor: 10_500, taxMinor: 350 },
    ];
    const total = 210_000 + 10_500 + 1_050;
    const credit = { [`PAYEE:${p1}:PAYABLE:KRW`]: 119_000, [`PAYEE:${p2}:PAYABLE:KRW`]: 59_500, [FEE]: 42_000, [TAX]: 1_050 };
    const approve = async () => {
      const paymentId = randomUUID();
      const a = await withTx(t.pool, (tx) => postPaymentApproval(tx, ctx, { paymentId, amountMinor: total, currency: 'KRW', snapshot: { split, merchantOfRecord: 'JETPOOL' } }));
      let before = 0;
      const refund = async (amountMinor: number, feeRefundMinor: number | null) => {
        const refundId = randomUUID();
        await withTx(t.pool, (tx) => postRefundReversal(tx, ctx, { paymentId, refundId, amountMinor, refundedBeforeMinor: before, feeRefundMinor, split }));
        before += amountMinor;
        const rows = await t.pool.query(
          `SELECT a.code, e.debit_minor, e.credit_minor FROM ledger_transactions x JOIN ledger_entries e ON e.transaction_id = x.id
             JOIN ledger_accounts a ON a.id = e.account_id WHERE x.source_type = 'REFUND' AND x.source_id = $1`,
          [refundId],
        );
        expect(rows.rows.find((r) => r.code === 'PLATFORM:PG_CLEARING:KRW')?.credit_minor).toBe(amountMinor);
        return Object.fromEntries(rows.rows.filter((r) => r.debit_minor > 0).map((r) => [r.code, r.debit_minor])) as Record<string, number>;
      };
      const reversed = async () => {
        const rows = await t.pool.query(
          `SELECT a.code, sum(e.debit_minor)::bigint AS d FROM ledger_transactions x JOIN ledger_entries e ON e.transaction_id = x.id
             JOIN ledger_accounts a ON a.id = e.account_id WHERE x.reverses_transaction_id = $1 AND e.debit_minor > 0 GROUP BY a.code`,
          [a.transactionId],
        );
        return Object.fromEntries(rows.rows.map((r) => [r.code, r.d])) as Record<string, number>;
      };
      return { refund, reversed };
    };

    // 50 % of the subtotal, service fee non-refundable: VAT and the buyer fee stay; payees + commission pro rata
    const a = await approve();
    expect(await a.refund(105_000, 0)).toEqual({ [`PAYEE:${p1}:PAYABLE:KRW`]: 59_500, [`PAYEE:${p2}:PAYABLE:KRW`]: 29_750, [FEE]: 15_750 });
    // the rest, unspecified (staff / full refund): exactly the remainder of every account
    await a.refund(total - 105_000, null);
    expect(await a.reversed()).toEqual(credit);

    // fee refundable: the fee part reverses the buyer fee and VAT pro rata; nothing more than the fee is taken from FEE_REVENUE
    const b = await approve();
    expect(await b.refund(105_000 + 5_775, 5_775)).toEqual({ [`PAYEE:${p1}:PAYABLE:KRW`]: 59_500, [`PAYEE:${p2}:PAYABLE:KRW`]: 29_750, [FEE]: 15_750 + 5_250, [TAX]: 525 });

    // staff partial refund (pro rata) first, then component refunds: never above a credit, exact at the end
    const c = await approve();
    await c.refund(33_333, null);
    await c.refund(100_000, 0);
    const mid = await c.reversed();
    for (const [code, amount] of Object.entries(mid)) expect(amount, code).toBeLessThanOrEqual(credit[code]);
    await c.refund(total - 133_333, 11_550 - (mid[TAX] ?? 0));
    expect(await c.reversed()).toEqual(credit);
  });

  it('SUPPLIER merchant of record posts PASS_THROUGH + commission; trial balance is zero-sum; ledger is append-only', async () => {
    const { owner, productId } = await makeSupplier('SUPPLIER', 2000);
    const { payment } = await paidOrder(productId, 50_000);
    const rows = await t.pool.query(
      `SELECT a.code, e.debit_minor, e.credit_minor FROM ledger_transactions x JOIN ledger_entries e ON e.transaction_id = x.id JOIN ledger_accounts a ON a.id = e.account_id
        WHERE x.source_type = 'PAYMENT' AND x.source_id = $1`,
      [payment.id],
    );
    const by = Object.fromEntries(rows.rows.map((r) => [r.code, r.debit_minor || r.credit_minor]));
    expect(by[`PASS_THROUGH:${owner.id}:KRW`]).toBe(40_000);
    expect(by['PLATFORM:FEE_REVENUE:KRW']).toBe(10_000);
    expect(by['PLATFORM:PG_CLEARING:KRW']).toBe(50_000);

    expect((await call(t, buyer, 'GET', '/v1/admin/ledger/trial-balance')).status).toBe(403);
    const tb = await call(t, acctA, 'GET', '/v1/admin/ledger/trial-balance');
    expect(tb.body.balanced).toBe(true);
    expect(tb.body.currencies.every((c: any) => c.debitMinor === c.creditMinor)).toBe(true);
    const txs = await call(t, acctA, 'GET', `/v1/admin/ledger/transactions?sourceType=PAYMENT&sourceId=${payment.id}`);
    expect(txs.body.items).toHaveLength(1);
    expect(txs.body.items[0].entries.length).toBeGreaterThanOrEqual(3);
    const accounts = await call(t, acctA, 'GET', '/v1/admin/ledger/accounts?currency=KRW');
    expect(accounts.body.items.some((a: any) => a.code === `PASS_THROUGH:${owner.id}:KRW`)).toBe(true);
    await expect(t.pool.query(`UPDATE ledger_entries SET debit_minor = debit_minor + 1`)).rejects.toThrow(/append-only/);

    // PG settles to bank: Dr BANK / Cr PG_CLEARING (idempotent)
    const h = idem();
    const s1 = await call(t, acctA, 'POST', '/v1/admin/ledger/pg-settlements', { currency: 'KRW', amountMinor: 50_000, reference: 'TOSS-2026-10-07' }, h);
    expect(s1.status).toBe(201);
    const s2 = await call(t, acctA, 'POST', '/v1/admin/ledger/pg-settlements', { currency: 'KRW', amountMinor: 50_000, reference: 'TOSS-2026-10-07' }, idem());
    expect(s2.status).toBe(200); // same reference → same ledger tx
    const bank = await t.pool.query(`SELECT balance_minor FROM ledger_balances WHERE code = 'PLATFORM:BANK:KRW'`);
    expect(bank.rows[0].balance_minor).toBe(50_000);
  });
});

describe('FIN-02 settlement & payout', () => {
  it('generates ledger-derived settlements, enforces maker-checker, pays out (manual export) and posts Dr payable / Cr BANK', async () => {
    const { owner, productId } = await makeSupplier('JETPOOL', 1000);
    const a = await paidOrder(productId, 60_000);
    const b = await paidOrder(productId, 40_000);
    // partial refund on b before fulfilment: settlement must net it out
    await call(t, acctA, 'POST', `/v1/payments/${b.payment.id}/refunds`, { amountMinor: 10_000, reason: 'partial' }, idem());
    await t.drain();
    await fulfil(a.departureId);
    await fulfil(b.departureId);
    expect((await call(t, buyer, 'GET', `/v1/orders/${a.orderId}`)).body.item.status).toBe('FULFILLED');

    const gen = await call(t, acctA, 'POST', '/v1/admin/settlements/generate', { periodStart: today(), periodEnd: today() }, idem());
    expect(gen.status).toBe(201);
    const s = gen.body.items.find((x: any) => x.payeeId === owner.id);
    expect(s).toBeTruthy();
    expect(s.status).toBe('APPROVAL_PENDING');
    // gross 100k, fee 10% = 10k, refund: 10k * 90% payee share = 9k → net 81k
    expect(s.grossMinor).toBe(100_000);
    expect(s.feeMinor).toBe(10_000);
    expect(s.refundMinor).toBe(9_000);
    expect(s.netMinor).toBe(81_000);
    // re-generation does not double count
    const again = await call(t, acctA, 'POST', '/v1/admin/settlements/generate', { periodStart: today(), periodEnd: today() }, idem());
    expect(again.body.items.find((x: any) => x.payeeId === owner.id)).toBeUndefined();

    const self = await call(t, acctA, 'POST', `/v1/admin/settlements/${s.id}/approve`);
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('MAKER_CHECKER_VIOLATION');
    const admin = await createUser(t, { roles: ['ADMIN'] });
    expect((await call(t, admin, 'POST', `/v1/admin/settlements/${s.id}/approve`)).status).toBe(403); // ACCOUNTING only
    const appr = await call(t, acctB, 'POST', `/v1/admin/settlements/${s.id}/approve`);
    expect(appr.status).toBe(200);
    expect(appr.body.item.status).toBe('APPROVED');

    // payout requires a verified tokenized account
    expect((await call(t, acctB, 'POST', `/v1/admin/settlements/${s.id}/payout`, undefined, idem())).body.code).toBe('PAYOUT_ACCOUNT_REQUIRED');
    const aal1 = await createUser(t, { roles: ['SUPPLIER'] });
    expect((await call(t, aal1, 'POST', '/v1/payout-accounts', { bankCode: '004', accountLast4: '1234', accountToken: 'tok_abcdef123', holderName: 'X' })).body.code).toBe('AAL2_REQUIRED');
    expect((await call(t, owner, 'POST', '/v1/payout-accounts', { bankCode: '004', accountLast4: '1234', accountToken: '12345678901234', holderName: 'Kim' })).status).toBe(400);
    const acc = await call(t, owner, 'POST', '/v1/payout-accounts', { bankCode: '004', accountLast4: '1234', accountToken: 'tok_bank_9f8e7d', holderName: 'Kim' });
    expect(acc.status).toBe(201);
    expect(acc.body.item.accountToken).toBeUndefined();
    await call(t, acctB, 'POST', `/v1/admin/payout-accounts/${acc.body.item.id}/verify`, { decision: 'VERIFIED' });

    // payout.automatic OFF → manual: PAYOUT_PENDING + CSV export, then mark paid
    const po = await call(t, acctB, 'POST', `/v1/admin/settlements/${s.id}/payout`, undefined, idem());
    expect(po.status).toBe(200);
    expect(po.body.mode).toBe('MANUAL');
    expect(po.body.item.status).toBe('PAYOUT_PENDING');
    const csv = await call(t, acctB, 'GET', '/v1/admin/settlements/payout-export');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(String(csv.body)).toContain(s.id);
    expect(String(csv.body)).toContain('"81000"');
    const paid = await call(t, acctB, 'POST', `/v1/admin/settlements/${s.id}/mark-paid`, { payoutRef: 'BANK-TRX-001' }, idem());
    expect(paid.status).toBe(200);
    expect(paid.body.item.status).toBe('PAID');
    const payable = await t.pool.query(`SELECT balance_minor FROM ledger_balances WHERE code = $1`, [`PAYEE:${owner.id}:PAYABLE:KRW`]);
    expect(payable.rows[0].balance_minor).toBe(0);
    const tb = await call(t, acctA, 'GET', '/v1/admin/ledger/trial-balance');
    expect(tb.body.balanced).toBe(true);
    expect((await call(t, acctB, 'POST', `/v1/admin/settlements/${s.id}/reconcile`)).body.item.status).toBe('RECONCILED');

    const mine = await call(t, owner, 'GET', '/v1/provider/settlements');
    expect(mine.status).toBe(200);
    expect(mine.body.items[0].id).toBe(s.id);
    expect(mine.body.items[0].lines.reduce((x: number, l: any) => x + l.netMinor, 0)).toBe(81_000);
    const aud = await t.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE resource_id = $1 AND category = 'MONEY'`, [s.id]);
    expect(aud.rows[0].n).toBeGreaterThanOrEqual(3);
  });

  it('holds settlements for payees with a PAYOUT_HOLD sanction; automatic payout when enabled', async () => {
    const held = await makeSupplier('JETPOOL', 0);
    const ok = await makeSupplier('JETPOOL', 500);
    const h = await paidOrder(held.productId, 10_000);
    const o = await paidOrder(ok.productId, 20_000);
    await fulfil(h.departureId);
    await fulfil(o.departureId);
    const admin = await createUser(t, { roles: ['ADMIN'] });
    await t.pool.query(`INSERT INTO sanctions(user_id, sanction_type, reason, issued_by) VALUES ($1,'PAYOUT_HOLD','fraud review',$2)`, [held.owner.id, admin.id]);
    const gen = await call(t, acctA, 'POST', '/v1/admin/settlements/generate', { periodStart: today(), periodEnd: today() }, idem());
    const sh = gen.body.items.find((x: any) => x.payeeId === held.owner.id);
    expect(sh.status).toBe('HELD');
    expect(sh.holdReason).toMatch(/PAYOUT_HOLD/);
    const so = gen.body.items.find((x: any) => x.payeeId === ok.owner.id);
    expect(so.netMinor).toBe(19_000);
    await call(t, acctB, 'POST', `/v1/admin/settlements/${so.id}/approve`);
    const acc = await call(t, ok.owner, 'POST', '/v1/payout-accounts', { bankCode: '088', accountLast4: '9876', accountToken: 'tok_x_123456', holderName: 'Lee' });
    await call(t, acctB, 'POST', `/v1/admin/payout-accounts/${acc.body.item.id}/verify`, { decision: 'VERIFIED' });
    await enableFlags(t, 'payout.automatic');
    const po = await call(t, acctB, 'POST', `/v1/admin/settlements/${so.id}/payout`, undefined, idem());
    expect(po.body.mode).toBe('MOCK');
    expect(po.body.item.status).toBe('PAID');
    const bankTx = await t.pool.query(`SELECT count(*)::int AS n FROM ledger_transactions WHERE source_type = 'SETTLEMENT' AND source_id = $1 AND transaction_type = 'PAYOUT'`, [so.id]);
    expect(bankTx.rows[0].n).toBe(1);
  });
});
