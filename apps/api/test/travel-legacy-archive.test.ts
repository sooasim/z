import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, enableFlags, idem, type TestApp, type TestUser } from './helpers.js';

/**
 * MIG-01 heritage collection: the WON TRAVEL CLUB programmes JETPOOL inherited stay browsable after they ran, and
 * carry their rebuilt content (travel_products.detail). They are readable, never orderable, and the marker alone
 * decides it — an ordinary archived product stays invisible.
 */
let t: TestApp;
let supplierUser: TestUser;
let buyer: TestUser;
let supplierId: string;
let ranId: string;
let openId: string;
let plainArchivedId: string;

const DETAIL = {
  lead: '몸과 마음을 치유하는 시간',
  factSheet: { rows: [{ label: '일시', values: ['2025. 2. 7(금) ~ 2. 10(일)'] }], includes: ['왕복항공권'] },
  schedule: { days: [{ day: 1, date: '2/7(금)', items: [{ time: '09:10', text: '인천국제공항 출발' }] }] },
  spots: [{ name: '노보리베츠 온천마을', body: '일본 3대 온천' }],
  legacy: { system: 'LEGACY_WONT', path: '/product/past_spainbest-30-31', page: 'product_past_spainbest-30-31' },
  seedMedia: { hash: 'abc', source: 'scripts/legacy/assign.mjs' },
};

async function makeProduct(slug: string, status: string, detail: unknown) {
  const r = await t.pool.query(
    `INSERT INTO travel_products(supplier_id, type, slug, title, summary, city, country, status, detail)
     VALUES ($1,'PACKAGE',$2,$3,'요약','Sapporo','JP',$4,$5::jsonb) RETURNING id`,
    [supplierId, slug, `프로그램 ${slug}`, status, JSON.stringify(detail ?? {})],
  );
  return r.rows[0].id as string;
}

beforeAll(async () => {
  t = await createTestApp();
  supplierUser = await createUser(t);
  buyer = await createUser(t);
  supplierId = (
    await t.pool.query(`INSERT INTO suppliers(owner_user_id, name, supplier_type, status) VALUES ($1,'WONT Travel Club Tours','TOUR_OPERATOR','APPROVED') RETURNING id`, [supplierUser.id])
  ).rows[0].id;
  ranId = await makeProduct('wont-sapporo-snow-festival', 'ARCHIVED', DETAIL);
  openId = await makeProduct('wont-barcelona-humanities', 'PUBLISHED', { ...DETAIL, legacy: { ...DETAIL.legacy, path: '/product/past_spainbest-30-31-32' } });
  plainArchivedId = await makeProduct('retired-city-tour', 'ARCHIVED', {});
});
afterAll(async () => t.close());

describe('TRAVEL-01 migrated WONT programmes', () => {
  it('serves a programme that already ran, with its rebuilt content and without the seeder bookkeeping', async () => {
    const res = await call(t, null, 'GET', `/v1/travel-products/${ranId}`);
    expect(res.status).toBe(200);
    expect(res.body.item.status).toBe('ARCHIVED');
    expect(res.body.item.detail.schedule.days).toHaveLength(1);
    expect(res.body.item.detail.spots[0].name).toBe('노보리베츠 온천마을');
    expect(res.body.item.detail.legacy.system).toBe('LEGACY_WONT');
    expect(res.body.item.detail.seedMedia).toBeUndefined();
  });

  it('answers departures for it with an empty list instead of 404, so the page has nothing to sell', async () => {
    const res = await call(t, null, 'GET', `/v1/travel-products/${ranId}/departures`);
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('keeps an ordinary archived product invisible — the legacy marker is what opens the archive', async () => {
    expect((await call(t, null, 'GET', `/v1/travel-products/${plainArchivedId}`)).status).toBe(404);
    expect((await call(t, null, 'GET', `/v1/travel-products/${plainArchivedId}/departures`)).status).toBe(404);
  });

  it('lists the collection on request only: the default catalogue stays on-sale products', async () => {
    const def = await call(t, null, 'GET', '/v1/travel-products?limit=50');
    expect(def.body.items.map((p: any) => p.id)).toContain(openId);
    expect(def.body.items.map((p: any) => p.id)).not.toContain(ranId);

    const coll = await call(t, null, 'GET', '/v1/travel-products?collection=LEGACY_WONT&limit=50');
    expect(coll.status).toBe(200);
    const ids = coll.body.items.map((p: any) => p.id);
    expect(ids).toContain(ranId);
    expect(ids).toContain(openId);
    expect(ids).not.toContain(plainArchivedId);
    expect(coll.body.items.find((p: any) => p.id === ranId).detail.lead).toBe('몸과 마음을 치유하는 시간');
  });

  it('never sells one: a departure on a programme that has run cannot be ordered', async () => {
    await enableFlags(t, 'travel.commerce');
    const dep = (
      await t.pool.query(
        `INSERT INTO travel_departures(product_id, starts_at, capacity, status) VALUES ($1, now() + interval '30 days', 10, 'OPEN') RETURNING id`,
        [ranId],
      )
    ).rows[0].id;
    const res = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: dep, qty: 1 }] }, idem());
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PRODUCT_UNAVAILABLE');
  });
});
