import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { emit } from '../src/platform/outbox.js';
import { haversineKm } from '../src/modules/geo/geocoder.js';

let t: TestApp;
let host: TestUser;
const exact: Record<string, { lat: number; lng: number }> = {};

// Attacker-side inversion: only uses public id + public fuzzed point + the constant prefix from source.
function unfuzz(id: string, pubLat: number, pubLng: number) {
  const h = createHash('sha256').update(`jetpool-geo-fuzz:${id}`).digest();
  const angle = (h.readUInt32BE(0) / 0xffffffff) * 2 * Math.PI;
  const dist = 200 + (h.readUInt32BE(4) / 0xffffffff) * 100;
  const lat = pubLat - (dist * Math.cos(angle)) / 111_320;
  // lng term uses cos(exact lat); iterate once with the recovered lat (difference is negligible)
  let lng = pubLng - (dist * Math.sin(angle)) / (111_320 * Math.max(Math.cos((pubLat * Math.PI) / 180), 0.01));
  lng = pubLng - (dist * Math.sin(angle)) / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return { lat, lng };
}

async function seed(key: string, lat: number, lng: number, exchange = false) {
  const { rows } = await t.pool.query(
    `INSERT INTO properties(host_id, slug, title, description, property_type, max_guests, lat, lng, city, region, rental_enabled, exchange_enabled,
                            paid_booking_enabled, base_price_minor, status, published_at)
     VALUES ($1,$2,$3,'d','APARTMENT',2,$4,$5,'Seoul','KR-11',$6,$7,$6,$8,'PUBLISHED', now()) RETURNING id`,
    [host.id, `${key}-vr142`, `t-${key}`, lat, lng, !exchange, exchange, exchange ? null : 100000],
  );
  exact[rows[0].id] = { lat, lng };
  await emit(t.pool, t.ctx(), { aggregateType: 'property', aggregateId: rows[0].id, eventType: 'property.published', payload: { propertyId: rows[0].id } });
}

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
  await seed('a', 37.582612, 126.983045);
  await seed('b', 37.556123, 126.923456);
  await seed('c', 37.497911, 127.027611, true); // private home listed for exchange only
  await t.drain();
});
afterAll(async () => t.close());

describe('R1-42 fuzz reversal', () => {
  it('anonymous search results can be un-fuzzed to ~1 m', async () => {
    const r = await call(t, null, 'GET', '/v1/search/properties?bbox=126.8,37.4,127.2,37.7&limit=50');
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBe(3);
    for (const it of r.body.items) {
      const e = exact[it.id];
      const pubErr = haversineKm(e.lat, e.lng, it.location.lat, it.location.lng) * 1000;
      const rec = unfuzz(it.id, it.location.lat, it.location.lng);
      const recErr = haversineKm(e.lat, e.lng, rec.lat, rec.lng) * 1000;
      console.log(JSON.stringify({ endpoint: 'GET /v1/search/properties', id: it.id, published: it.location, exact: e, recovered: { lat: +rec.lat.toFixed(6), lng: +rec.lng.toFixed(6) }, publishedErrM: +pubErr.toFixed(1), recoveredErrM: +recErr.toFixed(2) }));
      expect(it.location.approximate).toBe(true);
      expect(pubErr).toBeGreaterThan(150);
      expect(recErr).toBeLessThan(2);
    }
  });

  it('anonymous property detail can be un-fuzzed as well', async () => {
    for (const id of Object.keys(exact)) {
      const r = await call(t, null, 'GET', `/v1/properties/${id}`);
      if (r.status !== 200) { console.log('detail status', id, r.status, JSON.stringify(r.body).slice(0, 200)); continue; }
      const loc = r.body.item?.location ?? r.body.location;
      const e = exact[id];
      const rec = unfuzz(id, loc.lat, loc.lng);
      const recErr = haversineKm(e.lat, e.lng, rec.lat, rec.lng) * 1000;
      console.log(JSON.stringify({ endpoint: `GET /v1/properties/${id}`, published: loc, recovered: { lat: +rec.lat.toFixed(6), lng: +rec.lng.toFixed(6) }, exact: e, recoveredErrM: +recErr.toFixed(2) }));
      expect(recErr).toBeLessThan(2);
    }
  });
});
