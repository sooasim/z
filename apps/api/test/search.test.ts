import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, day, type TestApp, type TestUser } from './helpers.js';
import { withTx } from '../src/platform/db.js';
import { emit } from '../src/platform/outbox.js';
import { acquireBlock } from '../src/platform/inventory.js';
import { projectProperty, reconcileIndex } from '../src/modules/search/service.js';
import { haversineKm } from '../src/modules/geo/geocoder.js';

let t: TestApp;
let host: TestUser;
const ids: Record<string, string> = {};

/** Seed a PUBLISHED property directly in the source tables, then announce it through the outbox. */
async function seed(key: string, p: { title: string; city: string; region: string; lat: number; lng: number; type?: string; price?: number | null; guests?: number; amenities?: string[]; exchange?: boolean; paid?: boolean; description?: string }) {
  const { rows } = await t.pool.query(
    `INSERT INTO properties(host_id, slug, title, description, property_type, max_guests, lat, lng, city, region, rental_enabled, exchange_enabled,
                            paid_booking_enabled, base_price_minor, status, published_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PUBLISHED', now()) RETURNING id`,
    [host.id, `${key}-slug`, p.title, p.description ?? 'desc', p.type ?? 'APARTMENT', p.guests ?? 2, p.lat, p.lng, p.city, p.region, p.price != null, p.exchange ?? false, p.paid ?? p.price != null, p.price ?? null],
  );
  ids[key] = rows[0].id;
  for (const a of p.amenities ?? []) await t.pool.query(`INSERT INTO property_amenities(property_id, amenity_code) VALUES ($1,$2)`, [rows[0].id, a]);
  await emit(t.pool, t.ctx(), { aggregateType: 'property', aggregateId: rows[0].id, eventType: 'property.published', payload: { propertyId: rows[0].id } });
}
const search = async (qs: string) => {
  const r = await call(t, null, 'GET', `/v1/search/properties?${qs}`);
  expect(r.status).toBe(200);
  return r.body;
};
const found = (body: any) => body.items.map((i: any) => i.id);

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
  await seed('hanok', { title: '북촌 전통 한옥', city: 'Seoul', region: 'KR-11', lat: 37.5826, lng: 126.983, type: 'HANOK', price: 200000, guests: 4, amenities: ['wifi', 'ondol'] });
  await seed('mapo', { title: 'Hongdae loft', city: 'Seoul', region: 'KR-11', lat: 37.556, lng: 126.923, price: 90000, guests: 2, amenities: ['wifi', 'washer'], description: 'Near the station, great nightlife' });
  await seed('gangnam', { title: 'Gangnam studio', city: 'Seoul', region: 'KR-11', lat: 37.4979, lng: 127.0276, type: 'STUDIO', price: 120000, guests: 2, amenities: ['wifi'] });
  await seed('busan', { title: 'Haeundae ocean view', city: 'Busan', region: 'KR-26', lat: 35.1587, lng: 129.1604, price: 150000, guests: 6, amenities: ['wifi', 'pool'] });
  await seed('jeju', { title: 'Jeju stone house', city: 'Jeju', region: 'KR-49', lat: 33.4996, lng: 126.5312, type: 'HOUSE', price: null, exchange: true, guests: 5, amenities: ['garden'] });
  await t.drain();
});
afterAll(async () => t.close());

