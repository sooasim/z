/**
 * G4 end-to-end release gate — Guide Friend chain, driven over HTTP only (call(t, user, ...)).
 *
 * Scenario FREE: a FRIEND guide verifies identity through the TRUST-01 API flow (private document upload →
 * verification case → staff review/approval), creates a profile and availability, publishes (GUIDE role) →
 * a traveler finds the guide with /v1/search/guides by city/language → request → free offer → accept
 * (Idempotency-Key) → booking CONFIRMED with a GUIDE_BOOKING conversation and no payment object → start →
 * complete → traveler review → REVIEWED via the outbox (t.drain()).
 *
 * Scenario PAID: G9 references are configured through their APIs (GUIDE fee/tax finance rules with
 * maker-checker, GUIDE/PAID compliance rule with four-eyes approval, guide.paid flag via the admin flag API) →
 * PAID guide submits a qualification → compliance verifies → publish with paid_enabled → request → paid offer
 * → accept (time held, ACCEPTED) → payments prepare (GUIDE_BOOKING) → MOCK confirm → CONFIRMED → ledger
 * postings and trial balance → traveler cancels ≥24h before start → full refund executed by the outbox →
 * compensating ledger reversal, balanced, all balances back to zero.
 *
 * Scenario NEGATIVE: free guides cannot price; paid publication is denied without an approved rule and while
 * guide.paid is OFF (and paid selling / payment are refused); double booking of the same guide time → 409
 * (pre-check, sequential and concurrent accepts).
 *
 * Test-setup hooks without an API (documented, no SQL anywhere in this file):
 *  - accounts are created with createUser() (no e-mail signup here: the signup chain is covered by e2e-stay);
 *    guides are created WITHOUT identity verification and get it through the TRUST-01 HTTP flow;
 *  - staff accounts (ADMIN+COMPLIANCE, a second COMPLIANCE officer, two ACCOUNTING users) are created at AAL2
 *    (staff MFA onboarding is out of scope of this chain);
 *  - the dev "presigned PUT" of the media pipeline is performed with t.app.inject (unauthenticated, HMAC token in URL);
 *  - t.drain() / t.runJobs() stand in for the outbox worker and the job scheduler.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createTestApp, createUser, call, day, idem, type TestApp, type TestUser } from './helpers.js';
import { applyBps } from '../src/platform/money.js';

// ------------------------------------------------------------------------------------------------ fixtures

const PRICE = 50_000; // paid offer price (KRW minor units)
const HOURLY = 30_000; // paid guide's advertised hourly price
const PLATFORM_FEE_BPS = 1000; // 10% platform fee withheld from the guide's gross
const TAX_BPS = 1000; // 10% VAT on the platform fee
const PLATFORM_FEE = applyBps(PRICE, PLATFORM_FEE_BPS);
const TAX = applyBps(PLATFORM_FEE, TAX_BPS);
const GUIDE_NET = PRICE - PLATFORM_FEE;
const FEE_REVENUE = PRICE - GUIDE_NET - TAX;
const PAID_RULE_KEY = 'kr-guide-paid-business-registration';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Minute-aligned reference instant: every window in this file is derived from it (deterministic intervals). */
const T0 = Math.ceil(Date.now() / MIN) * MIN;
const ts = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();
const win = (fromMs: number, toMs: number) => ({ startAt: ts(fromMs), endAt: ts(toMs) });
const iso = (v: string | Date) => new Date(v).toISOString();

/** FRIEND guide availability: a near-term slot (activity starts within the 30-minute early-start window) and a later one. */
const FREE_SLOT = win(5 * MIN, 6 * HOUR);
const FREE_BOOK = win(15 * MIN, 75 * MIN);
const LATER_SLOT = win(5 * DAY, 5 * DAY + 10 * HOUR);
/** Paid activity ≥ 24h ahead so a traveler cancellation is fully refundable. */
const PAID_WIN = win(3 * DAY, 3 * DAY + 2 * HOUR);

const sha256hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const pdf = (label: string) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(`% ${label} ${randomUUID()}\n`), Buffer.alloc(256, 0x20), Buffer.from('\n%%EOF\n')]);
const show = (r: { status: number; body: any }) => JSON.stringify(r.body);

// ------------------------------------------------------------------------------------------------ state

let t: TestApp;
let admin: TestUser; // ADMIN + COMPLIANCE, AAL2
let compliance2: TestUser; // second compliance officer (four-eyes)
let acctA: TestUser; // ACCOUNTING maker
let acctB: TestUser; // ACCOUNTING checker
let outsider: TestUser;
let friendGuide: TestUser;
let traveler: TestUser;
let paidGuide: TestUser;
let paidTraveler: TestUser;
let rival: TestUser; // traveler whose overlapping request waits while the paid booking holds the time

let freeRequestId: string;
let freeBookingId: string;
let freeConversationId: string;
let paidRuleId: string;
let qualificationId: string;
let paidRequestId: string;
let paidBookingId: string;
let paymentId: string;
let approvalTxId: string;
let rivalRequestId: string;

// ------------------------------------------------------------------------------------------------ helpers

async function upload(user: TestUser, purpose: string, mimeType: string, bytes: Buffer) {
  const sha = sha256hex(bytes);
  const r = await call(t, user, 'POST', '/v1/media/upload-url', { purpose, mimeType, byteSize: bytes.length, sha256: sha });
  expect(r.status, show(r)).toBe(201);
  expect(r.body.media).toMatchObject({ status: 'UPLOADING', visibility: 'PRIVATE', publicUrl: null });
  const u = new URL(r.body.upload.url);
  const put = await t.app.inject({ method: 'PUT', url: u.pathname + u.search, payload: bytes, headers: { 'content-type': mimeType } });
  expect(put.statusCode, put.body).toBe(200);
  const c = await call(t, user, 'POST', `/v1/media/${r.body.media.id}/complete`);
  expect(c.status, show(c)).toBe(200);
  expect(c.body.item).toMatchObject({ status: 'READY', visibility: 'PRIVATE', publicUrl: null });
  return { id: c.body.item.id as string, sha256: sha };
}

/** TRUST-01 identity verification over HTTP: private document → case → staff start-review → approve. */
async function verifyIdentity(user: TestUser) {
  const before = await call(t, user, 'GET', '/v1/me');
  expect(before.body.user.identityVerified).toBe(false);
  const doc = await upload(user, 'VERIFICATION', 'application/pdf', pdf('national id card'));
  const vc = await call(t, user, 'POST', '/v1/verifications', { subjectType: 'IDENTITY', documents: [{ documentType: 'NATIONAL_ID_CARD', mediaId: doc.id, sha256: doc.sha256 }] });
  expect(vc.status, show(vc)).toBe(201);
  expect(vc.body.item).toMatchObject({ status: 'SUBMITTED', subject_type: 'IDENTITY', user_id: user.id });
  const caseId = vc.body.item.id as string;
  // a user can neither use the staff queue nor approve their own case
  expect((await call(t, user, 'POST', `/v1/admin/verifications/${caseId}/approve`, {})).status).toBe(403);
  const queue = await call(t, admin, 'GET', '/v1/admin/verifications?subjectType=IDENTITY');
  expect(queue.status, show(queue)).toBe(200);
  expect(queue.body.items.map((i: any) => i.id)).toContain(caseId);
  const sr = await call(t, admin, 'POST', `/v1/admin/verifications/${caseId}/start-review`);
  expect(sr.status, show(sr)).toBe(200);
  expect(sr.body.item.status).toBe('IN_REVIEW');
  const ok = await call(t, admin, 'POST', `/v1/admin/verifications/${caseId}/approve`, { reason: 'ID document matches the account holder' });
  expect(ok.status, show(ok)).toBe(200);
  expect(ok.body.item).toMatchObject({ status: 'APPROVED', reviewer_id: admin.id });
  const me = await call(t, user, 'GET', '/v1/me');
  expect(me.body.user.identityVerified).toBe(true);
  const mine = await call(t, user, 'GET', '/v1/verifications');
  expect(mine.status).toBe(200);
  expect(mine.body.summary.IDENTITY).toEqual({ verified: true, status: 'APPROVED' });
  return caseId;
}

async function searchGuides(params: Record<string, string | number | boolean>, user: TestUser | null = null) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const r = await call(t, user, 'GET', `/v1/search/guides?${qs}`);
  expect(r.status, show(r)).toBe(200);
  return r.body as { items: any[]; weights: Record<string, number> };
}
const searchIds = async (params: Record<string, string | number | boolean>, user: TestUser | null = null) =>
  (await searchGuides(params, user)).items.map((i) => i.guide.guideId as string);

async function requestGuide(u: TestUser, guideId: string, w: { startAt: string; endAt: string }, extra: Record<string, unknown> = {}) {
  const r = await call(t, u, 'POST', '/v1/guide-requests', { guideId, ...w, partySize: 2, ...extra });
  expect(r.status, show(r)).toBe(201);
  expect(r.body.item).toMatchObject({ status: 'REQUESTED', traveler_id: u.id, guide_id: guideId, current_offer_version: 0 });
  return r.body.item.id as string;
}

async function offer(g: TestUser, requestId: string, w: { startAt: string; endAt: string }, paid: boolean, priceMinor = 0) {
  return call(t, g, 'POST', `/v1/guide-requests/${requestId}/offers`, { ...w, paid, priceMinor, itinerary: 'Meet at the station, market walk, tea house' });
}

async function getBooking(u: TestUser, id: string) {
  const r = await call(t, u, 'GET', `/v1/guide-bookings/${id}`);
  expect(r.status, show(r)).toBe(200);
  return r.body.item;
}

async function getRequest(u: TestUser, id: string) {
  const r = await call(t, u, 'GET', `/v1/guide-requests/${id}`);
  expect(r.status, show(r)).toBe(200);
  return r.body.item;
}

async function getPayment(u: TestUser, id: string) {
  const r = await call(t, u, 'GET', `/v1/payments/${id}`);
  expect(r.status, show(r)).toBe(200);
  return r.body.item;
}

