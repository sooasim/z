/**
 * G4 end-to-end release gate — Paid Stay chain, driven over HTTP only (call(t, user, ...)).
 *
 * Chain: real signup (consents) → email verify → login → host application → identity/host verification →
 * admin approval → listing draft (address, amenities, house rules, cancellation policy) → 3 photos via the
 * presigned upload pipeline → permit + compliance review → publish → search → public detail (no exact address)
 * → calendar → quote → hold (Idempotency-Key) → payment prepare → MOCK provider confirm → CONFIRMED (exact
 * address revealed) → reservation conversation → check-in → complete → reviews → settlement (maker-checker)
 * → payout, followed by ledger / audit / state-history assertions.
 * Scenario 2: guest cancellation with a partial refund executed by the outbox (t.drain()).
 * Scenario 3: a browser success redirect alone never confirms; a wrong amount is rejected (AMOUNT_MISMATCH).
 *
 * Test-setup hooks without an API (documented, no SQL):
 *  - feature flags are switched on with enableFlags() (G9 legal gates have no self-service API in tests);
 *  - staff accounts (ADMIN+COMPLIANCE, a second COMPLIANCE officer, two ACCOUNTING users) are created with
 *    createUser() at AAL2 (staff MFA onboarding is out of scope of this chain);
 *  - the out-of-band e-mail code sender is replaced by an in-memory capture (the documented
 *    `identity.codeSender` adapter) so the e-mail verification code can be read, as a user would from their inbox;
 *  - the dev "presigned PUT" is performed with t.app.inject (it is unauthenticated, the HMAC token is in the URL);
 *  - the MOCK payment provider's call log is inspected to prove no provider confirmation happened.
 * Approved compliance and finance rules are created and approved through their APIs (four-eyes / maker-checker).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Secret, TOTP } from 'otpauth';
import { createTestApp, createUser, call, day, enableFlags, idem, type TestApp, type TestUser } from './helpers.js';
import { allocate, applyBps } from '../src/platform/money.js';
import type { CodeMessage } from '../src/modules/identity/service.js';
import type { MockProvider } from '../src/modules/payments/provider.js';

// ------------------------------------------------------------------------------------------------ fixtures

const NIGHTLY = 120_000;
const CLEANING = 30_000;
const PLATFORM_FEE_BPS = 1000; // 10% guest service fee
const HOST_FEE_BPS = 300; // 3% host fee
const TAX_BPS = 1000; // 10% VAT on the service fee
const PERMIT_TYPE = 'FOREIGN_TOURIST_HOMESTAY';
const EXACT_LINE1 = 'Mapo-daero 123, Unit 1502';
const POSTAL = '04100';
const PASSWORD = 'Str0ng-pass-phrase!';

/** 2-night stay economics (deterministic, from approved finance rules). */
const SUBTOTAL = 2 * NIGHTLY;
const FEE_BASE = SUBTOTAL + CLEANING;
const PLATFORM_FEE = applyBps(FEE_BASE, PLATFORM_FEE_BPS);
const HOST_FEE = applyBps(FEE_BASE, HOST_FEE_BPS);
const TAX = applyBps(PLATFORM_FEE, TAX_BPS);
const TOTAL = SUBTOTAL + CLEANING + PLATFORM_FEE + TAX;
const HOST_NET = FEE_BASE - HOST_FEE;
const FEE_REVENUE = TOTAL - HOST_NET - TAX;

/** Calendar date in Asia/Seoul (the listing timezone), offset by n days. */
function seoulDay(n: number): string {
  const d = new Date(Date.now() + 9 * 3600_000);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const sha256hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/** Minimal PNG (signature + IHDR) padded to look like a real file. */
function png(w: number, h: number, pad = 96) {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = 6;
  b.write(randomUUID(), 40, 'ascii'); // distinct bytes per photo
  return b;
}
const pdf = (label: string) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(`% ${label}\n`), Buffer.alloc(256, 0x20), Buffer.from('\n%%EOF\n')]);

const totpNow = (secret: string) => new TOTP({ secret: Secret.fromBase32(secret), digits: 6, period: 30, algorithm: 'SHA1' }).generate();
const corr = (label: string) => `e2e-${label}-${randomUUID()}`;
const asUser = (s: { user: { id: string; email: string }; accessToken: string; sessionId: string }): TestUser => ({
  id: s.user.id,
  email: s.user.email,
  password: PASSWORD,
  token: s.accessToken,
  sessionId: s.sessionId,
  headers: { authorization: `Bearer ${s.accessToken}` },
});
const show = (r: { status: number; body: any }) => JSON.stringify(r.body);

// ------------------------------------------------------------------------------------------------ state

let t: TestApp;
let admin: TestUser; // ADMIN + COMPLIANCE, AAL2
let compliance2: TestUser; // second compliance officer (four-eyes on rules)
let acctA: TestUser; // ACCOUNTING maker
let acctB: TestUser; // ACCOUNTING checker
let outsider: TestUser;
let host: TestUser;
let guest: TestUser;
const mailbox: CodeMessage[] = [];

let propertyId: string;
let slug: string;
let permitId: string;
let reservationId: string;
let paymentId: string;
let approvalTxId: string;
const corrIds: Record<string, string> = {};

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
  expect(c.body.item.status).toBe('READY');
  return { ...c.body.item, sha256: sha } as { id: string; visibility: string; publicUrl: string | null; sha256: string; width: number | null };
}

async function signupAndLogin(email: string, displayName: string) {
  const docs = await call(t, null, 'GET', '/v1/consent-documents');
  expect(docs.status).toBe(200);
  const v = (type: string) => docs.body.items.find((d: any) => d.type === type)?.version as string;
  expect(v('TERMS')).toBeTruthy();
  expect(v('PRIVACY')).toBeTruthy();

  // required consents are enforced server-side
  const missing = await call(t, null, 'POST', '/v1/auth/signup', { email, password: PASSWORD, displayName, consents: [{ type: 'TERMS', version: v('TERMS'), granted: true }] });
  expect(missing.status, show(missing)).toBe(422);
  expect(missing.body.code).toBe('CONSENT_REQUIRED');

  const consents = [
    { type: 'TERMS', version: v('TERMS'), granted: true },
    { type: 'PRIVACY', version: v('PRIVACY'), granted: true },
    { type: 'MARKETING', version: v('MARKETING'), granted: false },
  ];
  const s = await call(t, null, 'POST', '/v1/auth/signup', { email, password: PASSWORD, displayName, locale: 'ko-KR', consents });
  expect(s.status, show(s)).toBe(201);
  expect(s.body.tokenType).toBe('Bearer');
  expect(s.body.aal).toBe('aal1');
  expect(s.body.user).toMatchObject({ email, displayName, status: 'ACTIVE', emailVerified: false });
  expect(s.body.user.roles).not.toContain('HOST');
  const signedUp = asUser(s.body);

  // e-mail verification with the out-of-band code
  const code = mailbox.filter((m) => m.email === email && m.purpose === 'EMAIL_VERIFY').at(-1)?.code;
  expect(code, 'verification code delivered out-of-band').toMatch(/^\d{6}$/);
  const ver = await call(t, signedUp, 'POST', '/v1/auth/email/verify/confirm', { code });
  expect(ver.status, show(ver)).toBe(200);
  expect(ver.body.emailVerified).toBe(true);

  const bad = await call(t, null, 'POST', '/v1/auth/login', { email, password: 'wrong-password-1' });
  expect(bad.status).toBe(401);
  const login = await call(t, null, 'POST', '/v1/auth/login', { email, password: PASSWORD });
  expect(login.status, show(login)).toBe(200);
  expect(login.body.sessionId).not.toBe(s.body.sessionId);
  const user = asUser(login.body);

  const me = await call(t, user, 'GET', '/v1/me');
  expect(me.status).toBe(200);
  expect(me.body.user).toMatchObject({ id: user.id, email, emailVerified: true });
  expect(me.body.session).toEqual({ id: login.body.sessionId, aal: 'aal1' });

  const c = await call(t, user, 'GET', '/v1/consents');
  expect(c.status).toBe(200);
  const granted = (type: string) => c.body.history.find((h: any) => h.consent_type === type);
  expect(granted('TERMS')).toMatchObject({ version: v('TERMS'), granted: true });
  expect(granted('PRIVACY')).toMatchObject({ version: v('PRIVACY'), granted: true });
  expect(granted('MARKETING')).toMatchObject({ granted: false });
  return user;
}

