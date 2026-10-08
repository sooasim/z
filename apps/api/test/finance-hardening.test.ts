/**
 * QA hardening r1 — FIN-01..03 regressions (money group):
 *  - retiring an APPROVED fee/tax rule needs a second ACCOUNTING/ADMIN user (maker-checker);
 *  - a negative statement (refunds after a payout) is carried forward and recovered from later earnings;
 *  - paid orders / guide bookings that end CANCELLED but keep (part of) the proceeds are settled;
 *  - impossible settlement dates are 400;
 *  - keyset pagination over settlements / ledger transactions / receipts created in one transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, createUser, call, idem, enableFlags, day, type TestApp, type TestUser } from './helpers.js';
import { quoteFees } from '../src/modules/finance/rules.js';
import { postPaymentApproval, postPgSettlement } from '../src/modules/finance/ledger.js';
import { withTx } from '../src/platform/db.js';
import { setFlag } from '../src/platform/flags.js';
import { runDepartureLifecycle } from '../src/modules/travel/service.js';

let t: TestApp;
let buyer: TestUser;
let acctA: TestUser;
let acctB: TestUser;

async function makeSupplier(commissionBps: number, terms: Record<string, unknown> = {}) {
  const owner = await createUser(t, { roles: ['SUPPLIER'], aal: 'aal2' });
  const s = await t.pool.query(
    `INSERT INTO suppliers(owner_user_id, name, supplier_type, status, merchant_of_record, commission_bps) VALUES ($1,'Sup','TOUR_OPERATOR','APPROVED','JETPOOL',$2) RETURNING id`,
    [owner.id, commissionBps],
  );
  const p = await t.pool.query(`INSERT INTO travel_products(supplier_id, type, title, base_price_minor, status, cancellation_terms) VALUES ($1,'TOUR','T',100000,'PUBLISHED',$2) RETURNING id`, [
    s.rows[0].id,
    JSON.stringify(terms),
  ]);
  return { owner, productId: p.rows[0].id as string };
}

async function paidOrder(productId: string, price: number, startsIn = "interval '10 days'") {
  const d = await t.pool.query(`INSERT INTO travel_departures(product_id, starts_at, capacity, price_minor) VALUES ($1, now() + ${startsIn}, 10, $2) RETURNING id`, [productId, price]);
  const o = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: d.rows[0].id, qty: 1 }] }, idem());
  expect(o.status).toBe(201);
  const prep = await call(t, buyer, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: o.body.item.id }, idem());
  const c = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${o.body.item.id}`, orderId: prep.body.orderId, amount: prep.body.amount }, idem());
  expect(c.status).toBe(200);
  return { orderId: o.body.item.id as string, departureId: d.rows[0].id as string, payment: c.body.item };
}

/** Departure starts (lifecycle fulfils the order); the fulfilment is then dated `fulfilledOn` (period placement). */
async function fulfil(departureId: string, orderId: string, fulfilledOn: string) {
  await t.pool.query(`UPDATE travel_departures SET starts_at = now() - interval '1 hour' WHERE id = $1`, [departureId]);
  await runDepartureLifecycle(t.app.ctx, t.ctx());
  await t.pool.query(`UPDATE orders SET fulfilled_at = $2::date + interval '12 hours' WHERE id = $1 AND status = 'FULFILLED'`, [orderId, fulfilledOn]);
}

const payable = async (userId: string) =>
  Number((await t.pool.query(`SELECT coalesce((SELECT balance_minor FROM ledger_balances WHERE code = $1), 0) AS b`, [`PAYEE:${userId}:PAYABLE:KRW`])).rows[0].b);

async function generate(periodStart: string, periodEnd: string) {
  const g = await call(t, acctA, 'POST', '/v1/admin/settlements/generate', { periodStart, periodEnd }, idem());
  expect(g.status, JSON.stringify(g.body)).toBe(201);
  return g.body as { items: any[]; skipped: any[] };
}

