import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';

/**
 * TRAVEL-01 — head office authoring its own travel products.
 *
 * Products hang off a `suppliers` row, and there was none for the platform itself, so the console could review
 * and publish a product but never write one. Staff now author as the house supplier (`suppliers.is_house`),
 * through the same extranet routes, FSM and review flow as a third-party supplier.
 *
 * The boundary this pins down: staff author only in-house products. Another company's product stays with that
 * company — staff touch it through the review routes (publish / reject), not by editing its content.
 */

let t: TestApp;
let admin: TestUser, editor: TestUser, member: TestUser;

/** A third-party supplier with one product of its own. */
async function thirdParty() {
  const owner = await createUser(t, { roles: ['SUPPLIER'] });
  const { rows } = await t.pool.query(`INSERT INTO suppliers(owner_user_id, name, supplier_type, status) VALUES ($1,'Busan Day Tours','TOUR_OPERATOR','APPROVED') RETURNING id`, [owner.id]);
  const supplierId = rows[0].id as string;
  const p = await call(t, owner, 'POST', '/v1/supplier/products', { type: 'TOUR', title: 'Busan harbour walk', city: 'Busan', basePriceMinor: 40000 });
  expect(p.status).toBe(201);
  return { owner, supplierId, productId: p.body.item.id as string };
}

const draft = (title: string) => ({ type: 'TOUR', title, city: 'Seoul', country: 'KR', basePriceMinor: 90000, summary: 'Half a day on foot', cancellationTerms: { note: 'Free up to 72h before' } });

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  editor = await createUser(t, { roles: ['EDITOR'] });
  member = await createUser(t);
});
afterAll(async () => t.close());

describe('the house supplier', () => {
  it('does not exist until someone authors an in-house product', async () => {
    const r = await call(t, admin, 'GET', '/v1/supplier/products');
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect((await t.pool.query(`SELECT 1 FROM suppliers WHERE is_house`)).rowCount).toBe(0);
  });

  it('is created once, owned by the company and approved, when the first product is saved', async () => {
    const a = await call(t, admin, 'POST', '/v1/supplier/products', draft('Seoul palace morning'));
    expect(a.status).toBe(201);
    const b = await call(t, editor, 'POST', '/v1/supplier/products', draft('Hanok alley evening'));
    expect(b.status).toBe(201);
    // Both land on the same supplier — one house row, whoever writes first.
    expect(a.body.item.supplierId).toBe(b.body.item.supplierId);
    const { rows } = await t.pool.query(`SELECT * FROM suppliers WHERE is_house`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ owner_user_id: null, status: 'APPROVED', merchant_of_record: 'JETPOOL', commission_bps: 0 });
    // and the creation is on the record as a money-category decision, not a silent insert
    const audits = await t.pool.query(`SELECT * FROM audit_logs WHERE action = 'supplier.house_created'`);
    expect(audits.rowCount).toBe(1);
    // nobody inherits a SUPPLIER role from it
    expect((await t.pool.query(`SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'SUPPLIER'`, [admin.id])).rowCount).toBe(0);
  });

  it('carries the whole draft → review → published path, with the product visible to buyers at the end', async () => {
    const created = await call(t, admin, 'POST', '/v1/supplier/products', draft('Jeonju food crawl'));
    const id = created.body.item.id;

    const edited = await call(t, admin, 'PATCH', `/v1/supplier/products/${id}`, { basePriceMinor: 120000, options: [{ name: 'Vegetarian course', priceMinor: 10000 }] });
    expect(edited.status).toBe(200);
    expect(edited.body.item.basePriceMinor).toBe(120000);

    const one = await call(t, admin, 'GET', `/v1/supplier/products/${id}`);
    expect(one.body.item.options).toMatchObject([{ name: 'Vegetarian course', priceMinor: 10000, active: true }]);

    expect((await call(t, admin, 'POST', `/v1/supplier/products/${id}/submit`)).body.item.status).toBe('IN_REVIEW');
    const published = await call(t, admin, 'POST', `/v1/admin/travel-products/${id}/publish`, { note: 'in-house programme' });
    expect(published.status).toBe(200);
    expect(published.body.item.status).toBe('PUBLISHED');

    const pub = await call(t, null, 'GET', `/v1/travel-products/${id}`);
    expect(pub.status).toBe(200);
    // The buyer sees who sells it; "house" is an internal distinction and stays out of the public DTO.
    expect(pub.body.item.seller).toEqual({ supplierId: created.body.item.supplierId, name: 'JETPOOL 직영', merchantOfRecord: 'JETPOOL' });
    // The console, on the other hand, needs to know which rows are its own to edit.
    const row = (await call(t, admin, 'GET', '/v1/admin/travel-products')).body.items.find((p: any) => p.id === id);
    expect(row.isHouse).toBe(true);
  });

  it('takes departures and inventory edits like any other product', async () => {
    const created = await call(t, admin, 'POST', '/v1/supplier/products', draft('Gangneung sunrise'));
    const id = created.body.item.id;
    const startsAt = new Date(Date.now() + 14 * 24 * 3600_000).toISOString();
    const dep = await call(t, admin, 'POST', `/v1/travel-products/${id}/departures`, { startsAt, capacity: 12, minParticipants: 4, priceMinor: 95000 });
    expect(dep.status).toBe(201);
    const depId = dep.body.item.id;

    // readable while the product is still a draft: the console shows what it is about to publish
    const list = await call(t, admin, 'GET', `/v1/travel-products/${id}/departures`, undefined, {});
    expect(list.body.items.map((d: any) => d.id)).toContain(depId);

    expect((await call(t, admin, 'PATCH', `/v1/supplier/departures/${depId}`, { capacity: 20, status: 'CLOSED' })).body.item).toMatchObject({ capacity: 20, status: 'CLOSED' });
    const cancelled = await call(t, admin, 'POST', `/v1/supplier/departures/${depId}/cancel`, { reason: 'guide unavailable' });
    expect(cancelled.body.item.status).toBe('CANCELLED');
  });
});

