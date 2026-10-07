/**
 * FIN-02 settlement of terminal stays that never reach COMPLETED (NO_SHOW, CANCELLED with a 0 % refund,
 * PARTIALLY_REFUNDED). The host keeps (part of) the proceeds, so the ledger payable must be settled: the
 * statement net equals the payee's PAYABLE balance (ledger-derived), and a payout brings it to zero.
 * Policy (pending G9 payout-policy approval): payable once the booked check-out date has passed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, createUser, call, day, enableFlags, idem, type TestApp, type TestUser } from './helpers.js';
import { applyBps } from '../src/platform/money.js';

let t: TestApp;
let guest: TestUser;
let acctA: TestUser;
let acctB: TestUser;
let moderateId: string;

const NIGHTLY = 100_000;
const CLEANING = 20_000;
const FEE_BASE = 2 * NIGHTLY + CLEANING; // 2-night stays
const PLATFORM_FEE = applyBps(FEE_BASE, 1000);
const HOST_FEE = applyBps(FEE_BASE, 300);
const TAX = applyBps(PLATFORM_FEE, 1000);
const TOTAL = FEE_BASE + PLATFORM_FEE + TAX;
const HOST_NET = FEE_BASE - HOST_FEE;

const show = (r: { body: any }) => JSON.stringify(r.body);

async function makeHostAndProperty() {
  const host = await createUser(t, { roles: ['HOST'], aal: 'aal2' });
  const { rows } = await t.pool.query(
    `INSERT INTO properties(host_id, title, property_type, status, rental_enabled, paid_booking_enabled, base_price_minor, cleaning_fee_minor,
                            currency, max_guests, min_nights, timezone, country, cancellation_policy_id, published_at, city)
     VALUES ($1,'Stay','HOUSE','PUBLISHED',true,true,$2,$3,'KRW',4,1,'UTC','KR',$4, now(), 'Seoul') RETURNING id`,
    [host.id, NIGHTLY, CLEANING, moderateId],
  );
  await t.pool.query(`INSERT INTO property_addresses(property_id, line1, city, country, public_area_label) VALUES ($1,'1 Test-ro','Seoul','KR','Mapo-gu')`, [rows[0].id]);
  return { host, propertyId: rows[0].id as string };
}

/** quote → hold → prepare → MOCK provider confirm (posts the approval ledger transaction). */
async function bookAndPay(propertyId: string, checkIn: string, checkOut: string) {
  const q = await call(t, guest, 'POST', '/v1/booking/quotes', { propertyId, checkIn, checkOut, guests: 2 });
  expect(q.status, show(q)).toBe(201);
  expect(q.body.item.totalMinor).toBe(TOTAL);
  const h = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId: q.body.item.id }, idem());
  expect(h.status, show(h)).toBe(201);
  const rid = h.body.item.reservation.id as string;
  const p = await call(t, guest, 'POST', '/v1/payments/toss/prepare', { subjectType: 'RESERVATION', subjectId: rid }, idem());
  expect(p.status, show(p)).toBe(201);
  const c = await call(t, guest, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${randomUUID().replace(/-/g, '')}`, orderId: p.body.orderId, amount: p.body.amount }, idem());
  expect(c.status, show(c)).toBe(200);
  expect(c.body.item.status).toBe('APPROVED');
  return { reservationId: rid, paymentId: p.body.paymentId as string };
}

/** Simulate the passage of time: the booked stay lies in the past (inventory is irrelevant to settlement). */
async function moveStayToPast(reservationId: string) {
  await t.pool.query(`UPDATE reservations SET check_in = $2, check_out = $3 WHERE id = $1`, [reservationId, day(-3), day(-1)]);
}

const status = async (id: string) => (await t.pool.query(`SELECT status FROM reservations WHERE id = $1`, [id])).rows[0].status as string;
const payable = async (hostId: string) =>
  Number((await t.pool.query(`SELECT balance_minor FROM ledger_balances WHERE code = $1`, [`PAYEE:${hostId}:PAYABLE:KRW`])).rows[0]?.balance_minor ?? 0);
const generate = async (periodStart = day(0), periodEnd = day(0)) => {
  const g = await call(t, acctA, 'POST', '/v1/admin/settlements/generate', { periodStart, periodEnd }, idem());
  expect(g.status, show(g)).toBe(201);
  return g.body.items as any[];
};
const linesOf = async (host: TestUser, settlementId: string) =>
  (await call(t, host, 'GET', '/v1/provider/settlements')).body.items.find((s: any) => s.id === settlementId).lines as any[];

beforeAll(async () => {
  t = await createTestApp();
  guest = await createUser(t);
  acctA = await createUser(t, { roles: ['ACCOUNTING'] });
  acctB = await createUser(t, { roles: ['ACCOUNTING'] });
  moderateId = (await t.pool.query(`SELECT id FROM cancellation_policies WHERE code = 'MODERATE'`)).rows[0].id;
  await enableFlags(t, 'stay.paid_booking', 'payout.automatic');
  await t.pool.query(
    `INSERT INTO compliance_rules(rule_key, subject_type, jurisdiction, effective_from, status, approved_at, note)
     VALUES ('test-allow','PROPERTY','KR','2020-01-01','APPROVED', now(), 'test')`,
  );
  await t.pool.query(
    `INSERT INTO finance_rules(rule_type, domain, jurisdiction, params, effective_from, status, approved_at) VALUES
       ('PLATFORM_FEE','STAY','KR','{"bps":1000}','2020-01-01','APPROVED', now()),
       ('HOST_FEE','STAY','KR','{"bps":300}','2020-01-01','APPROVED', now()),
       ('TAX','STAY','KR','{"bps":1000}','2020-01-01','APPROVED', now())`,
  );
});
afterAll(async () => t?.close());

describe('FIN-02 settlement of terminal stays (no-show / cancellation proceeds)', () => {
  it('settles what the host keeps once check-out has passed; statement net = ledger payable; payout clears it', async () => {
    // A: no-show — the host keeps the full net credited at approval
    const a = await makeHostAndProperty();
    const ra = await bookAndPay(a.propertyId, day(10), day(12));
    await moveStayToPast(ra.reservationId);
    const ns = await call(t, a.host, 'POST', `/v1/reservations/${ra.reservationId}/no-show`, { reason: 'did not arrive' });
    expect(ns.status, show(ns)).toBe(200);
    expect(ns.body.item.status).toBe('NO_SHOW');

    // B: guest cancellation in the 50 % tier (24h ≤ notice < 120h) → PARTIALLY_REFUNDED
    const b = await makeHostAndProperty();
    const rb = await bookAndPay(b.propertyId, day(3), day(5));
    const cb = await call(t, guest, 'POST', `/v1/reservations/${rb.reservationId}/cancel`, { reason: 'change of plans' }, idem());
    expect(cb.status, show(cb)).toBe(200);
    expect(cb.body.item.cancellation.refundMinor).toBe(applyBps(TOTAL - PLATFORM_FEE, 5000));
    await t.drain();
    expect(await status(rb.reservationId)).toBe('PARTIALLY_REFUNDED');

    // C: guest cancellation inside the 0 % tier (< 24h) → no refund, stays CANCELLED
    const c = await makeHostAndProperty();
    const rc = await bookAndPay(c.propertyId, day(3), day(5));
    await t.pool.query(`UPDATE reservations SET check_in = $2, check_out = $3 WHERE id = $1`, [rc.reservationId, day(0), day(2)]);
    const cc = await call(t, guest, 'POST', `/v1/reservations/${rc.reservationId}/cancel`, { reason: 'too late' }, idem());
    expect(cc.status, show(cc)).toBe(200);
    expect(cc.body.item.cancellation.refundMinor).toBe(0);
    expect(await status(rc.reservationId)).toBe('CANCELLED');

    // D: host cancellation → full refund → REFUNDED, nothing left to settle
    const d = await makeHostAndProperty();
    const rd = await bookAndPay(d.propertyId, day(10), day(12));
    const cd = await call(t, d.host, 'POST', `/v1/reservations/${rd.reservationId}/cancel`, { reason: 'host unavailable' }, idem());
    expect(cd.status, show(cd)).toBe(200);
    await t.drain();
    expect(await status(rd.reservationId)).toBe('REFUNDED');
    expect(await payable(d.host.id)).toBe(0);

    // run 1: only A's stay is over; B and C are not paid out before their check-out date
    const run1 = await generate();
    const sa = run1.find((s) => s.payeeId === a.host.id);
    expect(sa, 'no-show stay settled').toMatchObject({ payeeType: 'HOST', status: 'APPROVAL_PENDING', grossMinor: FEE_BASE, feeMinor: HOST_FEE, refundMinor: 0, netMinor: HOST_NET });
    expect(sa.netMinor).toBe(await payable(a.host.id));
    expect(await linesOf(a.host, sa.id)).toEqual([{ sourceType: 'RESERVATION', sourceId: ra.reservationId, grossMinor: FEE_BASE, feeMinor: HOST_FEE, refundMinor: 0, netMinor: HOST_NET }]);
    for (const p of [b, c, d]) expect(run1.filter((s) => s.payeeId === p.host.id)).toEqual([]);

    // run 2 (after B's and C's stays are over): ledger-derived nets, A is not settled twice, D never appears
    await moveStayToPast(rb.reservationId);
    await moveStayToPast(rc.reservationId);
    const run2 = await generate(day(1), day(1));
    expect(run2.filter((s) => s.payeeId === a.host.id || s.payeeId === d.host.id)).toEqual([]);

    const hostDebit = Number(
      (
        await t.pool.query(
          `SELECT e.debit_minor FROM ledger_transactions x JOIN ledger_entries e ON e.transaction_id = x.id JOIN ledger_accounts acc ON acc.id = e.account_id
            JOIN refunds r ON r.id = x.source_id JOIN payments p ON p.id = r.payment_id
           WHERE x.transaction_type = 'REFUND' AND p.subject_id = $1 AND acc.code = $2`,
          [rb.reservationId, `PAYEE:${b.host.id}:PAYABLE:KRW`],
        )
      ).rows[0].debit_minor,
    );
    expect(hostDebit).toBeGreaterThan(0);
    expect(hostDebit).toBeLessThan(HOST_NET);
    const sb = run2.find((s) => s.payeeId === b.host.id);
    expect(sb, 'partially refunded stay settled').toMatchObject({ grossMinor: FEE_BASE, feeMinor: HOST_FEE, refundMinor: hostDebit, netMinor: HOST_NET - hostDebit });
    expect(sb.netMinor).toBe(await payable(b.host.id));
    const lb = await linesOf(b.host, sb.id);
    expect(lb).toHaveLength(2);
    expect(lb).toEqual(expect.arrayContaining([
      { sourceType: 'RESERVATION', sourceId: rb.reservationId, grossMinor: FEE_BASE, feeMinor: HOST_FEE, refundMinor: 0, netMinor: HOST_NET },
      expect.objectContaining({ sourceType: 'LEDGER_REFUND', grossMinor: 0, feeMinor: 0, refundMinor: hostDebit, netMinor: -hostDebit }),
    ]));

    const sc = run2.find((s) => s.payeeId === c.host.id);
    expect(sc, '0 % cancellation settled').toMatchObject({ grossMinor: FEE_BASE, feeMinor: HOST_FEE, refundMinor: 0, netMinor: HOST_NET });
    expect(sc.netMinor).toBe(await payable(c.host.id));

    // re-generation never double counts
    expect((await generate(day(-1), day(1))).filter((s) => [a, b, c, d].some((p) => p.host.id === s.payeeId))).toEqual([]);

    // maker-checker approval + payout of the partial-refund statement clears the host payable
    const acc = await call(t, b.host, 'POST', '/v1/payout-accounts', { bankCode: '088', accountLast4: '4321', accountToken: 'tok_stay_payout_b', holderName: 'Host B' });
    expect(acc.status, show(acc)).toBe(201);
    expect((await call(t, acctB, 'POST', `/v1/admin/payout-accounts/${acc.body.item.id}/verify`, { decision: 'VERIFIED' })).status).toBe(200);
    expect((await call(t, acctA, 'POST', `/v1/admin/settlements/${sb.id}/approve`)).body.code).toBe('MAKER_CHECKER_VIOLATION');
    expect((await call(t, acctB, 'POST', `/v1/admin/settlements/${sb.id}/approve`)).body.item.status).toBe('APPROVED');
    const po = await call(t, acctB, 'POST', `/v1/admin/settlements/${sb.id}/payout`, undefined, idem());
    expect(po.status, show(po)).toBe(200);
    expect(po.body.item).toMatchObject({ status: 'PAID', netMinor: HOST_NET - hostDebit });
    expect(await payable(b.host.id)).toBe(0);

    const tb = await call(t, acctA, 'GET', '/v1/admin/ledger/trial-balance');
    expect(tb.body.balanced).toBe(true);
  });
});