beforeAll(async () => {
  t = await createTestApp();
  buyer = await createUser(t);
  acctA = await createUser(t, { roles: ['ACCOUNTING'] });
  acctB = await createUser(t, { roles: ['ACCOUNTING'] });
  await enableFlags(t, 'travel.commerce');
});
afterAll(async () => t.close());

describe('FIN-03 retiring an approved rule is maker-checker', () => {
  it('one accountant requests, a different one confirms; the requester alone cannot switch the fee off', async () => {
    const fee = await call(t, acctA, 'POST', '/v1/finance/rules', { ruleType: 'PLATFORM_FEE', domain: 'TRAVEL', params: { bps: 1000 }, effectiveFrom: '2020-01-01T00:00:00Z' });
    const tax = await call(t, acctA, 'POST', '/v1/finance/rules', { ruleType: 'TAX', domain: 'TRAVEL', params: { bps: 1000 }, effectiveFrom: '2020-01-01T00:00:00Z' });
    for (const r of [fee, tax]) expect((await call(t, acctB, 'POST', `/v1/finance/rules/${r.body.item.id}/approve`)).status).toBe(200);
    const quote = () => quoteFees(t.pool, { domain: 'TRAVEL', amountMinor: 100_000, currency: 'KRW' });
    expect(await quote()).toMatchObject({ platformFeeMinor: 10_000, taxMinor: 1_000 });

    // the creator alone: only a request, the rule stays APPROVED and keeps applying
    const req1 = await call(t, acctA, 'POST', `/v1/finance/rules/${fee.body.item.id}/retire`, { reason: 'just because' });
    expect(req1.status).toBe(202);
    expect(req1.body).toMatchObject({ pending: true, code: 'RETIRE_CONFIRMATION_REQUIRED', item: { status: 'APPROVED', retireRequestedBy: acctA.id } });
    const again = await call(t, acctA, 'POST', `/v1/finance/rules/${fee.body.item.id}/retire`, { reason: 'just because' });
    expect(again.status).toBe(403);
    expect(again.body.code).toBe('MAKER_CHECKER_VIOLATION');
    expect(await quote()).toMatchObject({ platformFeeMinor: 10_000, taxMinor: 1_000 });
    expect((await call(t, acctB, 'GET', '/v1/finance/quote?domain=TRAVEL&amountMinor=100000')).body.item.platformFeeMinor).toBe(10_000);

    // a second person confirms
    const ok = await call(t, acctB, 'POST', `/v1/finance/rules/${fee.body.item.id}/retire`, { reason: 'superseded by the 2027 schedule' });
    expect(ok.status).toBe(200);
    expect(ok.body.item).toMatchObject({ status: 'RETIRED', retireRequestedBy: acctA.id, retiredBy: acctB.id });
    expect((await quote()).platformFeeMinor).toBe(0);

    // a pending request can be withdrawn; the rule stays approved
    expect((await call(t, acctA, 'POST', `/v1/finance/rules/${tax.body.item.id}/retire`, { reason: 'mistake' })).status).toBe(202);
    const cancel = await call(t, acctA, 'POST', `/v1/finance/rules/${tax.body.item.id}/retire/cancel`);
    expect(cancel.status).toBe(200);
    expect(cancel.body.item).toMatchObject({ status: 'APPROVED', retireRequestedBy: null });

    // DRAFT rules are still retired in one step
    const draft = await call(t, acctA, 'POST', '/v1/finance/rules', { ruleType: 'HOST_FEE', domain: 'TRAVEL', params: { bps: 100 }, effectiveFrom: '2020-01-01T00:00:00Z' });
    expect((await call(t, acctA, 'POST', `/v1/finance/rules/${draft.body.item.id}/retire`, { reason: 'not needed' })).body.item.status).toBe('RETIRED');
    const aud = await t.pool.query(`SELECT action FROM audit_logs WHERE resource_id = $1 AND category = 'MONEY' ORDER BY created_at`, [fee.body.item.id]);
    expect(aud.rows.map((r) => r.action)).toEqual(expect.arrayContaining(['finance.rule.retire_requested', 'finance.rule.retire']));
    // tidy up so later fee math in this file is rule-free
    await call(t, acctB, 'POST', `/v1/finance/rules/${tax.body.item.id}/retire`, { reason: 'tidy up' });
    await call(t, acctA, 'POST', `/v1/finance/rules/${tax.body.item.id}/retire`, { reason: 'tidy up' });
    expect((await quote()).taxMinor).toBe(0);
  });
});

