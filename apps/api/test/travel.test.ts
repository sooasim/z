import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, idem, enableFlags, type TestApp, type TestUser } from './helpers.js';
import { expireOrders, runDepartureLifecycle } from '../src/modules/travel/service.js';

let t: TestApp;
let admin: TestUser;
let supplierUser: TestUser;
let buyer: TestUser;
let productId: string;

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

async function newDeparture(capacity: number, opts: { minParticipants?: number; priceMinor?: number; startsInHours?: number; cutoffInHours?: number } = {}) {
  const res = await call(t, supplierUser, 'POST', `/v1/travel-products/${productId}/departures`, {
    startsAt: hoursFromNow(opts.startsInHours ?? 24 * 10),
    capacity,
    minParticipants: opts.minParticipants ?? 1,
    priceMinor: opts.priceMinor,
    cutoffAt: opts.cutoffInHours !== undefined ? hoursFromNow(opts.cutoffInHours) : undefined,
  });
  expect(res.status).toBe(201);
  return res.body.item.id as string;
}

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  supplierUser = await createUser(t);
  buyer = await createUser(t);
});
afterAll(async () => t.close());

describe('TRAVEL-01 supplier & catalog', () => {
  it('supplier applies, admin approves (role granted), product is reviewed and published with seller info', async () => {
    const apply = await call(t, supplierUser, 'POST', '/v1/suppliers', { name: 'Seoul Tours', supplierType: 'TOUR_OPERATOR' });
    expect(apply.status).toBe(201);
    expect(apply.body.item.status).toBe('PENDING');
    expect((await call(t, supplierUser, 'POST', '/v1/suppliers', { name: 'Again', supplierType: 'TICKET' })).status).toBe(409);

    // non-admin / AAL1 admin cannot approve
    expect((await call(t, buyer, 'POST', `/v1/admin/suppliers/${apply.body.item.id}/approve`, { merchantOfRecord: 'JETPOOL', commissionBps: 1500 })).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['ADMIN'], aal: 'aal1' });
    expect((await call(t, aal1, 'POST', `/v1/admin/suppliers/${apply.body.item.id}/approve`, { merchantOfRecord: 'JETPOOL', commissionBps: 1500 })).body.code).toBe('AAL2_REQUIRED');

    const ok = await call(t, admin, 'POST', `/v1/admin/suppliers/${apply.body.item.id}/approve`, { merchantOfRecord: 'JETPOOL', commissionBps: 1500 });
    expect(ok.status).toBe(200);
    expect(ok.body.item.status).toBe('APPROVED');
    const roles = await t.pool.query(`SELECT role FROM user_roles WHERE user_id = $1`, [supplierUser.id]);
    expect(roles.rows.map((r) => r.role)).toContain('SUPPLIER');

    const created = await call(t, supplierUser, 'POST', '/v1/supplier/products', {
      type: 'TOUR',
      title: 'Bukchon Night Walk',
      city: 'Seoul',
      basePriceMinor: 50_000,
      currency: 'KRW',
      cancellationTerms: { tiers: [{ min_hours_before: 72, refund_pct: 100 }, { min_hours_before: 24, refund_pct: 50 }, { min_hours_before: 0, refund_pct: 0 }] },
      options: [{ name: 'Hanbok rental', priceMinor: 10_000 }],
    });
    expect(created.status).toBe(201);
    productId = created.body.item.id;
    expect(created.body.item.options).toHaveLength(1);

    // not public while DRAFT
    expect((await call(t, null, 'GET', `/v1/travel-products/${productId}`)).status).toBe(404);
    // publish requires review state
    expect((await call(t, admin, 'POST', `/v1/admin/travel-products/${productId}/publish`, {})).body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await call(t, supplierUser, 'POST', `/v1/supplier/products/${productId}/submit`)).body.item.status).toBe('IN_REVIEW');
    const pub = await call(t, admin, 'POST', `/v1/admin/travel-products/${productId}/publish`, {});
    expect(pub.status).toBe(200);
    expect(pub.body.item.status).toBe('PUBLISHED');

    const list = await call(t, null, 'GET', '/v1/travel-products?city=Seoul&type=TOUR');
    expect(list.status).toBe(200);
    const found = list.body.items.find((p: any) => p.id === productId);
    expect(found.seller).toMatchObject({ name: 'Seoul Tours', merchantOfRecord: 'JETPOOL' });

    // another user cannot edit the product
    const other = await createUser(t, { roles: ['SUPPLIER'] });
    expect((await call(t, other, 'PATCH', `/v1/supplier/products/${productId}`, { title: 'Hacked' })).status).toBe(403);
  });

  it('departures: supplier creates, public lists, non-owner cannot create', async () => {
    const id = await newDeparture(10, { minParticipants: 2 });
    const pub = await call(t, null, 'GET', `/v1/travel-products/${productId}/departures`);
    expect(pub.body.items.find((d: any) => d.id === id)).toMatchObject({ capacity: 10, remaining: 10, minParticipants: 2, status: 'OPEN' });
    expect((await call(t, buyer, 'POST', `/v1/travel-products/${productId}/departures`, { startsAt: hoursFromNow(48), capacity: 3 })).status).toBe(403);
  });
});