describe('what staff may not do here', () => {
  it('cannot edit another company product through the extranet, only review it', async () => {
    const { productId } = await thirdParty();
    expect((await call(t, admin, 'PATCH', `/v1/supplier/products/${productId}`, { title: 'Renamed by head office' })).status).toBe(404);
    expect((await call(t, admin, 'GET', `/v1/supplier/products/${productId}`)).status).toBe(404);
    expect((await call(t, admin, 'POST', `/v1/supplier/products/${productId}/submit`)).status).toBe(404);
    expect((await call(t, admin, 'POST', `/v1/travel-products/${productId}/departures`, { startsAt: new Date(Date.now() + 86_400_000).toISOString(), capacity: 5 })).status).toBe(404);
    // the title is untouched, and review still works
    const row = await t.pool.query(`SELECT title FROM travel_products WHERE id = $1`, [productId]);
    expect(row.rows[0].title).toBe('Busan harbour walk');
    expect((await call(t, admin, 'GET', '/v1/admin/travel-products')).body.items.some((p: any) => p.id === productId)).toBe(true);
  });

  it('writes as their own supplier when they have one, never as the house', async () => {
    const both = await createUser(t, { roles: ['ADMIN', 'SUPPLIER'] });
    const { rows } = await t.pool.query(`INSERT INTO suppliers(owner_user_id, name, supplier_type, status) VALUES ($1,'Side business','ACTIVITY','APPROVED') RETURNING id`, [both.id]);
    const created = await call(t, both, 'POST', '/v1/supplier/products', draft('Own company tour'));
    expect(created.status).toBe(201);
    expect(created.body.item.supplierId).toBe(rows[0].id);
  });

  it('keeps the extranet shut to members and to AAL1 staff', async () => {
    const r = await call(t, member, 'POST', '/v1/supplier/products', draft('Should not exist'));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('ROLE_REQUIRED');
    expect((await call(t, null, 'POST', '/v1/supplier/products', draft('Should not exist'))).status).toBe(401);

    // Authoring must not be an easier door than reviewing: staff still need AAL2 where the gate is on.
    const aal1 = await createUser(t, { roles: ['ADMIN'], aal: 'aal1' });
    const weak = await call(t, aal1, 'POST', '/v1/supplier/products', draft('Should not exist'));
    expect(weak.status).toBe(403);
    expect(weak.body.code).toBe('AAL2_REQUIRED');
  });
});