describe('FIN-02 refunds after a payout are carried forward', () => {
  it('a negative statement is never paid; its balance is recovered from the next earnings', async () => {
    const { owner, productId } = await makeSupplier(0);
    const acc = await call(t, owner, 'POST', '/v1/payout-accounts', { bankCode: '004', accountLast4: '1111', accountToken: 'tok_carry_fwd_1', holderName: 'Sup' });
    await call(t, acctB, 'POST', `/v1/admin/payout-accounts/${acc.body.item.id}/verify`, { decision: 'VERIFIED' });
    await enableFlags(t, 'payout.automatic');
    const pay = async (s: any) => {
      expect((await call(t, acctB, 'POST', `/v1/admin/settlements/${s.id}/approve`)).body.item.status).toBe('APPROVED');
      const po = await call(t, acctB, 'POST', `/v1/admin/settlements/${s.id}/payout`, undefined, idem());
      expect(po.body.item?.status, JSON.stringify(po.body)).toBe('PAID');
    };
    const mine = (r: { items: any[] }) => r.items.filter((x) => x.payeeId === owner.id);

    // period 1: sale A 100,000 → paid out
    const a = await paidOrder(productId, 100_000);
    await fulfil(a.departureId, a.orderId, day(-30));
    const [s1] = mine(await generate(day(-30), day(-30)));
    expect(s1).toMatchObject({ grossMinor: 100_000, netMinor: 100_000, status: 'APPROVAL_PENDING' });
    await pay(s1);
    expect(await payable(owner.id)).toBe(0);

    // a 60,000 refund on A after the payout
    expect((await call(t, acctA, 'POST', `/v1/payments/${a.payment.id}/refunds`, { amountMinor: 60_000, reason: 'goodwill after payout' }, idem())).status).toBe(201);
    await t.drain();
    expect(await payable(owner.id)).toBe(-60_000);

    // period 2: only the refund → negative statement, carried forward (never approvable / payable)
    const [s2] = mine(await generate(day(-29), day(0)));
    expect(s2).toMatchObject({ grossMinor: 0, refundMinor: 60_000, netMinor: -60_000, status: 'CARRIED_FORWARD' });
    expect((await call(t, acctB, 'POST', `/v1/admin/settlements/${s2.id}/approve`)).status).toBe(409);

    // period 3: a 50,000 sale does not cover the debt → still nothing paid, the rest carried again
    const b = await paidOrder(productId, 50_000);
    await fulfil(b.departureId, b.orderId, day(1));
    const [s3] = mine(await generate(day(1), day(1)));
    expect(s3).toMatchObject({ grossMinor: 50_000, refundMinor: 60_000, netMinor: -10_000, status: 'CARRIED_FORWARD' });

    // period 4: a 30,000 sale → paid 20,000 (30,000 − the 10,000 still owed)
    const c = await paidOrder(productId, 30_000);
    await fulfil(c.departureId, c.orderId, day(2));
    const [s4] = mine(await generate(day(2), day(2)));
    expect(s4).toMatchObject({ grossMinor: 30_000, refundMinor: 10_000, netMinor: 20_000, status: 'APPROVAL_PENDING' });
    const detail = await call(t, acctA, 'GET', `/v1/admin/settlements/${s4.id}`);
    expect(detail.body.item.items.map((i: any) => [i.source_type, i.refund_minor])).toEqual(expect.arrayContaining([['CARRY_FORWARD', 10_000]]));
    await pay(s4);

    // total paid 120,000 = 100,000 + 50,000 + 30,000 − 60,000; the ledger payable is exactly 0
    const paid = await t.pool.query(`SELECT coalesce(sum(net_minor),0)::bigint AS s FROM settlements WHERE payee_id = $1 AND status = 'PAID'`, [owner.id]);
    expect(Number(paid.rows[0].s)).toBe(120_000);
    expect(await payable(owner.id)).toBe(0);
    // nothing is carried twice
    expect(mine(await generate(day(3), day(3)))).toEqual([]);
    await setFlag(t.pool, 'payout.automatic', false);
  });
});