async function notifications(user: TestUser) {
  const r = await call(t, user, 'GET', '/v1/notifications?limit=100');
  expect(r.status, show(r)).toBe(200);
  return r.body.items as Array<{ templateKey: string; data: any }>;
}
const noteFor = async (user: TestUser, key: string, match: (d: any) => boolean = () => true) =>
  (await notifications(user)).find((n) => n.templateKey === key && match(n.data ?? {}));

async function auditActions(category: string) {
  const r = await call(t, admin, 'GET', `/v1/admin/audit-logs?category=${category}&limit=200`);
  expect(r.status, show(r)).toBe(200);
  return r.body.items as Array<{ action: string; resource_type: string; resource_id: string | null; category: string; actor_id: string | null }>;
}

async function trialBalance() {
  const tb = await call(t, acctA, 'GET', '/v1/admin/ledger/trial-balance');
  expect(tb.status, show(tb)).toBe(200);
  return tb.body;
}

async function ledgerBalance(code: string) {
  const r = await call(t, acctA, 'GET', '/v1/admin/ledger/accounts?currency=KRW');
  expect(r.status, show(r)).toBe(200);
  return (r.body.items.find((a: any) => a.code === code)?.balance_minor ?? 0) as number;
}

async function ledgerTxs(sourceType: string, sourceId: string) {
  const r = await call(t, acctA, 'GET', `/v1/admin/ledger/transactions?sourceType=${sourceType}&sourceId=${sourceId}`);
  expect(r.status, show(r)).toBe(200);
  return r.body.items as Array<{ id: string; type: string; reversesTransactionId: string | null; entries: Array<{ account: string; debitMinor: number; creditMinor: number; currency: string }> }>;
}

async function setPaidFlag(enabled: boolean, reason: string) {
  const r = await call(t, admin, 'PATCH', '/v1/admin/feature-flags', { flagKey: 'guide.paid', enabled, reason });
  expect(r.status, show(r)).toBe(200);
  expect(r.body.item).toMatchObject({ flag_key: 'guide.paid', enabled });
}

async function assertOutboxHealthy() {
  await t.drain();
  const ov = await call(t, admin, 'GET', '/v1/admin/overview');
  expect(ov.status, show(ov)).toBe(200);
  const dl = await call(t, admin, 'GET', '/v1/admin/outbox/dead-letters');
  expect(ov.body.outbox, `outbox not drained cleanly; dead letters: ${JSON.stringify(dl.body)}`).toMatchObject({ pending: 0, deadLetters: 0 });
}

/** Verified identity + profile + VERIFIED business registration (used for additional paid guides). */
async function qualifiedPaidGuide(name: string) {
  const g = await createUser(t, { displayName: name });
  await verifyIdentity(g);
  const p = await call(t, g, 'POST', '/v1/guides/profile', { guideType: 'PAID', hourlyPriceMinor: HOURLY, city: 'Seoul', languages: ['ko', 'en'], interests: ['history'] });
  expect(p.status, show(p)).toBe(201);
  const doc = await upload(g, 'VERIFICATION', 'application/pdf', pdf('business registration'));
  const q = await call(t, g, 'POST', '/v1/guides/qualifications', { qualificationType: 'BUSINESS_REGISTRATION', documentMediaId: doc.id, referenceNo: '220-81-00000', validUntil: day(365) });
  expect(q.status, show(q)).toBe(201);
  const v = await call(t, admin, 'POST', `/v1/admin/guide-qualifications/${q.body.item.id}/verify`, {});
  expect(v.status, show(v)).toBe(200);
  return g;
}

// ------------------------------------------------------------------------------------------------ setup

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN', 'COMPLIANCE'], aal: 'aal2', displayName: 'Ops Admin' });
  compliance2 = await createUser(t, { roles: ['COMPLIANCE'], aal: 'aal2', displayName: 'Compliance Officer' });
  acctA = await createUser(t, { roles: ['ACCOUNTING'], aal: 'aal2', displayName: 'Accountant A' });
  acctB = await createUser(t, { roles: ['ACCOUNTING'], aal: 'aal2', displayName: 'Accountant B' });
  outsider = await createUser(t, { displayName: 'Outsider' });
});
afterAll(async () => t?.close());

// ------------------------------------------------------------------------------------------------ FREE

