import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { autoCompleteStays } from '../src/modules/booking/reservations.js';

let t: TestApp;
let host: TestUser;

function png(w = 1024, h = 768) {
  const b = Buffer.alloc(120);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
async function upload(user: TestUser, bytes: Buffer) {
  const r = await call(t, user, 'POST', '/v1/media/upload-url', { purpose: 'PROPERTY', mimeType: 'image/png', byteSize: bytes.length });
  const u = new URL(r.body.upload.url);
  await t.app.inject({ method: 'PUT', url: u.pathname + u.search, payload: bytes, headers: { 'content-type': 'image/png' } });
  return { id: r.body.media.id as string, complete: await call(t, user, 'POST', `/v1/media/${r.body.media.id}/complete`) };
}

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
  await t.pool.query(`INSERT INTO host_profiles(user_id, status, verification_status) VALUES ($1,'APPROVED','VERIFIED')`, [host.id]);
});
afterAll(async () => t.close());

describe('probe', () => {
  it('timezone', async () => {
    const r = await call(t, host, 'POST', '/v1/properties', { title: 'tz test', propertyType: 'HOUSE', timezone: 'Not/AZone' });
    console.log('create tz', r.status, r.body?.item?.timezone);
    const g = await createUser(t);
    const qq = await call(t, g, 'POST', '/v1/booking/quotes', { propertyId: r.body.item.id, checkIn: '2027-01-01', checkOut: '2027-01-03', guests: 1 });
    console.log('quote', qq.status, qq.body?.code);
    const cal = await call(t, null, 'GET', `/v1/properties/${r.body.item.id}/calendar?from=2027-01-01&to=2027-01-10`);
    console.log('calendar', cal.status, cal.body?.code);
    // simulate one CHECKED_IN reservation on that property
    const pid = r.body.item.id;
    await t.pool.query(`INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, total_minor, currency, quote_snapshot)
                        VALUES ($1,$2,$3,'CHECKED_IN','2026-01-01','2026-01-03',1000,'KRW','{}')`, [pid, host.id, g.id]);
    try {
      const n = await autoCompleteStays(t.app.ctx);
      console.log('autocomplete ok', n);
    } catch (e: any) {
      console.log('autocomplete threw', e.code, e.message);
    }
  });

  it('bathrooms 100', async () => {
    const r = await call(t, host, 'POST', '/v1/properties', { title: 'bath test', propertyType: 'HOUSE', bathrooms: 100 });
    console.log('bathrooms', r.status, r.body?.code);
  });

  it('city backslash', async () => {
    const r = await call(t, null, 'GET', '/v1/properties?city=abc%5C');
    console.log('city backslash', r.status, r.body?.code);
  });

  it('search invalid date', async () => {
    const r = await call(t, null, 'GET', '/v1/search/properties?checkIn=2026-02-30&checkOut=2026-03-02');
    console.log('search feb30', r.status, r.body?.code);
    const r2 = await call(t, null, 'GET', '/v1/search/properties?checkIn=2026-13-01&checkOut=2026-13-05');
    console.log('search month13', r2.status, r2.body?.code);
  });

  it('permit invalid date', async () => {
    const r = await call(t, host, 'POST', '/v1/properties', { title: 'permit test', propertyType: 'HOUSE' });
    const p = await call(t, host, 'POST', `/v1/properties/${r.body.item.id}/permits`, { permitType: 'TOURIST', jurisdiction: 'KR', validFrom: '2027-02-30' });
    console.log('permit feb30', p.status, p.body?.code);
  });

  it('png huge width', async () => {
    const { id, complete } = await upload(host, png(0x80000000, 10));
    console.log('png complete', complete.status, complete.body?.code);
    const again = await call(t, host, 'POST', `/v1/media/${id}/complete`);
    console.log('png retry', again.status, again.body?.code);
    const m = await t.pool.query(`SELECT status FROM media_assets WHERE id = $1`, [id]);
    console.log('png status', m.rows[0].status);
  });

  it('fuzz reversal', async () => {
    const exact = { lat: 37.582612, lng: 126.983045 };
    const r = await call(t, host, 'POST', '/v1/properties', { title: 'fuzz test', propertyType: 'HOUSE', lat: exact.lat, lng: exact.lng });
    const id = r.body.item.id;
    await t.pool.query(`UPDATE properties SET status = 'PUBLISHED' WHERE id = $1`, [id]);
    const pub = await call(t, null, 'GET', `/v1/properties/${id}`);
    const loc = pub.body.item.location;
    // attacker: recompute the (unkeyed) offset from the public id and subtract it
    const h = createHash('sha256').update(`jetpool-geo-fuzz:${id}`).digest();
    const angle = (h.readUInt32BE(0) / 0xffffffff) * 2 * Math.PI;
    const dist = 200 + (h.readUInt32BE(4) / 0xffffffff) * 100;
    const lat = loc.lat - (dist * Math.cos(angle)) / 111_320;
    const lng = loc.lng - (dist * Math.sin(angle)) / (111_320 * Math.cos((lat * Math.PI) / 180));
    console.log('public', loc, 'recovered', { lat: lat.toFixed(6), lng: lng.toFixed(6) }, 'exact', exact);
  });

  it('region spoof allow', async () => {
    const admin = await createUser(t, { roles: ['COMPLIANCE'] });
    await t.pool.query(`INSERT INTO compliance_rules(rule_key, subject_type, jurisdiction, required_permit_types, effective_from, status, approved_at, approved_by)
      VALUES ('kr-biz','PROPERTY','KR','{BUSINESS_REG}','2020-01-01','APPROVED',now(),$1),
             ('seoul-homestay','PROPERTY','KR-11','{TOURIST_HOMESTAY}','2020-01-01','APPROVED',now(),$1)`, [admin.id]);
    const mk = async (region: string) => {
      const r = await call(t, host, 'POST', '/v1/properties', { title: 'spoof ' + region, propertyType: 'HOUSE', rentalEnabled: true, basePriceMinor: 100000, region, lat: 37.5826, lng: 126.983, city: 'Seoul', address: { line1: '서울 종로구 북촌로 11길 1', city: 'Seoul' } });
      const id = r.body.item.id;
      await t.pool.query(`INSERT INTO property_permits(property_id, permit_type, jurisdiction, status) VALUES ($1,'BUSINESS_REG','KR','VERIFIED')`, [id]);
      const e = await call(t, host, 'POST', '/v1/compliance/evaluate', { propertyId: id });
      return e.body.item;
    };
    console.log('honest KR-11', JSON.stringify(await mk('KR-11')));
    console.log('spoofed KR-26', JSON.stringify(await mk('KR-26')));
  });

  it('city backslash published', async () => {
    const r = await call(t, host, 'POST', '/v1/properties', { title: 'bs test', propertyType: 'HOUSE', city: 'Seoul' });
    await t.pool.query(`UPDATE properties SET status = 'PUBLISHED' WHERE id = $1`, [r.body.item.id]);
    const x = await call(t, null, 'GET', '/v1/properties?city=abc%5C');
    console.log('city backslash published', x.status, x.body?.code);
    const y = await call(t, null, 'GET', '/v1/search/properties?checkIn=2026-02-30&checkOut=2026-03-05');
    console.log('search feb30 b', y.status, y.body?.code);
  });

  it('region spoof', async () => {
    const r = await call(t, host, 'POST', '/v1/properties', { title: 'region test', propertyType: 'HOUSE', region: 'ZZ-99', country: 'QQ', lat: 37.5, lng: 127, city: 'Seoul', address: { line1: '서울 종로구 1', city: 'Seoul' } });
    console.log('region spoof', r.status, r.body?.item?.location);
  });
});