describe('FIN-02 cancelled subjects that keep the proceeds are settled', () => {
  it('a paid order cancelled inside the 0 % tier is settled once its departure date has passed', async () => {
    const { owner, productId } = await makeSupplier(1000, { tiers: [{ min_hours_before: 72, refund_pct: 100 }, { min_hours_before: 24, refund_pct: 50 }, { min_hours_before: 0, refund_pct: 0 }] });
    const o = await paidOrder(productId, 100_000, "interval '10 hours'");
    expect(await payable(owner.id)).toBe(90_000);
    const cx = await call(t, buyer, 'POST', `/v1/orders/${o.orderId}/cancel`, { reason: 'too late' }, idem());
    expect(cx.status).toBe(200);
    expect(cx.body.refund.amountMinor).toBe(0);
    await t.drain();
    // not before the tour would have run
    expect((await generate('2000-01-01', day(1))).items.filter((x) => x.payeeId === owner.id)).toEqual([]);
    await t.pool.query(`UPDATE travel_departures SET starts_at = now() - interval '1 hour' WHERE id = $1`, [o.departureId]);
    const [s] = (await generate('2000-01-02', day(1))).items.filter((x) => x.payeeId === owner.id);
    expect(s).toMatchObject({ grossMinor: 100_000, feeMinor: 10_000, refundMinor: 0, netMinor: 90_000, status: 'APPROVAL_PENDING' });
    expect(s.netMinor).toBe(await payable(owner.id));
    const items = await t.pool.query(`SELECT source_type, source_id FROM settlement_items WHERE settlement_id = $1`, [s.id]);
    expect(items.rows).toEqual([{ source_type: 'ORDER', source_id: o.orderId }]);
    // settled once
    expect((await generate('2000-01-03', day(1))).items.filter((x) => x.payeeId === owner.id)).toEqual([]);
  });

  it('a paid guide booking that ends CANCELLED (guide keeps the price) is settled; one under an open dispute is not', async () => {
    const guide = await createUser(t);
    const traveler = await createUser(t);
    const booking = async (status: string, hoursAgo: number) => {
      const b = await t.pool.query(
        `INSERT INTO guide_bookings(guide_id, traveler_id, guide_type, start_at, end_at, status, paid, price_minor)
         VALUES ($1,$2,'PAID', now() - make_interval(hours => $3 + 2), now() - make_interval(hours => $3), $4, true, 100000) RETURNING id`,
        [guide.id, traveler.id, hoursAgo, status],
      );
      const id = b.rows[0].id as string;
      const snapshot = { payerId: traveler.id, amountMinor: 100_000, currency: 'KRW', orderName: 'guide', split: [{ payeeId: guide.id, payeeType: 'GUIDE', grossMinor: 100_000, feeMinor: 10_000, taxMinor: 0 }], merchantOfRecord: 'JETPOOL' };
      const p = await t.pool.query(
        `INSERT INTO payments(provider, provider_order_id, payment_key, payer_id, subject_type, subject_id, status, amount_minor, currency, expires_at, payable_snapshot)
         VALUES ('MOCK', $1, $2, $3, 'GUIDE_BOOKING', $4, 'APPROVED', 100000, 'KRW', now(), $5) RETURNING id`,
        [`JPg${randomUUID().replace(/-/g, '').slice(0, 20)}`, `mock_g_${id}`, traveler.id, id, JSON.stringify(snapshot)],
      );
      await withTx(t.pool, (tx) => postPaymentApproval(tx, t.ctx(), { paymentId: p.rows[0].id, amountMinor: 100_000, currency: 'KRW', snapshot: snapshot as any }));
      return id;
    };
    const cancelled = await booking('CANCELLED', 5);
    const disputed = await booking('DISPUTED', 6);
    await t.pool.query(`INSERT INTO disputes(opened_by, context_type, context_id, counterparty_id, reason, status) VALUES ($1,'GUIDE_BOOKING',$2,$3,'no show','OPEN')`, [
      traveler.id,
      disputed,
      guide.id,
    ]);
    const gen = await generate('2000-01-04', day(1));
    const s = gen.items.find((x) => x.payeeId === guide.id);
    expect(s).toMatchObject({ payeeType: 'GUIDE', grossMinor: 100_000, feeMinor: 10_000, netMinor: 90_000 });
    const items = await t.pool.query(`SELECT source_id FROM settlement_items WHERE settlement_id = $1`, [s.id]);
    expect(items.rows.map((r) => r.source_id)).toEqual([cancelled]); // the disputed one waits for the dispute
  });
});