describe('G4 E2E — Guide Friend FREE chain (HTTP only)', () => {
  it('F1. FRIEND guide: profile → publication gated on identity → TRUST-01 verification → availability → publish (GUIDE role)', async () => {
    friendGuide = await createUser(t, { displayName: 'Jisoo Friend' });
    const p = await call(t, friendGuide, 'POST', '/v1/guides/profile', {
      guideType: 'FRIEND',
      headline: 'Local foodie showing Jongno alleys',
      bio: 'Born and raised in Seoul; I love showing visitors the old markets and palaces.',
      languages: ['ko', 'en', 'ja'],
      regions: ['Jongno'],
      interests: ['food', 'history'],
      specialties: ['palaces'],
      city: 'Seoul',
      lat: 37.5796,
      lng: 126.977,
      maxGroupSize: 4,
    });
    expect(p.status, show(p)).toBe(201);
    expect(p.body.item).toMatchObject({
      user_id: friendGuide.id, guide_type: 'FRIEND', status: 'DRAFT', paid_enabled: false, hourly_price_minor: null, currency: 'KRW',
      languages: ['ko', 'en', 'ja'], regions: ['jongno'], interests: ['food', 'history'], max_group_size: 4, city: 'Seoul',
    });
    expect((await call(t, friendGuide, 'POST', '/v1/guides/profile', { guideType: 'FRIEND' })).status).toBe(409);
    expect((await call(t, null, 'GET', `/v1/guides/${friendGuide.id}`)).status).toBe(404); // drafts are not public

    // invariant 7 analogue for free guides: identity verification is required for every type
    const denied = await call(t, friendGuide, 'POST', '/v1/guides/profile/publish');
    expect(denied.status, show(denied)).toBe(422);
    expect(denied.body.code).toBe('GUIDE_PUBLICATION_DENIED');
    expect(denied.body.details.reasons).toEqual(['IDENTITY_NOT_VERIFIED']);
    const me0 = await call(t, friendGuide, 'GET', '/v1/guides/me');
    expect(me0.status).toBe(200);
    expect(me0.body.item.status).toBe('DRAFT');
    expect(me0.body.eligibility).toMatchObject({ guideType: 'FRIEND', identityVerified: false, publishable: false, paidAllowed: false });

    await verifyIdentity(friendGuide);
    const me1 = await call(t, friendGuide, 'GET', '/v1/guides/me');
    expect(me1.body.eligibility).toMatchObject({ identityVerified: true, publishable: true, reasons: [] });

    // availability: two concrete slots
    const av = await call(t, friendGuide, 'PUT', '/v1/guides/me/availability', { slots: [FREE_SLOT, LATER_SLOT] });
    expect(av.status, show(av)).toBe(200);
    expect(av.body.item).toEqual({ removed: 0, added: 2 });
    expect((await call(t, null, 'GET', `/v1/guides/${friendGuide.id}/availability?from=${encodeURIComponent(FREE_SLOT.startAt)}&to=${encodeURIComponent(FREE_SLOT.endAt)}`)).status).toBe(404);

    expect((await call(t, friendGuide, 'GET', '/v1/me')).body.user.roles).not.toContain('GUIDE');
    const pub = await call(t, friendGuide, 'POST', '/v1/guides/profile/publish');
    expect(pub.status, show(pub)).toBe(200);
    expect(pub.body.item).toMatchObject({ status: 'PUBLISHED', paid_enabled: false, verification_status: 'VERIFIED', guide_type: 'FRIEND' });
    expect(pub.body.eligibility).toMatchObject({ publishable: true, paidAllowed: false, identityVerified: true, reasons: [] });
    expect((await call(t, friendGuide, 'GET', '/v1/me')).body.user.roles).toContain('GUIDE');

    const pv = await call(t, null, 'GET', `/v1/guides/${friendGuide.id}`);
    expect(pv.status, show(pv)).toBe(200);
    expect(pv.body.item).toMatchObject({
      guideId: friendGuide.id, displayName: 'Jisoo Friend', guideType: 'FRIEND', free: true, paidEnabled: false, hourlyPriceMinor: null,
      verified: true, city: 'Seoul', languages: ['ko', 'en', 'ja'], approxLat: 37.58, approxLng: 126.98, ratingAvg: null, reviewCount: 0, maxGroupSize: 4,
    });
    expect(JSON.stringify(pv.body)).not.toContain('37.5796'); // only the coarse location is public

    const free = await call(t, null, 'GET', `/v1/guides/${friendGuide.id}/availability?from=${encodeURIComponent(FREE_SLOT.startAt)}&to=${encodeURIComponent(FREE_SLOT.endAt)}`);
    expect(free.status, show(free)).toBe(200);
    expect(free.body.items).toEqual([FREE_SLOT]);

    const perm = await auditActions('PERMISSION');
    expect(perm).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'role.granted', resource_id: friendGuide.id })]));
    const comp = await auditActions('COMPLIANCE');
    expect(comp).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'guide.published', resource_id: friendGuide.id }),
      expect.objectContaining({ action: 'verification.approved', actor_id: admin.id }),
    ]));
  });

  it('F2. traveler discovers the guide with /v1/search/guides by city and language (ranked, explained, availability-aware)', async () => {
    traveler = await createUser(t, { displayName: 'Alex Traveler' });
    const res = await searchGuides({ city: 'seoul', languages: 'ja,en', interests: 'food', from: FREE_BOOK.startAt, to: FREE_BOOK.endAt }, traveler);
    expect(res.weights).toEqual({ language: 0.35, interest: 0.25, availability: 0.2, rating: 0.1, distance: 0.1 });
    expect(res.items.map((i) => i.guide.guideId)).toEqual([friendGuide.id]);
    const hit = res.items[0];
    expect(hit.availability).toBe('AVAILABLE');
    expect(hit.components).toEqual({ language: 1, interest: 1, availability: 1, rating: 0.6 });
    expect(hit.score).toBeCloseTo((0.35 + 0.25 + 0.2 + 0.1 * 0.6) / 0.9, 4);
    expect(hit.explanation.join(' | ')).toMatch(/Speaks ja, en \(2\/2 requested languages\)/);
    expect(hit.explanation.join(' | ')).toMatch(/Shares interests: food/);
    expect(hit.guide).toMatchObject({ guideId: friendGuide.id, guideType: 'FRIEND', free: true, hourlyPriceMinor: null });
    expect(JSON.stringify(hit)).not.toContain('37.5796');

    expect(await searchIds({ city: 'Seoul', languages: 'ko', availableOnly: true, from: FREE_BOOK.startAt, to: FREE_BOOK.endAt })).toEqual([friendGuide.id]);
    expect(await searchIds({ city: 'Seoul', pricing: 'free' })).toEqual([friendGuide.id]);
    expect(await searchIds({ city: 'Seoul', pricing: 'paid' })).toEqual([]);
    expect(await searchIds({ city: 'Seoul', languages: 'de' })).toEqual([]);
    expect(await searchIds({ city: 'Busan', languages: 'en' })).toEqual([]);
    expect(await searchIds({ city: 'Seoul', types: 'PAID,PROFESSIONAL' })).toEqual([]);
    // the guide never sees themself
    expect(await searchIds({ city: 'Seoul' }, friendGuide)).toEqual([]);
    const bad = await call(t, null, 'GET', `/v1/search/guides?city=Seoul&from=${encodeURIComponent(FREE_BOOK.startAt)}`);
    expect(bad.status).toBe(400);
  });

  it('F3. request → free offer → accept (Idempotency-Key) → CONFIRMED with conversation and no payment object', async () => {
    const tooBig = await call(t, traveler, 'POST', '/v1/guide-requests', { guideId: friendGuide.id, ...FREE_BOOK, partySize: 5 });
    expect(tooBig.status).toBe(422);
    expect(tooBig.body.code).toBe('PARTY_TOO_LARGE');
    const past = await call(t, traveler, 'POST', '/v1/guide-requests', { guideId: friendGuide.id, startAt: ts(-2 * HOUR), endAt: ts(-HOUR) });
    expect(past.status).toBe(422);
    expect(past.body.code).toBe('START_IN_PAST');

    freeRequestId = await requestGuide(traveler, friendGuide.id, FREE_BOOK, { city: 'Seoul', languages: ['en'], interests: ['food'], message: 'Street food walk for two, please!' });
    const asGuide = await call(t, friendGuide, 'GET', '/v1/guide-requests?role=guide');
    expect(asGuide.body.items.map((x: any) => x.id)).toContain(freeRequestId);
    expect((await call(t, outsider, 'GET', `/v1/guide-requests/${freeRequestId}`)).status).toBe(404);
    expect(await noteFor(friendGuide, 'guide.request.received', (d) => d.requestId === freeRequestId)).toBeTruthy();

    // only the addressed guide may offer
    const byOutsider = await offer(outsider, freeRequestId, FREE_BOOK, false);
    expect(byOutsider.status).toBe(403);
    expect(byOutsider.body.code).toBe('NOT_REQUEST_GUIDE');
    expect((await offer(traveler, freeRequestId, FREE_BOOK, false)).status).toBe(403);

    const o = await offer(friendGuide, freeRequestId, FREE_BOOK, false);
    expect(o.status, show(o)).toBe(201);
    expect(o.body.item).toMatchObject({ id: freeRequestId, status: 'OFFERED', current_offer_version: 1, guide_id: friendGuide.id });
    expect(o.body.offer).toMatchObject({ version: 1, paid: false, price_minor: 0, currency: 'KRW', status: 'OPEN', created_by: friendGuide.id });
    expect(iso(o.body.offer.start_at)).toBe(FREE_BOOK.startAt);
    expect(await noteFor(traveler, 'guide.offer.received', (d) => d.requestId === freeRequestId && d.offerVersion === 1)).toBeTruthy();

    const own = await call(t, friendGuide, 'POST', `/v1/guide-requests/${freeRequestId}/accept`, { offerVersion: 1 }, idem());
    expect(own.status).toBe(403);
    expect(own.body.code).toBe('CANNOT_ACCEPT_OWN_OFFER');
    const noKey = await call(t, traveler, 'POST', `/v1/guide-requests/${freeRequestId}/accept`, { offerVersion: 1 });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const stale = await call(t, traveler, 'POST', `/v1/guide-requests/${freeRequestId}/accept`, { offerVersion: 2 }, idem());
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OFFER_VERSION_MISMATCH');

    const key = idem();
    const a = await call(t, traveler, 'POST', `/v1/guide-requests/${freeRequestId}/accept`, { offerVersion: 1 }, key);
    expect(a.status, show(a)).toBe(201);
    expect(a.body.item).toMatchObject({ id: freeRequestId, status: 'ACCEPTED' });
    expect(a.body.offer).toMatchObject({ version: 1, status: 'ACCEPTED' });
    const b = a.body.booking;
    expect(b).toMatchObject({
      status: 'CONFIRMED', paid: false, price_minor: 0, refunded_minor: 0, currency: 'KRW', guide_type: 'FRIEND',
      guide_id: friendGuide.id, traveler_id: traveler.id, request_id: freeRequestId, offer_id: o.body.offer.id,
    });
    expect([iso(b.start_at), iso(b.end_at)]).toEqual([FREE_BOOK.startAt, FREE_BOOK.endAt]);
    expect(b.conversation_id).toBeTruthy();
    freeBookingId = b.id;
    freeConversationId = b.conversation_id;

    const replay = await call(t, traveler, 'POST', `/v1/guide-requests/${freeRequestId}/accept`, { offerVersion: 1 }, key);
    expect(replay.status).toBe(201);
    expect(replay.body.booking.id).toBe(freeBookingId);
    const reused = await call(t, traveler, 'POST', `/v1/guide-requests/${freeRequestId}/accept`, { offerVersion: 2 }, key);
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const again = await call(t, traveler, 'POST', `/v1/guide-requests/${freeRequestId}/accept`, { offerVersion: 1 }, idem());
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
    const mine = await call(t, traveler, 'GET', '/v1/guide-bookings?role=traveler');
    expect(mine.status).toBe(200);
    expect(mine.body.items.filter((x: any) => x.request_id === freeRequestId).map((x: any) => x.id)).toEqual([freeBookingId]);

    const rq = await getRequest(traveler, freeRequestId);
    expect(rq.status).toBe('ACCEPTED');
    expect(rq.offers.map((x: any) => [x.version, x.status])).toEqual([[1, 'ACCEPTED']]);
    expect(rq.booking).toEqual({ id: freeBookingId, status: 'CONFIRMED' });

    // free booking confirms with NO payment object; it is not payable
    const pays = await call(t, traveler, 'GET', '/v1/payments');
    expect(pays.status).toBe(200);
    expect(pays.body.items.filter((x: any) => x.subjectId === freeBookingId)).toEqual([]);
    const prep = await call(t, traveler, 'POST', '/v1/payments/toss/prepare', { subjectType: 'GUIDE_BOOKING', subjectId: freeBookingId }, idem());
    expect(prep.status, show(prep)).toBe(409);
    expect(prep.body.code).toBe('NOT_PAYABLE');

    const detail = await getBooking(friendGuide, freeBookingId);
    expect(detail.status).toBe('CONFIRMED');
    expect(detail.history.map((h: any) => [h.from_state, h.to_state])).toEqual([[null, 'ACCEPTED'], ['ACCEPTED', 'CONFIRMED']]);
    expect((await call(t, outsider, 'GET', `/v1/guide-bookings/${freeBookingId}`)).status).toBe(404);

    // GUIDE_BOOKING conversation: both parties (only)
    const tl = await call(t, traveler, 'GET', '/v1/conversations');
    expect(tl.status, show(tl)).toBe(200);
    const conv = tl.body.items.find((c: any) => c.contextType === 'GUIDE_BOOKING' && c.contextId === freeBookingId);
    expect(conv, 'guide booking conversation created on confirmation').toBeTruthy();
    expect(conv.id).toBe(freeConversationId);
    expect(conv.myRole).toBe('TRAVELER');
    expect(conv.members.map((m: any) => [m.userId, m.role]).sort()).toEqual([[friendGuide.id, 'GUIDE'], [traveler.id, 'TRAVELER']].sort());
    const gl = await call(t, friendGuide, 'GET', '/v1/conversations');
    expect(gl.body.items.find((c: any) => c.id === freeConversationId)?.myRole).toBe('GUIDE');
    const m1 = await call(t, traveler, 'POST', `/v1/conversations/${freeConversationId}/messages`, { body: 'See you at Gwangjang market gate 2!', clientMessageId: 'tr-1' });
    expect(m1.status, show(m1)).toBe(201);
    const m2 = await call(t, friendGuide, 'POST', `/v1/conversations/${freeConversationId}/messages`, { body: 'Great, I will wear a yellow cap.', clientMessageId: 'gd-1' });
    expect(m2.status, show(m2)).toBe(201);
    for (const u of [traveler, friendGuide]) {
      const msgs = await call(t, u, 'GET', `/v1/conversations/${freeConversationId}/messages`);
      expect(msgs.status).toBe(200);
      expect(msgs.body.items.filter((x: any) => x.type !== 'SYSTEM').map((x: any) => x.senderId).sort()).toEqual([friendGuide.id, traveler.id].sort());
    }
    expect((await call(t, outsider, 'GET', `/v1/conversations/${freeConversationId}/messages`)).status).toBe(404);
    expect((await call(t, outsider, 'POST', `/v1/conversations/${freeConversationId}/messages`, { body: 'spam' })).status).toBe(404);

    for (const u of [traveler, friendGuide]) {
      expect(await noteFor(u, 'guide.booking.confirmed', (d) => d.bookingId === freeBookingId && d.conversationId === freeConversationId), `confirmed notification for ${u.id}`).toBeTruthy();
    }

    // the confirmed booking is cut out of the guide's free time and search availability
    const free = await call(t, null, 'GET', `/v1/guides/${friendGuide.id}/availability?from=${encodeURIComponent(FREE_SLOT.startAt)}&to=${encodeURIComponent(FREE_SLOT.endAt)}`);
    expect(free.body.items).toEqual([{ startAt: FREE_SLOT.startAt, endAt: FREE_BOOK.startAt }, { startAt: FREE_BOOK.endAt, endAt: FREE_SLOT.endAt }]);
    const s = await searchGuides({ city: 'Seoul', languages: 'en', from: FREE_BOOK.startAt, to: FREE_BOOK.endAt });
    expect(s.items.find((i) => i.guide.guideId === friendGuide.id)?.availability).toBe('UNAVAILABLE');
    expect(await searchIds({ city: 'Seoul', languages: 'en', availableOnly: true, from: FREE_BOOK.startAt, to: FREE_BOOK.endAt })).toEqual([]);
  });

  it('F4. guide starts → complete → traveler review → booking REVIEWED via the outbox', async () => {
    const tStart = await call(t, traveler, 'POST', `/v1/guide-bookings/${freeBookingId}/start`);
    expect(tStart.status).toBe(403);
    expect(tStart.body.code).toBe('NOT_BOOKING_GUIDE');
    const early = await call(t, friendGuide, 'POST', `/v1/guide-bookings/${freeBookingId}/complete`);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('INVALID_STATE_TRANSITION');
    const reviewEarly = await call(t, traveler, 'POST', '/v1/reviews', { transactionType: 'GUIDE_BOOKING', transactionId: freeBookingId, targetType: 'GUIDE', rating: 5 });
    expect(reviewEarly.status).toBe(422);
    expect(reviewEarly.body.code).toBe('TRANSACTION_NOT_COMPLETED');

    const st = await call(t, friendGuide, 'POST', `/v1/guide-bookings/${freeBookingId}/start`);
    expect(st.status, show(st)).toBe(200);
    expect(st.body.item.status).toBe('IN_PROGRESS');
    expect((await call(t, friendGuide, 'POST', `/v1/guide-bookings/${freeBookingId}/start`)).status).toBe(409);
    expect((await call(t, outsider, 'POST', `/v1/guide-bookings/${freeBookingId}/complete`)).status).toBe(403);

    // the guide cannot complete before the scheduled end (completion makes a booking settlement-eligible);
    // the traveler may confirm that the activity is over
    const guideEarly = await call(t, friendGuide, 'POST', `/v1/guide-bookings/${freeBookingId}/complete`);
    expect(guideEarly.status).toBe(409);
    expect(guideEarly.body.code).toBe('ACTIVITY_NOT_ENDED');
    const done = await call(t, traveler, 'POST', `/v1/guide-bookings/${freeBookingId}/complete`);
    expect(done.status, show(done)).toBe(200);
    expect(done.body.item.status).toBe('COMPLETED');
    expect((await call(t, friendGuide, 'POST', `/v1/guide-bookings/${freeBookingId}/complete`)).status).toBe(409);
    for (const u of [traveler, friendGuide]) {
      expect(await noteFor(u, 'guide.booking.review_invite', (d) => d.bookingId === freeBookingId)).toBeTruthy();
    }

    const stranger = await call(t, outsider, 'POST', '/v1/reviews', { transactionType: 'GUIDE_BOOKING', transactionId: freeBookingId, targetType: 'GUIDE', rating: 1 });
    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe('NOT_A_PARTY');
    const wrongTarget = await call(t, traveler, 'POST', '/v1/reviews', { transactionType: 'GUIDE_BOOKING', transactionId: freeBookingId, targetType: 'TRAVELER', rating: 1 });
    expect(wrongTarget.status).toBe(403);

    const rv = await call(t, traveler, 'POST', '/v1/reviews', {
      transactionType: 'GUIDE_BOOKING', transactionId: freeBookingId, targetType: 'GUIDE', rating: 5, subRatings: { knowledge: 5, friendliness: 5 }, body: 'Jisoo knew every hidden food stall. Amazing evening!',
    });
    expect(rv.status, show(rv)).toBe(201);
    const dup = await call(t, traveler, 'POST', '/v1/reviews', { transactionType: 'GUIDE_BOOKING', transactionId: freeBookingId, targetType: 'GUIDE', rating: 1 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('REVIEW_EXISTS');

    await t.drain(); // review.created → guide.review-tracker
    const b = await getBooking(traveler, freeBookingId);
    expect(b.status).toBe('REVIEWED');
    expect(b.history.map((h: any) => h.to_state)).toEqual(['ACCEPTED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED']);
    expect(b.history.at(-1).actor_type).toBe('SYSTEM');

    const pv = await call(t, null, 'GET', `/v1/guides/${friendGuide.id}`);
    expect(pv.body.item).toMatchObject({ ratingAvg: 5, reviewCount: 1 });
    const list = await call(t, null, 'GET', `/v1/reviews?targetType=GUIDE&targetId=${friendGuide.id}`);
    expect(list.status, show(list)).toBe(200);
    expect(list.body.summary).toEqual({ reviewCount: 1, ratingAvg: 5 });
    expect(list.body.items).toHaveLength(1);
    expect(await noteFor(friendGuide, 'review.received')).toBeTruthy();

    // the guide may review the traveler as well; the booking stays REVIEWED
    const back = await call(t, friendGuide, 'POST', '/v1/reviews', { transactionType: 'GUIDE_BOOKING', transactionId: freeBookingId, targetType: 'TRAVELER', rating: 5, body: 'Lovely, punctual guest.' });
    expect(back.status, show(back)).toBe(201);
    await t.drain();
    expect((await getBooking(friendGuide, freeBookingId)).status).toBe('REVIEWED');
    const tasks = await call(t, traveler, 'GET', '/v1/me/reviews');
    expect(tasks.status).toBe(200);
    expect(tasks.body.pending.filter((p: any) => p.transactionId === freeBookingId || p.transaction_id === freeBookingId)).toEqual([]);

    await assertOutboxHealthy();
  });
});