describe('STAY-04 / PLAT-01 search (invariant 1: the projection is candidates-only, never authoritative)', () => {
  it('projects published properties via outbox events (fuzzed coordinates, candidates only)', async () => {
    const body = await search('limit=50');
    expect(body.total).toBe(5);
    expect(body.candidatesOnly).toBe(true);
    const hanok = body.items.find((i: any) => i.id === ids.hanok);
    expect(hanok.location.approximate).toBe(true);
    const m = haversineKm(37.5826, 126.983, hanok.location.lat, hanok.location.lng) * 1000;
    expect(m).toBeGreaterThan(150);
    expect(m).toBeLessThan(350);
    const st = await t.pool.query(`SELECT status FROM search_sync_state WHERE document_id = $1`, [ids.hanok]);
    expect(st.rows[0].status).toBe('SYNCED');
  });

  it('full-text and Korean substring matching', async () => {
    expect(found(await search(`q=${encodeURIComponent('한옥')}`))).toEqual([ids.hanok]);
    expect(found(await search('q=nightlife'))).toEqual([ids.mapo]);
    expect(found(await search(`q=${encodeURIComponent('Ocean view')}`))).toEqual([ids.busan]);
    expect(found(await search('q=%25'))).toEqual([]); // LIKE wildcards are escaped
  });

  it('filters: city, region, guests, price, amenities, type, mode', async () => {
    expect(found(await search('city=busan'))).toEqual([ids.busan]);
    expect(found(await search('region=KR-11')).sort()).toEqual([ids.hanok, ids.mapo, ids.gangnam].sort());
    expect(found(await search('guests=5')).sort()).toEqual([ids.busan, ids.jeju].sort());
    expect(found(await search('priceMin=100000&priceMax=160000')).sort()).toEqual([ids.gangnam, ids.busan].sort());
    expect(found(await search('amenities=wifi,ondol'))).toEqual([ids.hanok]);
    expect(found(await search('propertyType=HANOK,HOUSE')).sort()).toEqual([ids.hanok, ids.jeju].sort());
    expect(found(await search('mode=exchange'))).toEqual([ids.jeju]);
    expect(found(await search('mode=rental'))).not.toContain(ids.jeju);
    expect((await call(t, null, 'GET', '/v1/search/properties?priceMin=10&priceMax=5')).status).toBe(400);
  });

  it('map viewport (bbox) and radius search with distance sort', async () => {
    // Seoul viewport: minLng,minLat,maxLng,maxLat
    const seoul = await search('bbox=126.8,37.4,127.2,37.7');
    expect(found(seoul).sort()).toEqual([ids.hanok, ids.mapo, ids.gangnam].sort());
    expect(found(await search('bbox=128.9,35.0,129.3,35.3'))).toEqual([ids.busan]);
    const near = await search('lat=37.5563&lng=126.9236&radius=3000&sort=distance');
    expect(found(near)[0]).toBe(ids.mapo);
    expect(found(near)).not.toContain(ids.gangnam);
    expect(near.items[0].distanceM).toBeLessThan(500);
    const sorted = await search('bbox=126.8,37.4,127.2,37.7&sort=distance');
    expect(sorted.items.length).toBe(3);
    expect((await call(t, null, 'GET', '/v1/search/properties?bbox=1,2,3')).body.code).toBe('INVALID_BBOX');
    expect((await call(t, null, 'GET', '/v1/search/properties?sort=distance')).body.code).toBe('ORIGIN_REQUIRED');
  });

  it('date-aware: active blocks and unavailable days exclude properties; expired holds do not', async () => {
    await withTx(t.pool, (tx) => acquireBlock(tx, { propertyId: ids.hanok, start: day(10), end: day(13), blockType: 'RESERVATION', sourceType: 'RESERVATION' }));
    await withTx(t.pool, (tx) => acquireBlock(tx, { propertyId: ids.mapo, start: day(10), end: day(13), blockType: 'HOLD', sourceType: 'RESERVATION_HOLD', expiresAt: new Date(Date.now() - 1000) }));
    await t.pool.query(`INSERT INTO availability_days(property_id, day, status) VALUES ($1,$2,'UNAVAILABLE')`, [ids.gangnam, day(11)]);
    const during = await search(`region=KR-11&checkIn=${day(11)}&checkOut=${day(12)}`);
    expect(during.dateFiltered).toBe(true);
    expect(found(during)).toEqual([ids.mapo]);
    // overlapping edge: checkout day == block start is free ([) ranges)
    expect(found(await search(`region=KR-11&checkIn=${day(8)}&checkOut=${day(10)}`)).sort()).toEqual([ids.hanok, ids.mapo, ids.gangnam].sort());
    expect(found(await search(`region=KR-11&checkIn=${day(12)}&checkOut=${day(14)}`)).sort()).toEqual([ids.mapo, ids.gangnam].sort());
    expect((await call(t, null, 'GET', `/v1/search/properties?checkIn=${day(5)}`)).body.code).toBe('INVALID_DATE');
    expect((await call(t, null, 'GET', `/v1/search/properties?checkIn=${day(5)}&checkOut=${day(5)}`)).body.code).toBe('INVALID_DATE_RANGE');
  });

  it('facet counts and sorting', async () => {
    const body = await search('limit=1&sort=price_asc');
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(5);
    expect(body.items[0].id).toBe(ids.mapo);
    expect(body.facets.propertyType).toEqual({ APARTMENT: 2, HANOK: 1, STUDIO: 1, HOUSE: 1 });
    expect(body.facets.amenities.wifi).toBe(4);
    expect(body.facets.city).toEqual({ Seoul: 3, Busan: 1, Jeju: 1 });
    expect(body.facets.mode).toEqual({ rental: 4, exchange: 1 });
    const page2 = await search('limit=2&page=2&sort=price_desc');
    expect(page2.items.map((i: any) => i.priceMinor)).toEqual([120000, 90000]);
  });

  it('unlisting removes the document; out-of-order events are ignored; reconcile repairs drift', async () => {
    await t.pool.query(`UPDATE properties SET status = 'UNLISTED' WHERE id = $1`, [ids.gangnam]);
    await emit(t.pool, t.ctx(), { aggregateType: 'property', aggregateId: ids.gangnam, eventType: 'property.unlisted', payload: { propertyId: ids.gangnam } });
    await t.drain();
    expect(found(await search('limit=50'))).not.toContain(ids.gangnam);
    expect((await t.pool.query(`SELECT status FROM search_sync_state WHERE document_id = $1`, [ids.gangnam])).rows[0].status).toBe('DELETED');
    // an older event arriving late must not resurrect / overwrite: documents are always built from the current rows
    expect(await projectProperty(t.pool, t.app.ctx, ids.gangnam, new Date(Date.now() - 3600_000))).toBe('DELETED');
    expect(found(await search('limit=50'))).not.toContain(ids.gangnam);
    // drift: projection row lost → reconcile job rebuilds from PostgreSQL
    await t.pool.query(`DELETE FROM search_documents WHERE document_id = $1`, [ids.busan]);
    await t.pool.query(`DELETE FROM search_sync_state WHERE document_id = $1`, [ids.busan]);
    expect(found(await search('city=Busan'))).toEqual([]);
    await reconcileIndex(t.app.ctx);
    expect(found(await search('city=Busan'))).toEqual([ids.busan]);
  });

  it('admin reindex rebuilds from PostgreSQL (ADMIN AAL2 only)', async () => {
    const admin = await createUser(t, { roles: ['ADMIN'] });
    const weak = await createUser(t, { roles: ['ADMIN'], aal: 'aal1' });
    expect((await call(t, host, 'POST', '/v1/admin/search/reindex', {})).status).toBe(403);
    expect((await call(t, weak, 'POST', '/v1/admin/search/reindex', {})).body.code).toBe('AAL2_REQUIRED');
    const r = await call(t, admin, 'POST', '/v1/admin/search/reindex', { reset: true });
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ adapter: 'postgres', indexed: 4 });
    expect((await search('limit=50')).total).toBe(4);
  });

  it('suggest returns places, cities and titles', async () => {
    const s = await call(t, null, 'GET', `/v1/search/suggest?q=${encodeURIComponent('부산')}`);
    expect(s.body.places[0]).toMatchObject({ region: 'KR-26' });
    const s2 = await call(t, null, 'GET', '/v1/search/suggest?q=Bu');
    expect(s2.body.cities).toEqual([{ city: 'Busan', count: 1 }]);
    const s3 = await call(t, null, 'GET', '/v1/search/suggest?q=loft');
    expect(s3.body.titles[0]).toMatchObject({ id: ids.mapo, slug: 'mapo-slug' });
  });
});
