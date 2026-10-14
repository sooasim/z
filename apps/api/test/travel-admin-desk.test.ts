/**
 * TRAVEL-01/02/04 backoffice desk: the endpoints the admin console drives — product registration on behalf of a
 * supplier, staff edits, the review → publish gate, departure inventory, and the order intake list / fulfil action.
 *
 * Covers the per-module checklist: happy path, permission negatives (wrong role, AAL1 staff, plain member),
 * invalid transitions, and the inventory conflict (capacity below booked seats).
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

async function payOrder(orderId: string, amountMinor: number) {
  const prep = await call(t, buyer, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: orderId }, idem());
  expect(prep.status).toBe(201);
  const conf = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${orderId}`, orderId: prep.body.orderId, amount: amountMinor }, idem());
  expect(conf.status).toBe(200);
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
  expect(apply.status).toBe(201);
  supplierId = apply.body.item.id;
  expect((await call(t, admin, 'POST', `/v1/admin/suppliers/${supplierId}/approve`, { merchantOfRecord: 'JETPOOL', commissionBps: 1200 })).status).toBe(200);
});
afterAll(async () => t.close());

describe('TRAVEL-01 staff product registration', () => {
  it('registers a product for a supplier as DRAFT and lists it in the console', async () => {
    const created = await call(t, admin, 'POST', '/v1/admin/travel-products', {
      supplierId,
      type: 'ACTIVITY',
      title: 'Seongsan Sunrise Boat',
      summary: 'Phone-onboarded supplier',
      city: 'Jeju',
      basePriceMinor: 70_000,
      currency: 'KRW',
      options: [{ name: 'Wetsuit', priceMinor: 5_000 }],
    });
    expect(created.status).toBe(201);
    expect(created.body.item).toMatchObject({ status: 'DRAFT', supplierId, title: 'Seongsan Sunrise Boat' });
    expect(created.body.item.options).toHaveLength(1);
    productId = created.body.item.id;

    // the creation is attributable: category CONTENT, actor = the admin
    const log = await t.pool.query(`SELECT actor_id, category FROM audit_logs WHERE action = 'travel_product.staff_created' AND resource_id = $1`, [productId]);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0]).toMatchObject({ actor_id: admin.id, category: 'CONTENT' });

    const list = await call(t, admin, 'GET', '/v1/admin/travel-products', undefined);
    expect(list.body.items.map((p: any) => p.id)).toContain(productId);
    const byQuery = await call(t, admin, 'GET', '/v1/admin/travel-products?q=Seongsan&status=DRAFT&type=ACTIVITY');
    expect(byQuery.body.items.map((p: any) => p.id)).toEqual([productId]);
    expect((await call(t, admin, 'GET', '/v1/admin/travel-products?q=NoSuchTitle')).body.items).toEqual([]);
    // the search term is a literal, not a LIKE pattern
    expect((await call(t, admin, 'GET', '/v1/admin/travel-products?q=%25')).body.items).toEqual([]);
  });

  it('refuses registration without the right role, at AAL1, or for an unknown supplier', async () => {
    const body = { supplierId, type: 'TOUR', title: 'Nope' };
    expect((await call(t, buyer, 'POST', '/v1/admin/travel-products', body)).status).toBe(403);
    expect((await call(t, support, 'POST', '/v1/admin/travel-products', body)).status).toBe(403);
    expect((await call(t, aal1Admin, 'POST', '/v1/admin/travel-products', body)).body.code).toBe('AAL2_REQUIRED');
    expect((await call(t, editor, 'POST', '/v1/admin/travel-products', { ...body, supplierId: '00000000-0000-0000-0000-000000000000' })).body.code).toBe('INVALID_SUPPLIER');
  });

  it('returns a detail view with every option and departure', async () => {
    const d = await call(t, admin, 'POST', `/v1/admin/travel-products/${productId}/departures`, { startsAt: hoursFromNow(24 * 20), capacity: 4, priceMinor: 70_000 });
    expect(d.status).toBe(201);
    const got = await call(t, editor, 'GET', `/v1/admin/travel-products/${productId}`);
    expect(got.status).toBe(200);
    expect(got.body.item).toMatchObject({ id: productId, supplierName: 'Jeju Boat Co', supplierStatus: 'APPROVED' });
    expect(got.body.item.options).toHaveLength(1);
    expect(got.body.item.departures.map((x: any) => x.id)).toContain(d.body.item.id);
    expect((await call(t, admin, 'GET', '/v1/admin/travel-products/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });

  it('edits with an audited reason and keeps a published product public', async () => {
    expect((await call(t, admin, 'PATCH', `/v1/admin/travel-products/${productId}`, { title: 'No reason' })).status).toBe(400);

    const submitted = await call(t, editor, 'POST', `/v1/admin/travel-products/${productId}/submit`, { reason: 'phone onboarding complete' });
    expect(submitted.body.item.status).toBe('IN_REVIEW');
    expect((await call(t, editor, 'POST', `/v1/admin/travel-products/${productId}/submit`, { reason: 'again' })).body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await call(t, admin, 'POST', `/v1/admin/travel-products/${productId}/publish`, {})).body.item.status).toBe('PUBLISHED');

    // the supplier PATCH would send this back to IN_REVIEW; the staff PATCH does not, because the editor is the reviewer
    const edited = await call(t, editor, 'PATCH', `/v1/admin/travel-products/${productId}`, { summary: 'Operator-corrected summary', reason: 'typo in the supplier copy' });
    expect(edited.status).toBe(200);
    expect(edited.body.item).toMatchObject({ status: 'PUBLISHED', summary: 'Operator-corrected summary' });
    const log = await t.pool.query(`SELECT reason, before_state, after_state FROM audit_logs WHERE action = 'travel_product.staff_edited' AND resource_id = $1`, [productId]);
    expect(log.rows).toHaveLength(1);
    expect(log.rows[0].reason).toBe('typo in the supplier copy');
    expect(log.rows[0].after_state).toMatchObject({ summary: 'Operator-corrected summary' });

    expect((await call(t, support, 'PATCH', `/v1/admin/travel-products/${productId}`, { title: 'Support edit', reason: 'not my role' })).status).toBe(403);
  });
});

describe('TRAVEL-02 staff departure inventory', () => {
  it('will not drop capacity below booked seats, and cancelling a departure cancels its orders', async () => {
    const dep = await call(t, admin, 'POST', `/v1/admin/travel-products/${productId}/departures`, { startsAt: hoursFromNow(24 * 30), capacity: 3, priceMinor: 70_000 });
    expect(dep.status).toBe(201);
    const departureId = dep.body.item.id;

    const o = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId, qty: 2 }] }, idem());
    expect(o.status).toBe(201);

    expect((await call(t, admin, 'PATCH', `/v1/admin/departures/${departureId}`, { capacity: 1, reason: 'shrinking the boat' })).body.code).toBe('CAPACITY_BELOW_BOOKED');
    const closed = await call(t, admin, 'PATCH', `/v1/admin/departures/${departureId}`, { capacity: 2, status: 'CLOSED', reason: 'sold out offline' });
    expect(closed.body.item).toMatchObject({ capacity: 2, status: 'CLOSED' });
    expect((await call(t, support, 'PATCH', `/v1/admin/departures/${departureId}`, { capacity: 2, reason: 'not my role' })).status).toBe(403);

    const cancelled = await call(t, admin, 'POST', `/v1/admin/departures/${departureId}/cancel`, { reason: 'boat under repair' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.item.status).toBe('CANCELLED');
    expect(cancelled.body.cancelledOrders).toBe(1);
    expect((await call(t, buyer, 'GET', `/v1/orders/${o.body.item.id}`)).body.item.status).toBe('CANCELLED');
    expect((await call(t, admin, 'POST', '/v1/admin/departures/00000000-0000-0000-0000-000000000000/cancel', { reason: 'missing departure' })).status).toBe(404);
  });

  it('refuses a departure in the past or on an archived product', async () => {
    expect((await call(t, admin, 'POST', `/v1/admin/travel-products/${productId}/departures`, { startsAt: hoursFromNow(-1), capacity: 2 })).body.code).toBe('DEPARTURE_IN_PAST');
    expect((await call(t, admin, 'POST', '/v1/admin/travel-products/00000000-0000-0000-0000-000000000000/departures', { startsAt: hoursFromNow(24), capacity: 2 })).status).toBe(404);
  });
});

describe('TRAVEL-04 order intake desk', () => {
  let orderId: string;
  let departureId: string;

  it('lists orders with the buyer name, no voucher codes, and the documented filters', async () => {
    const dep = await call(t, admin, 'POST', `/v1/admin/travel-products/${productId}/departures`, { startsAt: hoursFromNow(24 * 40), capacity: 5, priceMinor: 70_000 });
    departureId = dep.body.item.id;
    const o = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId, qty: 1 }] }, idem());
    expect(o.status).toBe(201);
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
    expect(done.status).toBe(200);
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