async function search(params: Record<string, string | number>) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const r = await call(t, null, 'GET', `/v1/search/properties?${qs}`);
  expect(r.status, show(r)).toBe(200);
  return r.body;
}
const searchStay = (checkIn: string, checkOut: string) => search({ city: 'Seoul', checkIn, checkOut, guests: 2, mode: 'rental' });

async function quoteHoldPay(checkIn: string, checkOut: string) {
  const q = await call(t, guest, 'POST', '/v1/booking/quotes', { propertyId, checkIn, checkOut, guests: 2 });
  expect(q.status, show(q)).toBe(201);
  expect(q.body.item.totalMinor).toBe(TOTAL);
  const h = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId: q.body.item.id }, idem());
  expect(h.status, show(h)).toBe(201);
  expect(h.body.item.reservation.status).toBe('HELD');
  const rid = h.body.item.reservation.id as string;
  const p = await call(t, guest, 'POST', '/v1/payments/toss/prepare', { subjectType: 'RESERVATION', subjectId: rid }, idem());
  expect(p.status, show(p)).toBe(201);
  expect(p.body.amount).toBe(TOTAL);
  return { quote: q.body.item, reservationId: rid, prepare: p.body };
}

async function confirm(prep: { orderId: string; amount: number }, headers: Record<string, string> = {}) {
  return call(t, guest, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${randomUUID().replace(/-/g, '')}`, orderId: prep.orderId, amount: prep.amount }, { ...idem(), ...headers });
}

async function getReservation(user: TestUser, id: string) {
  const r = await call(t, user, 'GET', `/v1/reservations/${id}`);
  expect(r.status, show(r)).toBe(200);
  return r.body.item;
}

async function trialBalance() {
  const tb = await call(t, acctA, 'GET', '/v1/admin/ledger/trial-balance');
  expect(tb.status, show(tb)).toBe(200);
  return tb.body;
}

async function ledgerAccounts() {
  const r = await call(t, acctA, 'GET', '/v1/admin/ledger/accounts?currency=KRW');
  expect(r.status, show(r)).toBe(200);
  const by = (code: string) => r.body.items.find((a: any) => a.code === code);
  return { items: r.body.items as any[], balance: (code: string) => (by(code)?.balance_minor ?? 0) as number };
}

async function auditActions(category: string) {
  const r = await call(t, admin, 'GET', `/v1/admin/audit-logs?category=${category}&limit=200`);
  expect(r.status, show(r)).toBe(200);
  return r.body.items as Array<{ action: string; resource_type: string; resource_id: string | null; category: string; correlation_id: string; actor_id: string | null }>;
}

async function notifications(user: TestUser) {
  const r = await call(t, user, 'GET', '/v1/notifications?limit=100');
  expect(r.status, show(r)).toBe(200);
  return r.body.items as Array<{ templateKey: string; data: any; category: string }>;
}
const notificationKeys = async (user: TestUser) => (await notifications(user)).map((n) => n.templateKey);

async function assertOutboxHealthy() {
  await t.drain();
  const ov = await call(t, admin, 'GET', '/v1/admin/overview');
  expect(ov.status, show(ov)).toBe(200);
  const dl = await call(t, admin, 'GET', '/v1/admin/outbox/dead-letters');
  expect(ov.body.outbox, `outbox not drained cleanly; dead letters: ${JSON.stringify(dl.body)}`).toMatchObject({ pending: 0, deadLetters: 0 });
}

// ------------------------------------------------------------------------------------------------ setup

beforeAll(async () => {
  t = await createTestApp();
  // test capture of the documented out-of-band code delivery adapter (no SQL, no API exposure of codes)
  t.app.ctx.adapters.set('identity.codeSender', async (_tx: unknown, _ctx: unknown, msg: CodeMessage) => {
    mailbox.push(msg);
  });
  admin = await createUser(t, { roles: ['ADMIN', 'COMPLIANCE'], aal: 'aal2', displayName: 'Ops Admin' });
  compliance2 = await createUser(t, { roles: ['COMPLIANCE'], aal: 'aal2', displayName: 'Compliance Officer' });
  acctA = await createUser(t, { roles: ['ACCOUNTING'], aal: 'aal2', displayName: 'Accountant A' });
  acctB = await createUser(t, { roles: ['ACCOUNTING'], aal: 'aal2', displayName: 'Accountant B' });
  outsider = await createUser(t, { displayName: 'Outsider' });
  // G9 gates: paid stays + automatic payouts (MOCK payout rail in test)
  await enableFlags(t, 'stay.paid_booking', 'payout.automatic');
});
afterAll(async () => t?.close());

// ------------------------------------------------------------------------------------------------ chain

describe('G4 E2E — paid stay chain (HTTP only)', () => {
  it('0. reference rules are configured through their APIs with maker-checker / four-eyes approval', async () => {
    const effectiveFrom = new Date(Date.now() - 86_400_000).toISOString();
    for (const [ruleType, bps] of [['PLATFORM_FEE', PLATFORM_FEE_BPS], ['HOST_FEE', HOST_FEE_BPS], ['TAX', TAX_BPS]] as const) {
      const created = await call(t, acctA, 'POST', '/v1/finance/rules', { ruleType, domain: 'STAY', jurisdiction: 'KR', params: { bps }, effectiveFrom, note: 'G9 business/legal approved' });
      expect(created.status, show(created)).toBe(201);
      expect(created.body.item).toMatchObject({ ruleType, domain: 'STAY', status: 'DRAFT', createdBy: acctA.id });
      const self = await call(t, acctA, 'POST', `/v1/finance/rules/${created.body.item.id}/approve`);
      expect(self.status).toBe(403);
      expect(self.body.code).toBe('MAKER_CHECKER_VIOLATION');
      const ok = await call(t, acctB, 'POST', `/v1/finance/rules/${created.body.item.id}/approve`);
      expect(ok.status, show(ok)).toBe(200);
      expect(ok.body.item).toMatchObject({ status: 'APPROVED', approvedBy: acctB.id });
    }
    const fq = await call(t, acctA, 'GET', `/v1/finance/quote?domain=STAY&amountMinor=${FEE_BASE}&currency=KRW`);
    expect(fq.status, show(fq)).toBe(200);
    expect(fq.body.item).toMatchObject({ platformFeeMinor: PLATFORM_FEE, hostFeeMinor: HOST_FEE, taxMinor: TAX });

    const rule = await call(t, admin, 'POST', '/v1/admin/compliance/rules', {
      ruleKey: 'kr-11-foreign-tourist-homestay',
      subjectType: 'PROPERTY',
      jurisdiction: 'KR-11',
      appliesTo: { mode: ['RENTAL'] },
      requiredPermitTypes: [PERMIT_TYPE],
      effectiveFrom: day(-30),
      note: 'Seoul: paid homestays require a verified registration',
    });
    expect(rule.status, show(rule)).toBe(201);
    expect(rule.body.item).toMatchObject({ status: 'DRAFT', jurisdiction: 'KR-11', requiredPermitTypes: [PERMIT_TYPE] });
    const selfApprove = await call(t, admin, 'POST', `/v1/admin/compliance/rules/${rule.body.item.id}/approve`, {});
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.code).toBe('FOUR_EYES_REQUIRED');
    const approved = await call(t, compliance2, 'POST', `/v1/admin/compliance/rules/${rule.body.item.id}/approve`, { reason: 'legal sign-off' });
    expect(approved.status, show(approved)).toBe(200);
    expect(approved.body.item).toMatchObject({ status: 'APPROVED', approvedBy: compliance2.id });
  });

  it('1. host and guest sign up with consents, verify e-mail and log in', async () => {
    host = await signupAndLogin(`host_${randomUUID().slice(0, 8)}@e2e.jetpool.kr`, 'Minji Host');
    guest = await signupAndLogin(`guest_${randomUUID().slice(0, 8)}@e2e.jetpool.kr`, 'Alex Guest');
    expect(host.id).not.toBe(guest.id);
  });

  it('2. host application → host verification → admin approval grants HOST', async () => {
    const before = await call(t, host, 'POST', '/v1/admin/host-applications/00000000-0000-0000-0000-000000000000/approve');
    expect(before.status).toBe(403); // a regular user cannot use the admin queue

    const app = await call(t, host, 'POST', '/v1/host-applications', { displayName: 'Minji', about: 'Hosting a quiet riverside flat in Mapo since 2019.' });
    expect(app.status, show(app)).toBe(201);
    expect(app.body.item.status).toBe('SUBMITTED');
    const dup = await call(t, host, 'POST', '/v1/host-applications', {});
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('APPLICATION_OPEN');

    // identity/business evidence via the private VERIFICATION media pipeline
    const doc = await upload(host, 'VERIFICATION', 'application/pdf', pdf('host business registration'));
    expect(doc.visibility).toBe('PRIVATE');
    expect(doc.publicUrl).toBeNull();
    const vc = await call(t, host, 'POST', '/v1/verifications', { subjectType: 'HOST', documents: [{ documentType: 'BUSINESS_REGISTRATION', mediaId: doc.id, sha256: doc.sha256 }] });
    expect(vc.status, show(vc)).toBe(201);
    expect(vc.body.item.status).toBe('SUBMITTED');
    const caseId = vc.body.item.id as string;

    const queue = await call(t, admin, 'GET', '/v1/admin/verifications?subjectType=HOST');
    expect(queue.status, show(queue)).toBe(200);
    expect(queue.body.items.map((i: any) => i.id)).toContain(caseId);
    const sr = await call(t, admin, 'POST', `/v1/admin/verifications/${caseId}/start-review`);
    expect(sr.status, show(sr)).toBe(200);
    expect(sr.body.item.status).toBe('IN_REVIEW');
    const va = await call(t, admin, 'POST', `/v1/admin/verifications/${caseId}/approve`, { reason: 'documents match' });
    expect(va.status, show(va)).toBe(200);
    expect(va.body.item.status).toBe('APPROVED');

    const apps = await call(t, admin, 'GET', '/v1/admin/host-applications');
    expect(apps.status, show(apps)).toBe(200);
    const mine = apps.body.items.find((a: any) => a.id === app.body.item.id);
    expect(mine).toBeTruthy();
    expect(mine.verification_status).toBe('VERIFIED');
    const ok = await call(t, admin, 'POST', `/v1/admin/host-applications/${app.body.item.id}/approve`, { reason: 'checklist complete' });
    expect(ok.status, show(ok)).toBe(200);
    expect(ok.body.item.status).toBe('APPROVED');

    const me = await call(t, host, 'GET', '/v1/me');
    expect(me.body.user.roles).toContain('HOST');
    const dash = await call(t, host, 'GET', '/v1/host/me');
    expect(dash.status, show(dash)).toBe(200);
    expect(dash.body.profile).toMatchObject({ status: 'APPROVED', verificationStatus: 'VERIFIED' });
    expect(dash.body.canPublish).toBe(true);
    expect(dash.body.publishBlockers).toEqual([]);
    expect(await notificationKeys(host)).toEqual(expect.arrayContaining(['host.approved', 'verification.approved']));
  });

  it('3. listing draft → 3 photos → permit → compliance review → admin verify → publish', async () => {
    const amen = await call(t, null, 'GET', '/v1/amenities');
    const codes = amen.body.items.map((a: any) => a.code);
    expect(codes).toEqual(expect.arrayContaining(['wifi', 'kitchen', 'aircon']));
    const pols = await call(t, null, 'GET', '/v1/properties/cancellation-policies');
    expect(pols.body.items.map((p: any) => p.code)).toContain('MODERATE');

    const draft = await call(t, host, 'POST', '/v1/properties', {
      title: 'Hangang View Apartment Mapo',
      summary: 'Bright two-bedroom flat by the river',
      description: 'A bright two-bedroom apartment overlooking the Han river, five minutes from Mapo station, with a full kitchen and fast Wi-Fi.',
      propertyType: 'APARTMENT',
      roomType: 'ENTIRE',
      maxGuests: 4,
      bedrooms: 2,
      beds: 2,
      bathrooms: 1.5,
      lat: 37.5446,
      lng: 126.9496,
      country: 'KR',
      region: 'KR-11',
      city: 'Seoul',
      timezone: 'Asia/Seoul',
      rentalEnabled: true,
      exchangeEnabled: false,
      instantBook: true,
      basePriceMinor: NIGHTLY,
      cleaningFeeMinor: CLEANING,
      currency: 'KRW',
      minNights: 1,
      maxNights: 30,
      checkInTime: '15:00',
      checkOutTime: '11:00',
      cancellationPolicyCode: 'MODERATE',
      address: { line1: EXACT_LINE1, postalCode: POSTAL, city: 'Seoul', region: 'KR-11', country: 'KR', publicAreaLabel: 'Mapo-gu' },
      houseRules: { smokingAllowed: false, petsAllowed: false, eventsAllowed: false, quietHours: '22:00-08:00', extraRules: 'Please remove shoes indoors.' },
      amenities: ['wifi', 'kitchen', 'aircon'],
    });
    expect(draft.status, show(draft)).toBe(201);
    const p = draft.body.item;
    propertyId = p.id;
    slug = p.slug;
    expect(p).toMatchObject({ status: 'DRAFT', hostId: host.id, paidBookingEnabled: false, basePriceMinor: NIGHTLY, cleaningFeeMinor: CLEANING, currency: 'KRW', timezone: 'Asia/Seoul' });
    expect(p.address).toMatchObject({ line1: EXACT_LINE1, postalCode: POSTAL, publicAreaLabel: 'Mapo-gu' });
    expect(p.amenities.map((a: any) => a.code).sort()).toEqual(['aircon', 'kitchen', 'wifi']);
    expect(p.houseRules).toMatchObject({ smokingAllowed: false, quietHours: '22:00-08:00' });
    expect(p.cancellationPolicy.code).toBe('MODERATE');
    expect(slug).toMatch(/^hangang-view-apartment-mapo-[0-9a-z]{6}$/);

    // other users cannot edit; drafts are not public
    expect((await call(t, guest, 'PATCH', `/v1/properties/${propertyId}`, { title: 'Hijacked' })).status).toBe(403);
    expect((await call(t, null, 'GET', `/v1/properties/by-slug/${slug}`)).status).toBe(404);

    // content gate: photos are required
    const early = await call(t, host, 'POST', `/v1/properties/${propertyId}/publish`);
    expect(early.status, show(early)).toBe(422);
    expect(early.body.code).toBe('PUBLISH_VALIDATION_FAILED');
    expect(early.body.details.errors).toEqual(['MEDIA_MIN_3']);

    const photos = [];
    for (const [w, h] of [[1600, 1067], [1200, 800], [1024, 768]]) {
      const m = await upload(host, 'PROPERTY', 'image/png', png(w, h));
      expect(m).toMatchObject({ visibility: 'PUBLIC', width: w });
      expect(m.publicUrl).toMatch(/\/public\/[0-9a-f-]+\.png$/);
      photos.push(m);
    }
    const att = await call(t, host, 'PUT', `/v1/properties/${propertyId}/media`, { items: photos.map((m, i) => ({ mediaId: m.id, caption: `photo ${i + 1}` })) });
    expect(att.status, show(att)).toBe(200);
    expect(att.body.items.map((m: any) => m.id)).toEqual(photos.map((m) => m.id));

    // permit with private evidence
    const permitDoc = await upload(host, 'VERIFICATION', 'application/pdf', pdf('homestay registration certificate'));
    const permit = await call(t, host, 'POST', `/v1/properties/${propertyId}/permits`, {
      permitType: PERMIT_TYPE, permitNo: 'MAPO-2026-0042', jurisdiction: 'KR-11', documentMediaId: permitDoc.id, validFrom: day(-30), validUntil: day(365),
    });
    expect(permit.status, show(permit)).toBe(201);
    expect(permit.body.item.status).toBe('PENDING');
    permitId = permit.body.item.id;

    // invariant 7: a paid listing with a pending permit is held for review, not published
    const review = await call(t, host, 'POST', `/v1/properties/${propertyId}/publish`);
    expect(review.status, show(review)).toBe(202);
    expect(review.body.outcome).toBe('IN_REVIEW');
    expect(review.body.compliance.decision).toBe('REVIEW');
    expect(review.body.compliance.reasons).toContain(`PERMIT_PENDING:kr-11-foreign-tourist-homestay:${PERMIT_TYPE}`);
    expect(review.body.item).toMatchObject({ status: 'IN_REVIEW', paidBookingEnabled: false });

    const pq = await call(t, admin, 'GET', '/v1/admin/permits?status=PENDING');
    expect(pq.status, show(pq)).toBe(200);
    expect(pq.body.items.map((x: any) => x.id)).toContain(permitId);
    expect((await call(t, host, 'POST', `/v1/admin/permits/${permitId}/verify`, {})).status).toBe(403);
    const pv = await call(t, admin, 'POST', `/v1/admin/permits/${permitId}/verify`, {});
    expect(pv.status, show(pv)).toBe(200);
    expect(pv.body.item.status).toBe('VERIFIED');
    expect(pv.body.evaluation.decision).toBe('ALLOW');

    const pub = await call(t, host, 'POST', `/v1/properties/${propertyId}/publish`);
    expect(pub.status, show(pub)).toBe(200);
    expect(pub.body.outcome).toBe('PUBLISHED');
    expect(pub.body.compliance).toMatchObject({ decision: 'ALLOW', reasons: [] });
    expect(pub.body.item).toMatchObject({ status: 'PUBLISHED', paidBookingEnabled: true });
    expect(pub.body.item.publishedAt).toBeTruthy();

    await t.drain(); // search projection
  });

  it('4. discovery: search for the dates, public detail by slug without the exact address, calendar', async () => {
    const [ci, co] = [seoulDay(0), seoulDay(2)];
    const res = await searchStay(ci, co);
    expect(res.candidatesOnly).toBe(true);
    expect(res.dateFiltered).toBe(true);
    const card = res.items.find((i: any) => i.id === propertyId);
    expect(card, 'published listing must be searchable for free dates').toBeTruthy();
    expect(card).toMatchObject({ slug, priceMinor: NIGHTLY, currency: 'KRW', paidBookingEnabled: true, rentalEnabled: true, areaLabel: 'Mapo-gu' });
    expect(card.photoUrls).toHaveLength(3);
    expect(card.location.approximate).toBe(true);
    expect(JSON.stringify(card)).not.toContain(EXACT_LINE1);

    const detail = await call(t, guest, 'GET', `/v1/properties/by-slug/${slug}`);
    expect(detail.status, show(detail)).toBe(200);
    const d = detail.body.item;
    expect(d.id).toBe(propertyId);
    expect(d.address).toBeUndefined();
    expect(d.hostId).toBeUndefined();
    const raw = JSON.stringify(d);
    expect(raw).not.toContain(EXACT_LINE1);
    expect(raw).not.toContain(POSTAL);
    expect(d.location).toMatchObject({ city: 'Seoul', areaLabel: 'Mapo-gu', approximate: true });
    expect([d.location.lat, d.location.lng]).not.toEqual([37.5446, 126.9496]);
    expect(Math.abs(d.location.lat - 37.5446)).toBeLessThan(0.05);
    expect(d.media).toHaveLength(3);
    expect(d.amenities.map((a: any) => a.code).sort()).toEqual(['aircon', 'kitchen', 'wifi']);
    expect(d.houseRules.extraRules).toBe('Please remove shoes indoors.');
    expect(d.cancellationPolicy.code).toBe('MODERATE');
    expect(d.host).toMatchObject({ id: host.id, verified: true });
    // the guest is not the owner: the id route gives the public view as well
    const byId = await call(t, guest, 'GET', `/v1/properties/${propertyId}`);
    expect(byId.status).toBe(200);
    expect(byId.body.item.address).toBeUndefined();

    const cal = await call(t, guest, 'GET', `/v1/properties/${propertyId}/calendar?from=${ci}&to=${co}`);
    expect(cal.status, show(cal)).toBe(200);
    expect(cal.body.item.days).toEqual([
      { date: ci, status: 'available', priceMinor: NIGHTLY, minNights: 1 },
      { date: seoulDay(1), status: 'available', priceMinor: NIGHTLY, minNights: 1 },
    ]);
  });

  it('5. quote → hold (Idempotency-Key) → prepare → MOCK confirm → CONFIRMED with exact address', async () => {
    const [ci, co] = [seoulDay(0), seoulDay(2)];
    const selfBook = await call(t, host, 'POST', '/v1/booking/quotes', { propertyId, checkIn: ci, checkOut: co, guests: 2 });
    expect(selfBook.status).toBe(403);
    expect(selfBook.body.code).toBe('SELF_BOOKING');

    const q = await call(t, guest, 'POST', '/v1/booking/quotes', { propertyId, checkIn: ci, checkOut: co, guests: 2 });
    expect(q.status, show(q)).toBe(201);
    expect(q.body.item).toMatchObject({
      propertyId, checkIn: ci, checkOut: co, guests: 2, nights: 2, currency: 'KRW',
      subtotalMinor: SUBTOTAL, cleaningFeeMinor: CLEANING, platformFeeMinor: PLATFORM_FEE, taxMinor: TAX, discountMinor: 0, totalMinor: TOTAL,
    });
    expect(q.body.item.breakdown.hostFeeMinor).toBe(HOST_FEE);
    expect(Object.keys(q.body.item.rulesVersion.finance).sort()).toEqual(['HOST_FEE', 'PLATFORM_FEE', 'TAX']);

    const noKey = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId: q.body.item.id });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const key = idem();
    corrIds.hold = corr('hold');
    const h = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId: q.body.item.id }, { ...key, 'x-correlation-id': corrIds.hold });
    expect(h.status, show(h)).toBe(201);
    expect(h.headers['x-correlation-id']).toBe(corrIds.hold);
    expect(h.body.item.hold).toMatchObject({ status: 'ACTIVE', propertyId, guestId: guest.id });
    expect(h.body.item.reservation).toMatchObject({ status: 'HELD', propertyId, hostId: host.id, guestId: guest.id, totalMinor: TOTAL, refundedMinor: 0, currency: 'KRW' });
    reservationId = h.body.item.reservation.id;

    const replay = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId: q.body.item.id }, key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.item.reservation.id).toBe(reservationId);
    const reused = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId: randomUUID() }, key);
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const second = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId: q.body.item.id }, idem());
    expect(second.status).toBe(409); // HOLD_EXISTS — one hold per quote

    const held = await getReservation(guest, reservationId);
    expect(held.status).toBe('HELD');
    expect(held.property.address).toBeNull(); // exact address hidden before confirmation
    // the hold blocks the dates for everyone else
    await t.drain();
    expect((await searchStay(ci, co)).items.map((i: any) => i.id)).not.toContain(propertyId);

    // payments: the amount is computed server-side
    expect((await call(t, outsider, 'POST', '/v1/payments/toss/prepare', { subjectType: 'RESERVATION', subjectId: reservationId }, idem())).status).toBe(403);
    expect((await call(t, guest, 'POST', '/v1/payments/toss/prepare', { subjectType: 'RESERVATION', subjectId: reservationId })).status).toBe(400); // Idempotency-Key required
    corrIds.prepare = corr('prepare');
    const prepKey = idem();
    const prep = await call(t, guest, 'POST', '/v1/payments/toss/prepare', { subjectType: 'RESERVATION', subjectId: reservationId }, { ...prepKey, 'x-correlation-id': corrIds.prepare });
    expect(prep.status, show(prep)).toBe(201);
    expect(prep.body).toMatchObject({ amount: TOTAL, currency: 'KRW', provider: 'MOCK' });
    expect(prep.body.orderId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
    paymentId = prep.body.paymentId;
    const prepReplay = await call(t, guest, 'POST', '/v1/payments/toss/prepare', { subjectType: 'RESERVATION', subjectId: reservationId }, prepKey);
    expect(prepReplay.status).toBe(201);
    expect(prepReplay.headers['idempotent-replayed']).toBe('true');
    expect(prepReplay.body.paymentId).toBe(paymentId);
    expect((await getReservation(guest, reservationId)).status).toBe('PAYMENT_PENDING');

    corrIds.confirm = corr('confirm');
    const confirmKey = idem();
    const paymentKey = `mock_${randomUUID().replace(/-/g, '')}`;
    const body = { paymentKey, orderId: prep.body.orderId, amount: prep.body.amount };
    const c = await call(t, guest, 'POST', '/v1/payments/toss/confirm', body, { ...confirmKey, 'x-correlation-id': corrIds.confirm });
    expect(c.status, show(c)).toBe(200);
    expect(c.body.item).toMatchObject({ id: paymentId, status: 'APPROVED', amountMinor: TOTAL, currency: 'KRW', paymentKey, method: 'CARD', subjectType: 'RESERVATION', subjectId: reservationId });
    const again = await call(t, guest, 'POST', '/v1/payments/toss/confirm', body, confirmKey);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');

    const r = await getReservation(guest, reservationId);
    expect(r).toMatchObject({ status: 'CONFIRMED', totalMinor: TOTAL, viewerRole: 'GUEST' });
    expect(r.confirmedAt).toBeTruthy();
    expect(r.property.address).toMatchObject({ line1: EXACT_LINE1, postalCode: POSTAL, city: 'Seoul', country: 'KR' });
    expect((await call(t, outsider, 'GET', `/v1/reservations/${reservationId}`)).status).toBe(403);

    const pay = await call(t, guest, 'GET', `/v1/payments/${paymentId}`);
    expect(pay.status).toBe(200);
    expect(pay.body.item).toMatchObject({ status: 'APPROVED', refundedMinor: 0, refundableMinor: TOTAL, refunds: [] });
    const rc = await call(t, guest, 'GET', '/v1/receipts');
    expect(rc.body.items.filter((x: any) => x.paymentId === paymentId)).toEqual([expect.objectContaining({ receiptType: 'PAYMENT', amountMinor: TOTAL, currency: 'KRW' })]);

    const hostView = await call(t, host, 'GET', '/v1/host/reservations?filter=current');
    expect(hostView.status).toBe(200);
    expect(hostView.body.items.map((x: any) => x.id)).toContain(reservationId);

    await t.drain();
    expect((await searchStay(ci, co)).items.map((i: any) => i.id)).not.toContain(propertyId);
    const cal = await call(t, guest, 'GET', `/v1/properties/${propertyId}/calendar?from=${ci}&to=${co}`);
    expect(cal.body.item.days.map((x: any) => x.status)).toEqual(['booked', 'booked']);
    // nobody else can book the confirmed dates
    const clash = await call(t, outsider, 'POST', '/v1/booking/quotes', { propertyId, checkIn: ci, checkOut: co, guests: 1 });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('INVENTORY_UNAVAILABLE');

    const gn = await notifications(guest);
    expect(gn.find((n) => n.templateKey === 'reservation.confirmed.guest')?.data).toMatchObject({ reservationId, code: r.code });
    expect(gn.map((n) => n.templateKey)).toContain('payment.approved');
    expect((await notifications(host)).find((n) => n.templateKey === 'reservation.confirmed.host')?.data).toMatchObject({ reservationId });
    const hostRes = await getReservation(host, reservationId);
    expect(hostRes.viewerRole).toBe('HOST');
    expect(hostRes.property.address).toMatchObject({ line1: EXACT_LINE1 });
  });

  it('6. a reservation conversation exists and both parties (only) can message', async () => {
    const gl = await call(t, guest, 'GET', '/v1/conversations');
    expect(gl.status, show(gl)).toBe(200);
    const conv = gl.body.items.find((c: any) => c.contextType === 'RESERVATION' && c.contextId === reservationId);
    expect(conv, 'reservation conversation created on confirmation').toBeTruthy();
    expect(conv.myRole).toBe('GUEST');
    expect(conv.members.map((m: any) => m.userId).sort()).toEqual([guest.id, host.id].sort());
    const hl = await call(t, host, 'GET', '/v1/conversations');
    expect(hl.body.items.find((c: any) => c.id === conv.id)?.myRole).toBe('HOST');

    const g = await call(t, guest, 'POST', `/v1/conversations/${conv.id}/messages`, { body: 'Hi! We will arrive around 4pm.', clientMessageId: 'g-1' });
    expect(g.status, show(g)).toBe(201);
    const h = await call(t, host, 'POST', `/v1/conversations/${conv.id}/messages`, { body: 'Welcome! The key box code will be sent on arrival day.', clientMessageId: 'h-1' });
    expect(h.status, show(h)).toBe(201);
    for (const u of [guest, host]) {
      const msgs = await call(t, u, 'GET', `/v1/conversations/${conv.id}/messages`);
      expect(msgs.status).toBe(200);
      expect(msgs.body.items.filter((m: any) => m.type !== 'SYSTEM').map((m: any) => m.senderId).sort()).toEqual([guest.id, host.id].sort());
    }
    expect((await call(t, outsider, 'GET', `/v1/conversations/${conv.id}/messages`)).status).toBe(404);
    expect((await call(t, outsider, 'POST', `/v1/conversations/${conv.id}/messages`, { body: 'spam' })).status).toBe(404);
  });

  it('7. host check-in → complete → guest review', async () => {
    expect((await call(t, guest, 'POST', `/v1/reservations/${reservationId}/complete`)).status).toBe(403);
    const early = await call(t, host, 'POST', `/v1/reservations/${reservationId}/complete`);
    expect(early.status).toBe(409); // CONFIRMED → COMPLETED is not a valid transition

    corrIds.checkIn = corr('checkin');
    const ci = await call(t, host, 'POST', `/v1/reservations/${reservationId}/check-in`, {}, { 'x-correlation-id': corrIds.checkIn });
    expect(ci.status, show(ci)).toBe(200);
    expect(ci.body.item.status).toBe('CHECKED_IN');
    expect(ci.body.item.checkedInAt).toBeTruthy();

    const reviewEarly = await call(t, guest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: reservationId, targetType: 'PROPERTY', rating: 5 });
    expect(reviewEarly.status).toBe(422);
    expect(reviewEarly.body.code).toBe('TRANSACTION_NOT_COMPLETED');

    corrIds.complete = corr('complete');
    const done = await call(t, host, 'POST', `/v1/reservations/${reservationId}/complete`, { reason: 'guest checked out' }, { 'x-correlation-id': corrIds.complete });
    expect(done.status, show(done)).toBe(200);
    expect(done.body.item.status).toBe('COMPLETED');

    const rv = await call(t, guest, 'POST', '/v1/reviews', {
      transactionType: 'RESERVATION', transactionId: reservationId, targetType: 'PROPERTY', rating: 5, subRatings: { cleanliness: 5, location: 5 }, body: 'Spotless flat with a wonderful river view.',
    });
    expect(rv.status, show(rv)).toBe(201);
    const rh = await call(t, guest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: reservationId, targetType: 'HOST', rating: 4, body: 'Very responsive host.' });
    expect(rh.status, show(rh)).toBe(201);
    const dup = await call(t, guest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: reservationId, targetType: 'PROPERTY', rating: 1 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('REVIEW_EXISTS');
    expect((await call(t, outsider, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: reservationId, targetType: 'PROPERTY', rating: 1 })).status).toBe(403);

    const list = await call(t, null, 'GET', `/v1/reviews?targetType=PROPERTY&targetId=${propertyId}`);
    expect(list.status).toBe(200);
    expect(list.body.summary).toEqual({ reviewCount: 1, ratingAvg: 5 });
    await t.drain();
    const d = await call(t, null, 'GET', `/v1/properties/by-slug/${slug}`);
    expect(d.body.item.reputation).toEqual({ reviewCount: 1, ratingAvg: 5 });
    expect(d.body.item.host.reputation).toEqual({ reviewCount: 1, ratingAvg: 4 });
  });

  it('8. accounting generates, a different accountant approves, payout; host sees earnings', async () => {
    // payout account registration requires AAL2: the host enrolls TOTP through the API
    const plain = await call(t, host, 'POST', '/v1/payout-accounts', { bankCode: '088', accountLast4: '4321', accountToken: 'tok_e2e_host_payout', holderName: 'Minji Kim' });
    expect(plain.status).toBe(403);
    expect(plain.body.code).toBe('AAL2_REQUIRED');
    const enroll = await call(t, host, 'POST', '/v1/auth/mfa/totp/enroll');
    expect(enroll.status, show(enroll)).toBe(201);
    const mfa = await call(t, host, 'POST', '/v1/auth/mfa/totp/verify', { factorId: enroll.body.factorId, code: totpNow(enroll.body.secret) });
    expect(mfa.status, show(mfa)).toBe(200);
    expect(mfa.body.aal).toBe('aal2');
    host = { ...host, token: mfa.body.accessToken, headers: { authorization: `Bearer ${mfa.body.accessToken}` } };
    const rawNumber = await call(t, host, 'POST', '/v1/payout-accounts', { bankCode: '088', accountLast4: '4321', accountToken: '110123456789', holderName: 'Minji Kim' });
    expect(rawNumber.status).toBe(400); // full account numbers are refused
    const acc = await call(t, host, 'POST', '/v1/payout-accounts', { bankCode: '088', accountLast4: '4321', accountToken: 'tok_e2e_host_payout', holderName: 'Minji Kim' });
    expect(acc.status, show(acc)).toBe(201);
    expect(acc.body.item.status).toBe('PENDING');
    expect(JSON.stringify(acc.body)).not.toContain('tok_e2e_host_payout');
    const vacc = await call(t, acctA, 'POST', `/v1/admin/payout-accounts/${acc.body.item.id}/verify`, { decision: 'VERIFIED' });
    expect(vacc.status, show(vacc)).toBe(200);
    expect(vacc.body.item.status).toBe('VERIFIED');

    // the PG settles collected funds into the bank
    const pgs = await call(t, acctA, 'POST', '/v1/admin/ledger/pg-settlements', { currency: 'KRW', amountMinor: TOTAL, reference: `PG-${day(0)}-001` }, idem());
    expect(pgs.status, show(pgs)).toBe(201);

    const gen = await call(t, acctA, 'POST', '/v1/admin/settlements/generate', { periodStart: day(-1), periodEnd: day(1) }, idem());
    expect(gen.status, show(gen)).toBe(201);
    const s = gen.body.items.find((x: any) => x.payeeId === host.id);
    expect(s, 'host settlement generated').toBeTruthy();
    expect(s).toMatchObject({ payeeType: 'HOST', status: 'APPROVAL_PENDING', grossMinor: FEE_BASE, feeMinor: HOST_FEE, refundMinor: 0, netMinor: HOST_NET, currency: 'KRW', generatedBy: acctA.id });

    const earn = await call(t, host, 'GET', '/v1/provider/settlements');
    expect(earn.status, show(earn)).toBe(200);
    const mine = earn.body.items.find((x: any) => x.id === s.id);
    expect(mine).toMatchObject({ status: 'APPROVAL_PENDING', netMinor: HOST_NET });
    expect(mine.lines).toEqual([{ sourceType: 'RESERVATION', sourceId: reservationId, grossMinor: FEE_BASE, feeMinor: HOST_FEE, refundMinor: 0, netMinor: HOST_NET }]);
    expect(earn.body.balances).toEqual([expect.objectContaining({ purpose: 'PAYEE_PAYABLE', currency: 'KRW', balanceMinor: HOST_NET })]);
    expect((await call(t, guest, 'GET', '/v1/provider/settlements')).body.items).toEqual([]);

    const self = await call(t, acctA, 'POST', `/v1/admin/settlements/${s.id}/approve`);
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('MAKER_CHECKER_VIOLATION');
    expect((await call(t, acctB, 'POST', `/v1/admin/settlements/${s.id}/payout`, undefined, idem())).status).toBe(409); // not yet approved
    const appr = await call(t, acctB, 'POST', `/v1/admin/settlements/${s.id}/approve`);
    expect(appr.status, show(appr)).toBe(200);
    expect(appr.body.item).toMatchObject({ status: 'APPROVED', approvedBy: acctB.id });

    const po = await call(t, acctB, 'POST', `/v1/admin/settlements/${s.id}/payout`, undefined, idem());
    expect(po.status, show(po)).toBe(200);
    expect(po.body.mode).toBe('MOCK');
    expect(po.body.item).toMatchObject({ status: 'PAID', netMinor: HOST_NET });
    expect(po.body.item.payoutRef).toMatch(/^mock_payout_/);

    const after = await call(t, host, 'GET', '/v1/provider/settlements');
    expect(after.body.items.find((x: any) => x.id === s.id)).toMatchObject({ status: 'PAID', netMinor: HOST_NET });
    expect(after.body.balances).toEqual([expect.objectContaining({ purpose: 'PAYEE_PAYABLE', balanceMinor: 0 })]);
    const stmt = await call(t, host, 'GET', '/v1/receipts');
    expect(stmt.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ receiptType: 'SETTLEMENT_STATEMENT', amountMinor: HOST_NET })]));
  });

  it('9. ledger balanced, payment postings, audit categories, full state history with correlation ids', async () => {
    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
    expect(tb.unbalancedTransactionIds).toEqual([]);
    expect(tb.currencies).toEqual([expect.objectContaining({ currency: 'KRW', differenceMinor: 0 })]);

    const lt = await call(t, acctA, 'GET', `/v1/admin/ledger/transactions?sourceType=PAYMENT&sourceId=${paymentId}`);
    expect(lt.status, show(lt)).toBe(200);
    expect(lt.body.items).toHaveLength(1);
    const ap = lt.body.items[0];
    approvalTxId = ap.id;
    expect(ap.type).toBe('PAYMENT_APPROVED');
    const entry = (account: string) => ap.entries.find((e: any) => e.account === account);
    expect(entry('PLATFORM:PG_CLEARING:KRW')).toMatchObject({ debitMinor: TOTAL, creditMinor: 0 });
    expect(entry(`PAYEE:${host.id}:PAYABLE:KRW`)).toMatchObject({ debitMinor: 0, creditMinor: HOST_NET });
    expect(entry('PLATFORM:TAX_PAYABLE:KRW')).toMatchObject({ debitMinor: 0, creditMinor: TAX });
    expect(entry('PLATFORM:FEE_REVENUE:KRW')).toMatchObject({ debitMinor: 0, creditMinor: FEE_REVENUE });
    expect(ap.entries.reduce((a: number, e: any) => a + e.debitMinor - e.creditMinor, 0)).toBe(0);

    const acc = await ledgerAccounts();
    expect(acc.balance('PLATFORM:PG_CLEARING:KRW')).toBe(0); // collected and settled by the PG
    expect(acc.balance('PLATFORM:BANK:KRW')).toBe(TOTAL - HOST_NET);
    expect(acc.balance('PLATFORM:FEE_REVENUE:KRW')).toBe(FEE_REVENUE);
    expect(acc.balance('PLATFORM:TAX_PAYABLE:KRW')).toBe(TAX);
    expect(acc.balance(`PAYEE:${host.id}:PAYABLE:KRW`)).toBe(0);

    const money = await auditActions('MONEY');
    for (const a of ['finance.rule.create', 'finance.rule.approve', 'ledger.pg_settlement', 'payout_account.create', 'payout_account.verify', 'settlement.generate', 'settlement.approve', 'settlement.payout', 'settlement.paid']) {
      expect(money.map((m) => m.action), `MONEY audit ${a}`).toContain(a);
    }
    expect(money.every((m) => m.category === 'MONEY' && !!m.correlation_id)).toBe(true);
    const perm = await auditActions('PERMISSION');
    expect(perm).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'role.granted', resource_type: 'user', resource_id: host.id, actor_id: admin.id })]));
    const comp = await auditActions('COMPLIANCE');
    for (const a of ['compliance_rule.created', 'compliance_rule.approved', 'host.applied', 'verification.submitted', 'verification.approved', 'host.approved', 'permit.verified']) {
      expect(comp.map((m) => m.action), `COMPLIANCE audit ${a}`).toContain(a);
    }
    expect(comp.find((m) => m.action === 'permit.verified')?.resource_id).toBe(permitId);

    const r = await getReservation(guest, reservationId);
    expect(r.status).toBe('COMPLETED');
    expect(r.history.map((h: any) => [h.from, h.to])).toEqual([
      [null, 'DRAFT'],
      ['DRAFT', 'QUOTED'],
      ['QUOTED', 'HELD'],
      ['HELD', 'PAYMENT_PENDING'],
      ['PAYMENT_PENDING', 'CONFIRMED'],
      ['CONFIRMED', 'CHECKED_IN'],
      ['CHECKED_IN', 'COMPLETED'],
    ]);
    expect(r.history.map((h: any) => h.correlationId)).toEqual([
      corrIds.hold, corrIds.hold, corrIds.hold, corrIds.prepare, corrIds.confirm, corrIds.checkIn, corrIds.complete,
    ]);
    expect(r.history.map((h: any) => h.actorId)).toEqual([guest.id, guest.id, guest.id, guest.id, guest.id, host.id, host.id]);
    expect(r.history.every((h: any) => !!h.at && !!h.actorType)).toBe(true);

    await assertOutboxHealthy();
  });

  it('10. guest cancels a confirmed stay → partial refund via outbox → ledger reversal → dates free again', async () => {
    const [ci, co] = [seoulDay(3), seoulDay(5)];
    expect((await searchStay(ci, co)).items.map((i: any) => i.id)).toContain(propertyId);
    const { reservationId: rid, prepare } = await quoteHoldPay(ci, co);
    const c = await confirm(prepare);
    expect(c.status, show(c)).toBe(200);
    expect(c.body.item.status).toBe('APPROVED');
    const pid = prepare.paymentId as string;
    expect((await getReservation(guest, rid)).status).toBe('CONFIRMED');
    await t.drain();
    expect((await searchStay(ci, co)).items.map((i: any) => i.id)).not.toContain(propertyId);

    // MODERATE: 24h ≤ notice < 120h → 50% of (total − non-refundable service fee)
    const expectedRefund = applyBps(TOTAL - PLATFORM_FEE, 5000);
    const prev = await call(t, guest, 'GET', `/v1/reservations/${rid}/cancellation-preview`);
    expect(prev.status, show(prev)).toBe(200);
    expect(prev.body.item.cancellable).toBe(true);
    expect(prev.body.item.evaluation).toMatchObject({
      actorRole: 'GUEST', policyCode: 'MODERATE', refundPct: 50, serviceFeeRefundable: false, platformFeeMinor: PLATFORM_FEE,
      refundableBaseMinor: TOTAL - PLATFORM_FEE, refundMinor: expectedRefund, nonRefundableMinor: TOTAL - expectedRefund, timezone: 'Asia/Seoul',
    });
    expect(prev.body.item.evaluation.tier).toEqual({ min_hours_before: 24, refund_pct: 50 });

    expect((await call(t, outsider, 'POST', `/v1/reservations/${rid}/cancel`, { reason: 'not mine' }, idem())).status).toBe(403);
    const noKey = await call(t, guest, 'POST', `/v1/reservations/${rid}/cancel`, { reason: 'Change of plans' });
    expect(noKey.status).toBe(400);
    const cancelKey = idem();
    const cx = await call(t, guest, 'POST', `/v1/reservations/${rid}/cancel`, { reason: 'Change of plans' }, cancelKey);
    expect(cx.status, show(cx)).toBe(200);
    expect(cx.body.item).toMatchObject({ status: 'REFUND_PENDING', cancelReason: 'Change of plans' });
    expect(cx.body.item.cancellation.refundMinor).toBe(expectedRefund);
    const cxReplay = await call(t, guest, 'POST', `/v1/reservations/${rid}/cancel`, { reason: 'Change of plans' }, cancelKey);
    expect(cxReplay.status).toBe(200);
    expect(cxReplay.headers['idempotent-replayed']).toBe('true');

    // refund intent recorded, provider cancel not yet executed (asynchronous via outbox)
    const pending = await call(t, guest, 'GET', `/v1/payments/${pid}`);
    expect(pending.body.item.status).toBe('APPROVED');
    expect(pending.body.item.refunds).toEqual([expect.objectContaining({ amountMinor: expectedRefund, status: 'REQUESTED' })]);
    expect(pending.body.item.refundableMinor).toBe(TOTAL - expectedRefund);

    await t.drain();

    const pay = await call(t, guest, 'GET', `/v1/payments/${pid}`);
    expect(pay.status).toBe(200);
    expect(pay.body.item).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedMinor: expectedRefund, refundableMinor: TOTAL - expectedRefund });
    expect(pay.body.item.refunds).toEqual([expect.objectContaining({ amountMinor: expectedRefund, status: 'PARTIAL', currency: 'KRW' })]);
    const refundId = pay.body.item.refunds[0].id as string;

    const r = await getReservation(guest, rid);
    expect(r).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedMinor: expectedRefund, cancelReason: 'Change of plans' });
    expect(r.property.address).toBeNull();
    expect(r.history.slice(-3).map((h: any) => [h.from, h.to])).toEqual([
      ['CONFIRMED', 'CANCELLED'],
      ['CANCELLED', 'REFUND_PENDING'],
      ['REFUND_PENDING', 'PARTIALLY_REFUNDED'],
    ]);
    expect(r.history.every((h: any) => !!h.correlationId)).toBe(true);
    // the provider-completed refund carries the correlation id of the cancellation request
    expect(r.history.at(-1).correlationId).toBe(r.history.at(-2).correlationId);

    // compensating ledger entries, proportional to the approval credits, balanced
    const lt = await call(t, acctA, 'GET', `/v1/admin/ledger/transactions?sourceType=REFUND&sourceId=${refundId}`);
    expect(lt.status, show(lt)).toBe(200);
    expect(lt.body.items).toHaveLength(1);
    const rev = lt.body.items[0];
    const appr = await call(t, acctA, 'GET', `/v1/admin/ledger/transactions?sourceType=PAYMENT&sourceId=${pid}`);
    expect(appr.body.items).toHaveLength(1);
    expect(rev).toMatchObject({ type: 'REFUND', reversesTransactionId: appr.body.items[0].id });
    const credits = appr.body.items[0].entries.filter((e: any) => e.creditMinor > 0).sort((a: any, b: any) => (a.account < b.account ? -1 : 1));
    const parts = allocate(expectedRefund, credits.map((e: any) => e.creditMinor));
    for (const [i, e] of credits.entries()) {
      expect(rev.entries.find((x: any) => x.account === e.account), `reversal of ${e.account}`).toMatchObject({ debitMinor: parts[i], creditMinor: 0 });
    }
    expect(rev.entries.find((x: any) => x.account === 'PLATFORM:PG_CLEARING:KRW')).toMatchObject({ debitMinor: 0, creditMinor: expectedRefund });
    expect(rev.entries.reduce((a: number, e: any) => a + e.debitMinor, 0)).toBe(expectedRefund);
    expect(rev.entries.reduce((a: number, e: any) => a + e.creditMinor, 0)).toBe(expectedRefund);
    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
    expect(tb.unbalancedTransactionIds).toEqual([]);

    const rcp = await call(t, guest, 'GET', '/v1/receipts');
    expect(rcp.body.items.filter((x: any) => x.paymentId === pid).map((x: any) => [x.receiptType, x.amountMinor]).sort()).toEqual([['PAYMENT', TOTAL], ['REFUND', expectedRefund]]);
    const moneyAudit = await auditActions('MONEY');
    expect(moneyAudit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'refund.requested', resource_id: pid }),
      expect.objectContaining({ action: 'refund.completed', resource_id: pid }),
    ]));
    expect((await notifications(guest)).find((n) => n.templateKey === 'payment.refunded')?.data).toMatchObject({ paymentId: pid, refundId });
    expect(await notificationKeys(host)).toContain('reservation.cancelled');

    // the refund of a never-settled reservation must not produce a (negative) host statement
    const regen = await call(t, acctA, 'POST', '/v1/admin/settlements/generate', { periodStart: day(2), periodEnd: day(3) }, idem());
    expect(regen.status, show(regen)).toBe(201);
    expect(regen.body.items.filter((x: any) => x.payeeId === host.id)).toEqual([]);
    expect(regen.body.skipped).toEqual([]);
    const hostAcc = await ledgerAccounts();
    // host payable: 0 after the first payout, + net of stay 2, − host share of the partial refund
    const hostCredit = appr.body.items[0].entries.find((e: any) => e.account === `PAYEE:${host.id}:PAYABLE:KRW`).creditMinor;
    const hostDebit = rev.entries.find((e: any) => e.account === `PAYEE:${host.id}:PAYABLE:KRW`).debitMinor;
    expect(hostCredit).toBe(HOST_NET);
    expect(hostAcc.balance(`PAYEE:${host.id}:PAYABLE:KRW`)).toBe(HOST_NET - hostDebit);

    // inventory released: the dates are bookable again
    await t.drain();
    expect((await searchStay(ci, co)).items.map((i: any) => i.id)).toContain(propertyId);
    const cal = await call(t, guest, 'GET', `/v1/properties/${propertyId}/calendar?from=${ci}&to=${co}`);
    expect(cal.body.item.days.map((x: any) => x.status)).toEqual(['available', 'available']);
    const hostCancelled = await call(t, host, 'GET', '/v1/host/reservations?filter=cancelled');
    expect(hostCancelled.body.items.map((x: any) => [x.id, x.status])).toContainEqual([rid, 'PARTIALLY_REFUNDED']);

    await assertOutboxHealthy();
  });

  it('11. a browser success redirect alone never confirms; a wrong amount is rejected with AMOUNT_MISMATCH', async () => {
    const [ci, co] = [seoulDay(10), seoulDay(12)];
    const { reservationId: rid, prepare } = await quoteHoldPay(ci, co);
    const pid = prepare.paymentId as string;
    // the browser would now be redirected to successUrl — that is a web page, it carries no authority
    expect(prepare.successUrl).toContain(`paymentId=${pid}`);
    const provider = t.app.ctx.adapters.get('payments.provider') as MockProvider;
    const confirmCalls = () => provider.calls.filter((c) => c.op === 'confirm' && (c.args as any).orderId === prepare.orderId).length;

    // no server-side confirm: outbox + all jobs run, nothing confirms the reservation
    await t.drain();
    await t.runJobs();
    let r = await getReservation(guest, rid);
    expect(r.status).toBe('PAYMENT_PENDING');
    expect(r.confirmedAt).toBeNull();
    expect(r.property.address).toBeNull();
    let p = await call(t, guest, 'GET', `/v1/payments/${pid}`);
    expect(p.body.item).toMatchObject({ status: 'CREATED', approvedAt: null, paymentKey: null });
    expect(confirmCalls()).toBe(0);

    // tampered amounts are refused before any provider call
    for (const amount of [prepare.amount + 1_000, 100]) {
      const bad = await confirm({ orderId: prepare.orderId, amount });
      expect(bad.status, show(bad)).toBe(400);
      expect(bad.body.code).toBe('AMOUNT_MISMATCH');
    }
    expect(confirmCalls()).toBe(0);
    r = await getReservation(guest, rid);
    expect(r.status).toBe('PAYMENT_PENDING');
    expect(r.property.address).toBeNull();
    p = await call(t, guest, 'GET', `/v1/payments/${pid}`);
    expect(p.body.item.status).toBe('CREATED');
    const mismatchAudit = (await auditActions('MONEY')).filter((a) => a.action === 'payment.confirm.amount_mismatch' && a.resource_id === pid);
    expect(mismatchAudit).toHaveLength(2);
    // another user cannot confirm the guest's order
    const foreign = await call(t, outsider, 'POST', '/v1/payments/toss/confirm', { paymentKey: 'mock_foreign', orderId: prepare.orderId, amount: prepare.amount }, idem());
    expect(foreign.status).toBe(403);

    // only a server-side provider confirmation with the exact amount confirms
    const ok = await confirm(prepare);
    expect(ok.status, show(ok)).toBe(200);
    expect(confirmCalls()).toBe(1);
    r = await getReservation(guest, rid);
    expect(r.status).toBe('CONFIRMED');
    expect(r.property.address).toMatchObject({ line1: EXACT_LINE1 });

    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
    await assertOutboxHealthy();
  });

  it('12. invariant 5: concurrent holds for the same dates — exactly one wins, the loser gets 409', async () => {
    const [ci, co] = [seoulDay(20), seoulDay(22)];
    const rival = await createUser(t, { displayName: 'Rival Guest' });
    const quotes = await Promise.all([guest, rival].map((u) => call(t, u, 'POST', '/v1/booking/quotes', { propertyId, checkIn: ci, checkOut: co, guests: 2 })));
    for (const q of quotes) expect(q.status, show(q)).toBe(201); // quotes are candidates only
    const holds = await Promise.all([guest, rival].map((u, i) => call(t, u, 'POST', '/v1/booking/holds', { quoteId: quotes[i].body.item.id }, idem())));
    const statuses = holds.map((h) => h.status).sort();
    expect(statuses, JSON.stringify(holds.map((h) => h.body))).toEqual([201, 409]);
    const loser = holds.find((h) => h.status === 409)!;
    expect(loser.body.code).toBe('INVENTORY_UNAVAILABLE');
    const winner = holds.find((h) => h.status === 201)!;
    expect(winner.body.item.reservation.status).toBe('HELD');
    const cal = await call(t, outsider, 'GET', `/v1/properties/${propertyId}/calendar?from=${ci}&to=${co}`);
    expect(cal.body.item.days.map((x: any) => x.status)).toEqual(['booked', 'booked']);
  });
});
