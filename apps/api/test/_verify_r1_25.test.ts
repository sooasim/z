import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { isVerified } from '../src/modules/verification/service.js';
import { hostPublishBlockers } from '../src/modules/hosts/service.js';
import { evaluateEligibility } from '../src/modules/exchange/service.js';
import { evaluateGuideEligibility } from '../src/modules/guide/eligibility.js';

let t: TestApp;
let host: TestUser, compliance: TestUser;

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

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t); // NOT identity verified
  compliance = await createUser(t, { roles: ['COMPLIANCE'] });
});
afterAll(async () => t.close());

describe('R1-25 verification expiry', () => {
  it('expired IDENTITY + HOST approvals keep gating open', async () => {
    // host application approved via HTTP
    const a = await call(t, host, 'POST', '/v1/host-applications', { displayName: 'Expiring Host' });
    expect(a.status).toBe(201);
    expect((await call(t, compliance, 'POST', `/v1/admin/host-applications/${a.body.item.id}/approve`, { reason: 'ok' })).status).toBe(200);

    // IDENTITY + HOST verification approved with an expiry 2 seconds out (stand-in for "ID document expiry date")
    const expiresAt = new Date(Date.now() + 2000).toISOString();
    const vi = await call(t, host, 'POST', '/v1/verifications', { subjectType: 'IDENTITY', documents: [{ documentType: 'ID_CARD', sha256: 'a'.repeat(64) }] });
    const vh = await call(t, host, 'POST', '/v1/verifications', { subjectType: 'HOST', documents: [{ documentType: 'OWNERSHIP', sha256: 'b'.repeat(64) }] });
    const ai = await call(t, compliance, 'POST', `/v1/admin/verifications/${vi.body.item.id}/approve`, { expiresAt });
    const ah = await call(t, compliance, 'POST', `/v1/admin/verifications/${vh.body.item.id}/approve`, { expiresAt });
    console.log('approve IDENTITY ->', ai.status, ai.body.item.status, ai.body.item.expires_at);
    console.log('approve HOST     ->', ah.status, ah.body.item.status, ah.body.item.expires_at);
    expect(ai.status).toBe(200);
    expect(ah.status).toBe(200);
    expect(await hostPublishBlockers(t.pool, host.id)).toEqual([]);

    // real time passes beyond expiry
    await new Promise((r) => setTimeout(r, 3000));
    await t.runJobs();
    await t.drain();
    await t.runJobs();

    const cases = (await t.pool.query(`SELECT subject_type, status, expires_at, expires_at < now() AS expired FROM verification_cases WHERE user_id = $1 ORDER BY subject_type`, [host.id])).rows;
    const u = (await t.pool.query(`SELECT identity_verified_at FROM users WHERE id = $1`, [host.id])).rows[0];
    const hp = (await t.pool.query(`SELECT status, verification_status FROM host_profiles WHERE user_id = $1`, [host.id])).rows[0];
    console.log('cases after expiry:', JSON.stringify(cases));
    console.log('users.identity_verified_at:', u.identity_verified_at);
    console.log('host_profiles:', JSON.stringify(hp));

    const idV = await isVerified(t.pool, host.id, 'IDENTITY');
    const hostV = await isVerified(t.pool, host.id, 'HOST');
    const blockers = await hostPublishBlockers(t.pool, host.id);
    const dash = await call(t, host, 'GET', '/v1/host/me');
    const mine = await call(t, host, 'GET', '/v1/verifications');
    const exch = await evaluateEligibility(t.pool, host.id);
    const guide = await evaluateGuideEligibility(t.pool, host.id, 'FRIEND');
    console.log('isVerified IDENTITY:', idV, ' isVerified HOST:', hostV);
    console.log('hostPublishBlockers:', JSON.stringify(blockers));
    console.log('GET /v1/host/me canPublish:', dash.body.canPublish, 'blockers:', JSON.stringify(dash.body.publishBlockers));
    console.log('GET /v1/verifications summary IDENTITY/HOST:', JSON.stringify(mine.body.summary.IDENTITY), JSON.stringify(mine.body.summary.HOST));
    console.log('exchange eligibility unmet:', JSON.stringify((exch as any).unmet ?? exch));
    console.log('guide eligibility reasons:', JSON.stringify((guide as any).reasons));

    // publish a listing after expiry via HTTP
    const pr = await call(t, host, 'POST', '/v1/properties', {
      title: '서울 북촌 한옥 스테이',
      description: '북촌 골목 안쪽의 조용한 전통 한옥입니다. 대청마루와 작은 마당이 있고 경복궁까지 걸어서 10분 거리입니다.',
      propertyType: 'HANOK', maxGuests: 4, lat: 37.5826, lng: 126.983, city: 'Seoul', region: 'KR-11',
      exchangeEnabled: true, rentalEnabled: true, basePriceMinor: 100000,
      address: { line1: '서울 종로구 북촌로 11길 1', city: 'Seoul', publicAreaLabel: '종로구 북촌' },
      amenities: ['wifi'], houseRules: { petsAllowed: false }, cancellationPolicyCode: 'MODERATE',
    });
    console.log('create property ->', pr.status, pr.body.code ?? '');
    const ids = [await photo(host), await photo(host), await photo(host)];
    await call(t, host, 'PUT', `/v1/properties/${pr.body.item.id}/media`, { items: ids.map((mediaId) => ({ mediaId })) });
    const pub = await call(t, host, 'POST', `/v1/properties/${pr.body.item.id}/publish`);
    console.log('POST /v1/properties/:id/publish after expiry ->', pub.status, JSON.stringify({ outcome: pub.body.outcome, code: pub.body.code, status: pub.body.item?.status }));

    // assertions documenting the defect
    expect(cases.every((c: any) => c.status === 'APPROVED' && c.expired === true)).toBe(true);
    expect(hostV).toBe(false); // case-based predicate does see expiry
    expect(idV).toBe(true); // ...but IDENTITY short-circuits on identity_verified_at
    expect(hp.verification_status).toBe('VERIFIED');
    expect(blockers).toEqual([]);
    expect(dash.body.canPublish).toBe(true);
    expect(pub.status).toBe(200);
    expect(pub.body.outcome).toBe('PUBLISHED');
  }, 30000);
});
