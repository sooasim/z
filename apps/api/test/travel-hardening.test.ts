/**
 * QA hardening r1 — TRAVEL-01..04 regressions (money group):
 *  - supplier view of a multi-supplier order is scoped to the supplier's own lines / vouchers / terms;
 *  - edits to a reviewed product send it back to review;
 *  - option lines are refunded once, with their own departure (no over-refund);
 *  - a full refund that does not go through cancelOrder voids vouchers and frees seats;
 *  - cancellations cap the refund by in-flight refunds (no 422 for the whole departure);
 *  - impossible dates / times and tampered cursors are 400 / ignored, never 500;
 *  - keyset pagination does not skip rows created in the same transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, idem, enableFlags, type TestApp, type TestUser } from './helpers.js';
import { runDepartureLifecycle } from '../src/modules/travel/service.js';

let t: TestApp;
let admin: TestUser;
let editor: TestUser;
let accountant: TestUser;
let buyer: TestUser;
let supA: TestUser;
let supB: TestUser;
let supplierAId: string;
let supplierBId: string;

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const TIERS = [
  { min_hours_before: 72, refund_pct: 100 },
  { min_hours_before: 24, refund_pct: 50 },
  { min_hours_before: 0, refund_pct: 0 },
];

async function approvedSupplier(owner: TestUser, name: string) {
  const apply = await call(t, owner, 'POST', '/v1/suppliers', { name, supplierType: 'TOUR_OPERATOR' });
  expect(apply.status).toBe(201);
  const ok = await call(t, admin, 'POST', `/v1/admin/suppliers/${apply.body.item.id}/approve`, { merchantOfRecord: 'JETPOOL', commissionBps: 1500 });
  expect(ok.status).toBe(200);
  return apply.body.item.id as string;
}

async function publishedProduct(owner: TestUser, body: Record<string, unknown>) {
  const p = await call(t, owner, 'POST', '/v1/supplier/products', { type: 'TOUR', currency: 'KRW', ...body });
  expect(p.status).toBe(201);
  expect((await call(t, owner, 'POST', `/v1/supplier/products/${p.body.item.id}/submit`)).body.item.status).toBe('IN_REVIEW');
  const pub = await call(t, editor, 'POST', `/v1/admin/travel-products/${p.body.item.id}/publish`, {});
  expect(pub.status).toBe(200);
  return p.body.item as { id: string; options: Array<{ id: string; name: string; priceMinor: number }> };
}

async function departure(owner: TestUser, productId: string, startsInHours: number, capacity = 10) {
  const d = await call(t, owner, 'POST', `/v1/travel-products/${productId}/departures`, { startsAt: hoursFromNow(startsInHours), capacity });
  expect(d.status).toBe(201);
  return d.body.item.id as string;
}

async function payOrder(u: TestUser, orderId: string) {
  const prep = await call(t, u, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: orderId }, idem());
  expect(prep.status).toBe(201);
  const c = await call(t, u, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${orderId}`, orderId: prep.body.orderId, amount: prep.body.amount }, idem());
  expect(c.status).toBe(200);
  return c.body.item as { id: string; amountMinor: number };
}

async function order(u: TestUser, items: Array<{ departureId: string; qty: number; optionIds?: string[] }>) {
  const o = await call(t, u, 'POST', '/v1/orders', { items }, idem());
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  return o.body.item as { id: string; totalMinor: number; subtotalMinor: number };
}

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  editor = await createUser(t, { roles: ['EDITOR'] });
  accountant = await createUser(t, { roles: ['ACCOUNTING'] });
  buyer = await createUser(t);
  supA = await createUser(t);
  supB = await createUser(t);
  supplierAId = await approvedSupplier(supA, 'Alpha Tours');
  supplierBId = await approvedSupplier(supB, 'Bravo Cruises');
  await enableFlags(t, 'travel.commerce');
});
afterAll(async () => t.close());

describe('TRAVEL-04 supplier view of a multi-supplier order', () => {
  it('GET /v1/orders/:id shows a supplier only its own lines, vouchers, pricing entry and terms', async () => {
    const pa = await publishedProduct(supA, { title: 'A Palace Tour', basePriceMinor: 50_000, cancellationTerms: { tiers: TIERS, note: 'Alpha terms' } });
    const pb = await publishedProduct(supB, { title: 'B Secret Night Cruise', basePriceMinor: 77_777, cancellationTerms: { tiers: TIERS, note: 'Bravo terms' } });
    const a1 = await departure(supA, pa.id, 24 * 10);
    const b1 = await departure(supB, pb.id, 24 * 10);
    const b2 = await departure(supB, pb.id, 24 * 11);
    const o = await order(buyer, [{ departureId: a1, qty: 1 }, { departureId: b1, qty: 2 }, { departureId: b2, qty: 1 }]);
    await payOrder(buyer, o.id);
    await t.drain();

    const full = (await call(t, buyer, 'GET', `/v1/orders/${o.id}`)).body.item;
    expect(full.items).toHaveLength(3);
    const bCodes: string[] = full.items.filter((i: any) => i.supplierId === supplierBId).flatMap((i: any) => i.vouchers.map((v: any) => v.code));
    const aCodes: string[] = full.items.filter((i: any) => i.supplierId === supplierAId).flatMap((i: any) => i.vouchers.map((v: any) => v.code));
    expect(bCodes).toHaveLength(3);
    expect(aCodes).toHaveLength(1);

    const asA = await call(t, supA, 'GET', `/v1/orders/${o.id}`);
    expect(asA.status).toBe(200);
    const view = asA.body.item;
    expect(view.items.map((i: any) => [i.supplierId, i.title, i.qty])).toEqual([[supplierAId, 'A Palace Tour', 1]]);
    expect(view.items[0].vouchers.map((v: any) => v.code)).toEqual(aCodes); // its own vouchers only
    const text = JSON.stringify(view);
    for (const code of bCodes) expect(text).not.toContain(code);
    expect(text).not.toContain('B Secret Night Cruise');
    expect(text).not.toContain('77777');
    expect(text).not.toContain('Bravo terms');
    expect(view.pricing.suppliers).toEqual([expect.objectContaining({ supplierId: supplierAId })]);
    expect(Object.keys(view.pricing.cancellationTerms)).toEqual([pa.id]);

    // the supplier list view is scoped the same way
    const listed = (await call(t, supA, 'GET', '/v1/supplier/orders')).body.items.find((x: any) => x.id === o.id);
    expect(listed.items.every((i: any) => i.supplierId === supplierAId)).toBe(true);
    expect(Object.keys(listed.pricing.cancellationTerms)).toEqual([pa.id]);

    // B sees its two lines, not A's
    const asB = (await call(t, supB, 'GET', `/v1/orders/${o.id}`)).body.item;
    expect(asB.items.map((i: any) => i.supplierId)).toEqual([supplierBId, supplierBId]);
    expect(JSON.stringify(asB)).not.toContain(aCodes[0]);
    // strangers still get 404
    expect((await call(t, await createUser(t), 'GET', `/v1/orders/${o.id}`)).status).toBe(404);
  });
});

describe('TRAVEL-01 review workflow', () => {
  it('editing a PUBLISHED product sends it back to review; editing IN_REVIEW withdraws it to DRAFT', async () => {
    const p = await publishedProduct(supA, { title: 'Clean Listing', basePriceMinor: 50_000, options: [{ name: 'Lunch', priceMinor: 10_000 }] });
    const dep = await departure(supA, p.id, 24 * 10);
    expect((await call(t, null, 'GET', `/v1/travel-products/${p.id}`)).status).toBe(200);

    // a no-op save (same values) keeps it published
    const same = await call(t, supA, 'PATCH', `/v1/supplier/products/${p.id}`, { title: 'Clean Listing', basePriceMinor: 50_000 });
    expect(same.status).toBe(200);
    expect(same.body.item.status).toBe('PUBLISHED');

    const opt = p.options[0];
    const edit = await call(t, supA, 'PATCH', `/v1/supplier/products/${p.id}`, {
      title: 'Call +82-10-0000 to book off-platform',
      description: 'Pay via bank transfer at http://phish.example',
      basePriceMinor: 990_000,
      options: [{ id: opt.id, name: opt.name, priceMinor: 500_000 }],
    });
    expect(edit.status).toBe(200);
    expect(edit.body.item.status).toBe('IN_REVIEW');
    // unreviewed content is not public and cannot be sold
    expect((await call(t, null, 'GET', `/v1/travel-products/${p.id}`)).status).toBe(404);
    expect((await call(t, null, 'GET', '/v1/travel-products?q=off-platform')).body.items).toEqual([]);
    const blocked = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: dep, qty: 1 }] }, idem());
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PRODUCT_UNAVAILABLE');
    expect((await call(t, editor, 'GET', '/v1/admin/travel-products?status=IN_REVIEW')).body.items.map((x: any) => x.id)).toContain(p.id);

    // the editor rejects the edit (back to DRAFT); a fixed version is resubmitted and only then published
    expect((await call(t, editor, 'POST', `/v1/admin/travel-products/${p.id}/reject`, { reason: 'off-platform contact details', to: 'DRAFT' })).body.item.status).toBe('DRAFT');
    expect((await call(t, supA, 'PATCH', `/v1/supplier/products/${p.id}`, { title: 'Clean Listing v2', description: 'ok', basePriceMinor: 55_000 })).body.item.status).toBe('DRAFT');
    expect((await call(t, supA, 'POST', `/v1/supplier/products/${p.id}/submit`)).body.item.status).toBe('IN_REVIEW');

    // an edit between submit and the editor's click withdraws the submission: the stale review cannot publish it
    const sneaky = await call(t, supA, 'PATCH', `/v1/supplier/products/${p.id}`, { description: 'now with a phishing link http://phish.example' });
    expect(sneaky.body.item.status).toBe('DRAFT');
    const stale = await call(t, editor, 'POST', `/v1/admin/travel-products/${p.id}/publish`, {});
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('INVALID_STATE_TRANSITION');

    const transitions = await t.pool.query(`SELECT to_state, reason FROM state_transitions WHERE aggregate_type = 'travel_product' AND aggregate_id = $1 ORDER BY created_at, id`, [p.id]);
    expect(transitions.rows.map((r) => r.reason)).toEqual(expect.arrayContaining(['EDITED_AFTER_REVIEW', 'EDITED_DURING_REVIEW']));
  });
});

describe('TRAVEL-04 cancellation refund with options', () => {
  let productId: string;
  let optionId: string;
  beforeAll(async () => {
    const p = await publishedProduct(supA, { title: 'Options Tour', basePriceMinor: 100_000, cancellationTerms: { tiers: TIERS }, options: [{ name: 'Photo pack', priceMinor: 50_000 }] });
    productId = p.id;
    optionId = p.options[0].id;
  });

  it('two departures of the same product, each with the option, refund each option once (50 % tier)', async () => {
    const d1 = await departure(supA, productId, 48);
    const d2 = await departure(supA, productId, 50);
    const o = await order(buyer, [{ departureId: d1, qty: 1, optionIds: [optionId] }, { departureId: d2, qty: 1, optionIds: [optionId] }]);
    expect(o.subtotalMinor).toBe(300_000);
    await payOrder(buyer, o.id);
    const c = await call(t, buyer, 'POST', `/v1/orders/${o.id}/cancel`, { reason: 'sick' }, idem());
    expect(c.status).toBe(200);
    expect(c.body.refund.amountMinor).toBe(150_000); // 50 % of 300,000 — not 200,000
    const lines = await t.pool.query(`SELECT id, sellable_type, sellable_id, parent_item_id FROM order_items WHERE order_id = $1`, [o.id]);
    const deps = lines.rows.filter((l) => l.sellable_type === 'TRAVEL_DEPARTURE');
    const opts = lines.rows.filter((l) => l.sellable_type === 'TRAVEL_OPTION');
    expect(opts.map((x) => x.parent_item_id).sort()).toEqual(deps.map((x) => x.id).sort()); // each option → its own departure line
  });

  it('mixed tiers: an option booked on a 0 % departure is not refunded through a 100 % departure', async () => {
    const far = await departure(supA, productId, 240);
    const near = await departure(supA, productId, 10);
    const o = await order(buyer, [{ departureId: far, qty: 1 }, { departureId: near, qty: 1, optionIds: [optionId] }]);
    expect(o.subtotalMinor).toBe(250_000);
    await payOrder(buyer, o.id);
    const c = await call(t, buyer, 'POST', `/v1/orders/${o.id}/cancel`, { reason: 'plans changed' }, idem());
    expect(c.status).toBe(200);
    expect(c.body.refund.amountMinor).toBe(100_000); // far departure at 100 %; near departure + its option at 0 %
  });
});

describe('TRAVEL-04 full refunds outside cancelOrder', () => {
  it('a full staff refund of a PAID order voids vouchers, cancels lines and releases the seats', async () => {
    const p = await publishedProduct(supA, { title: 'Refund Tour', basePriceMinor: 50_000 });
    const dep = await departure(supA, p.id, 24 * 10, 2);
    const o = await order(buyer, [{ departureId: dep, qty: 2 }]);
    const pay = await payOrder(buyer, o.id);
    expect((await call(t, null, 'GET', `/v1/travel-products/${p.id}/departures`)).body.items[0].remaining).toBe(0);
    const r = await call(t, accountant, 'POST', `/v1/payments/${pay.id}/refunds`, { amountMinor: pay.amountMinor, reason: 'goodwill full refund' }, idem());
    expect(r.status).toBe(201);
    await t.drain();
    await t.runJobs();
    const after = (await call(t, buyer, 'GET', `/v1/orders/${o.id}`)).body.item;
    expect(after.status).toBe('REFUNDED');
    expect(after.items.every((i: any) => i.status === 'CANCELLED')).toBe(true);
    expect(after.items[0].vouchers.map((v: any) => v.status)).toEqual(['VOID', 'VOID']);
    expect((await t.pool.query(`SELECT booked FROM travel_departures WHERE id = $1`, [dep])).rows[0].booked).toBe(0);
    // the seats are on sale again
    await order(await createUser(t), [{ departureId: dep, qty: 2 }]);
  });

  it('a full refund of a FULFILLED order voids the vouchers that are still ISSUED', async () => {
    const p = await publishedProduct(supA, { title: 'Fulfilled Tour', basePriceMinor: 30_000 });
    const dep = await departure(supA, p.id, 24 * 10, 3);
    const o = await order(buyer, [{ departureId: dep, qty: 1 }]);
    const pay = await payOrder(buyer, o.id);
    await t.pool.query(`UPDATE travel_departures SET starts_at = now() - interval '1 hour' WHERE id = $1`, [dep]);
    await runDepartureLifecycle(t.app.ctx, t.ctx());
    expect((await call(t, buyer, 'GET', `/v1/orders/${o.id}`)).body.item.status).toBe('FULFILLED');
    expect((await call(t, accountant, 'POST', `/v1/payments/${pay.id}/refunds`, { amountMinor: pay.amountMinor, reason: 'tour cancelled on site' }, idem())).status).toBe(201);
    await t.drain();
    const after = (await call(t, buyer, 'GET', `/v1/orders/${o.id}`)).body.item;
    expect(after.status).toBe('REFUNDED');
    expect(after.items[0].vouchers.map((v: any) => v.status)).toEqual(['VOID']);
  });
});

describe('TRAVEL-02/04 cancellation with a refund in flight', () => {
  it('a pending (failing) refund on one order does not make the departure cancellation or a buyer cancel fail', async () => {
    const p = await publishedProduct(supA, { title: 'Weather Tour', basePriceMinor: 40_000 });
    const dep = await departure(supA, p.id, 24 * 20, 10);
    const oa = await order(buyer, [{ departureId: dep, qty: 1 }]);
    const pa = await payOrder(buyer, oa.id);
    const ob = await order(buyer, [{ departureId: dep, qty: 1 }]);
    await payOrder(buyer, ob.id);
    const goodwill = await call(t, accountant, 'POST', `/v1/payments/${pa.id}/refunds`, { amountMinor: 5_000, reason: 'MOCK_FAIL goodwill' }, idem());
    expect(goodwill.status).toBe(201);
    await t.drain();
    expect((await t.pool.query(`SELECT status FROM refunds WHERE id = $1`, [goodwill.body.item.id])).rows[0].status).toBe('FAILED');

    const cx = await call(t, supA, 'POST', `/v1/supplier/departures/${dep}/cancel`, { reason: 'weather storm' });
    expect(cx.status, JSON.stringify(cx.body)).toBe(200);
    expect(cx.body.cancelledOrders).toBe(2);
    expect(cx.body.item.status).toBe('CANCELLED');
    const refunds = await t.pool.query(
      `SELECT p.subject_id, r.amount_minor, r.reason FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.subject_id = ANY($1::uuid[]) AND r.reason LIKE 'ORDER_CANCELLED%'`,
      [[oa.id, ob.id]],
    );
    const by = Object.fromEntries(refunds.rows.map((r) => [r.subject_id, r.amount_minor]));
    expect(by[oa.id]).toBe(35_000); // total − the 5,000 already promised
    expect(by[ob.id]).toBe(40_000);
    for (const id of [oa.id, ob.id]) expect((await call(t, buyer, 'GET', `/v1/orders/${id}`)).body.item.status).toBe('CANCELLED');

    // a buyer cancel of an order with a pending refund works the same way
    const dep2 = await departure(supA, p.id, 24 * 20, 10);
    const oc = await order(buyer, [{ departureId: dep2, qty: 1 }]);
    const pc = await payOrder(buyer, oc.id);
    await call(t, accountant, 'POST', `/v1/payments/${pc.id}/refunds`, { amountMinor: 5_000, reason: 'MOCK_FAIL goodwill' }, idem());
    await t.drain();
    const bc = await call(t, buyer, 'POST', `/v1/orders/${oc.id}/cancel`, { reason: 'changed plans' }, idem());
    expect(bc.status, JSON.stringify(bc.body)).toBe(200);
    expect(bc.body.refund.amountMinor).toBe(35_000);
  });
});

describe('input validation never reaches PostgreSQL as an impossible value', () => {
  it('impossible dates / times are 400, a tampered cursor is ignored', async () => {
    for (const qs of ['from=2026-02-30', 'to=2026-13-01', 'from=0000-01-01']) {
      const r = await call(t, null, 'GET', `/v1/travel-products?${qs}`);
      expect(r.status, qs).toBe(400);
    }
    expect((await call(t, null, 'GET', '/v1/travel-products?from=2026-03-01')).status).toBe(200);
    const anyProduct = (await t.pool.query(`SELECT id FROM travel_products WHERE status = 'PUBLISHED' LIMIT 1`)).rows[0].id;
    expect((await call(t, null, 'GET', `/v1/travel-products/${anyProduct}/departures?from=2026-02-30`)).status).toBe(400);

    expect((await call(t, buyer, 'POST', '/v1/itineraries', { title: 'x', startDate: '2026-13-01' })).status).toBe(400);
    const it0 = await call(t, buyer, 'POST', '/v1/itineraries', { title: 'Trip' });
    expect(it0.status).toBe(201);
    expect((await call(t, buyer, 'PATCH', `/v1/itineraries/${it0.body.item.id}`, { endDate: '2026-02-30' })).status).toBe(400);
    for (const [k, v] of [['startTime', '25:00'], ['endTime', '99:99'], ['startTime', '12:60']]) {
      const r = await call(t, buyer, 'POST', `/v1/itineraries/${it0.body.item.id}/items`, { dayIndex: 0, itemType: 'NOTE', title: 'n', [k]: v });
      expect(r.status, `${k}=${v}`).toBe(400);
    }
    expect((await call(t, buyer, 'POST', `/v1/itineraries/${it0.body.item.id}/items`, { dayIndex: 0, itemType: 'NOTE', title: 'n', startTime: '23:59', endTime: '00:00:00' })).status).toBe(201);

    const forged = Buffer.from(JSON.stringify(['2026-02-30T00:00:00Z', '00000000-0000-0000-0000-000000000000'])).toString('base64url');
    expect((await call(t, null, 'GET', `/v1/travel-products?cursor=${forged}`)).status).toBe(200);
    expect((await call(t, buyer, 'GET', `/v1/orders?cursor=${forged}`)).status).toBe(200);
  });
});

describe('keyset pagination with rows created in one transaction', () => {
  it('walks every product, buyer order and supplier order exactly once', async () => {
    const walk = async (user: TestUser | null, url: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const r: any = await call(t, user, 'GET', `${url}${url.includes('?') ? '&' : '?'}limit=1${cursor ? `&cursor=${cursor}` : ''}`);
        expect(r.status).toBe(200);
        seen.push(...r.body.items.map((x: any) => x.id));
        cursor = r.body.nextCursor;
        if (!cursor) break;
      }
      return seen;
    };
    // three products / orders inserted by one statement share created_at to the microsecond
    const prods = await t.pool.query(
      `INSERT INTO travel_products(supplier_id, type, title, base_price_minor, status)
       SELECT $1, 'TOUR', 'Batch zqx ' || g, 1000, 'PUBLISHED' FROM generate_series(1,3) g RETURNING id`,
      [supplierBId],
    );
    expect((await walk(null, '/v1/travel-products?q=zqx')).sort()).toEqual(prods.rows.map((r) => r.id).sort());

    const shopper = await createUser(t);
    const orders = await t.pool.query(
      `INSERT INTO orders(buyer_id, status, currency, subtotal_minor, total_minor, merchant_of_record)
       SELECT $1, 'PENDING', 'KRW', 1000, 1000, 'JETPOOL' FROM generate_series(1,3) RETURNING id`,
      [shopper.id],
    );
    await t.pool.query(
      `INSERT INTO order_items(order_id, sellable_type, sellable_id, supplier_id, title, qty, unit_price_minor, amount_minor)
       SELECT o, 'TRAVEL_DEPARTURE', gen_random_uuid(), $2, 'x', 1, 1000, 1000 FROM unnest($1::uuid[]) o`,
      [orders.rows.map((r) => r.id), supplierBId],
    );
    const ids = orders.rows.map((r) => r.id).sort();
    expect((await walk(shopper, '/v1/orders')).sort()).toEqual(ids);
    expect((await walk(supB, '/v1/supplier/orders?status=PENDING')).sort()).toEqual(ids);
  });
});
