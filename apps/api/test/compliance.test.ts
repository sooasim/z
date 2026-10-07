import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, day, type TestApp, type TestUser } from './helpers.js';
import { assertPaidBookingAllowed, evaluatePropertyCompliance, runPermitExpiry } from '../src/modules/compliance/service.js';
import { registeredJobs } from '../src/platform/jobs.js';

let t: TestApp;
let host: TestUser;
let stranger: TestUser;
let officerA: TestUser;
let officerB: TestUser;

function png() {
  const b = Buffer.alloc(120);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  return b;
}
async function upload(user: TestUser, purpose: string) {
  const bytes = png();
  const r = await call(t, user, 'POST', '/v1/media/upload-url', { purpose, mimeType: 'image/png', byteSize: bytes.length });
  const u = new URL(r.body.upload.url);
  await t.app.inject({ method: 'PUT', url: u.pathname + u.search, payload: bytes, headers: { 'content-type': 'image/png' } });
  return (await call(t, user, 'POST', `/v1/media/${r.body.media.id}/complete`)).body.item.id as string;
}
async function rentalListing(over: Record<string, unknown> = {}) {
  const r = await call(t, host, 'POST', '/v1/properties', {
    title: 'Mapo rental apartment',
    description: 'A bright two-room apartment near Hongdae station with fast wifi, a full kitchen and a small balcony.',
    propertyType: 'APARTMENT',
    maxGuests: 3,
    lat: 37.556,
    lng: 126.923,
    city: 'Seoul',
    region: 'KR-11',
    rentalEnabled: true,
    basePriceMinor: 90000,
    address: { line1: '서울 마포구 어딘가 1', publicAreaLabel: '마포구 서교동' },
    ...over,
  });
  const ids = [await upload(host, 'PROPERTY'), await upload(host, 'PROPERTY'), await upload(host, 'PROPERTY')];
  await call(t, host, 'PUT', `/v1/properties/${r.body.item.id}/media`, { items: ids.map((mediaId) => ({ mediaId })) });
  return r.body.item.id as string;
}
async function approvedRule(body: Record<string, unknown>) {
  const c = await call(t, officerA, 'POST', '/v1/admin/compliance/rules', body);
  expect(c.status).toBe(201);
  const a = await call(t, officerB, 'POST', `/v1/admin/compliance/rules/${c.body.item.id}/approve`, { reason: 'legal sign-off #1' });
  expect(a.status).toBe(200);
  return a.body.item;
}

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
  await t.pool.query(`INSERT INTO host_profiles(user_id, status, verification_status) VALUES ($1,'APPROVED','VERIFIED')`, [host.id]);
  stranger = await createUser(t);
  officerA = await createUser(t, { roles: ['COMPLIANCE'] });
  officerB = await createUser(t, { roles: ['COMPLIANCE'] });
});
afterAll(async () => t.close());

