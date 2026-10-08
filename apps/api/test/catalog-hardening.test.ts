/**
 * QA round 1 — catalog group regressions (properties, compliance, geo, search). Each block reproduces a confirmed
 * defect through the real HTTP routes and asserts the fixed behaviour.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import pg from 'pg';
import { createTestApp, createUser, call, day, type TestApp, type TestUser } from './helpers.js';
import { withTx } from '../src/platform/db.js';
import { emit } from '../src/platform/outbox.js';
import { haversineKm, CachedGeocoder, GeocoderBusyError, NominatimGeocoder, type Geocoder } from '../src/modules/geo/geocoder.js';
import { assertExchangeAllowed, assertPaidBookingAllowed, evaluatePropertyCompliance, runPermitExpiry } from '../src/modules/compliance/service.js';
import { reconcileIndex } from '../src/modules/search/service.js';
import { GEOCODER_ADAPTER } from '../src/modules/geo/service.js';
import { backfillGeoJurisdictions } from '../src/modules/properties/service.js';

let t: TestApp;
let officerA: TestUser;
let officerB: TestUser;

function png(w = 1024, h = 768) {
  const b = Buffer.alloc(120);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
async function upload(user: TestUser, purpose = 'PROPERTY') {
  const bytes = png();
  const r = await call(t, user, 'POST', '/v1/media/upload-url', { purpose, mimeType: 'image/png', byteSize: bytes.length });
  const u = new URL(r.body.upload.url);
  await t.app.inject({ method: 'PUT', url: u.pathname + u.search, payload: bytes, headers: { 'content-type': 'image/png' } });
  const c = await call(t, user, 'POST', `/v1/media/${r.body.media.id}/complete`);
  expect(c.status).toBe(200);
  return c.body.item.id as string;
}
async function approvedHost(roles: any[] = ['HOST']) {
  const u = await createUser(t, { roles, verified: true });
  await t.pool.query(`INSERT INTO host_profiles(user_id, status, verification_status) VALUES ($1,'APPROVED','VERIFIED')`, [u.id]);
  return u;
}
const DESCRIPTION = 'A bright and quiet home with fast wifi, a full kitchen, a small balcony and easy access to the subway.';
async function listing(user: TestUser, over: Record<string, unknown> = {}) {
  const r = await call(t, user, 'POST', '/v1/properties', {
    title: 'Hardening test home',
    description: DESCRIPTION,
    propertyType: 'HANOK',
    maxGuests: 3,
    lat: 37.5826,
    lng: 126.983,
    city: 'Seoul',
    region: 'KR-11',
    exchangeEnabled: true,
    address: { line1: '서울 종로구 북촌로 11길 1', city: 'Seoul', publicAreaLabel: '종로구 북촌' },
    cancellationPolicyCode: 'MODERATE',
    ...over,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const ids = [await upload(user), await upload(user), await upload(user)];
  expect((await call(t, user, 'PUT', `/v1/properties/${r.body.item.id}/media`, { items: ids.map((mediaId) => ({ mediaId })) })).status).toBe(200);
  return r.body.item;
}
async function approvedRule(body: Record<string, unknown>) {
  const c = await call(t, officerA, 'POST', '/v1/admin/compliance/rules', { effectiveFrom: day(-10), ...body });
  expect(c.status, JSON.stringify(c.body)).toBe(201);
  const a = await call(t, officerB, 'POST', `/v1/admin/compliance/rules/${c.body.item.id}/approve`, { reason: 'legal sign-off' });
  expect(a.status).toBe(200);
  return a.body.item;
}
async function verifiedPermit(host: TestUser, propertyId: string, permitType: string, jurisdiction: string) {
  const p = await call(t, host, 'POST', `/v1/properties/${propertyId}/permits`, { permitType, jurisdiction, permitNo: `${permitType}-1`, validFrom: day(-1), validUntil: day(300) });
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  const v = await call(t, officerA, 'POST', `/v1/admin/permits/${p.body.item.id}/verify`, { reason: 'checked' });
  expect(v.status, JSON.stringify(v.body)).toBe(200);
  return v.body;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  t = await createTestApp();
  officerA = await createUser(t, { roles: ['COMPLIANCE'] });
  officerB = await createUser(t, { roles: ['COMPLIANCE'] });
});
afterAll(async () => t.close());

describe('#1 a staff/compliance BLOCK cannot be lifted by the host', () => {
  it('host unlist / publish / archive / withdraw of a BLOCKED listing are refused; only staff unblock works', async () => {
    const host = await approvedHost();
    const p = await listing(host);
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/publish`)).body.item.status).toBe('PUBLISHED');
    const b = await call(t, officerA, 'POST', `/v1/admin/properties/${p.id}/block`, { reason: 'illegal listing' });
    expect(b.body.item.status).toBe('BLOCKED');

    const unlist = await call(t, host, 'POST', `/v1/properties/${p.id}/unlist`);
    expect(unlist.status).toBe(409);
    expect(unlist.body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/publish`)).status).toBe(409);
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/withdraw`)).status).toBe(409);
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/archive`)).status).toBe(409);
    expect((await call(t, null, 'GET', `/v1/properties/by-slug/${encodeURIComponent(p.slug)}`)).status).toBe(404);
    const row = await t.pool.query(`SELECT status FROM properties WHERE id = $1`, [p.id]);
    expect(row.rows[0].status).toBe('BLOCKED');
    const userMoves = await t.pool.query(
      `SELECT 1 FROM state_transitions WHERE aggregate_type = 'PROPERTY' AND aggregate_id = $1 AND from_state = 'BLOCKED' AND actor_type = 'USER'`,
      [p.id],
    );
    expect(userMoves.rowCount).toBe(0);

    // the legitimate path: staff unblock → UNLISTED → host may republish
    expect((await call(t, officerB, 'POST', `/v1/admin/properties/${p.id}/unblock`, { reason: 'resolved after review' })).body.item.status).toBe('UNLISTED');
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/publish`)).body.item.status).toBe('PUBLISHED');
  });

  it('host transitions only from their legitimate source states', async () => {
    const host = await approvedHost();
    const p = await listing(host);
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/withdraw`)).status).toBe(409); // DRAFT, not IN_REVIEW
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/unlist`)).status).toBe(409); // DRAFT, not PUBLISHED
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/archive`)).body.item.status).toBe('ARCHIVED');
  });
});

describe('#2/#17 public coordinate fuzz is keyed with a server secret', () => {
  it('the published point cannot be reversed from the public id + source code', async () => {
    const host = await approvedHost();
    const exact = { lat: 37.582612, lng: 126.983045 };
    const p = await listing(host, { ...exact, title: 'Fuzz probe hanok' });
    await call(t, host, 'POST', `/v1/properties/${p.id}/publish`);
    await t.drain();
    const pub = (await call(t, null, 'GET', `/v1/properties/by-slug/${encodeURIComponent(p.slug)}`)).body.item;
    const m = haversineKm(exact.lat, exact.lng, pub.location.lat, pub.location.lng) * 1000;
    expect(m).toBeGreaterThan(150);
    expect(m).toBeLessThan(350);

    // the attack from the report: recompute the offset from sha256(constant + public id) and subtract it
    const reverse = (id: string, lat: number, lng: number) => {
      const h = createHash('sha256').update(`jetpool-geo-fuzz:${id}`).digest();
      const angle = (h.readUInt32BE(0) / 0xffffffff) * 2 * Math.PI;
      const dist = 200 + (h.readUInt32BE(4) / 0xffffffff) * 100;
      const la = lat - (dist * Math.cos(angle)) / 111_320;
      return { lat: la, lng: lng - (dist * Math.sin(angle)) / (111_320 * Math.cos((la * Math.PI) / 180)) };
    };
    // sanity: the attacker's function does invert the OLD unkeyed scheme exactly
    const h = createHash('sha256').update(`jetpool-geo-fuzz:${p.id}`).digest();
    const angle = (h.readUInt32BE(0) / 0xffffffff) * 2 * Math.PI;
    const dist = 200 + (h.readUInt32BE(4) / 0xffffffff) * 100;
    const oldPub = { lat: exact.lat + (dist * Math.cos(angle)) / 111_320, lng: exact.lng + (dist * Math.sin(angle)) / (111_320 * Math.cos((exact.lat * Math.PI) / 180)) };
    const back = reverse(p.id, oldPub.lat, oldPub.lng);
    expect(haversineKm(exact.lat, exact.lng, back.lat, back.lng) * 1000).toBeLessThan(5);
    // …but not the keyed one
    const guess = reverse(p.id, pub.location.lat, pub.location.lng);
    expect(haversineKm(exact.lat, exact.lng, guess.lat, guess.lng) * 1000).toBeGreaterThan(50);

    // search projection and public view expose the same keyed point
    const card = (await call(t, null, 'GET', `/v1/search/properties?q=${encodeURIComponent('Fuzz probe')}`)).body.items.find((i: any) => i.id === p.id);
    expect(card.location).toMatchObject({ lat: pub.location.lat, lng: pub.location.lng, approximate: true });
  });
});

describe('#3 a verified permit is bound to the address / subject it was verified for', () => {
  it('moving a live paid listing to another address turns paid booking off until a permit is re-verified', async () => {
    await approvedRule({ ruleKey: 'r3.kr11.villa', jurisdiction: 'KR-11', appliesTo: { property_type: ['VILLA'] }, requiredPermitTypes: ['URBAN_HOMESTAY'] });
    const host = await approvedHost();
    const p = await listing(host, {
      propertyType: 'VILLA', rentalEnabled: true, exchangeEnabled: false, basePriceMinor: 120000, lat: 37.556, lng: 126.923,
      address: { line1: 'Flat A, 1 Wausan-ro, Mapo-gu', city: 'Seoul', publicAreaLabel: 'Mapo-gu' },
    });
    const v = await verifiedPermit(host, p.id, 'URBAN_HOMESTAY', 'KR-11');
    expect(v.evaluation.decision).toBe('ALLOW');
    const pub = await call(t, host, 'POST', `/v1/properties/${p.id}/publish`);
    expect(pub.body.item).toMatchObject({ status: 'PUBLISHED', paidBookingEnabled: true });

    // a pin correction (< 100 m) keeps the permit valid
    const nudge = await call(t, host, 'PATCH', `/v1/properties/${p.id}`, { lat: 37.5563, lng: 126.9232 });
    expect(nudge.body.item.paidBookingEnabled).toBe(true);

    // the move from the report: same region, another (unlicensed) flat
    const moved = await call(t, host, 'PATCH', `/v1/properties/${p.id}`, { address: { line1: 'Flat B, 99 Gangnam-daero, Gangnam-gu (unlicensed)', city: 'Seoul' }, lat: 37.4979, lng: 127.0276 });
    expect(moved.status).toBe(200);
    expect(moved.body.item).toMatchObject({ status: 'PUBLISHED', paidBookingEnabled: false });
    expect(moved.body.item.compliance.reasons).toEqual(['PERMIT_SUBJECT_CHANGED:r3.kr11.villa:URBAN_HOMESTAY']);
    await expect(assertPaidBookingAllowed(t.pool, p.id)).rejects.toMatchObject({ code: 'COMPLIANCE_BLOCKED' });
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'listing.blocked'`, [p.id]);
    expect(ev.rows.some((r) => r.payload.scope === 'PAID_BOOKING')).toBe(true);

    // a permit verified for the new address restores paid booking
    const again = await verifiedPermit(host, p.id, 'URBAN_HOMESTAY', 'KR-11');
    expect(again.evaluation).toMatchObject({ decision: 'ALLOW', paidBookingEnabled: true });

    // changing the property type also needs re-verification
    const retyped = await call(t, host, 'PATCH', `/v1/properties/${p.id}`, { roomType: 'PRIVATE_ROOM' });
    expect(retyped.body.item.paidBookingEnabled).toBe(false);
  });
});

describe('#4/#8 hosts that lose good standing lose their live listings and paid booking', () => {
  it('LISTING_SUSPENSION: booking gate closes at once; listings leave search/public view; republish refused', async () => {
    await approvedRule({ ruleKey: 'r4.kr27', jurisdiction: 'KR-27', requiredPermitTypes: [] });
    const host = await approvedHost();
    const p = await listing(host, {
      title: 'Daegu sanction probe', propertyType: 'HOUSE', rentalEnabled: true, exchangeEnabled: false, basePriceMinor: 90000,
      lat: 35.8714, lng: 128.6014, city: 'Daegu', region: 'KR-27', address: { line1: '대구 중구 어딘가 1', city: 'Daegu' },
    });
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/publish`)).body.item.paidBookingEnabled).toBe(true);
    await t.drain();
    await expect(assertPaidBookingAllowed(t.pool, p.id)).resolves.toBeUndefined();
    expect((await call(t, null, 'GET', '/v1/search/properties?city=Daegu')).body.items.map((i: any) => i.id)).toContain(p.id);

    const s = await call(t, officerA, 'POST', '/v1/admin/sanctions', { userId: host.id, sanctionType: 'LISTING_SUSPENSION', reason: 'fraudulent host activity' });
    expect(s.status).toBe(201);
    // the booking gate is dynamic: closed even before the outbox runs
    await expect(assertPaidBookingAllowed(t.pool, p.id)).rejects.toMatchObject({ status: 403, code: 'COMPLIANCE_BLOCKED' });

    await t.drain();
    const row = await t.pool.query(`SELECT status, paid_booking_enabled FROM properties WHERE id = $1`, [p.id]);
    expect(row.rows[0]).toEqual({ status: 'UNLISTED', paid_booking_enabled: false });
    expect((await call(t, null, 'GET', '/v1/search/properties?city=Daegu')).body.items.map((i: any) => i.id)).not.toContain(p.id);
    expect((await call(t, null, 'GET', `/v1/properties/by-slug/${encodeURIComponent(p.slug)}`)).status).toBe(404);
    const re = await call(t, host, 'POST', `/v1/properties/${p.id}/publish`);
    expect(re.status).toBe(403);
    expect(re.body.code).toBe('HOST_NOT_ELIGIBLE');
    const tr = await t.pool.query(`SELECT actor_type FROM state_transitions WHERE aggregate_id = $1 AND from_state = 'PUBLISHED' AND to_state = 'UNLISTED'`, [p.id]);
    expect(tr.rows[0].actor_type).toBe('SYSTEM');
  });

  it('BAN (account suspension) and pending privacy deletion take live listings down too', async () => {
    const banned = await approvedHost();
    const deleting = await approvedHost();
    const mk = async (u: TestUser, n: number) => {
      const p = await listing(u, {
        propertyType: 'HOUSE', rentalEnabled: true, exchangeEnabled: false, basePriceMinor: 80000,
        lat: 35.8714, lng: 128.6014, city: 'Daegu', region: 'KR-27', address: { line1: `대구 중구 어딘가 ${n}`, city: 'Daegu' },
      });
      expect((await call(t, u, 'POST', `/v1/properties/${p.id}/publish`)).body.item.status).toBe('PUBLISHED');
      return p.id as string;
    };
    const a = await mk(banned, 31);
    const b = await mk(deleting, 32);
    expect((await call(t, officerA, 'POST', '/v1/admin/sanctions', { userId: banned.id, sanctionType: 'BAN', reason: 'payment fraud ring' })).status).toBe(201);
    // privacy deletion request (the privacy module flips the account to PENDING_DELETION and emits privacy.requested)
    await withTx(t.pool, async (tx) => {
      await tx.query(`UPDATE users SET status = 'PENDING_DELETION' WHERE id = $1`, [deleting.id]);
      await emit(tx, t.ctx(), { aggregateType: 'privacy_request', aggregateId: deleting.id, eventType: 'privacy.requested', payload: { userId: deleting.id, type: 'DELETE' } });
    });
    await t.drain();
    const rows = await t.pool.query(`SELECT id, status, paid_booking_enabled FROM properties WHERE id = ANY($1::uuid[]) ORDER BY id`, [[a, b]]);
    expect(rows.rows.map((r) => [r.status, r.paid_booking_enabled])).toEqual([['UNLISTED', false], ['UNLISTED', false]]);
  });

  it('a suspended host profile (no event) is caught by the booking gate and the daily sweep', async () => {
    const host = await approvedHost();
    const p = await listing(host, {
      propertyType: 'HOUSE', rentalEnabled: true, exchangeEnabled: false, basePriceMinor: 80000,
      lat: 35.8714, lng: 128.6014, city: 'Daegu', region: 'KR-27', address: { line1: '대구 중구 어딘가 2', city: 'Daegu' },
    });
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/publish`)).body.item.paidBookingEnabled).toBe(true);
    await t.pool.query(`UPDATE host_profiles SET status = 'SUSPENDED' WHERE user_id = $1`, [host.id]);
    await expect(assertPaidBookingAllowed(t.pool, p.id)).rejects.toMatchObject({ code: 'COMPLIANCE_BLOCKED' });
    const res = await runPermitExpiry(t.ctx());
    expect(res.blocked).toBeGreaterThanOrEqual(1);
    expect((await t.pool.query(`SELECT paid_booking_enabled FROM properties WHERE id = $1`, [p.id])).rows[0].paid_booking_enabled).toBe(false);
  });
});

describe('#5/#11 staff cannot decide permits or blocks on their own listings', () => {
  it('HOST+COMPLIANCE user: self-verify refused (permit stays PENDING); another officer may verify', async () => {
    await approvedRule({ ruleKey: 'r5.kr47', jurisdiction: 'KR-47', appliesTo: { property_type: ['APARTMENT'] }, requiredPermitTypes: ['R5_PERMIT'] });
    const dual = await approvedHost(['HOST', 'COMPLIANCE']);
    const p = await listing(dual, {
      propertyType: 'APARTMENT', rentalEnabled: true, exchangeEnabled: false, basePriceMinor: 70000,
      lat: 35.8562, lng: 129.2247, city: 'Gyeongju', region: 'KR-47', address: { line1: '경주시 어딘가 1', city: 'Gyeongju' },
    });
    expect((await call(t, dual, 'POST', `/v1/properties/${p.id}/publish`)).body.code).toBe('COMPLIANCE_DENIED');
    const permit = await call(t, dual, 'POST', `/v1/properties/${p.id}/permits`, { permitType: 'R5_PERMIT', permitNo: 'FAKE-0001', jurisdiction: 'KR-47' });
    expect(permit.status).toBe(201);
    const self = await call(t, dual, 'POST', `/v1/admin/permits/${permit.body.item.id}/verify`, { reason: 'self' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('FOUR_EYES_REQUIRED');
    expect((await t.pool.query(`SELECT status, reviewer_id FROM property_permits WHERE id = $1`, [permit.body.item.id])).rows[0]).toEqual({ status: 'PENDING', reviewer_id: null });
    expect((await call(t, dual, 'POST', `/v1/admin/permits/${permit.body.item.id}/reject`, { reason: 'self' })).status).toBe(403);
    expect((await call(t, dual, 'POST', `/v1/properties/${p.id}/publish`)).body.outcome).toBe('IN_REVIEW');

    const ok = await call(t, officerA, 'POST', `/v1/admin/permits/${permit.body.item.id}/verify`, { reason: 'independent review' });
    expect(ok.status).toBe(200);
    expect(ok.body.item.status).toBe('VERIFIED');

    // own listing: block / unblock are refused too
    expect((await call(t, dual, 'POST', `/v1/admin/properties/${p.id}/block`, { reason: 'self block' })).body.code).toBe('FOUR_EYES_REQUIRED');
    expect((await call(t, officerA, 'POST', `/v1/admin/properties/${p.id}/block`, { reason: 'audit hold' })).body.item.status).toBe('BLOCKED');
    expect((await call(t, dual, 'POST', `/v1/admin/properties/${p.id}/unblock`, { reason: 'self unblock' })).body.code).toBe('FOUR_EYES_REQUIRED');
  });
});

describe('#7/#19 compliance jurisdiction cannot be self-declared away', () => {
  it('a Seoul listing declaring another region still gets the Seoul rules; garbage regions are refused', async () => {
    await approvedRule({ ruleKey: 'r7.kr.biz', jurisdiction: 'KR', appliesTo: { property_type: ['STUDIO'] }, requiredPermitTypes: ['BIZ_REG'] });
    await approvedRule({ ruleKey: 'r7.kr11.homestay', jurisdiction: 'KR-11', appliesTo: { property_type: ['STUDIO'] }, requiredPermitTypes: ['SEOUL_HOMESTAY'] });
    const host = await approvedHost();
    const p = await listing(host, {
      propertyType: 'STUDIO', rentalEnabled: true, exchangeEnabled: false, basePriceMinor: 60000, lat: 37.556, lng: 126.923,
      address: { line1: '서울 마포구 어딘가 1', city: 'Seoul', region: 'KR-11', publicAreaLabel: '마포구 서교동' },
    });
    expect((await t.pool.query(`SELECT geo_jurisdictions FROM properties WHERE id = $1`, [p.id])).rows[0].geo_jurisdictions).toContain('KR-11');
    await verifiedPermit(host, p.id, 'BIZ_REG', 'KR');
    const denied = await call(t, host, 'POST', `/v1/properties/${p.id}/publish`);
    expect(denied.body.details.reasons).toEqual(['PERMIT_MISSING:r7.kr11.homestay:SEOUL_HOMESTAY']);

    // the bypass from the report
    expect((await call(t, host, 'PATCH', `/v1/properties/${p.id}`, { region: 'KR-41' })).status).toBe(200);
    const still = await call(t, host, 'POST', `/v1/properties/${p.id}/publish`);
    expect(still.status).toBe(422);
    // the Seoul rule still applies (geocoded jurisdiction), and the region change also voids the BIZ_REG binding
    expect(still.body.details.reasons).toEqual(['PERMIT_SUBJECT_CHANGED:r7.kr.biz:BIZ_REG', 'PERMIT_MISSING:r7.kr11.homestay:SEOUL_HOMESTAY']);
    const r = await evaluatePropertyCompliance(t.pool, p.id, { persist: false });
    expect(r.rulesEvaluated.map((x) => x.split('@')[0]).sort()).toEqual(['r7.kr.biz', 'r7.kr11.homestay']);

    for (const bad of ['Seoul', 'JP-13', 'KR-99', 'KR-11; DROP']) {
      const res = await call(t, host, 'PATCH', `/v1/properties/${p.id}`, { region: bad });
      expect([400, 422], bad).toContain(res.status);
    }
    expect((await call(t, host, 'PATCH', `/v1/properties/${p.id}`, { region: '11' })).body.item.location.region).toBe('KR-11');
    // a permit issued for another jurisdiction does not count
    const foreign = await call(t, host, 'POST', `/v1/properties/${p.id}/permits`, { permitType: 'SEOUL_HOMESTAY', jurisdiction: 'KR-26' });
    await call(t, officerA, 'POST', `/v1/admin/permits/${foreign.body.item.id}/verify`, { reason: 'checked' });
    expect((await evaluatePropertyCompliance(t.pool, p.id, { persist: false })).reasons).toEqual(['PERMIT_JURISDICTION_MISMATCH:r7.kr11.homestay:SEOUL_HOMESTAY']);
  });
});

describe('#9 guest-eligibility constraints are enforced by the paid-booking gate', () => {
  it('foreigners_only: needs a verified foreign guest; unknown constraints and missing guest fail closed', async () => {
    const rule = await approvedRule({ ruleKey: 'r9.kr30', jurisdiction: 'KR-30', appliesTo: { property_type: ['GUESTHOUSE'] }, requiredPermitTypes: [], guestEligibility: { foreigners_only: true } });
    const host = await approvedHost();
    const p = await listing(host, {
      propertyType: 'GUESTHOUSE', rentalEnabled: true, exchangeEnabled: false, basePriceMinor: 50000,
      lat: 36.3504, lng: 127.3845, city: 'Daejeon', region: 'KR-30', address: { line1: '대전 중구 어딘가 1', city: 'Daejeon' },
    });
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/publish`)).body.item.paidBookingEnabled).toBe(true);
    const korean = await createUser(t, { verified: true });
    await t.pool.query(`INSERT INTO user_profiles(user_id, country) VALUES ($1,'KR')`, [korean.id]);
    const foreigner = await createUser(t, { verified: true });
    await t.pool.query(`INSERT INTO user_profiles(user_id, country) VALUES ($1,'US')`, [foreigner.id]);
    const unverified = await createUser(t);
    await t.pool.query(`INSERT INTO user_profiles(user_id, country) VALUES ($1,'US')`, [unverified.id]);

    await expect(assertPaidBookingAllowed(t.pool, p.id)).rejects.toMatchObject({ code: 'GUEST_NOT_ELIGIBLE', details: { reasons: ['GUEST_CONTEXT_REQUIRED'] } });
    await expect(assertPaidBookingAllowed(t.pool, p.id, { guestId: korean.id })).rejects.toMatchObject({ status: 403, code: 'GUEST_NOT_ELIGIBLE', details: { reasons: ['FOREIGNERS_ONLY'] } });
    await expect(assertPaidBookingAllowed(t.pool, p.id, { guestId: unverified.id })).rejects.toMatchObject({ details: { reasons: ['GUEST_IDENTITY_UNVERIFIED'] } });
    await expect(assertPaidBookingAllowed(t.pool, p.id, { guestId: foreigner.id })).resolves.toBeUndefined();

    // an eligibility key the gate does not understand is never silently ignored
    await t.pool.query(`UPDATE compliance_rules SET guest_eligibility = '{"min_stay_registration": true}' WHERE id = $1`, [rule.id]);
    await expect(assertPaidBookingAllowed(t.pool, p.id, { guestId: foreigner.id })).rejects.toMatchObject({ details: { reasons: ['UNSUPPORTED_ELIGIBILITY:min_stay_registration'] } });
  });
});

describe('#10 EXCHANGE-mode compliance rules gate exchange publication', () => {
  it('DENY refuses publication, PENDING permit → IN_REVIEW, verified → PUBLISHED; enabling exchange on a live listing is checked', async () => {
    await approvedRule({ ruleKey: 'r10.kr48.exchange', jurisdiction: 'KR-48', appliesTo: { mode: ['EXCHANGE'] }, requiredPermitTypes: ['EXCHANGE_OK'] });
    await approvedRule({ ruleKey: 'r10.kr48.rental', jurisdiction: 'KR-48', requiredPermitTypes: [] });
    const host = await approvedHost();
    const loc = { lat: 35.228, lng: 128.6811, city: 'Changwon', region: 'KR-48', address: { line1: '창원시 의창구 어딘가 1', city: 'Changwon' } };
    const ex = await listing(host, { ...loc, rentalEnabled: false, exchangeEnabled: true });
    const denied = await call(t, host, 'POST', `/v1/properties/${ex.id}/publish`);
    expect(denied.status).toBe(422);
    expect(denied.body.code).toBe('COMPLIANCE_DENIED');
    expect(denied.body.details.reasons).toEqual(['PERMIT_MISSING:r10.kr48.exchange:EXCHANGE_OK']);
    expect((await t.pool.query(`SELECT status FROM properties WHERE id = $1`, [ex.id])).rows[0].status).toBe('DRAFT');

    // rental + exchange: the exchange rule still applies (no "exchange-only" fallback past a DENY)
    const both = await listing(host, { ...loc, rentalEnabled: true, exchangeEnabled: true, basePriceMinor: 70000 });
    expect((await call(t, host, 'POST', `/v1/properties/${both.id}/publish`)).body.code).toBe('COMPLIANCE_DENIED');

    const permit = await call(t, host, 'POST', `/v1/properties/${ex.id}/permits`, { permitType: 'EXCHANGE_OK', jurisdiction: 'KR-48' });
    const review = await call(t, host, 'POST', `/v1/properties/${ex.id}/publish`);
    expect(review.status).toBe(202);
    expect(review.body.outcome).toBe('IN_REVIEW');
    await call(t, officerA, 'POST', `/v1/admin/permits/${permit.body.item.id}/verify`, { reason: 'registered' });
    expect((await call(t, host, 'POST', `/v1/properties/${ex.id}/publish`)).body.item.status).toBe('PUBLISHED');
    await expect(assertExchangeAllowed(t.pool, ex.id)).resolves.toBeUndefined();

    // a live rental-only listing cannot switch exchange on without meeting the exchange rule
    const rental = await listing(host, { ...loc, rentalEnabled: true, exchangeEnabled: false, basePriceMinor: 70000 });
    expect((await call(t, host, 'POST', `/v1/properties/${rental.id}/publish`)).body.item).toMatchObject({ status: 'PUBLISHED', paidBookingEnabled: true });
    const sw = await call(t, host, 'PATCH', `/v1/properties/${rental.id}`, { exchangeEnabled: true });
    expect(sw.status).toBe(422);
    expect(sw.body.code).toBe('COMPLIANCE_DENIED');
    await expect(assertExchangeAllowed(t.pool, rental.id)).rejects.toMatchObject({ code: 'COMPLIANCE_BLOCKED' });
  });
});

describe('#12/#24 geocoding never runs inside the property write transaction; the Nominatim queue is bounded', () => {
  it('a slow geocoder does not hold the property row lock or a transaction open', async () => {
    const host = await approvedHost();
    const p = (await call(t, host, 'POST', '/v1/properties', { title: 'Slow geocoder draft', propertyType: 'HOUSE' })).body.item;
    const original = t.app.ctx.adapters.get(GEOCODER_ADAPTER);
    let calls = 0;
    const slow: Geocoder = {
      name: 'KAKAO',
      async geocode() {
        calls++;
        await sleep(700);
        return [];
      },
      async reverse() {
        await sleep(700);
        return null;
      },
    };
    t.app.ctx.adapters.set(GEOCODER_ADAPTER, slow);
    const side = new pg.Client({ connectionString: (t.pool as any).options.connectionString });
    await side.connect();
    try {
      const patch = call(t, host, 'PATCH', `/v1/properties/${p.id}`, { address: { line1: '서울 종로구 어딘가 9', city: 'Seoul' } });
      await sleep(250);
      expect(calls).toBe(1); // the geocoder call is in flight right now
      await side.query('BEGIN');
      await expect(side.query(`SELECT id FROM properties WHERE id = $1 FOR UPDATE NOWAIT`, [p.id])).resolves.toBeTruthy();
      await side.query('ROLLBACK');
      const idle = await side.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state = 'idle in transaction'`);
      expect(idle.rows[0].n).toBe(0);
      expect((await patch).status).toBe(200);
    } finally {
      await side.end();
      t.app.ctx.adapters.set(GEOCODER_ADAPTER, original);
    }
  });

  it('a degraded provider leaves the derived jurisdiction "not computed"; the backfill job derives it later', async () => {
    const host = await approvedHost();
    const original = t.app.ctx.adapters.get(GEOCODER_ADAPTER);
    const down: Geocoder = {
      name: 'KAKAO',
      async geocode() {
        throw new Error('provider down');
      },
      async reverse() {
        throw new Error('provider down');
      },
    };
    t.app.ctx.adapters.set(GEOCODER_ADAPTER, down);
    let id: string;
    try {
      const r = await call(t, host, 'POST', '/v1/properties', {
        title: 'Degraded geocoder home', propertyType: 'HOUSE', lat: 37.556, lng: 126.923, region: 'KR-41', address: { line1: '서울 마포구 어딘가 7', city: 'Seoul' },
      });
      expect(r.status).toBe(201);
      id = r.body.item.id;
    } finally {
      t.app.ctx.adapters.set(GEOCODER_ADAPTER, original);
    }
    expect((await t.pool.query(`SELECT geo_jurisdictions FROM properties WHERE id = $1`, [id])).rows[0].geo_jurisdictions).toBeNull();
    expect(await backfillGeoJurisdictions(t.ctx())).toBeGreaterThanOrEqual(1);
    expect((await t.pool.query(`SELECT geo_jurisdictions FROM properties WHERE id = $1`, [id])).rows[0].geo_jurisdictions).toContain('KR-11');
  });

  it('NominatimGeocoder refuses requests whose projected queue wait exceeds the budget; CachedGeocoder falls back to STATIC', async () => {
    let fetches = 0;
    const fakeFetch = (async () => {
      fetches++;
      await sleep(20);
      return new Response('[]');
    }) as any;
    const n = new NominatimGeocoder('JETPOOL-test/1.0', fakeFetch, 'https://nominatim.test', 200, 500);
    const started = Date.now();
    const res = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => n.geocode(`flood ${i}`)));
    const busy = res.filter((r) => r.status === 'rejected' && r.reason instanceof GeocoderBusyError).length;
    expect(busy).toBeGreaterThanOrEqual(8);
    expect(fetches).toBeLessThanOrEqual(4);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(n.queueDepth).toBe(0);

    const cached = new CachedGeocoder(new NominatimGeocoder('JETPOOL-test/1.0', fakeFetch, 'https://nominatim.test', 1000, 100));
    const [a, b] = await Promise.all([cached.geocode('first query'), cached.geocode('서울')]);
    expect(a).toEqual([]);
    expect(b[0]).toMatchObject({ provider: 'STATIC', city: 'Seoul' }); // queue full → static fallback, no wait
  });
});

describe('#15 the permit-expiry sweep is a singleton and does not hold locks on unaffected listings', () => {
  it('does not wait on a locked listing whose paid booking stays on; a concurrent run is skipped', async () => {
    const host = await approvedHost();
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      const { rows } = await t.pool.query(
        `INSERT INTO properties(host_id, title, property_type, status, rental_enabled, paid_booking_enabled, base_price_minor, country, region, lat, lng, published_at)
         VALUES ($1,$2,'HOUSE','PUBLISHED',true,true,50000,'KR','KR-27',35.87,128.60, now()) RETURNING id`,
        [host.id, `sweep ${i}`],
      );
      ids.push(rows[0].id);
    }
    const side = await t.pool.connect();
    try {
      await side.query('BEGIN');
      await side.query(`SELECT id FROM properties WHERE id = $1 FOR UPDATE`, [ids[0]]);
      const res = await Promise.race([runPermitExpiry(t.ctx()), sleep(8000).then(() => 'TIMEOUT' as const)]);
      expect(res).not.toBe('TIMEOUT');
      expect((res as any).reevaluated).toBeGreaterThanOrEqual(20);
    } finally {
      await side.query('ROLLBACK');
      side.release();
    }
    const lock = await t.pool.connect();
    try {
      await lock.query(`SELECT pg_advisory_lock(hashtext('jetpool:compliance.permit-expiry'))`);
      expect(await runPermitExpiry(t.ctx())).toMatchObject({ skipped: true, expired: 0 });
      await lock.query(`SELECT pg_advisory_unlock(hashtext('jetpool:compliance.permit-expiry'))`);
    } finally {
      lock.release();
    }
  });
});

describe('#16 the search projection converges and never skips a late (long-transaction) event', () => {
  it('reconcile reports nothing to do after a normal edit + event; a late event still updates the document', async () => {
    const host = await approvedHost();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await withTx(t.pool, async (tx) => {
        const { rows } = await tx.query(
          `INSERT INTO properties(host_id, slug, title, property_type, status, rental_enabled, paid_booking_enabled, base_price_minor, city, region, lat, lng, published_at)
           VALUES ($1,$2,$3,'HOUSE','PUBLISHED',true,true,50000,'Recon',$4,35.87,128.60, now()) RETURNING id`,
          [host.id, `recon-${i}-${Date.now()}`, `Reconcile probe ${i}`, 'KR-27'],
        );
        await emit(tx, t.ctx(), { aggregateType: 'property', aggregateId: rows[0].id, eventType: 'property.published', payload: { propertyId: rows[0].id } });
        return rows[0].id as string;
      });
      ids.push(id);
    }
    await t.drain();
    for (const id of ids) {
      await withTx(t.pool, async (tx) => {
        await tx.query(`UPDATE properties SET summary = 'edited' WHERE id = $1`, [id]);
        await emit(tx, t.ctx(), { aggregateType: 'property', aggregateId: id, eventType: 'property.updated', payload: { propertyId: id, fields: ['summary'] } });
      });
    }
    await t.drain();
    await reconcileIndex(t.app.ctx); // settle anything else in this database
    expect(await reconcileIndex(t.app.ctx)).toEqual({ reprojected: 0, removed: 0 });
    expect(await reconcileIndex(t.app.ctx)).toEqual({ reprojected: 0, removed: 0 });

    // long transaction: starts first, commits last, its event carries the OLDER timestamp
    const id = ids[0];
    const long = await t.pool.connect();
    try {
      await long.query('BEGIN');
      await long.query('SELECT now()');
      await withTx(t.pool, async (tx) => {
        await tx.query(`UPDATE properties SET title = 'Reconcile probe renamed' WHERE id = $1`, [id]);
        await emit(tx, t.ctx(), { aggregateType: 'property', aggregateId: id, eventType: 'property.updated', payload: { propertyId: id, fields: ['title'] } });
      });
      await t.drain();
      await long.query(`UPDATE properties SET paid_booking_enabled = false WHERE id = $1`, [id]);
      await emit(long, t.ctx(), { aggregateType: 'property', aggregateId: id, eventType: 'listing.blocked', payload: { propertyId: id, scope: 'PAID_BOOKING' } });
      await long.query('COMMIT');
    } finally {
      long.release();
    }
    await t.drain();
    const rental = (await call(t, null, 'GET', '/v1/search/properties?city=Recon&mode=rental')).body.items.map((i: any) => i.id);
    expect(rental).not.toContain(id);
    expect(rental).toEqual(expect.arrayContaining([ids[1], ids[2]]));
  });
});

describe('#18 property timezones must be real IANA zones', () => {
  it('invalid zones are refused by the API and by the database', async () => {
    const host = await approvedHost();
    const p = (await call(t, host, 'POST', '/v1/properties', { title: 'Timezone probe', propertyType: 'HOUSE' })).body.item;
    const bad = await call(t, host, 'PATCH', `/v1/properties/${p.id}`, { timezone: 'Not/AZone' });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('INVALID_TIMEZONE');
    expect((await call(t, host, 'POST', '/v1/properties', { title: 'Timezone probe 2', propertyType: 'HOUSE', timezone: 'Mars/Olympus' })).body.code).toBe('INVALID_TIMEZONE');
    expect((await call(t, host, 'PATCH', `/v1/properties/${p.id}`, { timezone: 'Europe/Paris' })).body.item.timezone).toBe('Europe/Paris');
    await expect(t.pool.query(`UPDATE properties SET timezone = 'Not/AZone' WHERE id = $1`, [p.id])).rejects.toMatchObject({ code: '23514' });
  });
});

describe('#20 calendar-invalid dates are 400s, not 500s', () => {
  it('search, permits and rules validate real calendar dates', async () => {
    for (const qs of ['checkIn=2026-13-01&checkOut=2026-13-05', 'checkIn=2026-02-30&checkOut=2026-03-05']) {
      const r = await call(t, null, 'GET', `/v1/search/properties?${qs}`);
      expect(r.status, qs).toBe(400);
      expect(r.body.code).toBe('INVALID_DATE');
    }
    expect((await call(t, null, 'GET', `/v1/search/properties?checkIn=${day(30)}&checkOut=${day(32)}`)).status).toBe(200);
    const host = await approvedHost();
    const p = (await call(t, host, 'POST', '/v1/properties', { title: 'Date probe', propertyType: 'HOUSE' })).body.item;
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/permits`, { permitType: 'LODGING', jurisdiction: 'KR', validFrom: '2027-02-30' })).status).toBe(400);
    expect((await call(t, host, 'POST', `/v1/properties/${p.id}/permits`, { permitType: 'LODGING', jurisdiction: 'KR', validUntil: '2027-13-01' })).status).toBe(400);
    expect((await call(t, officerA, 'POST', '/v1/admin/compliance/rules', { ruleKey: 'bad.date', jurisdiction: 'KR', effectiveFrom: '2027-02-30' })).status).toBe(400);
    expect((await call(t, officerA, 'POST', '/v1/admin/compliance/rules', { ruleKey: 'leap.day', jurisdiction: 'KR-99', effectiveFrom: '2028-02-29' })).status).toBe(201);
  });
});