// ------------------------------------------------------------------------------------------------ PAID

describe('G4 E2E — Guide PAID chain (HTTP only)', () => {
  it('P1. PAID guide verifies identity and drafts a priced profile; publication is denied with no rule and guide.paid OFF', async () => {
    paidGuide = await createUser(t, { displayName: 'Minho Pro' });
    await verifyIdentity(paidGuide);
    const p = await call(t, paidGuide, 'POST', '/v1/guides/profile', {
      guideType: 'PAID', headline: 'Licensed history walks', languages: ['ko', 'en'], interests: ['history'], city: 'Seoul', hourlyPriceMinor: HOURLY, maxGroupSize: 6,
    });
    expect(p.status, show(p)).toBe(201);
    expect(p.body.item).toMatchObject({ guide_type: 'PAID', status: 'DRAFT', paid_enabled: false, hourly_price_minor: HOURLY, currency: 'KRW' });

    const flags = await call(t, admin, 'GET', '/v1/admin/feature-flags');
    expect(flags.status, show(flags)).toBe(200);
    expect(flags.body.items.find((f: any) => (f.flag_key ?? f.flagKey ?? f.key) === 'guide.paid')).toMatchObject({ enabled: false });

    const r = await call(t, paidGuide, 'POST', '/v1/guides/profile/publish');
    expect(r.status, show(r)).toBe(422);
    expect(r.body.code).toBe('GUIDE_PAID_GATE_FAILED');
    expect(r.body.details.reasons).toEqual(['NO_APPROVED_COMPLIANCE_RULE', 'FEATURE_DISABLED:guide.paid']);
    expect(r.body.details.rules).toEqual([]);
    const me = await call(t, paidGuide, 'GET', '/v1/guides/me');
    expect(me.body.item).toMatchObject({ status: 'DRAFT', paid_enabled: false });
    expect(me.body.eligibility).toMatchObject({ identityVerified: true, publishable: false, paidAllowed: false });
    expect((await call(t, null, 'GET', `/v1/guides/${paidGuide.id}`)).status).toBe(404);
    expect(await searchIds({ city: 'Seoul', pricing: 'paid' })).toEqual([]);
    expect((await call(t, paidGuide, 'GET', '/v1/me')).body.user.roles).not.toContain('GUIDE');
  });

  it('P2. G9 references via APIs: GUIDE fee/tax rules (maker-checker) and the GUIDE/PAID compliance rule (four-eyes)', async () => {
    const effectiveFrom = new Date(Date.now() - DAY).toISOString();
    for (const [ruleType, bps] of [['PLATFORM_FEE', PLATFORM_FEE_BPS], ['TAX', TAX_BPS]] as const) {
      const created = await call(t, acctA, 'POST', '/v1/finance/rules', { ruleType, domain: 'GUIDE', jurisdiction: 'KR', params: { bps }, effectiveFrom, note: 'G9 guide commission approved' });
      expect(created.status, show(created)).toBe(201);
      expect(created.body.item).toMatchObject({ ruleType, domain: 'GUIDE', status: 'DRAFT', createdBy: acctA.id });
      const self = await call(t, acctA, 'POST', `/v1/finance/rules/${created.body.item.id}/approve`);
      expect(self.status).toBe(403);
      expect(self.body.code).toBe('MAKER_CHECKER_VIOLATION');
      const ok = await call(t, acctB, 'POST', `/v1/finance/rules/${created.body.item.id}/approve`);
      expect(ok.status, show(ok)).toBe(200);
      expect(ok.body.item).toMatchObject({ status: 'APPROVED', approvedBy: acctB.id });
    }
    const fq = await call(t, acctA, 'GET', `/v1/finance/quote?domain=GUIDE&amountMinor=${PRICE}&currency=KRW`);
    expect(fq.status, show(fq)).toBe(200);
    expect(fq.body.item).toMatchObject({ platformFeeMinor: PLATFORM_FEE, hostFeeMinor: 0, taxMinor: TAX });

    expect((await call(t, paidGuide, 'POST', '/v1/admin/compliance/rules', { ruleKey: 'self-made', subjectType: 'GUIDE', jurisdiction: 'KR', effectiveFrom: day(-1) })).status).toBe(403);
    const rule = await call(t, admin, 'POST', '/v1/admin/compliance/rules', {
      ruleKey: PAID_RULE_KEY,
      subjectType: 'GUIDE',
      jurisdiction: 'KR',
      appliesTo: { guide_type: ['PAID'] },
      requiredPermitTypes: ['BUSINESS_REGISTRATION'],
      effectiveFrom: day(-1),
      note: 'Paid guiding requires a verified business registration',
    });
    expect(rule.status, show(rule)).toBe(201);
    expect(rule.body.item).toMatchObject({ status: 'DRAFT', subjectType: 'GUIDE', jurisdiction: 'KR', requiredPermitTypes: ['BUSINESS_REGISTRATION'], appliesTo: { guide_type: ['PAID'] }, createdBy: admin.id });
    paidRuleId = rule.body.item.id;

    // a DRAFT rule does not count
    const draft = await call(t, paidGuide, 'POST', '/v1/guides/profile/publish');
    expect(draft.status).toBe(422);
    expect(draft.body.details.reasons).toEqual(['NO_APPROVED_COMPLIANCE_RULE', 'FEATURE_DISABLED:guide.paid']);

    const selfApprove = await call(t, admin, 'POST', `/v1/admin/compliance/rules/${paidRuleId}/approve`, {});
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.code).toBe('FOUR_EYES_REQUIRED');
    expect((await call(t, paidGuide, 'POST', `/v1/admin/compliance/rules/${paidRuleId}/approve`, {})).status).toBe(403);
    const approved = await call(t, compliance2, 'POST', `/v1/admin/compliance/rules/${paidRuleId}/approve`, { reason: 'legal sign-off: paid guides' });
    expect(approved.status, show(approved)).toBe(200);
    expect(approved.body.item).toMatchObject({ status: 'APPROVED', approvedBy: compliance2.id });

    const r = await call(t, paidGuide, 'POST', '/v1/guides/profile/publish');
    expect(r.status, show(r)).toBe(422);
    expect(r.body.code).toBe('GUIDE_PAID_GATE_FAILED');
    expect(r.body.details.reasons).toEqual(['QUALIFICATION_MISSING:BUSINESS_REGISTRATION', 'FEATURE_DISABLED:guide.paid']);
    expect(r.body.details.rules).toEqual([{ ruleId: paidRuleId, ruleKey: PAID_RULE_KEY, required: ['BUSINESS_REGISTRATION'], missing: ['BUSINESS_REGISTRATION'] }]);
  });

  it('P3. qualification → compliance verifies → still denied while guide.paid is OFF → flag ON → published with paid_enabled', async () => {
    const foreign = await upload(outsider, 'VERIFICATION', 'application/pdf', pdf('someone else'));
    const stolen = await call(t, paidGuide, 'POST', '/v1/guides/qualifications', { qualificationType: 'BUSINESS_REGISTRATION', documentMediaId: foreign.id });
    expect(stolen.status).toBe(422);
    expect(stolen.body.code).toBe('DOCUMENT_NOT_FOUND');
    const doc = await upload(paidGuide, 'VERIFICATION', 'application/pdf', pdf('business registration certificate'));
    const expired = await call(t, paidGuide, 'POST', '/v1/guides/qualifications', { qualificationType: 'BUSINESS_REGISTRATION', documentMediaId: doc.id, validUntil: day(-2) });
    expect(expired.status).toBe(422);
    expect(expired.body.code).toBe('QUALIFICATION_EXPIRED');

    const q = await call(t, paidGuide, 'POST', '/v1/guides/qualifications', { qualificationType: 'BUSINESS_REGISTRATION', documentMediaId: doc.id, referenceNo: '220-81-12345', validUntil: day(365) });
    expect(q.status, show(q)).toBe(201);
    expect(q.body.item).toMatchObject({ guide_id: paidGuide.id, qualification_type: 'BUSINESS_REGISTRATION', status: 'PENDING', document_media_id: doc.id });
    qualificationId = q.body.item.id;

    // pending ≠ verified
    const pending = await call(t, paidGuide, 'POST', '/v1/guides/profile/publish');
    expect(pending.body.details.reasons).toContain('QUALIFICATION_MISSING:BUSINESS_REGISTRATION');

    expect((await call(t, paidGuide, 'GET', '/v1/admin/guide-qualifications')).status).toBe(403);
    expect((await call(t, paidGuide, 'POST', `/v1/admin/guide-qualifications/${qualificationId}/verify`, {})).status).toBe(403);
    const queue = await call(t, admin, 'GET', '/v1/admin/guide-qualifications?status=PENDING');
    expect(queue.status, show(queue)).toBe(200);
    expect(queue.body.items.find((x: any) => x.id === qualificationId)).toMatchObject({ guide_id: paidGuide.id, guide_type: 'PAID', status: 'PENDING' });
    const v = await call(t, admin, 'POST', `/v1/admin/guide-qualifications/${qualificationId}/verify`, { reason: 'registration checked against the national registry' });
    expect(v.status, show(v)).toBe(200);
    expect(v.body.item).toMatchObject({ id: qualificationId, status: 'VERIFIED', verified_by: admin.id });
    expect((await call(t, compliance2, 'POST', `/v1/admin/guide-qualifications/${qualificationId}/verify`, {})).status).toBe(409);
    expect(await noteFor(paidGuide, 'guide.qualification.verified', (d) => d.qualificationId === qualificationId)).toBeTruthy();

    // every configured predicate passes except the G9 feature gate
    const off = await call(t, paidGuide, 'POST', '/v1/guides/profile/publish');
    expect(off.status, show(off)).toBe(422);
    expect(off.body.code).toBe('GUIDE_PAID_GATE_FAILED');
    expect(off.body.details.reasons).toEqual(['FEATURE_DISABLED:guide.paid']);
    expect((await call(t, paidGuide, 'GET', '/v1/guides/me')).body.item).toMatchObject({ status: 'DRAFT', paid_enabled: false });

    expect((await call(t, compliance2, 'PATCH', '/v1/admin/feature-flags', { flagKey: 'guide.paid', enabled: true, reason: 'not an admin' })).status).toBe(403);
    await setPaidFlag(true, 'G9 paid-guide eligibility approved by legal');

    const pub = await call(t, paidGuide, 'POST', '/v1/guides/profile/publish');
    expect(pub.status, show(pub)).toBe(200);
    expect(pub.body.item).toMatchObject({ status: 'PUBLISHED', paid_enabled: true, verification_status: 'VERIFIED', guide_type: 'PAID', hourly_price_minor: HOURLY });
    expect(pub.body.eligibility).toMatchObject({ publishable: true, paidAllowed: true, reasons: [] });
    expect(pub.body.eligibility.rulesEvaluated).toEqual([{ ruleId: paidRuleId, ruleKey: PAID_RULE_KEY, required: ['BUSINESS_REGISTRATION'], missing: [] }]);
    expect((await call(t, paidGuide, 'GET', '/v1/me')).body.user.roles).toContain('GUIDE');

    const pv = await call(t, null, 'GET', `/v1/guides/${paidGuide.id}`);
    expect(pv.status).toBe(200);
    expect(pv.body.item).toMatchObject({ guideType: 'PAID', paidEnabled: true, free: false, hourlyPriceMinor: HOURLY, currency: 'KRW', verified: true });
    expect(await searchIds({ city: 'Seoul', pricing: 'paid' })).toEqual([paidGuide.id]);
    expect(await searchIds({ city: 'Seoul', pricing: 'free' })).toEqual([friendGuide.id]);
    expect(await searchIds({ city: 'Seoul', pricing: 'paid', maxPriceMinor: HOURLY - 1 })).toEqual([]);
    const s = await searchGuides({ city: 'Seoul', languages: 'en', interests: 'history', pricing: 'paid', from: PAID_WIN.startAt, to: PAID_WIN.endAt });
    expect(s.items.map((i) => [i.guide.guideId, i.availability])).toEqual([[paidGuide.id, 'ON_REQUEST']]);

    const comp = await auditActions('COMPLIANCE');
    for (const a of ['compliance_rule.created', 'compliance_rule.approved', 'guide.qualification.verified', 'guide.published']) {
      expect(comp.map((m) => m.action), `COMPLIANCE audit ${a}`).toContain(a);
    }
    expect(comp.find((m) => m.action === 'guide.qualification.verified')?.resource_id).toBe(qualificationId);
    expect(comp.filter((m) => m.action === 'guide.published').map((m) => m.resource_id)).toContain(paidGuide.id);
    const perm = await auditActions('PERMISSION');
    expect(perm).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'feature_flag.updated', resource_id: 'guide.paid', actor_id: admin.id }),
      expect.objectContaining({ action: 'role.granted', resource_id: paidGuide.id }),
    ]));
  });

  it('P4. request → paid offer with price → accept → ACCEPTED awaiting payment; the guide time is held', async () => {
    paidTraveler = await createUser(t, { displayName: 'Sam Paying Traveler' });
    rival = await createUser(t, { displayName: 'Rival Traveler' });
    paidRequestId = await requestGuide(paidTraveler, paidGuide.id, PAID_WIN, { partySize: 3, city: 'Seoul', languages: ['en'], interests: ['history'], message: 'Palace history tour for three' });

    const unpaid = await offer(paidGuide, paidRequestId, PAID_WIN, false);
    expect(unpaid.status).toBe(422);
    expect(unpaid.body.code).toBe('PAID_FLAG_MISMATCH');
    const zero = await offer(paidGuide, paidRequestId, PAID_WIN, true, 0);
    expect(zero.status).toBe(422);
    expect(zero.body.code).toBe('PRICE_REQUIRED');
    const o = await offer(paidGuide, paidRequestId, PAID_WIN, true, PRICE);
    expect(o.status, show(o)).toBe(201);
    expect(o.body.item).toMatchObject({ status: 'OFFERED', current_offer_version: 1 });
    expect(o.body.offer).toMatchObject({ version: 1, paid: true, price_minor: PRICE, currency: 'KRW', status: 'OPEN' });

    const key = idem();
    const a = await call(t, paidTraveler, 'POST', `/v1/guide-requests/${paidRequestId}/accept`, { offerVersion: 1 }, key);
    expect(a.status, show(a)).toBe(201);
    const b = a.body.booking;
    expect(b).toMatchObject({ status: 'ACCEPTED', paid: true, price_minor: PRICE, refunded_minor: 0, currency: 'KRW', guide_type: 'PAID', guide_id: paidGuide.id, traveler_id: paidTraveler.id });
    expect(b.conversation_id).toBeNull(); // not confirmed yet
    paidBookingId = b.id;
    expect(await noteFor(paidTraveler, 'guide.booking.payment_required', (d) => d.bookingId === paidBookingId && d.amountMinor === PRICE && d.currency === 'KRW')).toBeTruthy();
    const convs = await call(t, paidTraveler, 'GET', '/v1/conversations');
    expect(convs.body.items.filter((c: any) => c.contextId === paidBookingId)).toEqual([]);

    // invariant 5: the ACCEPTED (unpaid) booking already holds the guide's time
    rivalRequestId = await requestGuide(rival, paidGuide.id, { startAt: ts(3 * DAY + HOUR), endAt: ts(3 * DAY + 3 * HOUR) });
    const clash = await offer(paidGuide, rivalRequestId, { startAt: ts(3 * DAY + HOUR), endAt: ts(3 * DAY + 3 * HOUR) }, true, PRICE);
    expect(clash.status, show(clash)).toBe(409);
    expect(clash.body.code).toBe('GUIDE_UNAVAILABLE');
    expect((await getRequest(rival, rivalRequestId)).status).toBe('REQUESTED');
  });

  it('P5. payments prepare (GUIDE_BOOKING) → MOCK confirm → CONFIRMED; ledger posting balanced', async () => {
    const byGuide = await call(t, paidGuide, 'POST', '/v1/payments/toss/prepare', { subjectType: 'GUIDE_BOOKING', subjectId: paidBookingId }, idem());
    expect(byGuide.status).toBe(403);
    expect(byGuide.body.code).toBe('NOT_PAYER');
    expect((await call(t, outsider, 'POST', '/v1/payments/toss/prepare', { subjectType: 'GUIDE_BOOKING', subjectId: paidBookingId }, idem())).status).toBe(403);
    expect((await call(t, paidTraveler, 'POST', '/v1/payments/toss/prepare', { subjectType: 'GUIDE_BOOKING', subjectId: paidBookingId })).status).toBe(400);

    const prepKey = idem();
    const prep = await call(t, paidTraveler, 'POST', '/v1/payments/toss/prepare', { subjectType: 'GUIDE_BOOKING', subjectId: paidBookingId }, prepKey);
    expect(prep.status, show(prep)).toBe(201);
    expect(prep.body).toMatchObject({ amount: PRICE, currency: 'KRW', provider: 'MOCK' });
    expect(prep.body.orderId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
    paymentId = prep.body.paymentId;
    const prepReplay = await call(t, paidTraveler, 'POST', '/v1/payments/toss/prepare', { subjectType: 'GUIDE_BOOKING', subjectId: paidBookingId }, prepKey);
    expect(prepReplay.status).toBe(201);
    expect(prepReplay.headers['idempotent-replayed']).toBe('true');
    expect(prepReplay.body.paymentId).toBe(paymentId);
    expect((await getBooking(paidTraveler, paidBookingId)).status).toBe('PAYMENT_PENDING');
    expect((await getPayment(paidTraveler, paymentId)).status).toBe('CREATED');

    // a tampered amount never confirms
    const bad = await call(t, paidTraveler, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${randomUUID().replace(/-/g, '')}`, orderId: prep.body.orderId, amount: PRICE - 1 }, idem());
    expect(bad.status, show(bad)).toBe(400);
    expect(bad.body.code).toBe('AMOUNT_MISMATCH');
    expect((await getBooking(paidTraveler, paidBookingId)).status).toBe('PAYMENT_PENDING');
    const foreign = await call(t, outsider, 'POST', '/v1/payments/toss/confirm', { paymentKey: 'mock_foreign', orderId: prep.body.orderId, amount: PRICE }, idem());
    expect(foreign.status).toBe(403);

    const confirmKey = idem();
    const body = { paymentKey: `mock_${randomUUID().replace(/-/g, '')}`, orderId: prep.body.orderId, amount: PRICE };
    const c = await call(t, paidTraveler, 'POST', '/v1/payments/toss/confirm', body, confirmKey);
    expect(c.status, show(c)).toBe(200);
    expect(c.body.item).toMatchObject({ id: paymentId, status: 'APPROVED', amountMinor: PRICE, currency: 'KRW', subjectType: 'GUIDE_BOOKING', subjectId: paidBookingId, paymentKey: body.paymentKey });
    const again = await call(t, paidTraveler, 'POST', '/v1/payments/toss/confirm', body, confirmKey);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');

    // paid booking confirms only after the server-verified payment
    const bk = await getBooking(paidTraveler, paidBookingId);
    expect(bk).toMatchObject({ status: 'CONFIRMED', paid: true, price_minor: PRICE, refunded_minor: 0 });
    expect(bk.conversation_id).toBeTruthy();
    expect(bk.history.map((h: any) => [h.from_state, h.to_state])).toEqual([[null, 'ACCEPTED'], ['ACCEPTED', 'PAYMENT_PENDING'], ['PAYMENT_PENDING', 'CONFIRMED']]);
    const convs = await call(t, paidTraveler, 'GET', '/v1/conversations');
    const conv = convs.body.items.find((x: any) => x.contextType === 'GUIDE_BOOKING' && x.contextId === paidBookingId);
    expect(conv?.id).toBe(bk.conversation_id);
    expect(conv.members.map((m: any) => m.userId).sort()).toEqual([paidGuide.id, paidTraveler.id].sort());
    expect(await noteFor(paidTraveler, 'payment.approved', (d) => d.paymentId === paymentId)).toBeTruthy();
    for (const u of [paidTraveler, paidGuide]) expect(await noteFor(u, 'guide.booking.confirmed', (d) => d.bookingId === paidBookingId)).toBeTruthy();

    const pay = await getPayment(paidTraveler, paymentId);
    expect(pay).toMatchObject({ status: 'APPROVED', refundedMinor: 0, refundableMinor: PRICE, refunds: [] });
    const rc = await call(t, paidTraveler, 'GET', '/v1/receipts');
    expect(rc.body.items.filter((x: any) => x.paymentId === paymentId)).toEqual([expect.objectContaining({ receiptType: 'PAYMENT', amountMinor: PRICE, currency: 'KRW' })]);
    const second = await call(t, paidTraveler, 'POST', '/v1/payments/toss/prepare', { subjectType: 'GUIDE_BOOKING', subjectId: paidBookingId }, idem());
    expect(second.status).toBe(409);

    // ledger: Dr PG clearing / Cr guide payable (net of platform fee) / Cr VAT / Cr fee revenue
    const txs = await ledgerTxs('PAYMENT', paymentId);
    expect(txs).toHaveLength(1);
    const ap = txs[0];
    approvalTxId = ap.id;
    expect(ap.type).toBe('PAYMENT_APPROVED');
    expect(ap.entries.map((e) => [e.account, e.debitMinor, e.creditMinor]).sort()).toEqual([
      ['PLATFORM:PG_CLEARING:KRW', PRICE, 0],
      [`PAYEE:${paidGuide.id}:PAYABLE:KRW`, 0, GUIDE_NET],
      ['PLATFORM:TAX_PAYABLE:KRW', 0, TAX],
      ['PLATFORM:FEE_REVENUE:KRW', 0, FEE_REVENUE],
    ].sort());
    expect(ap.entries.every((e) => e.currency === 'KRW')).toBe(true);
    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
    expect(tb.unbalancedTransactionIds).toEqual([]);
    expect(tb.currencies).toEqual([expect.objectContaining({ currency: 'KRW', differenceMinor: 0, debitMinor: PRICE, creditMinor: PRICE })]);
    expect(await ledgerBalance('PLATFORM:PG_CLEARING:KRW')).toBe(PRICE);
    expect(await ledgerBalance(`PAYEE:${paidGuide.id}:PAYABLE:KRW`)).toBe(GUIDE_NET);
    expect(await ledgerBalance('PLATFORM:FEE_REVENUE:KRW')).toBe(FEE_REVENUE);
    expect(await ledgerBalance('PLATFORM:TAX_PAYABLE:KRW')).toBe(TAX);
  });

  it('P6. traveler cancels ≥24h before start → full refund via outbox → ledger reversal balanced → time released', async () => {
    expect((await call(t, outsider, 'POST', `/v1/guide-bookings/${paidBookingId}/cancel`, { reason: 'not mine' }, idem())).status).toBe(403);
    const noKey = await call(t, paidTraveler, 'POST', `/v1/guide-bookings/${paidBookingId}/cancel`, { reason: 'Flight changed' });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const key = idem();
    const cx = await call(t, paidTraveler, 'POST', `/v1/guide-bookings/${paidBookingId}/cancel`, { reason: 'Flight changed' }, key);
    expect(cx.status, show(cx)).toBe(200);
    expect(cx.body.item).toMatchObject({ id: paidBookingId, status: 'CANCELLED' });
    expect(cx.body.refund).toMatchObject({ refundMinor: PRICE, refundPct: 100, policy: 'TRAVELER_24H_PLUS_FULL', status: 'REQUESTED' });
    expect(cx.body.refund.hoursBefore).toBeGreaterThanOrEqual(24);
    const refundId = cx.body.refund.refundId as string;
    expect(refundId).toBeTruthy();
    const replay = await call(t, paidTraveler, 'POST', `/v1/guide-bookings/${paidBookingId}/cancel`, { reason: 'Flight changed' }, key);
    expect(replay.status).toBe(200);
    expect(replay.body.refund.refundId).toBe(refundId);
    const twice = await call(t, paidTraveler, 'POST', `/v1/guide-bookings/${paidBookingId}/cancel`, {}, idem());
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('INVALID_STATE_TRANSITION');

    // the refund intent is recorded; the provider cancel runs asynchronously (outbox)
    const pending = await getPayment(paidTraveler, paymentId);
    expect(pending.status).toBe('APPROVED');
    expect(pending.refunds).toEqual([expect.objectContaining({ id: refundId, amountMinor: PRICE, status: 'REQUESTED' })]);
    expect(pending.refundableMinor).toBe(0);

    await t.drain();

    const pay = await getPayment(paidTraveler, paymentId);
    expect(pay).toMatchObject({ status: 'REFUNDED', refundedMinor: PRICE, refundableMinor: 0 });
    expect(pay.refunds).toEqual([expect.objectContaining({ id: refundId, amountMinor: PRICE, status: 'REFUNDED', currency: 'KRW' })]);
    const bk = await getBooking(paidTraveler, paidBookingId);
    expect(bk).toMatchObject({ status: 'CANCELLED', refunded_minor: PRICE });
    expect(bk.history.map((h: any) => h.to_state)).toEqual(['ACCEPTED', 'PAYMENT_PENDING', 'CONFIRMED', 'CANCELLED']);

    // compensating entries: exact mirror of the approval credits, balanced
    const rev = await ledgerTxs('REFUND', refundId);
    expect(rev).toHaveLength(1);
    expect(rev[0]).toMatchObject({ type: 'REFUND', reversesTransactionId: approvalTxId });
    expect(rev[0].entries.map((e) => [e.account, e.debitMinor, e.creditMinor]).sort()).toEqual([
      ['PLATFORM:PG_CLEARING:KRW', 0, PRICE],
      [`PAYEE:${paidGuide.id}:PAYABLE:KRW`, GUIDE_NET, 0],
      ['PLATFORM:TAX_PAYABLE:KRW', TAX, 0],
      ['PLATFORM:FEE_REVENUE:KRW', FEE_REVENUE, 0],
    ].sort());
    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
    expect(tb.unbalancedTransactionIds).toEqual([]);
    expect(tb.currencies).toEqual([expect.objectContaining({ currency: 'KRW', differenceMinor: 0, debitMinor: 2 * PRICE, creditMinor: 2 * PRICE })]);
    for (const code of ['PLATFORM:PG_CLEARING:KRW', `PAYEE:${paidGuide.id}:PAYABLE:KRW`, 'PLATFORM:FEE_REVENUE:KRW', 'PLATFORM:TAX_PAYABLE:KRW']) {
      expect(await ledgerBalance(code), `${code} back to zero`).toBe(0);
    }

    const rcp = await call(t, paidTraveler, 'GET', '/v1/receipts');
    expect(rcp.body.items.filter((x: any) => x.paymentId === paymentId).map((x: any) => [x.receiptType, x.amountMinor]).sort()).toEqual([['PAYMENT', PRICE], ['REFUND', PRICE]]);
    expect(await noteFor(paidTraveler, 'payment.refunded', (d) => d.paymentId === paymentId && d.refundId === refundId)).toBeTruthy();
    expect(await noteFor(paidGuide, 'guide.booking.cancelled', (d) => d.bookingId === paidBookingId && d.cancelledBy === 'TRAVELER')).toBeTruthy();
    const money = await auditActions('MONEY');
    expect(money).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'refund.requested', resource_id: paymentId }),
      expect.objectContaining({ action: 'refund.completed', resource_id: paymentId }),
      expect.objectContaining({ action: 'guide.booking.refund_requested', resource_id: paidBookingId }),
      expect.objectContaining({ action: 'finance.rule.approve' }),
    ]));

    // the guide's time is free again: the waiting rival request can now be offered
    const o = await offer(paidGuide, rivalRequestId, { startAt: ts(3 * DAY + HOUR), endAt: ts(3 * DAY + 3 * HOUR) }, true, PRICE);
    expect(o.status, show(o)).toBe(201);
    expect((await call(t, rival, 'POST', `/v1/guide-requests/${rivalRequestId}/cancel`, { reason: 'found another plan' })).body.item.status).toBe('CANCELLED');

    // jobs (refund retry, expiry, reconciliation, lifecycle) change nothing for the settled refund
    await t.runJobs();
    await t.drain();
    const after = await getPayment(paidTraveler, paymentId);
    expect(after).toMatchObject({ status: 'REFUNDED', refundedMinor: PRICE });
    expect(after.refunds).toHaveLength(1);
    expect(await ledgerTxs('REFUND', refundId)).toHaveLength(1);
    expect((await trialBalance()).balanced).toBe(true);
    expect((await getBooking(paidGuide, paidBookingId)).status).toBe('CANCELLED');

    await assertOutboxHealthy();
  });
});

// ------------------------------------------------------------------------------------------------ NEGATIVE

describe('G4 E2E — Guide NEGATIVE gates (HTTP only)', () => {
  it('N1. FRIEND / VOLUNTEER guides cannot price: profile, patch, offer and counter are refused', async () => {
    for (const guideType of ['FRIEND', 'VOLUNTEER']) {
      const u = await createUser(t);
      const r = await call(t, u, 'POST', '/v1/guides/profile', { guideType, hourlyPriceMinor: 10_000 });
      expect(r.status, show(r)).toBe(422);
      expect(r.body.code).toBe('FREE_GUIDE_PRICE_NOT_ALLOWED');
      expect((await call(t, u, 'GET', '/v1/guides/me')).status).toBe(404); // nothing was created
    }
    const patch = await call(t, friendGuide, 'PATCH', '/v1/guides/profile', { hourlyPriceMinor: 5_000 });
    expect(patch.status).toBe(422);
    expect(patch.body.code).toBe('FREE_GUIDE_PRICE_NOT_ALLOWED');
    const zero = await call(t, friendGuide, 'PATCH', '/v1/guides/profile', { hourlyPriceMinor: 0 });
    expect(zero.status, show(zero)).toBe(200);
    expect(zero.body.item).toMatchObject({ hourly_price_minor: null, paid_enabled: false, status: 'PUBLISHED' });

    const w = { startAt: ts(5 * DAY + 9 * HOUR), endAt: ts(5 * DAY + 10 * HOUR) };
    const rid = await requestGuide(traveler, friendGuide.id, w);
    for (const [paid, price] of [[true, 1_000], [false, 1_000], [true, 0]] as const) {
      const o = await offer(friendGuide, rid, w, paid, price);
      expect(o.status, `paid=${paid} price=${price}: ${show(o)}`).toBe(422);
      expect(o.body.code).toBe('FREE_GUIDE_PRICE_NOT_ALLOWED');
    }
    expect((await getRequest(traveler, rid)).status).toBe('REQUESTED');
    expect((await offer(friendGuide, rid, w, false)).status).toBe(201);
    const counter = await call(t, traveler, 'POST', `/v1/guide-requests/${rid}/counter`, { ...w, priceMinor: 2_000 });
    expect(counter.status).toBe(422);
    expect(counter.body.code).toBe('FREE_GUIDE_PRICE_NOT_ALLOWED');
    expect((await call(t, traveler, 'POST', `/v1/guide-requests/${rid}/cancel`, { reason: 'just testing prices' })).body.item.status).toBe('CANCELLED');

    const pv = await call(t, null, 'GET', `/v1/guides/${friendGuide.id}`);
    expect(pv.body.item).toMatchObject({ free: true, paidEnabled: false, hourlyPriceMinor: null });
    expect(await searchIds({ city: 'Seoul', pricing: 'paid' })).not.toContain(friendGuide.id);
  });

  it('N2. paid publication is denied when no approved rule applies to the type (PROFESSIONAL, guide.paid ON)', async () => {
    const pro = await createUser(t, { displayName: 'No Rule Pro' });
    await verifyIdentity(pro);
    expect((await call(t, pro, 'POST', '/v1/guides/profile', { guideType: 'PROFESSIONAL', hourlyPriceMinor: 80_000, city: 'Seoul', languages: ['en'] })).status).toBe(201);
    const r = await call(t, pro, 'POST', '/v1/guides/profile/publish');
    expect(r.status, show(r)).toBe(422);
    expect(r.body.code).toBe('GUIDE_PAID_GATE_FAILED');
    expect(r.body.details.reasons).toEqual(['NO_APPROVED_COMPLIANCE_RULE']);
    expect(r.body.details.rules).toEqual([]); // the PAID rule does not apply to PROFESSIONAL
    expect((await call(t, pro, 'GET', '/v1/guides/me')).body.item).toMatchObject({ status: 'DRAFT', paid_enabled: false });
    expect((await call(t, null, 'GET', `/v1/guides/${pro.id}`)).status).toBe(404);
    expect(await searchIds({ city: 'Seoul', types: 'PROFESSIONAL' })).toEqual([]);
  });

  it('N3. while guide.paid is OFF: paid publication denied, paid offers refused, payment prepare refused', async () => {
    const g2 = await qualifiedPaidGuide('Flag Off Guide');
    // an ACCEPTED (unpaid) paid booking created while the flag is ON
    const t3 = await createUser(t, { displayName: 'Late Payer' });
    const w = { startAt: ts(4 * DAY), endAt: ts(4 * DAY + HOUR) };
    const rid = await requestGuide(t3, paidGuide.id, w);
    expect((await offer(paidGuide, rid, w, true, PRICE)).status).toBe(201);
    const acc = await call(t, t3, 'POST', `/v1/guide-requests/${rid}/accept`, { offerVersion: 1 }, idem());
    expect(acc.status, show(acc)).toBe(201);
    const bid = acc.body.booking.id as string;
    expect(acc.body.booking.status).toBe('ACCEPTED');

    await setPaidFlag(false, 'G9 gate temporarily withdrawn (test)');
    try {
      const r = await call(t, g2, 'POST', '/v1/guides/profile/publish');
      expect(r.status, show(r)).toBe(422);
      expect(r.body.code).toBe('GUIDE_PAID_GATE_FAILED');
      expect(r.body.details.reasons).toEqual(['FEATURE_DISABLED:guide.paid']);
      expect((await call(t, g2, 'GET', '/v1/guides/me')).body.item).toMatchObject({ status: 'DRAFT', paid_enabled: false });
      expect((await call(t, null, 'GET', `/v1/guides/${g2.id}`)).status).toBe(404);

      const rid2 = await requestGuide(t3, paidGuide.id, { startAt: ts(6 * DAY), endAt: ts(6 * DAY + HOUR) });
      const o = await offer(paidGuide, rid2, { startAt: ts(6 * DAY), endAt: ts(6 * DAY + HOUR) }, true, PRICE);
      expect(o.status, show(o)).toBe(403);
      expect(o.body.code).toBe('FEATURE_DISABLED');
      expect((await getRequest(t3, rid2)).status).toBe('REQUESTED');

      const prep = await call(t, t3, 'POST', '/v1/payments/toss/prepare', { subjectType: 'GUIDE_BOOKING', subjectId: bid }, idem());
      expect(prep.status, show(prep)).toBe(403);
      expect(prep.body.code).toBe('FEATURE_DISABLED');
      expect((await getBooking(t3, bid)).status).toBe('ACCEPTED');
      expect((await call(t, t3, 'GET', '/v1/payments')).body.items.filter((x: any) => x.subjectId === bid)).toEqual([]);
      expect((await call(t, t3, 'POST', `/v1/guide-requests/${rid2}/cancel`, {})).body.item.status).toBe('CANCELLED');
    } finally {
      await setPaidFlag(true, 'G9 gate restored (test)');
    }
    // an unpaid paid booking is cancelled without any refund
    const cx = await call(t, t3, 'POST', `/v1/guide-bookings/${bid}/cancel`, { reason: 'changed my mind' }, idem());
    expect(cx.status, show(cx)).toBe(200);
    expect(cx.body.item.status).toBe('CANCELLED');
    expect(cx.body.refund).toBeNull();
  });

  it('N4. a published PAID guide whose republication is denied (flag OFF) must not stay listed as a free guide', async () => {
    // Invariant 7 + the documented continuous-enforcement policy (reevaluatePaidGuide): a PAID/PROFESSIONAL guide that
    // no longer passes the gate has paid selling turned off AND is hidden until republished. A denied republish must
    // leave the profile in the same safe state — never PUBLISHED-as-free (it can sell nothing: PAID offers must be paid).
    const waiting = await createUser(t, { displayName: 'Hopeful Traveler' });
    let strayRequestId: string | null = null;
    await setPaidFlag(false, 'G9 gate temporarily withdrawn (test)');
    try {
      const r = await call(t, paidGuide, 'POST', '/v1/guides/profile/publish');
      expect(r.status, show(r)).toBe(422);
      expect(r.body.code).toBe('GUIDE_PAID_GATE_FAILED');
      expect(r.body.details.reasons).toEqual(['FEATURE_DISABLED:guide.paid']);
      const me = await call(t, paidGuide, 'GET', '/v1/guides/me');
      expect(me.body.item.paid_enabled).toBe(false);
      const pub = await call(t, null, 'GET', `/v1/guides/${paidGuide.id}`);
      const listedFree = (await searchIds({ city: 'Seoul', pricing: 'free' })).includes(paidGuide.id);
      const req = await call(t, waiting, 'POST', '/v1/guide-requests', { guideId: paidGuide.id, startAt: ts(7 * DAY), endAt: ts(7 * DAY + HOUR) });
      if (req.status === 201) strayRequestId = req.body.item.id;
      const offerTry = strayRequestId ? await offer(paidGuide, strayRequestId, { startAt: ts(7 * DAY), endAt: ts(7 * DAY + HOUR) }, true, PRICE) : null;
      await t.runJobs(); // the continuous re-evaluation job must not leave it published either
      const afterJobs = (await call(t, paidGuide, 'GET', '/v1/guides/me')).body.item;
      const facts = `profile=${me.body.item.status}/paid_enabled=${me.body.item.paid_enabled}; public GET ${pub.status} ${JSON.stringify(pub.body.item ? { free: pub.body.item.free, paidEnabled: pub.body.item.paidEnabled, hourlyPriceMinor: pub.body.item.hourlyPriceMinor } : pub.body)}; listed under pricing=free: ${listedFree}; traveler request → ${req.status}; guide offer on it → ${offerTry?.status} ${offerTry?.body?.code}; after jobs: ${afterJobs.status}/paid_enabled=${afterJobs.paid_enabled}`;
      expect.soft(me.body.item.status, `denied PAID guide must not stay PUBLISHED — ${facts}`).not.toBe('PUBLISHED');
      expect.soft(pub.status, `denied PAID guide must not be publicly visible — ${facts}`).toBe(404);
      expect.soft(listedFree, `denied PAID guide must not be listed as a free guide — ${facts}`).toBe(false);
      expect.soft(req.status, `travelers must not be able to request a guide that can sell nothing — ${facts}`).toBe(422);
      expect.soft(afterJobs.status, `re-evaluation job must not leave it PUBLISHED — ${facts}`).not.toBe('PUBLISHED');
    } finally {
      await setPaidFlag(true, 'G9 gate restored (test)');
      if (strayRequestId) await call(t, waiting, 'POST', `/v1/guide-requests/${strayRequestId}/cancel`, {});
      await call(t, paidGuide, 'POST', '/v1/guides/profile/publish');
    }
    const restored = await call(t, paidGuide, 'GET', '/v1/guides/me');
    expect(restored.body.item).toMatchObject({ status: 'PUBLISHED', paid_enabled: true });
  });

  it('N5. double booking of the same guide time → 409 (offer pre-check, sequential accept, concurrent accepts)', async () => {
    const [tA, tB, tC, tD, tE, tF] = await Promise.all(Array.from({ length: 6 }, (_, i) => createUser(t, { displayName: `Traveler ${'ABCDEF'[i]}` })));
    const A = win(5 * DAY + HOUR, 5 * DAY + 3 * HOUR);
    const B = win(5 * DAY + 2 * HOUR, 5 * DAY + 4 * HOUR); // overlaps A
    const C = win(5 * DAY + 5 * HOUR, 5 * DAY + 6 * HOUR);
    const D = win(5 * DAY + 7 * HOUR, 5 * DAY + 8 * HOUR);

    const accept = (u: TestUser, rid: string) => call(t, u, 'POST', `/v1/guide-requests/${rid}/accept`, { offerVersion: 1 }, idem());

    // A is booked
    const ra = await requestGuide(tA, friendGuide.id, A);
    expect((await offer(friendGuide, ra, A, false)).status).toBe(201);
    const aa = await accept(tA, ra);
    expect(aa.status, show(aa)).toBe(201);
    expect(aa.body.booking.status).toBe('CONFIRMED');

    // overlapping (B) and identical (A) windows are refused up-front
    for (const w of [B, A]) {
      const rb = await requestGuide(tB, friendGuide.id, w);
      const ob = await offer(friendGuide, rb, w, false);
      expect(ob.status, show(ob)).toBe(409);
      expect(ob.body.code).toBe('GUIDE_UNAVAILABLE');
      expect((await getRequest(tB, rb)).status).toBe('REQUESTED');
    }

    // sequential: two open offers for D; the second accept is refused and fully rolled back
    const rc = await requestGuide(tC, friendGuide.id, D);
    const rd = await requestGuide(tD, friendGuide.id, D);
    expect((await offer(friendGuide, rc, D, false)).status).toBe(201);
    expect((await offer(friendGuide, rd, D, false)).status).toBe(201);
    const ac = await accept(tC, rc);
    expect(ac.status, show(ac)).toBe(201);
    const ad = await accept(tD, rd);
    expect(ad.status, show(ad)).toBe(409);
    expect(ad.body.code).toBe('GUIDE_UNAVAILABLE');
    const rdAfter = await getRequest(tD, rd);
    expect(rdAfter.status).toBe('OFFERED');
    expect(rdAfter.offers.map((o: any) => o.status)).toEqual(['OPEN']);
    expect(rdAfter.booking).toBeNull();

    // concurrent: two open offers for C, accepted at the same time → exactly one booking (DB exclusion constraint)
    const re = await requestGuide(tE, friendGuide.id, C);
    const rf = await requestGuide(tF, friendGuide.id, C);
    expect((await offer(friendGuide, re, C, false)).status).toBe(201);
    expect((await offer(friendGuide, rf, C, false)).status).toBe(201);
    const race = await Promise.all([accept(tE, re), accept(tF, rf)]);
    expect(race.map((x) => x.status).sort(), JSON.stringify(race.map((x) => x.body))).toEqual([201, 409]);
    expect(race.find((x) => x.status === 409)!.body.code).toBe('GUIDE_UNAVAILABLE');
    const winner = race.find((x) => x.status === 201)!.body.booking;

    // exactly three non-overlapping active bookings in the later slot, and the free time reflects them
    const list = await call(t, friendGuide, 'GET', '/v1/guide-bookings?role=guide&status=CONFIRMED&limit=100');
    expect(list.status).toBe(200);
    const later = list.body.items.filter((x: any) => new Date(x.start_at).getTime() >= T0 + 5 * DAY);
    expect(later.map((x: any) => x.id).sort()).toEqual([aa.body.booking.id, ac.body.booking.id, winner.id].sort());
    expect(later.map((x: any) => [iso(x.start_at), iso(x.end_at)]).sort()).toEqual([[A.startAt, A.endAt], [C.startAt, C.endAt], [D.startAt, D.endAt]].sort());
    const free = await call(t, null, 'GET', `/v1/guides/${friendGuide.id}/availability?from=${encodeURIComponent(LATER_SLOT.startAt)}&to=${encodeURIComponent(LATER_SLOT.endAt)}`);
    expect(free.body.items).toEqual([
      { startAt: LATER_SLOT.startAt, endAt: A.startAt },
      { startAt: A.endAt, endAt: C.startAt },
      { startAt: C.endAt, endAt: D.startAt },
      { startAt: D.endAt, endAt: LATER_SLOT.endAt },
    ]);

    await assertOutboxHealthy();
    expect((await trialBalance()).balanced).toBe(true);
  });
});
