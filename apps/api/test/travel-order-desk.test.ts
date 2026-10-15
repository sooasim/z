/**
 * TRAVEL-04 backoffice order desk: the two endpoints the operator order console drives — the intake list and
 * the "mark delivered" action — plus the console filters on the TRAVEL-01 product list.
 *
 * The product and its departure are created the way the shipped consoles do it, through the supplier extranet
 * (`/v1/supplier/products`, `/v1/travel-products/:id/departures`), so this test exercises the same endpoints a
 * real operator reaches rather than a parallel admin-only path.
 *
 * Covers the per-module checklist: happy path, permission negatives (wrong role, AAL1 staff, plain member),
 * invalid transitions (unpaid and already-delivered orders), and the documented filters/pagination.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, idem, enableFlags, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
let admin: TestUser;
let editor: TestUser;
let support: TestUser;
let aal1Admin: TestUser;
let supplierUser: TestUser;
let buyer: TestUser;
let supplierId: string;
let productId: string;

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
const show = (r: any) => JSON.stringify(r.body).slice(0, 400);

async function payOrder(orderId: string, amountMinor: number) {
  const prep = await call(t, buyer, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: orderId }, idem());
  expect(prep.status, show(prep)).toBe(201);
  const conf = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${orderId}`, orderId: prep.body.orderId, amount: amountMinor }, idem());
  expect(conf.status, show(conf)).toBe(200);
}

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  editor = await createUser(t, { roles: ['EDITOR'] });
  support = await createUser(t, { roles: ['SUPPORT'] });
  aal1Admin = await createUser(t, { roles: ['ADMIN'], aal: 'aal1' });
  supplierUser = await createUser(t, { displayName: 'Jeju Boat Co' });
  buyer = await createUser(t, { displayName: 'Buyer Kim' });
  await enableFlags(t, 'travel.commerce');

  const apply = await call(t, supplierUser, 'POST', '/v1/suppliers', { name: 'Jeju Boat Co', supplierType: 'ACTIVITY' });
  expect(apply.status, show(apply)).toBe(201);
  supplierId = apply.body.item.id;
  expect((await call(t, admin, 'POST', `/v1/admin/suppliers/${supplierId}/approve`, { merchantOfRecord: 'JETPOOL', commissionBps: 1200 })).status).toBe(200);

  const created = await call(t, supplierUser, 'POST', '/v1/supplier/products', {
    type: 'ACTIVITY',
    title: 'Seongsan Sunrise Boat',
    summary: 'Sunrise boat ride off Seongsan',
    city: 'Jeju',
    country: 'KR',
    basePriceMinor: 70_000,
    currency: 'KRW',
    options: [{ name: 'Wetsuit', priceMinor: 5_000 }],
  });
  expect(created.status, show(created)).toBe(201);
  productId = created.body.item.id;
  // a departure first: publishing refuses a product nobody could book
  expect((await call(t, supplierUser, 'POST', `/v1/travel-products/${productId}/departures`, { startsAt: hoursFromNow(24 * 40), capacity: 5, priceMinor: 70_000 })).status).toBe(201);
  expect((await call(t, supplierUser, 'POST', `/v1/supplier/products/${productId}/submit`)).status).toBe(200);
  expect((await call(t, admin, 'POST', `/v1/admin/travel-products/${productId}/publish`, {})).status).toBe(200);
});
afterAll(async () => t.close());

describe('TRAVEL-01 product console filters', () => {
  it('narrows the list by status, type and search term, and counts open departures', async () => {
    const all = await call(t, admin, 'GET', '/v1/admin/travel-products');
    expect(all.status).toBe(200);
    const row = all.body.items.find((p: any) => p.id === productId);
    expect(row).toBeTruthy();
    // what tells an operator a published product is actually sellable
    expect(row.openDepartures).toBe(1);

    const byQuery = await call(t, admin, 'GET', '/v1/admin/travel-products?q=Seongsan&status=PUBLISHED&type=ACTIVITY');
    expect(byQuery.body.items.map((p: any) => p.id)).toEqual([productId]);
    expect((await call(t, admin, 'GET', `/v1/admin/travel-products?supplierId=${supplierId}`)).body.items.map((p: any) => p.id)).toEqual([productId]);
    expect((await call(t, admin, 'GET', '/v1/admin/travel-products?q=NoSuchTitle')).body.items).toEqual([]);
    expect((await call(t, admin, 'GET', '/v1/admin/travel-products?type=PACKAGE')).body.items.map((p: any) => p.id)).not.toContain(productId);
    // the search term is a literal, not a LIKE pattern
    expect((await call(t, admin, 'GET', '/v1/admin/travel-products?q=%25')).body.items).toEqual([]);
  });

  it('is staff-only', async () => {
    expect((await call(t, buyer, 'GET', '/v1/admin/travel-products')).status).toBe(403);
    expect((await call(t, editor, 'GET', '/v1/admin/travel-products')).status).toBe(200);
  });
});

describe('TRAVEL-04 order intake desk', () => {
  let orderId: string;
  let departureId: string;

  it('lists orders with the buyer name, no voucher codes, and the documented filters', async () => {
    const deps = await call(t, null, 'GET', `/v1/travel-products/${productId}/departures`);
    expect(deps.status).toBe(200);
    departureId = deps.body.items[0].id;

    const o = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId, qty: 1 }] }, idem());
    expect(o.status, show(o)).toBe(201);
    orderId = o.body.item.id;
    await payOrder(orderId, o.body.item.totalMinor);

    const list = await call(t, admin, 'GET', '/v1/admin/orders');
    expect(list.status).toBe(200);
    const row = list.body.items.find((x: any) => x.id === orderId);
    expect(row).toMatchObject({ status: 'PAID', buyerId: buyer.id, buyerName: 'Buyer Kim' });
    expect(row.items).toHaveLength(1);
    // a bearer voucher code is never in a list response — it is read one order at a time
    expect(JSON.stringify(list.body)).not.toMatch(/"vouchers":\[\{/);
    // CART drafts are not intake
    expect(list.body.items.every((x: any) => x.status !== 'CART')).toBe(true);

    expect((await call(t, admin, 'GET', `/v1/admin/orders?status=PAID&supplierId=${supplierId}`)).body.items.map((x: any) => x.id)).toContain(orderId);
    expect((await call(t, admin, 'GET', `/v1/admin/orders?code=${row.code}`)).body.items.map((x: any) => x.id)).toEqual([orderId]);
    expect((await call(t, admin, 'GET', '/v1/admin/orders?status=REFUNDED')).body.items).toEqual([]);
    expect((await call(t, admin, 'GET', `/v1/admin/orders?buyerId=${admin.id}`)).body.items).toEqual([]);
    expect((await call(t, admin, 'GET', '/v1/admin/orders?from=2026-03-02&to=2026-03-01')).body.code).toBe('INVALID_RANGE');

    // pagination is keyset, not offset
    const firstPage = await call(t, admin, 'GET', '/v1/admin/orders?limit=1');
    expect(firstPage.body.items).toHaveLength(1);
    if (firstPage.body.nextCursor) {
      const second = await call(t, admin, 'GET', `/v1/admin/orders?limit=1&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`);
      expect(second.body.items[0]?.id).not.toBe(firstPage.body.items[0].id);
    }
  });

  it('only staff see the desk', async () => {
    expect((await call(t, buyer, 'GET', '/v1/admin/orders')).status).toBe(403);
    expect((await call(t, supplierUser, 'GET', '/v1/admin/orders')).status).toBe(403);
    expect((await call(t, aal1Admin, 'GET', '/v1/admin/orders')).body.code).toBe('AAL2_REQUIRED');
    expect((await call(t, support, 'GET', '/v1/admin/orders')).status).toBe(200);
  });

  it('marks a paid order fulfilled once, with an audited reason', async () => {
    expect((await call(t, admin, 'POST', `/v1/admin/orders/${orderId}/fulfill`, {})).status).toBe(400);
    const done = await call(t, support, 'POST', `/v1/admin/orders/${orderId}/fulfill`, { reason: 'supplier confirmed by phone' });
    expect(done.status, show(done)).toBe(200);
    expect(done.body.item.status).toBe('FULFILLED');
    expect(done.body.item.fulfilledAt).toBeTruthy();

    const log = await t.pool.query(`SELECT actor_id, category, reason FROM audit_logs WHERE action = 'order.fulfill.staff' AND resource_id = $1`, [orderId]);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]).toMatchObject({ actor_id: support.id, category: 'MONEY', reason: 'supplier confirmed by phone' });

    // a FULFILLED order cannot be fulfilled again, and an unpaid one never can
    expect((await call(t, admin, 'POST', `/v1/admin/orders/${orderId}/fulfill`, { reason: 'double submit' })).body.code).toBe('INVALID_STATE_TRANSITION');
    const unpaid = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId, qty: 1 }] }, idem());
    expect((await call(t, admin, 'POST', `/v1/admin/orders/${unpaid.body.item.id}/fulfill`, { reason: 'not paid yet' })).body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await call(t, admin, 'POST', '/v1/admin/orders/00000000-0000-0000-0000-000000000000/fulfill', { reason: 'missing order' })).status).toBe(404);
    expect((await call(t, buyer, 'POST', `/v1/admin/orders/${orderId}/fulfill`, { reason: 'not my order to fulfil' })).status).toBe(403);
  });
});