describe('FIN-02 / FIN-01 inputs and listings', () => {
  it('impossible settlement dates are 400 and a tampered cursor is ignored', async () => {
    const bad = await call(t, acctA, 'POST', '/v1/admin/settlements/generate', { periodStart: '2026-02-01', periodEnd: '2026-02-30' }, idem());
    expect(bad.status).toBe(400);
    const forged = Buffer.from(JSON.stringify(['2026-01-01T99:00:00Z', '00000000-0000-0000-0000-000000000000'])).toString('base64url');
    for (const url of ['/v1/admin/settlements', '/v1/admin/ledger/transactions', '/v1/provider/settlements', '/v1/receipts']) {
      expect((await call(t, acctA, 'GET', `${url}?cursor=${forged}`)).status, url).toBe(200);
    }
  });

  it('keyset pagination walks rows created in one transaction exactly once', async () => {
    const walk = async (u: TestUser, url: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const r: any = await call(t, u, 'GET', `${url}${url.includes('?') ? '&' : '?'}limit=1${cursor ? `&cursor=${cursor}` : ''}`);
        expect(r.status).toBe(200);
        seen.push(...r.body.items.map((x: any) => x.id));
        cursor = r.body.nextCursor;
        if (!cursor) break;
      }
      return seen;
    };
    // 3 PG settlements posted in one transaction (identical created_at)
    const ref = randomUUID().slice(0, 8);
    const tx = await withTx(t.pool, async (db) => {
      const out = [];
      for (let i = 0; i < 3; i++) out.push((await postPgSettlement(db, t.ctx(), { currency: 'USD', amountMinor: 100 + i, reference: `batch-${ref}-${i}` })).transactionId);
      return out;
    });
    const seenTx = await walk(acctA, '/v1/admin/ledger/transactions?type=PG_SETTLEMENT&sourceType=PG_SETTLEMENT');
    expect(seenTx.filter((id) => tx.includes(id)).sort()).toEqual([...tx].sort());

    // 3 settlements of one payee generated together (same created_at); and receipts issued in one transaction
    const payee = await createUser(t);
    const st = await t.pool.query(
      `INSERT INTO settlements(payee_id, payee_type, period_start, period_end, gross_minor, fee_minor, refund_minor, net_minor, currency, status)
       SELECT $1, 'HOST', ('2001-01-01'::date + g), ('2001-01-01'::date + g), 0, 0, 0, 0, 'KRW', 'DRAFT' FROM generate_series(1,3) g RETURNING id`,
      [payee.id],
    );
    const sIds = st.rows.map((r) => r.id).sort();
    expect((await walk(acctA, `/v1/admin/settlements?payeeId=${payee.id}`)).sort()).toEqual(sIds);
    expect((await walk(payee, '/v1/provider/settlements')).sort()).toEqual(sIds);
    const rc = await t.pool.query(
      `INSERT INTO receipts(user_id, receipt_type, amount_minor, currency) SELECT $1, 'SETTLEMENT_STATEMENT', 1, 'KRW' FROM generate_series(1,3) RETURNING id`,
      [payee.id],
    );
    expect((await walk(payee, '/v1/receipts')).sort()).toEqual(rc.rows.map((r) => r.id).sort());
  });
});
