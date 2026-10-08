import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, day, type TestApp, type TestUser } from './helpers.js';
import { hostPublishBlockers } from '../src/modules/hosts/service.js';
import { isVerified } from '../src/modules/verification/service.js';

let t: TestApp;
let host: TestUser, compliance: TestUser, officerB: TestUser;

function png() {
  const b = Buffer.alloc(120);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(1024, 16);
  b.writeUInt32BE(768, 20);
  return b;
}
async function upload(user: TestUser, purpose: string) {
  const bytes = png();
  const r = await call(t, user, 'POST', '/v1/media/upload-url', { purpose, mimeType: 'image/png', byteSize: bytes.length });
  const u = new URL(r.body.upload.url);
  await t.app.inject({ method: 'PUT', url: u.pathname + u.search, payload: bytes, headers: { 'content-type': 'image/png' } });
  return (await call(t, user, 'POST', `/v1/media/${r.body.media.id}/complete`)).body.item.id as string;
}
async function paidListing(title: string) {
  const r = await call(t, host, 'POST', '/v1/properties', {
    title,
    description: 'A bright two-room apartment near Hongdae station with fast wifi, a full kitchen and a small balcony.',
    propertyType: 'APARTMENT', maxGuests: 3, lat: 37.556, lng: 126.923, city: 'Seoul', region: 'KR-11',
    rentalEnabled: true, basePriceMinor: 90000,
    address: { line1: '서울 마포구 어딘가 1', publicAreaLabel: '마포구 서교동' },
  });
  expect(r.status).toBe(201);
  const ids = [await upload(host, 'PROPERTY'), await upload(host, 'PROPERTY'), await upload(host, 'PROPERTY')];
  await call(t, host, 'PUT', `/v1/properties/${r.body.item.id}/media`, { items: ids.map((mediaId) => ({ mediaId })) });
  const id = r.body.item.id as string;
  const doc = await upload(host, 'VERIFICATION');
  const permit = await call(t, host, 'POST', `/v1/properties/${id}/permits`, { permitType: 'URBAN_HOMESTAY', permitNo: `P-${title}`, jurisdiction: 'KR-11', documentMediaId: doc, validFrom: day(-1), validUntil: day(300) });
  expect(permit.status).toBe(201);
  const v = await call(t, compliance, 'POST', `/v1/admin/permits/${permit.body.item.id}/verify`, { reason: 'registry ok' });
  expect(v.body.evaluation.decision).toBe('ALLOW');
  return id;
}

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t);
  compliance = await createUser(t, { roles: ['COMPLIANCE'] });
  officerB = await createUser(t, { roles: ['COMPLIANCE'] });
  const c = await call(t, compliance, 'POST', '/v1/admin/compliance/rules', { ruleKey: 'kr11.urban', jurisdiction: 'KR-11', appliesTo: { property_type: ['APARTMENT'] }, requiredPermitTypes: ['URBAN_HOMESTAY'], effectiveFrom: day(-30) });
  expect(c.status).toBe(201);
  expect((await call(t, officerB, 'POST', `/v1/admin/compliance/rules/${c.body.item.id}/approve`, { reason: 'ok' })).status).toBe(200);
});
afterAll(async () => t.close());

describe('R1-12 expired HOST verification', () => {
  it('still permits paid publication after expiry', async () => {
    // real onboarding through the API
    const a = await call(t, host, 'POST', '/v1/host-applications', { displayName: 'Expiring Host' });
    expect(a.status).toBe(201);
    expect((await call(t, compliance, 'POST', `/v1/admin/host-applications/${a.body.item.id}/approve`, { reason: 'ok' })).status).toBe(200);
    const vc = await call(t, host, 'POST', '/v1/verifications', { subjectType: 'HOST', documents: [{ documentType: 'OWNERSHIP', sha256: 'a'.repeat(64) }] });
    expect(vc.status).toBe(201);
    const expiresAt = new Date(Date.now() + 365 * 86400_000).toISOString();
    const ap = await call(t, compliance, 'POST', `/v1/admin/verifications/${vc.body.item.id}/approve`, { reason: 'docs ok', expiresAt });
    console.log('APPROVE', ap.status, JSON.stringify({ status: ap.body.item?.status, expires_at: ap.body.item?.expires_at ?? ap.body.item?.expiresAt }));
    expect(ap.status).toBe(200);
    await t.drain();
    expect(await isVerified(t.pool, host.id, 'HOST')).toBe(true);
    expect(await hostPublishBlockers(t.pool, host.id)).toEqual([]);

    // time passes: the approval's expiry is now in the past (equivalent to the clock moving past expiresAt)
    await t.pool.query(`UPDATE verification_cases SET expires_at = now() - interval '1 day' WHERE id = $1`, [vc.body.item.id]);
    // run every scheduled job + drain the outbox: nothing should be left un-applied
    await t.runJobs();
    await t.drain();
    await t.runJobs();
    await t.drain();

    const caseRow = (await t.pool.query(`SELECT status, expires_at < now() AS expired FROM verification_cases WHERE id = $1`, [vc.body.item.id])).rows[0];
    const hp = (await t.pool.query(`SELECT status, verification_status FROM host_profiles WHERE user_id = $1`, [host.id])).rows[0];
    const verifiedNow = await isVerified(t.pool, host.id, 'HOST');
    const blockers = await hostPublishBlockers(t.pool, host.id);
    console.log('AFTER EXPIRY case=', JSON.stringify(caseRow), 'host_profile=', JSON.stringify(hp), 'isVerified(HOST)=', verifiedNow, 'blockers=', JSON.stringify(blockers));

    const summary = await call(t, host, 'GET', '/v1/verifications/me').catch(() => null);
    console.log('SUMMARY', summary?.status, JSON.stringify(summary?.body?.summary ?? summary?.body?.HOST ?? summary?.body).slice(0, 400));
    const dash = await call(t, host, 'GET', '/v1/host/me');
    console.log('DASH', dash.status, JSON.stringify({ canPublish: dash.body.canPublish, publishBlockers: dash.body.publishBlockers, hostVerified: dash.body.checklist?.hostVerified, verificationStatus: dash.body.profile?.verificationStatus }));
    const pubHost = await call(t, null, 'GET', `/v1/hosts/${host.id}`);
    console.log('PUBLIC HOST', pubHost.status, JSON.stringify({ verified: pubHost.body.item?.verified }));

    // a NEW paid listing after expiry
    const id = await paidListing('After expiry paid apt');
    const pub = await call(t, host, 'POST', `/v1/properties/${id}/publish`);
    console.log('PUBLISH', pub.status, JSON.stringify({ outcome: pub.body.outcome, code: pub.body.code, status: pub.body.item?.status, paidBookingEnabled: pub.body.item?.paidBookingEnabled, details: pub.body.details }));

    expect(verifiedNow).toBe(false);
    expect(hp.verification_status).toBe('VERIFIED');
    expect(blockers).toEqual([]);
    expect(pub.status).toBe(200);
    expect(pub.body.item).toMatchObject({ status: 'PUBLISHED', paidBookingEnabled: true });
    expect(pubHost.body.item.verified).toBe(true);
    expect(dash.body.canPublish).toBe(true);
    expect(dash.body.checklist.hostVerified).toBe(false);
  });
});
