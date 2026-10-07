import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { haversineKm } from '../src/modules/geo/geocoder.js';

let t: TestApp;
let host: TestUser;
let unapproved: TestUser;
let stranger: TestUser;

function png() {
  const b = Buffer.alloc(120);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(1024, 16);
  b.writeUInt32BE(768, 20);
  return b;
}
async function photo(user: TestUser) {
  const bytes = png();
  const r = await call(t, user, 'POST', '/v1/media/upload-url', { purpose: 'PROPERTY', mimeType: 'image/png', byteSize: bytes.length });
  const u = new URL(r.body.upload.url);
  await t.app.inject({ method: 'PUT', url: u.pathname + u.search, payload: bytes, headers: { 'content-type': 'image/png' } });
  return (await call(t, user, 'POST', `/v1/media/${r.body.media.id}/complete`)).body.item.id as string;
}
async function approvedHost() {
  const u = await createUser(t, { roles: ['HOST'] });
  await t.pool.query(`INSERT INTO host_profiles(user_id, status, verification_status) VALUES ($1,'APPROVED','VERIFIED')`, [u.id]);
  return u;
}
const DESCRIPTION = '북촌 골목 안쪽의 조용한 전통 한옥입니다. 대청마루와 작은 마당이 있고 경복궁까지 걸어서 10분 거리입니다.';
async function publishable(user: TestUser, over: Record<string, unknown> = {}) {
  const r = await call(t, user, 'POST', '/v1/properties', {
    title: '서울 북촌 한옥 스테이',
    description: DESCRIPTION,
    propertyType: 'HANOK',
    maxGuests: 4,
    lat: 37.5826,
    lng: 126.983,
    city: 'Seoul',
    region: 'KR-11',
    exchangeEnabled: true,
    address: { line1: '서울 종로구 북촌로 11길 1', city: 'Seoul', publicAreaLabel: '종로구 북촌' },
    amenities: ['wifi', 'ondol'],
    houseRules: { petsAllowed: false, quietHours: '22:00-08:00' },
    cancellationPolicyCode: 'MODERATE',
    ...over,
  });
  expect(r.status).toBe(201);
  const ids = [await photo(user), await photo(user), await photo(user)];
  expect((await call(t, user, 'PUT', `/v1/properties/${r.body.item.id}/media`, { items: ids.map((mediaId) => ({ mediaId })) })).status).toBe(200);
  return r.body.item;
}

beforeAll(async () => {
  t = await createTestApp();
  host = await approvedHost();
  unapproved = await createUser(t, { roles: ['HOST'] });
  stranger = await createUser(t);
});
afterAll(async () => t.close());