describe('STAY-03 compliance gate', () => {
  it('fails closed: no approved rule → REVIEW, and paid booking is blocked', async () => {
    const id = await rentalListing();
    const ev = await call(t, host, 'POST', '/v1/compliance/evaluate', { propertyId: id });
    expect(ev.status).toBe(200);
    expect(ev.body.item).toMatchObject({ decision: 'REVIEW', reasons: ['NO_APPROVED_RULE'], paidBookingEnabled: false });
    await expect(assertPaidBookingAllowed(t.pool, id)).rejects.toMatchObject({ status: 403, code: 'COMPLIANCE_BLOCKED' });
    // even if a row were flipped by mistake, the fresh evaluation still blocks
    await t.pool.query(`UPDATE properties SET status = 'PUBLISHED', paid_booking_enabled = true WHERE id = $1`, [id]);
    await expect(assertPaidBookingAllowed(t.pool, id)).rejects.toMatchObject({ code: 'COMPLIANCE_BLOCKED' });
    const n = await t.pool.query(`SELECT count(*)::int AS n FROM compliance_decisions WHERE subject_id = $1`, [id]);
    expect(n.rows[0].n).toBeGreaterThanOrEqual(1);
    // a DRAFT (unapproved) rule never counts
    await call(t, officerA, 'POST', '/v1/admin/compliance/rules', { ruleKey: 'draft.only', jurisdiction: 'KR', requiredPermitTypes: [], effectiveFrom: day(-10) });
    expect((await evaluatePropertyCompliance(t.pool, id, { persist: false })).decision).toBe('REVIEW');
  });

  it('rule management: staff AAL2 only, four-eyes approval, audited', async () => {
    const aal1 = await createUser(t, { roles: ['COMPLIANCE'], aal: 'aal1' });
    const body = { ruleKey: 'kr.test.rule', jurisdiction: 'KR-26', requiredPermitTypes: ['XX_PERMIT'], effectiveFrom: day(0) };
    expect((await call(t, host, 'POST', '/v1/admin/compliance/rules', body)).status).toBe(403);
    expect((await call(t, aal1, 'POST', '/v1/admin/compliance/rules', body)).body.code).toBe('AAL2_REQUIRED');
    const c = await call(t, officerA, 'POST', '/v1/admin/compliance/rules', body);
    expect(c.body.item).toMatchObject({ status: 'DRAFT', jurisdiction: 'KR-26', createdBy: officerA.id });
    expect((await call(t, officerA, 'POST', `/v1/admin/compliance/rules/${c.body.item.id}/approve`, {})).body.code).toBe('FOUR_EYES_REQUIRED');
    const a = await call(t, officerB, 'POST', `/v1/admin/compliance/rules/${c.body.item.id}/approve`, {});
    expect(a.body.item).toMatchObject({ status: 'APPROVED', approvedBy: officerB.id });
    expect((await call(t, officerB, 'POST', `/v1/admin/compliance/rules/${c.body.item.id}/approve`, {})).status).toBe(409);
    const ret = await call(t, officerA, 'POST', `/v1/admin/compliance/rules/${c.body.item.id}/retire`, { reason: 'superseded' });
    expect(ret.body.item.status).toBe('RETIRED');
    const aud = await t.pool.query(`SELECT action FROM audit_logs WHERE resource_id = $1 AND category = 'COMPLIANCE' ORDER BY created_at`, [c.body.item.id]);
    expect(aud.rows.map((r) => r.action)).toEqual(['compliance_rule.created', 'compliance_rule.approved', 'compliance_rule.retired']);
    expect((await call(t, officerA, 'GET', '/v1/admin/compliance/rules?status=RETIRED')).body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('missing permit → DENY; pending → REVIEW; verified → ALLOW and paid publish; expiry job blocks paid booking', async () => {
    await approvedRule({ ruleKey: 'kr11.urban-stay', jurisdiction: 'KR-11', appliesTo: { property_type: ['APARTMENT', 'HOUSE'] }, requiredPermitTypes: ['URBAN_HOMESTAY'], guestEligibility: { foreigners_only: true }, effectiveFrom: day(-30) });
    const id = await rentalListing();
    const denied = await call(t, host, 'POST', `/v1/properties/${id}/publish`);
    expect(denied.status).toBe(422);
    expect(denied.body.code).toBe('COMPLIANCE_DENIED');
    expect(denied.body.details.reasons).toEqual(['PERMIT_MISSING:kr11.urban-stay:URBAN_HOMESTAY']);

    // permit documents must be private verification media owned by the host
    const publicPhoto = await upload(host, 'PROPERTY');
    const badDoc = await call(t, host, 'POST', `/v1/properties/${id}/permits`, { permitType: 'URBAN_HOMESTAY', jurisdiction: 'KR-11', documentMediaId: publicPhoto });
    expect(badDoc.body.code).toBe('MEDIA_PURPOSE_MISMATCH');
    expect((await call(t, stranger, 'POST', `/v1/properties/${id}/permits`, { permitType: 'URBAN_HOMESTAY', jurisdiction: 'KR-11' })).status).toBe(403);
    expect((await call(t, stranger, 'POST', '/v1/compliance/evaluate', { propertyId: id })).status).toBe(403);
    expect((await call(t, host, 'POST', `/v1/properties/${id}/permits`, { permitType: 'URBAN_HOMESTAY', jurisdiction: 'KR-11', validUntil: day(-1) })).body.code).toBe('PERMIT_ALREADY_EXPIRED');

    const doc = await upload(host, 'VERIFICATION');
    const permit = await call(t, host, 'POST', `/v1/properties/${id}/permits`, { permitType: 'URBAN_HOMESTAY', permitNo: 'SEOUL-2026-001', jurisdiction: 'KR-11', documentMediaId: doc, validFrom: day(-1), validUntil: day(30) });
    expect(permit.status).toBe(201);
    expect(permit.body.item.status).toBe('PENDING');
    expect((await evaluatePropertyCompliance(t.pool, id, { persist: false })).decision).toBe('REVIEW');
    const inReview = await call(t, host, 'POST', `/v1/properties/${id}/publish`);
    expect(inReview.body.outcome).toBe('IN_REVIEW');
    expect((await call(t, host, 'GET', `/v1/properties/${id}/permits`)).body.items).toHaveLength(1);
    expect((await call(t, stranger, 'GET', `/v1/properties/${id}/permits`)).status).toBe(403);

    // verification is staff-only and audited
    expect((await call(t, host, 'POST', `/v1/admin/permits/${permit.body.item.id}/verify`, {})).status).toBe(403);
    expect((await call(t, officerA, 'GET', '/v1/admin/permits')).body.items.some((p: any) => p.id === permit.body.item.id)).toBe(true);
    const v = await call(t, officerA, 'POST', `/v1/admin/permits/${permit.body.item.id}/verify`, { reason: 'checked with registry' });
    expect(v.status).toBe(200);
    expect(v.body.item.status).toBe('VERIFIED');
    expect(v.body.evaluation.decision).toBe('ALLOW');
    const aud = await t.pool.query(`SELECT category FROM audit_logs WHERE resource_id = $1 AND action = 'permit.verified'`, [permit.body.item.id]);
    expect(aud.rows[0].category).toBe('COMPLIANCE');
    expect((await call(t, officerA, 'POST', `/v1/admin/permits/${permit.body.item.id}/verify`, {})).status).toBe(409);

    const pub = await call(t, host, 'POST', `/v1/properties/${id}/publish`);
    expect(pub.status).toBe(200);
    expect(pub.body.item).toMatchObject({ status: 'PUBLISHED', paidBookingEnabled: true });
    await expect(assertPaidBookingAllowed(t.pool, id)).resolves.toBeUndefined();

    // permit validity ends → daily job expires it, re-evaluates and switches paid booking off
    expect(registeredJobs().map((j) => j.name)).toContain('compliance.permit-expiry');
    await t.pool.query(`UPDATE property_permits SET valid_from = $2, valid_until = $3 WHERE id = $1`, [permit.body.item.id, day(-40), day(-1)]);
    const res = await runPermitExpiry(t.ctx());
    expect(res.expired).toBe(1);
    expect(res.blocked).toBeGreaterThanOrEqual(1);
    const row = await t.pool.query(`SELECT p.paid_booking_enabled, p.status, pp.status AS permit FROM properties p JOIN property_permits pp ON pp.property_id = p.id WHERE p.id = $1`, [id]);
    expect(row.rows[0]).toMatchObject({ paid_booking_enabled: false, permit: 'EXPIRED', status: 'PUBLISHED' });
    const evs = await t.pool.query(`SELECT event_type FROM outbox_events WHERE (payload->>'propertyId') = $1`, [id]);
    expect(evs.rows.map((e) => e.event_type)).toEqual(expect.arrayContaining(['compliance.verified', 'compliance.expired', 'listing.blocked']));
    await expect(assertPaidBookingAllowed(t.pool, id)).rejects.toMatchObject({ code: 'COMPLIANCE_BLOCKED' });
    expect((await evaluatePropertyCompliance(t.pool, id)).reasons).toEqual(['PERMIT_EXPIRED:kr11.urban-stay:URBAN_HOMESTAY']);
  });

  it('applies_to filters, jurisdiction scoping and effective dates', async () => {
    // HANOK is not covered by the KR-11 rule (property_type filter) → no matching rule → REVIEW
    const hanok = await rentalListing({ propertyType: 'HANOK' });
    expect((await evaluatePropertyCompliance(t.pool, hanok, { persist: false })).reasons).toEqual(['NO_APPROVED_RULE']);
    // a future-dated rule does not apply yet
    await approvedRule({ ruleKey: 'kr49.future', jurisdiction: 'KR-49', requiredPermitTypes: [], effectiveFrom: day(30) });
    const jeju = await rentalListing({ region: 'KR-49', city: 'Jeju' });
    expect((await evaluatePropertyCompliance(t.pool, jeju, { persist: false })).decision).toBe('REVIEW');
    // a rule with no required permits for the jurisdiction allows paid booking
    await approvedRule({ ruleKey: 'kr49.now', jurisdiction: 'KR-49', requiredPermitTypes: [], effectiveFrom: day(-1) });
    const r = await evaluatePropertyCompliance(t.pool, jeju, { persist: false });
    expect(r.decision).toBe('ALLOW');
    expect(r.rulesEvaluated[0]).toMatch(/^kr49\.now@/);
    // exchange-only listing: publishable but never paid-bookable
    const ex = await rentalListing({ rentalEnabled: false, exchangeEnabled: true, region: 'KR-26' });
    expect((await evaluatePropertyCompliance(t.pool, ex, { persist: false })).reasons).toEqual(['NO_PAID_BOOKING']);
    await expect(assertPaidBookingAllowed(t.pool, ex)).rejects.toMatchObject({ code: 'COMPLIANCE_BLOCKED' });
  });

  it('permit rejection requires a reason and keeps paid booking off', async () => {
    const id = await rentalListing();
    const p = await call(t, host, 'POST', `/v1/properties/${id}/permits`, { permitType: 'URBAN_HOMESTAY', jurisdiction: 'KR-11' });
    expect((await call(t, officerA, 'POST', `/v1/admin/permits/${p.body.item.id}/reject`, {})).body.code).toBe('REASON_REQUIRED');
    const rj = await call(t, officerA, 'POST', `/v1/admin/permits/${p.body.item.id}/reject`, { reason: 'document unreadable' });
    expect(rj.body.item.status).toBe('REJECTED');
    expect(rj.body.evaluation).toMatchObject({ decision: 'DENY', paidBookingEnabled: false });
  });
});