describe('TRAVEL-04 orders', () => {
  it('is gated by travel.commerce flag', async () => {
    const dep = await newDeparture(3);
    const res = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: dep, qty: 1 }] }, idem());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FEATURE_DISABLED');
    await enableFlags(t, 'travel.commerce');
  });

  it('requires Idempotency-Key and computes the total server-side; replay returns the same order', async () => {
    const dep = await newDeparture(5);
    expect((await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: dep, qty: 1 }] })).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const opt = (await call(t, null, 'GET', `/v1/travel-products/${productId}`)).body.item.options[0].id;
    const h = idem();
    const a = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: dep, qty: 2, optionIds: [opt] }], totalMinor: 1 } as any, h);
    expect(a.status).toBe(201);
    expect(a.body.item.subtotalMinor).toBe(2 * 60_000);
    expect(a.body.item.totalMinor).toBe(120_000); // no approved fee rule → no fee
    expect(a.body.item.status).toBe('PENDING');
    const b = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: dep, qty: 2, optionIds: [opt] }], totalMinor: 1 } as any, h);
    expect(b.body.item.id).toBe(a.body.item.id);
    expect(b.headers['idempotent-replayed']).toBe('true');
    const d = await t.pool.query(`SELECT booked FROM travel_departures WHERE id = $1`, [dep]);
    expect(d.rows[0].booked).toBe(2);
    // other users cannot read it
    const stranger = await createUser(t);
    expect((await call(t, stranger, 'GET', `/v1/orders/${a.body.item.id}`)).status).toBe(404);
    expect((await call(t, supplierUser, 'GET', `/v1/orders/${a.body.item.id}`)).status).toBe(200);
  });

  it('never overbooks: capacity 5, 10 parallel orders of 1 → exactly 5 succeed', async () => {
    const dep = await newDeparture(5);
    const buyers = await Promise.all(Array.from({ length: 10 }, () => createUser(t)));
    const results = await Promise.all(buyers.map((u) => call(t, u, 'POST', '/v1/orders', { items: [{ departureId: dep, qty: 1 }] }, idem())));
    expect(results.filter((r) => r.status === 201)).toHaveLength(5);
    const failed = results.filter((r) => r.status !== 201);
    expect(failed).toHaveLength(5);
    expect(failed.every((r) => r.body.code === 'SOLD_OUT')).toBe(true);
    const d = await t.pool.query(`SELECT booked, capacity FROM travel_departures WHERE id = $1`, [dep]);
    expect(d.rows[0]).toEqual({ booked: 5, capacity: 5 });
  });

  it('expiry job releases capacity of unpaid orders', async () => {
    const dep = await newDeparture(2);
    const o = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: dep, qty: 2 }] }, idem());
    expect(o.status).toBe(201);
    expect((await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: dep, qty: 1 }] }, idem())).body.code).toBe('SOLD_OUT');
    await t.pool.query(`UPDATE orders SET expires_at = now() - interval '1 minute' WHERE id = $1`, [o.body.item.id]);
    expect(await expireOrders(t.app.ctx, t.ctx())).toBeGreaterThanOrEqual(1);
    const after = await call(t, buyer, 'GET', `/v1/orders/${o.body.item.id}`);
    expect(after.body.item.status).toBe('EXPIRED');
    const d = await t.pool.query(`SELECT booked FROM travel_departures WHERE id = $1`, [dep]);
    expect(d.rows[0].booked).toBe(0);
    expect((await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: dep, qty: 1 }] }, idem())).status).toBe(201);
  });

  it('buyer cancels an unpaid order → capacity released; cancelling again is an invalid transition', async () => {
    const dep = await newDeparture(4);
    const o = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: dep, qty: 3 }] }, idem());
    const stranger = await createUser(t);
    expect((await call(t, stranger, 'POST', `/v1/orders/${o.body.item.id}/cancel`, { reason: 'x1' }, idem())).status).toBe(404);
    const c = await call(t, buyer, 'POST', `/v1/orders/${o.body.item.id}/cancel`, { reason: 'changed plans' }, idem());
    expect(c.status).toBe(200);
    expect(c.body.item.status).toBe('CANCELLED');
    expect((await t.pool.query(`SELECT booked FROM travel_departures WHERE id = $1`, [dep])).rows[0].booked).toBe(0);
    const again = await call(t, buyer, 'POST', `/v1/orders/${o.body.item.id}/cancel`, { reason: 'changed plans' }, idem());
    expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('paid order: vouchers issued; cancel refunds per cancellation terms', async () => {
    const dep = await newDeparture(4, { startsInHours: 48 }); // 48h before → 50% tier
    const o = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: dep, qty: 2 }] }, idem());
    const prep = await call(t, buyer, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: o.body.item.id }, idem());
    expect(prep.status).toBe(201);
    expect(prep.body.amount).toBe(100_000);
    const conf = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${o.body.item.id}`, orderId: prep.body.orderId, amount: 100_000 }, idem());
    expect(conf.status).toBe(200);
    const paid = await call(t, buyer, 'GET', `/v1/orders/${o.body.item.id}`);
    expect(paid.body.item.status).toBe('PAID');
    const depLine = paid.body.item.items.find((i: any) => i.sellableType === 'TRAVEL_DEPARTURE');
    expect(depLine.vouchers).toHaveLength(2);

    const sup = await call(t, supplierUser, 'GET', '/v1/supplier/orders');
    expect(sup.body.items.some((x: any) => x.id === o.body.item.id)).toBe(true);

    const c = await call(t, buyer, 'POST', `/v1/orders/${o.body.item.id}/cancel`, { reason: 'sick' }, idem());
    expect(c.status).toBe(200);
    expect(c.body.refund.amountMinor).toBe(50_000);
    await t.drain();
    const after = await call(t, buyer, 'GET', `/v1/orders/${o.body.item.id}`);
    expect(after.body.item.status).toBe('CANCELLED');
    expect(after.body.item.refundedMinor).toBe(50_000);
    expect(after.body.item.items.find((i: any) => i.sellableType === 'TRAVEL_DEPARTURE').vouchers.every((v: any) => v.status === 'VOID')).toBe(true);
    const pay = await t.pool.query(`SELECT status, refunded_minor FROM payments WHERE subject_id = $1 AND status <> 'CANCELLED'`, [o.body.item.id]);
    expect(pay.rows[0]).toEqual({ status: 'PARTIALLY_REFUNDED', refunded_minor: 50_000 });
    expect((await t.pool.query(`SELECT booked FROM travel_departures WHERE id = $1`, [dep])).rows[0].booked).toBe(0);
  });

  it('min participants: GUARANTEED when reached; CANCELLED with full refund past cutoff below min', async () => {
    const depA = await newDeparture(5, { minParticipants: 1, startsInHours: 24 * 5 });
    const depB = await newDeparture(5, { minParticipants: 3, startsInHours: 24 * 5, cutoffInHours: 24 * 4 });
    const pay = async (dep: string) => {
      const o = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: dep, qty: 1 }] }, idem());
      const prep = await call(t, buyer, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: o.body.item.id }, idem());
      const conf = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${o.body.item.id}`, orderId: prep.body.orderId, amount: prep.body.amount }, idem());
      expect(conf.status).toBe(200);
      return o.body.item.id as string;
    };
    await pay(depA);
    const orderB = await pay(depB);
    await t.pool.query(`UPDATE travel_departures SET cutoff_at = now() - interval '1 minute' WHERE id = $1`, [depB]);
    const out = await runDepartureLifecycle(t.app.ctx, t.ctx());
    expect(out.guaranteed).toBeGreaterThanOrEqual(1);
    expect(out.cancelled).toBeGreaterThanOrEqual(1);
    const rows = await t.pool.query(`SELECT id, status FROM travel_departures WHERE id = ANY($1::uuid[])`, [[depA, depB]]);
    const st = Object.fromEntries(rows.rows.map((r) => [r.id, r.status]));
    expect(st[depA]).toBe('GUARANTEED');
    expect(st[depB]).toBe('CANCELLED');
    await t.drain();
    const b = await call(t, buyer, 'GET', `/v1/orders/${orderB}`);
    expect(b.body.item.status).toBe('CANCELLED');
    expect(b.body.item.refundedMinor).toBe(b.body.item.totalMinor);
  });

  it('order DTO hides the settlement split from buyers; each supplier sees only its own pricing entry', async () => {
    const otherUser = await createUser(t);
    const s2 = (await call(t, otherUser, 'POST', '/v1/suppliers', { name: 'Busan Boats', supplierType: 'TOUR_OPERATOR' })).body.item.id;
    expect((await call(t, admin, 'POST', `/v1/admin/suppliers/${s2}/approve`, { merchantOfRecord: 'JETPOOL', commissionBps: 1000 })).status).toBe(200);
    const p2 = (await call(t, otherUser, 'POST', '/v1/supplier/products', { type: 'TOUR', title: 'Harbour Cruise', city: 'Busan', basePriceMinor: 30_000, currency: 'KRW' })).body.item.id;
    await call(t, otherUser, 'POST', `/v1/supplier/products/${p2}/submit`);
    expect((await call(t, admin, 'POST', `/v1/admin/travel-products/${p2}/publish`, {})).status).toBe(200);
    const dep2 = await call(t, otherUser, 'POST', `/v1/travel-products/${p2}/departures`, { startsAt: hoursFromNow(24 * 10), capacity: 5 });
    expect(dep2.status).toBe(201);
    const dep1 = await newDeparture(5);
    const o = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: dep1, qty: 1 }, { departureId: dep2.body.item.id, qty: 1 }] }, idem());
    expect(o.status).toBe(201);

    for (const view of [o.body.item, (await call(t, buyer, 'GET', `/v1/orders/${o.body.item.id}`)).body.item]) {
      expect(view.pricing).toMatchObject({ subtotalMinor: 80_000, totalMinor: view.totalMinor });
      expect(view.pricing.suppliers).toBeUndefined();
      expect(JSON.stringify(view)).not.toContain(supplierUser.id);
      expect(JSON.stringify(view)).not.toContain(otherUser.id);
      expect(JSON.stringify(view)).not.toContain('commission');
    }

    const s1 = (await call(t, supplierUser, 'GET', '/v1/suppliers/me')).body.item.id;
    for (const [user, sid, gross] of [[supplierUser, s1, 50_000], [otherUser, s2, 30_000]] as const) {
      const so = (await call(t, user, 'GET', '/v1/supplier/orders')).body.items.find((x: any) => x.id === o.body.item.id);
      expect(so.items.every((i: any) => i.supplierId === sid)).toBe(true);
      expect(so.pricing.suppliers).toEqual([expect.objectContaining({ supplierId: sid, grossMinor: gross })]);
    }
  });
});