describe('STAY-01 property / listing', () => {
  it('serves the amenity and cancellation-policy catalogs', async () => {
    const a = await call(t, null, 'GET', '/v1/amenities');
    expect(a.body.items.find((x: any) => x.code === 'ondol')).toMatchObject({ labelKo: '온돌' });
    const p = await call(t, null, 'GET', '/v1/properties/cancellation-policies');
    expect(p.body.items.map((x: any) => x.code)).toEqual(['FLEXIBLE', 'MODERATE', 'STRICT']);
  });

  it('creates a draft with a Korean-safe unique slug, private address and related content', async () => {
    const r = await call(t, host, 'POST', '/v1/properties', {
      title: '서울 한옥 스테이!',
      propertyType: 'HANOK',
      address: { line1: '서울 종로구 1', publicAreaLabel: '종로' },
      amenities: ['wifi'],
      houseRules: { smokingAllowed: false },
    });
    expect(r.status).toBe(201);
    expect(r.body.item.status).toBe('DRAFT');
    expect(r.body.item.slug).toMatch(/^서울-한옥-스테이-[0-9a-z]{6}$/);
    expect(r.body.item.address.line1).toBe('서울 종로구 1');
    expect(r.body.item.region).toBeUndefined();
    expect(r.body.item.location.region).toBe('KR-11'); // filled from the geocoder (STATIC)
    expect(r.body.item.location.lat).toBeNull(); // a city centroid never becomes the listing pin
    expect(r.body.item.amenities.map((a: any) => a.code)).toEqual(['wifi']);
    const again = await call(t, host, 'POST', '/v1/properties', { title: '서울 한옥 스테이!', propertyType: 'HANOK' });
    expect(again.body.item.slug).not.toBe(r.body.item.slug);
    const evs = await t.pool.query(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1`, [r.body.item.id]);
    expect(evs.rows.map((e) => e.event_type)).toContain('property.created');
    expect((await call(t, host, 'POST', '/v1/properties', { title: 'x', propertyType: 'CASTLE' })).status).toBe(400);
    expect((await call(t, host, 'POST', '/v1/properties', { title: 'ok title', propertyType: 'HOUSE', amenities: ['jacuzzi9'] })).body.code).toBe('UNKNOWN_AMENITY');
    expect((await call(t, null, 'POST', '/v1/properties', { title: 'ok title', propertyType: 'HOUSE' })).status).toBe(401);
  });

  it('enforces ownership on edit/read/lifecycle; drafts are invisible to others', async () => {
    const r = await call(t, host, 'POST', '/v1/properties', { title: 'Owner only', propertyType: 'HOUSE' });
    const id = r.body.item.id;
    expect((await call(t, stranger, 'PATCH', `/v1/properties/${id}`, { title: 'hacked' })).status).toBe(403);
    expect((await call(t, stranger, 'GET', `/v1/properties/${id}`)).status).toBe(404);
    expect((await call(t, null, 'GET', `/v1/properties/${id}`)).status).toBe(404);
    expect((await call(t, stranger, 'POST', `/v1/properties/${id}/publish`)).status).toBe(403);
    expect((await call(t, stranger, 'POST', `/v1/properties/${id}/archive`)).status).toBe(403);
    expect((await call(t, stranger, 'PUT', `/v1/properties/${id}/amenities`, { codes: [] })).status).toBe(403);
    const mine = await call(t, host, 'GET', '/v1/host/properties?status=DRAFT');
    expect(mine.body.items.some((p: any) => p.id === id)).toBe(true);
    expect((await call(t, stranger, 'GET', '/v1/host/properties')).body.items).toEqual([]);
    const upd = await call(t, host, 'PATCH', `/v1/properties/${id}`, { summary: 'nice', checkInTime: '16:00', minNights: 2, maxNights: 10 });
    expect(upd.body.item).toMatchObject({ summary: 'nice', checkInTime: '16:00', minNights: 2 });
    expect((await call(t, host, 'PATCH', `/v1/properties/${id}`, { minNights: 5, maxNights: 2 })).status).toBe(400);
  });

  it('publish validates required content', async () => {
    const r = await call(t, host, 'POST', '/v1/properties', { title: 'Empty draft', propertyType: 'HOUSE', rentalEnabled: true, description: 'too short' });
    const res = await call(t, host, 'POST', `/v1/properties/${r.body.item.id}/publish`);
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('PUBLISH_VALIDATION_FAILED');
    expect(res.body.details.errors).toEqual(expect.arrayContaining(['DESCRIPTION_MIN_50', 'BASE_PRICE_REQUIRED', 'GEO_REQUIRED', 'ADDRESS_REQUIRED', 'MEDIA_MIN_3']));
    const noMode = await call(t, host, 'POST', '/v1/properties', { title: 'No mode', propertyType: 'HOUSE' });
    expect((await call(t, host, 'POST', `/v1/properties/${noMode.body.item.id}/publish`)).body.details.errors).toContain('LISTING_MODE_REQUIRED');
  });

  it('requires an approved host to publish', async () => {
    const p = await publishable(unapproved);
    const res = await call(t, unapproved, 'POST', `/v1/properties/${p.id}/publish`);
    expect(res.status).toBe(403);
    expect(['HOST_NOT_APPROVED', 'HOST_NOT_ELIGIBLE']).toContain(res.body.code);
  });

  it('publishes an exchange-only listing without paid booking; public detail hides the exact address', async () => {
    const p = await publishable(host);
    const res = await call(t, host, 'POST', `/v1/properties/${p.id}/publish`);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('PUBLISHED');
    expect(res.body.item).toMatchObject({ status: 'PUBLISHED', paidBookingEnabled: false });
    const pub = await call(t, null, 'GET', `/v1/properties/by-slug/${encodeURIComponent(p.slug)}`);
    expect(pub.status).toBe(200);
    const json = JSON.stringify(pub.body);
    expect(json).not.toContain('북촌로 11길');
    expect(pub.body.item.address).toBeUndefined();
    expect(pub.body.item.location).toMatchObject({ areaLabel: '종로구 북촌', approximate: true, city: 'Seoul' });
    const m = haversineKm(37.5826, 126.983, pub.body.item.location.lat, pub.body.item.location.lng) * 1000;
    expect(m).toBeGreaterThan(150);
    expect(m).toBeLessThan(350);
    expect(pub.body.item.media).toHaveLength(3);
    expect(pub.body.item.media[0].url).toMatch(/^http/);
    expect(pub.body.item.amenities.map((a: any) => a.code).sort()).toEqual(['ondol', 'wifi']);
    expect(pub.body.item.houseRules.quietHours).toBe('22:00-08:00');
    expect(pub.body.item.cancellationPolicy.code).toBe('MODERATE');
    expect(pub.body.item.host).toMatchObject({ id: host.id, verified: true });
    expect(pub.body.item.reputation).toEqual({ reviewCount: 0, ratingAvg: null });
    // by id for the public = same public view
    expect((await call(t, stranger, 'GET', `/v1/properties/${p.id}`)).body.item.address).toBeUndefined();
    expect((await call(t, null, 'GET', `/v1/properties?hostId=${host.id}`)).body.items.some((x: any) => x.id === p.id)).toBe(true);
    const evs = await t.pool.query(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1`, [p.id]);
    expect(evs.rows.map((e) => e.event_type)).toContain('property.published');
  });

  it('paid listing without any approved compliance rule fails closed (IN_REVIEW, no paid booking)', async () => {
    const p = await publishable(host, { exchangeEnabled: false, rentalEnabled: true, basePriceMinor: 150000 });
    const res = await call(t, host, 'POST', `/v1/properties/${p.id}/publish`);
    expect(res.status).toBe(202);
    expect(res.body.outcome).toBe('IN_REVIEW');
    expect(res.body.compliance).toMatchObject({ decision: 'REVIEW', reasons: ['NO_APPROVED_RULE'] });
    expect(res.body.item).toMatchObject({ status: 'IN_REVIEW', paidBookingEnabled: false });
    expect((await call(t, null, 'GET', `/v1/properties/by-slug/${encodeURIComponent(p.slug)}`)).status).toBe(404);
    // rental + exchange: publishes exchange-only
    const both = await publishable(host, { rentalEnabled: true, basePriceMinor: 100000 });
    const r2 = await call(t, host, 'POST', `/v1/properties/${both.id}/publish`);
    expect(r2.body.item).toMatchObject({ status: 'PUBLISHED', paidBookingEnabled: false });
    // withdraw IN_REVIEW → DRAFT
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/withdraw`)).body.item.status).toBe('DRAFT');
  });

  it('published listings reach the search projection through the outbox; unlisting removes them', async () => {
    const p = await publishable(host, { title: '검색 테스트 한옥 숙소' });
    await call(t, host, 'POST', `/v1/properties/${p.id}/publish`);
    await t.drain();
    const hit = await call(t, null, 'GET', `/v1/search/properties?q=${encodeURIComponent('검색 테스트')}`);
    expect(hit.body.items.map((i: any) => i.id)).toEqual([p.id]);
    expect(hit.body.items[0].amenities.sort()).toEqual(['ondol', 'wifi']);
    expect(hit.body.items[0].coverUrl).toMatch(/^http/);
    await call(t, host, 'POST', `/v1/properties/${p.id}/unlist`);
    await t.drain();
    expect((await call(t, null, 'GET', `/v1/search/properties?q=${encodeURIComponent('검색 테스트')}`)).body.items).toEqual([]);
  });

  it('lifecycle: unlist / relist / archive with FSM history and invalid transitions', async () => {
    const p = await publishable(host);
    await call(t, host, 'POST', `/v1/properties/${p.id}/publish`);
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/publish`)).status).toBe(409); // already published
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/unlist`)).body.item.status).toBe('UNLISTED');
    expect((await call(t, null, 'GET', `/v1/properties/by-slug/${encodeURIComponent(p.slug)}`)).status).toBe(404);
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/unlist`)).status).toBe(409);
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/publish`)).body.item.status).toBe('PUBLISHED');
    // a live listing must remain valid after edits
    const bad = await call(t, host, 'PATCH', `/v1/properties/${p.id}`, { description: 'short' });
    expect(bad.status).toBe(422);
    expect((await call(t, host, 'PUT', `/v1/properties/${p.id}/media`, { items: [] })).status).toBe(422);
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/archive`)).body.item.status).toBe('ARCHIVED');
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/publish`)).status).toBe(409);
    expect((await call(t, host, 'PATCH', `/v1/properties/${p.id}`, { title: 'again' })).status).toBe(409);
    const hist = await t.pool.query(`SELECT from_state, to_state FROM state_transitions WHERE aggregate_type = 'PROPERTY' AND aggregate_id = $1 ORDER BY id`, [p.id]);
    expect(hist.rows.map((h) => `${h.from_state}>${h.to_state}`)).toEqual(['DRAFT>PUBLISHED', 'PUBLISHED>UNLISTED', 'UNLISTED>PUBLISHED', 'PUBLISHED>ARCHIVED']);
    const evs = await t.pool.query(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at`, [p.id]);
    expect(evs.rows.map((e) => e.event_type)).toEqual(expect.arrayContaining(['property.unlisted', 'property.archived', 'property.updated']));
  });

  it('admin block/unblock requires staff AAL2, is audited and disables paid booking', async () => {
    const p = await publishable(host);
    await call(t, host, 'POST', `/v1/properties/${p.id}/publish`);
    const aal1 = await createUser(t, { roles: ['ADMIN'], aal: 'aal1' });
    const officer = await createUser(t, { roles: ['COMPLIANCE'] });
    expect((await call(t, host, 'POST', `/v1/admin/properties/${p.id}/block`, { reason: 'illegal listing' })).status).toBe(403);
    const r1 = await call(t, aal1, 'POST', `/v1/admin/properties/${p.id}/block`, { reason: 'illegal listing' });
    expect(r1.body.code).toBe('AAL2_REQUIRED');
    const b = await call(t, officer, 'POST', `/v1/admin/properties/${p.id}/block`, { reason: 'illegal listing' });
    expect(b.body.item).toMatchObject({ status: 'BLOCKED', paidBookingEnabled: false });
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/publish`)).status).toBe(409);
    expect((await call(t, null, 'GET', `/v1/properties/by-slug/${encodeURIComponent(p.slug)}`)).status).toBe(404);
    const aud = await t.pool.query(`SELECT action, category, reason FROM audit_logs WHERE resource_id = $1`, [p.id]);
    expect(aud.rows).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'property.blocked', category: 'COMPLIANCE', reason: 'illegal listing' })]));
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'listing.blocked'`, [p.id]);
    expect(ev.rows[0].payload.scope).toBe('LISTING');
    // staff can read the private view
    expect((await call(t, officer, 'GET', `/v1/properties/${p.id}`)).body.item.address.line1).toContain('북촌로');
    const u = await call(t, officer, 'POST', `/v1/admin/properties/${p.id}/unblock`, { reason: 'resolved after review' });
    expect(u.body.item.status).toBe('UNLISTED');
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/publish`)).body.item.status).toBe('PUBLISHED');
  });
});
