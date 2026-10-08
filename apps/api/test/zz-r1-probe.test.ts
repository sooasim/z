import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestApp, createUser, call, day, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
let host: TestUser;

function png() {
  const b = Buffer.alloc(120);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(1024, 16);
  b.writeUInt32BE(768, 20);
  return b;
}
async function upload(user: TestUser, purpose = 'PROPERTY') {
  const bytes = png();
  const r = await call(t, user, 'POST', '/v1/media/upload-url', { purpose, mimeType: 'image/png', byteSize: bytes.length });
  const u = new URL(r.body.upload.url);
  await t.app.inject({ method: 'PUT', url: u.pathname + u.search, payload: bytes, headers: { 'content-type': 'image/png' } });
  return (await call(t, user, 'POST', `/v1/media/${r.body.media.id}/complete`)).body.item.id as string;
}
async function approvedHost(roles: any[] = ['HOST']) {
  const u = await createUser(t, { roles });
  await t.pool.query(`INSERT INTO host_profiles(user_id, status, verification_status) VALUES ($1,'APPROVED','VERIFIED')`, [u.id]);
  return u;
}
async function listing(user: TestUser, over: Record<string, unknown> = {}) {
  const r = await call(t, user, 'POST', '/v1/properties', {
    title: 'Probe listing', propertyType: 'APARTMENT', maxGuests: 2, lat: 37.5826, lng: 126.983, city: 'Seoul', region: 'KR-11',
    description: 'A'.repeat(80), exchangeEnabled: true, address: { line1: '서울 종로구 북촌로 11길 1', publicAreaLabel: '북촌' }, ...over,
  });
  const ids = [await upload(user), await upload(user), await upload(user)];
  await call(t, user, 'PUT', `/v1/properties/${r.body.item.id}/media`, { items: ids.map((mediaId) => ({ mediaId })) });
  return r.body.item;
}

beforeAll(async () => {
  t = await createTestApp();
  host = await approvedHost();
});
afterAll(async () => t.close());

describe('probe', () => {
  it('host self-unblocks an admin-blocked listing', async () => {
    const p = await listing(host);
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/publish`)).status).toBe(200);
    const officer = await createUser(t, { roles: ['COMPLIANCE'] });
    expect((await call(t, officer, 'POST', `/v1/admin/properties/${p.id}/block`, { reason: 'illegal listing' })).body.item.status).toBe('BLOCKED');
    const u = await call(t, host, 'POST', `/v1/properties/${p.id}/unlist`);
    console.log('unlist from BLOCKED', u.status, u.body.item?.status);
    const pub = await call(t, host, 'POST', `/v1/properties/${p.id}/publish`);
    console.log('publish after', pub.status, pub.body.item?.status);
  });

  it('fuzz is reversible from public data', async () => {
    const p = await listing(host, { title: 'Fuzz probe' });
    await call(t, host, 'POST', `/v1/properties/${p.id}/publish`);
    const pub = (await call(t, null, 'GET', `/v1/properties/${p.id}`)).body.item;
    const { lat: fl, lng: fg } = pub.location;
    const h = createHash('sha256').update(`jetpool-geo-fuzz:${pub.id}`).digest();
    const angle = (h.readUInt32BE(0) / 0xffffffff) * 2 * Math.PI;
    const dist = 200 + (h.readUInt32BE(4) / 0xffffffff) * 100;
    const lat = fl - (dist * Math.cos(angle)) / 111_320;
    const lng = fg - (dist * Math.sin(angle)) / (111_320 * Math.cos((lat * Math.PI) / 180));
    console.log('recovered', lat, lng, 'vs exact 37.5826 126.983');
  });

  it('staff host verifies own permit; address change after ALLOW keeps paid booking', async () => {
    const a = await createUser(t, { roles: ['COMPLIANCE'] });
    const b = await createUser(t, { roles: ['COMPLIANCE'] });
    const c = await call(t, a, 'POST', '/v1/admin/compliance/rules', { ruleKey: 'probe.kr11', jurisdiction: 'KR-11', requiredPermitTypes: ['URBAN_HOMESTAY'], effectiveFrom: day(-5) });
    await call(t, b, 'POST', `/v1/admin/compliance/rules/${c.body.item.id}/approve`, {});
    const staffHost = await approvedHost(['HOST', 'COMPLIANCE']);
    const p = await listing(staffHost, { exchangeEnabled: false, rentalEnabled: true, basePriceMinor: 100000 });
    const doc = await upload(staffHost, 'VERIFICATION');
    const permit = await call(t, staffHost, 'POST', `/v1/properties/${p.id}/permits`, { permitType: 'URBAN_HOMESTAY', jurisdiction: 'KR-11', documentMediaId: doc });
    const v = await call(t, staffHost, 'POST', `/v1/admin/permits/${permit.body.item.id}/verify`, { reason: 'self' });
    console.log('self verify', v.status, v.body.item?.status, v.body.evaluation?.decision);
    const pub = await call(t, staffHost, 'POST', `/v1/properties/${p.id}/publish`);
    console.log('publish', pub.status, pub.body.item?.paidBookingEnabled);
    const patch = await call(t, staffHost, 'PATCH', `/v1/properties/${p.id}`, { lat: 37.5, lng: 127.1, address: { line1: 'totally different unlicensed flat 99' } });
    console.log('after address change', patch.status, patch.body.item?.paidBookingEnabled);
  });
});