describe('TRAVEL-03 itinerary', () => {
  it('builds, reorders and removes items; owner only', async () => {
    const it0 = await call(t, buyer, 'POST', '/v1/itineraries', { title: 'Seoul 3 days', startDate: '2030-05-01', endDate: '2030-05-03' });
    expect(it0.status).toBe(201);
    const id = it0.body.item.id;
    const a = await call(t, buyer, 'POST', `/v1/itineraries/${id}/items`, { dayIndex: 0, itemType: 'TRAVEL_PRODUCT', refId: productId, title: 'Night walk' });
    expect(a.status).toBe(201);
    const b = await call(t, buyer, 'POST', `/v1/itineraries/${id}/items`, { dayIndex: 0, itemType: 'NOTE', title: 'Dinner' });
    expect(b.body.item.items.map((x: any) => x.title)).toEqual(['Night walk', 'Dinner']);
    expect((await call(t, buyer, 'POST', `/v1/itineraries/${id}/items`, { dayIndex: 1, itemType: 'STAY', refId: productId, title: 'Bad ref' })).body.code).toBe('REF_NOT_FOUND');
    const [x, y] = b.body.item.items;
    const re = await call(t, buyer, 'POST', `/v1/itineraries/${id}/items/reorder`, { items: [{ id: x.id, dayIndex: 0, sortOrder: 1 }, { id: y.id, dayIndex: 0, sortOrder: 0 }] });
    expect(re.body.item.items.map((i: any) => i.title)).toEqual(['Dinner', 'Night walk']);
    expect(re.body.item.version).toBeGreaterThan(1);
    const stale = await call(t, buyer, 'PATCH', `/v1/itineraries/${id}`, { title: 'X', version: 1 });
    expect(stale.body.code).toBe('STALE_VERSION');
    const other = await createUser(t);
    expect((await call(t, other, 'GET', `/v1/itineraries/${id}`)).status).toBe(404);
    const del = await call(t, buyer, 'DELETE', `/v1/itineraries/${id}/items/${x.id}`);
    expect(del.body.item.items).toHaveLength(1);
  });
});
