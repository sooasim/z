/**
 * G4 end-to-end release gate — Home Exchange bilateral chain, driven over HTTP only (call(t, user, ...)).
 *
 * Scenario 1 (full chain): two members each pass identity verification (TRUST-01) → host application + host
 * verification + admin approval (HOST-01) → exchange home draft with address / house rules → 3 photos through the
 * presigned media pipeline (STAY-02) → publish (STAY-01/03) → exchange profile → eligibility (EXCH-01) →
 * discovery shows the other member's home → A requests B → B counters → A accepts the counter version (EXCH-02) →
 * both safety-ack + verify (EXCH-03) → agreement fetched, both sign the exact terms hash, second signature
 * auto-confirms; explicit confirm is idempotent (EXCH-04/05) → both homes blocked: public calendar "booked",
 * paid-stay quote / hold for a third user rejected 409, host block rejected 409 → messaging in the exchange
 * conversation (contact details masked until confirmation) → lifecycle job → COMPLETED → bilateral reviews via
 * /v1/reviews → REVIEWED via the outbox (EXCH-06, TRUST-02) → full state history with correlation ids, outbox
 * events, audit, "no reservation rows" (independent FSM, invariant 2) and "no money moved" (trial balance).
 * Scenario 2: cancelling a CONFIRMED exchange releases BOTH blocks in one transaction (concurrent cancels → one wins).
 * Scenario 3: auto-confirm fails atomically on a host block (invariant 6), explicit confirm with Idempotency-Key
 * succeeds after the block is removed, then a dispute opened on the exchange creates a TRUST-03 disputes row that
 * GET /v1/disputes shows to both parties.
 *
 * Test-setup hooks without an API (documented):
 *  - feature flags are switched on with enableFlags() — `exchange.enabled` (the gate under test) and
 *    `stay.paid_booking` (needed so the third user's paid HOLD reaches the inventory check instead of FEATURE_DISABLED);
 *  - members and staff are created with createUser() (signup is covered by e2e-stay); members start with an
 *    unverified identity and become verified only through /v1/verifications + admin approval;
 *  - the dev "presigned PUT" upload is performed with t.app.inject (unauthenticated, HMAC token in the URL);
 *  - there is no clock API: to drive EXCH-06 the exchange's stay dates are moved into the past with one SQL UPDATE
 *    of exchange_requests.dates_a/dates_b (dates only) before running the lifecycle job (t.runJobs()).
 * Read-only SQL is used only for assertions on tables that have no read API (state_transitions, inventory_blocks,
 * reservations, outbox_events, agreement_acceptances / exchange_state_history views).
 *
 * Scenario 1 uses one exchange-only home (A, Seoul) and one dual-mode home (B, Busan: exchange + paid stays with
 * compliance ALLOW) so that the cross-domain calendar invariant (EXCH-05: a confirmed exchange cannot collide with
 * paid reservations) is observable through a real paid-stay quote/hold; an exchange-only home never quotes (422).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createTestApp, createUser, call, day, enableFlags, idem, type TestApp, type TestUser } from './helpers.js';
import { applyBps } from '../src/platform/money.js';
import { canonicalJson, sha256 } from '../src/platform/crypto.js';

// ------------------------------------------------------------------------------------------------ fixtures

const NIGHTLY = 100_000;
const CLEANING = 20_000;
const PLATFORM_FEE_BPS = 1000; // 10% guest service fee (STAY)
const TAX_BPS = 1000; // 10% VAT on the service fee
const QUOTE_NIGHTS = 2;
const SUBTOTAL = QUOTE_NIGHTS * NIGHTLY;
const PLATFORM_FEE = applyBps(SUBTOTAL + CLEANING, PLATFORM_FEE_BPS);
const TAX = applyBps(PLATFORM_FEE, TAX_BPS);
const QUOTE_TOTAL = SUBTOTAL + CLEANING + PLATFORM_FEE + TAX;
const TERMS_VERSION = '2026-10-draft'; // EXCHANGE_TERMS consent document (0007 reference data)

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const show = (r: { status: number; body: any }) => JSON.stringify(r.body);
const sha256hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const range = (from: number, to: number) => ({ start: day(from), end: day(to) });
const nights = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => day(from + i));

/** Minimal PNG (signature + IHDR) padded to look like a real file; distinct bytes per photo. */
function png(w: number, h: number, pad = 96) {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = 6;
  b.write(randomUUID(), 40, 'ascii');
  return b;
}
const pdf = (label: string) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(`% ${label} ${randomUUID()}\n`), Buffer.alloc(256, 0x20), Buffer.from('\n%%EOF\n')]);

// ------------------------------------------------------------------------------------------------ state

let t: TestApp;
let admin: TestUser; // ADMIN + COMPLIANCE, AAL2 (verification / host approvals, audit reader)
let compliance2: TestUser; // second compliance officer (four-eyes on compliance rules)
let acctA: TestUser; // ACCOUNTING maker
let acctB: TestUser; // ACCOUNTING checker
let support: TestUser; // SUPPORT, AAL2 (elevated agreement read)
let outsider: TestUser; // third user: paid-stay guest, never a party of any exchange

/** correlation id per labelled request (sent as x-correlation-id) */
const cids: Record<string, string> = {};

async function act(label: string, user: TestUser | null, method: Method, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const cid = `e2e-exch-${label}-${randomUUID()}`;
  cids[label] = cid;
  const r = await call(t, user, method, url, body, { 'x-correlation-id': cid, ...headers });
  expect(r.headers['x-correlation-id']).toBe(cid);
  return r;
}

const rows = async (sql: string, params: unknown[] = []) => (await t.pool.query(sql, params)).rows as any[];
const exchangeBlocks = (exchangeId: string) =>
  rows(
    `SELECT id, property_id, lower(stay_range)::text AS start, upper(stay_range)::text AS "end", block_type, source_type, source_id, state,
            expires_at, created_at, released_at
       FROM inventory_blocks WHERE source_type = 'EXCHANGE' AND source_id = $1 ORDER BY property_id`,
    [exchangeId],
  );
const history = (exchangeId: string) =>
  rows(
    `SELECT id, from_state, to_state, actor_id, actor_type, reason, correlation_id, metadata FROM state_transitions
      WHERE aggregate_type = 'EXCHANGE' AND aggregate_id = $1 ORDER BY id`,
    [exchangeId],
  );

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

async function getExchange(user: TestUser, id: string) {
  const r = await call(t, user, 'GET', `/v1/exchanges/${id}`);
  expect(r.status, show(r)).toBe(200);
  return r.body.item;
}

async function calendar(propertyId: string, from: string, to: string): Promise<Record<string, string>> {
  const r = await call(t, null, 'GET', `/v1/properties/${propertyId}/calendar?from=${from}&to=${to}`);
  expect(r.status, show(r)).toBe(200);
  return Object.fromEntries(r.body.item.days.map((d: any) => [d.date, d.status]));
}

async function auditFor(resourceId: string) {
  const r = await call(t, admin, 'GET', `/v1/admin/audit-logs?resourceId=${resourceId}&limit=200`);
  expect(r.status, show(r)).toBe(200);
  return r.body.items as Array<{ action: string; actor_id: string | null; resource_type: string; resource_id: string; correlation_id: string; category: string; before_state: any; after_state: any; reason: string | null }>;
}

async function notificationKeys(user: TestUser) {
  const r = await call(t, user, 'GET', '/v1/notifications?limit=100');
  expect(r.status, show(r)).toBe(200);
  return (r.body.items as Array<{ templateKey: string }>).map((n) => n.templateKey);
}

async function trialBalance() {
  const r = await call(t, acctA, 'GET', '/v1/admin/ledger/trial-balance');
  expect(r.status, show(r)).toBe(200);
  return r.body;
}

// ------------------------------------------------------------------------------------------------ onboarding

interface HomeSpec {
  name: string;
  title: string;
  city: string;
  region: string;
  lat: number;
  lng: number;
  line1: string;
  postalCode: string;
  areaLabel: string;
  prefs: string[];
  /** dual-mode: exchange + paid stays (requires the approved KR compliance rule) */
  dual: boolean;
}
interface Member { user: TestUser; spec: HomeSpec; propertyId: string; slug: string }

/** TRUST-01 identity → HOST-01 application/verification/approval → STAY-01/02 listing + photos → publish → EXCH-01 profile. */
async function onboardHost(spec: HomeSpec): Promise<Member> {
  const user = await createUser(t, { displayName: spec.name });

  const el0 = await call(t, user, 'GET', '/v1/exchange/eligibility');
  expect(el0.status, show(el0)).toBe(200);
  expect(el0.body.item).toMatchObject({ eligible: false, unmet: ['IDENTITY_NOT_VERIFIED', 'NO_EXCHANGE_HOME', 'PROFILE_INCOMPLETE'], homes: [], profile: null });

  // ---- identity verification (private VERIFICATION media + admin review)
  const idDoc = await upload(user, 'VERIFICATION', 'application/pdf', pdf(`${spec.name} national id`));
  expect(idDoc).toMatchObject({ visibility: 'PRIVATE', publicUrl: null });
  const idCase = await call(t, user, 'POST', '/v1/verifications', { subjectType: 'IDENTITY', documents: [{ documentType: 'NATIONAL_ID', mediaId: idDoc.id, sha256: idDoc.sha256 }] });
  expect(idCase.status, show(idCase)).toBe(201);
  expect(idCase.body.item).toMatchObject({ status: 'SUBMITTED', subject_type: 'IDENTITY', user_id: user.id });
  const selfReview = await call(t, user, 'POST', `/v1/admin/verifications/${idCase.body.item.id}/approve`, {});
  expect(selfReview.status).toBe(403);
  const sr = await call(t, admin, 'POST', `/v1/admin/verifications/${idCase.body.item.id}/start-review`);
  expect(sr.status, show(sr)).toBe(200);
  expect(sr.body.item.status).toBe('IN_REVIEW');
  const ia = await call(t, admin, 'POST', `/v1/admin/verifications/${idCase.body.item.id}/approve`, { reason: 'ID document matches the member' });
  expect(ia.status, show(ia)).toBe(200);
  expect(ia.body.item.status).toBe('APPROVED');
  const vs = await call(t, user, 'GET', '/v1/verifications');
  expect(vs.status).toBe(200);
  expect(vs.body.summary.IDENTITY).toEqual({ verified: true, status: 'APPROVED' });

  // ---- host application + host verification + approval (grants HOST)
  const app = await call(t, user, 'POST', '/v1/host-applications', { displayName: spec.name, about: `Sharing our home in ${spec.city} with fellow travellers.` });
  expect(app.status, show(app)).toBe(201);
  expect(app.body.item.status).toBe('SUBMITTED');
  expect(app.body.item.checklist).toMatchObject({ emailVerified: true, identityVerified: true, hostVerified: false });
  const hostDoc = await upload(user, 'VERIFICATION', 'application/pdf', pdf(`${spec.name} host declaration`));
  const hc = await call(t, user, 'POST', '/v1/verifications', { subjectType: 'HOST', documents: [{ documentType: 'HOST_DECLARATION', mediaId: hostDoc.id, sha256: hostDoc.sha256 }] });
  expect(hc.status, show(hc)).toBe(201);
  const ha = await call(t, admin, 'POST', `/v1/admin/verifications/${hc.body.item.id}/approve`, { reason: 'host declaration verified' });
  expect(ha.status, show(ha)).toBe(200);
  expect(ha.body.item.status).toBe('APPROVED');
  const decided = await call(t, admin, 'POST', `/v1/admin/host-applications/${app.body.item.id}/approve`, { reason: 'checklist complete' });
  expect(decided.status, show(decided)).toBe(200);
  expect(decided.body.item.status).toBe('APPROVED');
  const me = await call(t, user, 'GET', '/v1/me');
  expect(me.body.user.roles).toContain('HOST');
  const dash = await call(t, user, 'GET', '/v1/host/me');
  expect(dash.status, show(dash)).toBe(200);
  expect(dash.body.profile).toMatchObject({ status: 'APPROVED', verificationStatus: 'VERIFIED' });
  expect(dash.body).toMatchObject({ canPublish: true, publishBlockers: [] });

  // ---- listing
  const draft = await call(t, user, 'POST', '/v1/properties', {
    title: spec.title,
    summary: `Family home in ${spec.city}`,
    description: `A bright, quiet two-bedroom family apartment in ${spec.city} with a full kitchen, fast Wi-Fi and a small balcony.`,
    propertyType: 'APARTMENT',
    roomType: 'ENTIRE',
    maxGuests: 4,
    bedrooms: 2,
    beds: 2,
    bathrooms: 1,
    lat: spec.lat,
    lng: spec.lng,
    country: 'KR',
    region: spec.region,
    city: spec.city,
    timezone: 'Asia/Seoul',
    rentalEnabled: spec.dual,
    exchangeEnabled: true,
    checkInTime: '15:00',
    checkOutTime: '11:00',
    ...(spec.dual ? { basePriceMinor: NIGHTLY, cleaningFeeMinor: CLEANING, currency: 'KRW', minNights: 1, maxNights: 30, cancellationPolicyCode: 'MODERATE' } : {}),
    address: { line1: spec.line1, postalCode: spec.postalCode, city: spec.city, region: spec.region, country: 'KR', publicAreaLabel: spec.areaLabel },
    houseRules: { smokingAllowed: false, petsAllowed: false, eventsAllowed: false, quietHours: '22:00-07:00', extraRules: 'Please water the plants.' },
    amenities: ['wifi', 'kitchen'],
  });
  expect(draft.status, show(draft)).toBe(201);
  const p = draft.body.item;
  expect(p).toMatchObject({ status: 'DRAFT', hostId: user.id, exchangeEnabled: true, rentalEnabled: spec.dual, paidBookingEnabled: false });
  expect(p.address).toMatchObject({ line1: spec.line1, publicAreaLabel: spec.areaLabel });
  const early = await call(t, user, 'POST', `/v1/properties/${p.id}/publish`);
  expect(early.status, show(early)).toBe(422);
  expect(early.body.details.errors).toEqual(['MEDIA_MIN_3']);

  const photos = [];
  for (const [w, h] of [[1600, 1067], [1200, 800], [1024, 768]]) {
    const m = await upload(user, 'PROPERTY', 'image/png', png(w, h));
    expect(m).toMatchObject({ visibility: 'PUBLIC', width: w });
    photos.push(m);
  }
  const att = await call(t, user, 'PUT', `/v1/properties/${p.id}/media`, { items: photos.map((m, i) => ({ mediaId: m.id, caption: `photo ${i + 1}` })) });
  expect(att.status, show(att)).toBe(200);
  expect(att.body.items.map((m: any) => m.id)).toEqual(photos.map((m) => m.id));

  const pub = await call(t, user, 'POST', `/v1/properties/${p.id}/publish`);
  expect(pub.status, show(pub)).toBe(200);
  expect(pub.body.outcome).toBe('PUBLISHED');
  expect(pub.body.compliance.decision).toBe('ALLOW');
  expect(pub.body.item).toMatchObject({ status: 'PUBLISHED', exchangeEnabled: true, rentalEnabled: spec.dual, paidBookingEnabled: spec.dual });

  // ---- exchange profile → eligible
  const prof = await call(t, user, 'PUT', '/v1/exchange/profile', { homeDescription: `${spec.title}: quiet street, close to the subway.`, preferredDestinations: spec.prefs, flexibleDates: false });
  expect(prof.status, show(prof)).toBe(200);
  expect(prof.body.item).toMatchObject({ eligible: true, unmet: [], profile: { preferredDestinations: spec.prefs, flexibleDates: false, status: 'ELIGIBLE' } });
  const el = await call(t, user, 'GET', '/v1/exchange/eligibility');
  expect(el.body.item).toMatchObject({ eligible: true, unmet: [] });
  expect(el.body.item.homes).toEqual([{ id: p.id, title: spec.title, city: spec.city }]);
  return { user, spec, propertyId: p.id, slug: p.slug };
}

const homeSpec = (name: string, city: string, region: string, lat: number, lng: number, prefs: string[], dual = false): HomeSpec => ({
  name,
  title: `${name}'s ${city} Home`,
  city,
  region,
  lat,
  lng,
  line1: `${city}-ro ${Math.floor(Math.random() * 900) + 100}, Unit ${Math.floor(Math.random() * 90) + 10}01`,
  postalCode: String(10000 + Math.floor(Math.random() * 80000)),
  areaLabel: `${city} centre`,
  prefs,
  dual,
});

/** request (v1) → accept → both safety-acks → AGREEMENT_PENDING; returns the agreement hash. */
async function toAgreement(label: string, a: Member, b: Member, datesA: { start: string; end: string }, datesB: { start: string; end: string }) {
  const req = await act(`${label}-request`, a.user, 'POST', '/v1/exchanges', { myPropertyId: a.propertyId, theirPropertyId: b.propertyId, datesA, datesB, guestsA: 2, guestsB: 2, message: 'Shall we swap?' });
  expect(req.status, show(req)).toBe(201);
  const id = req.body.item.id as string;
  const acc = await act(`${label}-accept`, b.user, 'POST', `/v1/exchanges/${id}/accept`, { offerVersion: 1 });
  expect(acc.status, show(acc)).toBe(200);
  expect(acc.body.item.status).toBe('VERIFICATION_PENDING');
  const ackA = await act(`${label}-ackA`, a.user, 'POST', `/v1/exchanges/${id}/safety-ack`, { acknowledged: true });
  expect(ackA.status, show(ackA)).toBe(200);
  expect(ackA.body.item.status).toBe('VERIFICATION_PENDING');
  const ackB = await act(`${label}-ackB`, b.user, 'POST', `/v1/exchanges/${id}/safety-ack`, { acknowledged: true });
  expect(ackB.status, show(ackB)).toBe(200);
  expect(ackB.body.item.status).toBe('AGREEMENT_PENDING');
  const ag = await call(t, a.user, 'GET', `/v1/exchanges/${id}/agreement`);
  expect(ag.status, show(ag)).toBe(200);
  expect(ag.body.item.termsHash).toBe(sha256(canonicalJson(ag.body.item.termsSnapshot)));
  return { id, hash: ag.body.item.termsHash as string, agreementId: ag.body.item.id as string };
}

// ------------------------------------------------------------------------------------------------ lifecycle

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN', 'COMPLIANCE'], aal: 'aal2', displayName: 'Ops Admin' });
  compliance2 = await createUser(t, { roles: ['COMPLIANCE'], aal: 'aal2', displayName: 'Compliance Officer' });
  acctA = await createUser(t, { roles: ['ACCOUNTING'], aal: 'aal2', displayName: 'Accountant A' });
  acctB = await createUser(t, { roles: ['ACCOUNTING'], aal: 'aal2', displayName: 'Accountant B' });
  support = await createUser(t, { roles: ['SUPPORT'], aal: 'aal2', displayName: 'Support Agent' });
  outsider = await createUser(t, { displayName: 'Third Guest' });
}, 60_000);
afterAll(async () => t?.close());

// ================================================================================================ scenario 1

describe('G4 E2E — Home Exchange bilateral chain (HTTP only)', () => {
  let A: Member; // requester, exchange-only home in Seoul
  let B: Member; // responder, dual-mode home in Busan
  let exchangeId: string;
  let conversationId: string;
  let agreementId: string;
  let termsHash: string;
  let preConfirmQuoteId: string;
  let tb0: any;

  const A_V1 = range(30, 35); // B's party stays at A's home
  const B_V1 = range(40, 45); // A's party stays at B's home
  const B_V2 = range(41, 46); // B's counter-offer

  it('0. reference rules are configured through their APIs (maker-checker / four-eyes)', async () => {
    const effectiveFrom = new Date(Date.now() - 86_400_000).toISOString();
    for (const [ruleType, bps] of [['PLATFORM_FEE', PLATFORM_FEE_BPS], ['TAX', TAX_BPS]] as const) {
      const created = await call(t, acctA, 'POST', '/v1/finance/rules', { ruleType, domain: 'STAY', jurisdiction: 'KR', params: { bps }, effectiveFrom, note: 'G9 approved' });
      expect(created.status, show(created)).toBe(201);
      const self = await call(t, acctA, 'POST', `/v1/finance/rules/${created.body.item.id}/approve`);
      expect(self.status).toBe(403);
      const ok = await call(t, acctB, 'POST', `/v1/finance/rules/${created.body.item.id}/approve`);
      expect(ok.status, show(ok)).toBe(200);
      expect(ok.body.item.status).toBe('APPROVED');
    }
    const rule = await call(t, admin, 'POST', '/v1/admin/compliance/rules', {
      ruleKey: 'kr-paid-stay-test-allow',
      subjectType: 'PROPERTY',
      jurisdiction: 'KR',
      appliesTo: { mode: ['RENTAL'] },
      requiredPermitTypes: [],
      effectiveFrom: day(-30),
      note: 'paid stays allowed without permits (test jurisdiction)',
    });
    expect(rule.status, show(rule)).toBe(201);
    const selfApprove = await call(t, admin, 'POST', `/v1/admin/compliance/rules/${rule.body.item.id}/approve`, {});
    expect(selfApprove.status).toBe(403);
    expect(selfApprove.body.code).toBe('FOUR_EYES_REQUIRED');
    const approved = await call(t, compliance2, 'POST', `/v1/admin/compliance/rules/${rule.body.item.id}/approve`, { reason: 'legal sign-off' });
    expect(approved.status, show(approved)).toBe(200);
    expect(approved.body.item.status).toBe('APPROVED');
    await enableFlags(t, 'stay.paid_booking');
    tb0 = await trialBalance();
    expect(tb0.balanced).toBe(true);
  });

  it('1. two members become verified, approved hosts with published exchange homes and complete profiles', async () => {
    A = await onboardHost(homeSpec('Minsu', 'Seoul', 'KR-11', 37.5446, 126.9496, ['Busan']));
    B = await onboardHost(homeSpec('Jiwoo', 'Busan', 'KR-26', 35.1587, 129.1604, ['Seoul'], true));
    expect(A.user.id).not.toBe(B.user.id);
    // the outsider is not eligible (no verified identity, no home, no profile)
    const el = await call(t, outsider, 'GET', '/v1/exchange/eligibility');
    expect(el.body.item.eligible).toBe(false);
  }, 60_000);

  it('2. flag gate, then discovery shows the other member\'s home (mutual fit, no exact address)', async () => {
    const off = await call(t, A.user, 'GET', '/v1/exchange/homes?city=Busan');
    expect(off.status).toBe(403);
    expect(off.body.code).toBe('FEATURE_DISABLED');
    const offReq = await call(t, A.user, 'POST', '/v1/exchanges', { myPropertyId: A.propertyId, theirPropertyId: B.propertyId, datesA: A_V1, datesB: B_V1 });
    expect(offReq.status).toBe(403);
    expect(offReq.body.code).toBe('FEATURE_DISABLED');
    await enableFlags(t, 'exchange.enabled');

    const da = await call(t, A.user, 'GET', '/v1/exchange/homes?city=Busan');
    expect(da.status, show(da)).toBe(200);
    expect(da.body.items).toHaveLength(1);
    expect(da.body.items[0]).toMatchObject({
      id: B.propertyId,
      title: B.spec.title,
      city: 'Busan',
      maxGuests: 4,
      host: { id: B.user.id, displayName: 'Jiwoo', preferredDestinations: ['Seoul'], flexibleDates: false },
      mutualFit: { score: 100, iWantTheirCity: true, theyWantMyCity: true },
    });
    expect(JSON.stringify(da.body)).not.toContain(B.spec.line1);
    const all = await call(t, A.user, 'GET', '/v1/exchange/homes');
    expect(all.body.items.map((i: any) => i.id)).toEqual([B.propertyId]); // never my own home
    const db = await call(t, B.user, 'GET', '/v1/exchange/homes?city=Seoul');
    expect(db.body.items.map((i: any) => i.id)).toEqual([A.propertyId]);
    expect(JSON.stringify(db.body)).not.toContain(A.spec.line1);
    // the public listing never exposes the exact address either
    const pubB = await call(t, outsider, 'GET', `/v1/properties/${B.propertyId}`);
    expect(pubB.status).toBe(200);
    expect(JSON.stringify(pubB.body)).not.toContain(B.spec.line1);
  });

  it('3. A requests B (idempotent create), conversation opens, contact details are masked before confirmation', async () => {
    const key = idem();
    const body = { myPropertyId: A.propertyId, theirPropertyId: B.propertyId, datesA: A_V1, datesB: B_V1, guestsA: 2, guestsB: 2, message: 'Would you like to swap homes in spring?' };
    const req = await act('s1-request', A.user, 'POST', '/v1/exchanges', body, key);
    expect(req.status, show(req)).toBe(201);
    const ex = req.body.item;
    exchangeId = ex.id;
    conversationId = ex.conversationId;
    expect(ex).toMatchObject({
      status: 'REQUESTED',
      role: 'REQUESTER',
      nextAction: 'AWAIT_RESPONSE',
      requesterId: A.user.id,
      responderId: B.user.id,
      propertyA: { id: A.propertyId, city: 'Seoul' },
      propertyB: { id: B.propertyId, city: 'Busan' },
      datesA: A_V1,
      datesB: B_V1,
      currentOfferVersion: 1,
      lastOfferBy: A.user.id,
      acceptedAVersion: 1,
      acceptedBVersion: null,
      agreement: null,
      addresses: null,
      version: 1,
    });
    expect(ex.offers).toHaveLength(1);
    expect(ex.currentOffer).toMatchObject({ version: 1, createdBy: A.user.id, guestsA: 2, guestsB: 2, message: body.message });
    expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
    // replay with the same Idempotency-Key returns the stored response and creates nothing
    const replay = await call(t, A.user, 'POST', '/v1/exchanges', body, key);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(req.body);
    const count = await rows(`SELECT count(*)::int AS n FROM exchange_requests WHERE requester_id = $1`, [A.user.id]);
    expect(count[0].n).toBe(1);
    // a duplicate open request for the same homes is refused
    const dup = await call(t, A.user, 'POST', '/v1/exchanges', { ...body, message: 'again' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_OPEN_REQUEST');

    const listB = await call(t, B.user, 'GET', '/v1/exchanges');
    expect(listB.body.items).toHaveLength(1);
    expect(listB.body.items[0]).toMatchObject({ id: exchangeId, role: 'RESPONDER', nextAction: 'RESPOND', status: 'REQUESTED' });
    // third parties: 404 (existence not leaked)
    expect((await call(t, outsider, 'GET', `/v1/exchanges/${exchangeId}`)).status).toBe(404);
    expect((await call(t, outsider, 'POST', `/v1/exchanges/${exchangeId}/accept`, { offerVersion: 1 })).status).toBe(404);
    expect((await call(t, outsider, 'GET', '/v1/exchanges')).body.items).toEqual([]);
    expect((await call(t, null, 'GET', `/v1/exchanges/${exchangeId}`)).status).toBe(401);
    // the maker of the latest offer cannot counter it
    const own = await call(t, A.user, 'POST', `/v1/exchanges/${exchangeId}/counter`, { expectedVersion: 1, guestsA: 3 });
    expect(own.status).toBe(409);
    expect(own.body.code).toBe('NOT_YOUR_TURN');

    // exchange conversation (COMMS-01): both parties are members with their exchange roles
    const convA = await call(t, A.user, 'GET', '/v1/conversations');
    const c = convA.body.items.find((x: any) => x.id === conversationId);
    expect(c).toMatchObject({ contextType: 'EXCHANGE', contextId: exchangeId, myRole: 'REQUESTER', status: 'OPEN' });
    expect(c.members.map((m: any) => [m.userId, m.role]).sort()).toEqual([[A.user.id, 'REQUESTER'], [B.user.id, 'RESPONDER']].sort());
    const pre = await act('s1-msgA', A.user, 'POST', `/v1/conversations/${conversationId}/messages`, { body: 'Hi Jiwoo! Call me on 010-1234-5678 or minsu@example.com', clientMessageId: 'a-1' });
    expect(pre.status, show(pre)).toBe(201);
    expect(pre.body.item.body).not.toContain('010-1234-5678');
    expect(pre.body.item.body).not.toContain('minsu@example.com');
    expect(pre.body.item.body).toContain('[연락처 비공개]');
    expect(pre.body.item.metadata).toMatchObject({ contactInfoMasked: true, maskedKinds: ['EMAIL', 'PHONE'] });
    expect((await call(t, outsider, 'GET', `/v1/conversations/${conversationId}/messages`)).status).toBe(404);
    expect((await call(t, outsider, 'POST', `/v1/conversations/${conversationId}/messages`, { body: 'let me in' })).status).toBe(404);
  });

  it('4. B counters (v2), stale acceptance is rejected, A accepts the counter version → verification gate', async () => {
    const stale = await call(t, B.user, 'POST', `/v1/exchanges/${exchangeId}/counter`, { expectedVersion: 2, datesB: B_V2 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OFFER_VERSION_MISMATCH');
    const ctr = await act('s1-counter', B.user, 'POST', `/v1/exchanges/${exchangeId}/counter`, { expectedVersion: 1, datesB: B_V2, guestsA: 3, message: 'One day later works better for us; we are three.' });
    expect(ctr.status, show(ctr)).toBe(200);
    expect(ctr.body.item).toMatchObject({
      status: 'COUNTERED',
      currentOfferVersion: 2,
      lastOfferBy: B.user.id,
      acceptedAVersion: 1,
      acceptedBVersion: 2,
      datesA: A_V1,
      datesB: B_V2,
      nextAction: 'AWAIT_RESPONSE',
      version: 2,
    });
    expect(ctr.body.item.offers.map((o: any) => o.version)).toEqual([1, 2]);
    expect(ctr.body.item.currentOffer).toMatchObject({ version: 2, createdBy: B.user.id, datesA: A_V1, datesB: B_V2, guestsA: 3, guestsB: 2 });
    expect((await getExchange(A.user, exchangeId)).nextAction).toBe('RESPOND');

    const old = await call(t, A.user, 'POST', `/v1/exchanges/${exchangeId}/accept`, { offerVersion: 1 });
    expect(old.status).toBe(409);
    expect(old.body.code).toBe('OFFER_VERSION_MISMATCH');
    const acc = await act('s1-accept', A.user, 'POST', `/v1/exchanges/${exchangeId}/accept`, { offerVersion: 2 });
    expect(acc.status, show(acc)).toBe(200);
    expect(acc.body.item).toMatchObject({ status: 'VERIFICATION_PENDING', acceptedAVersion: 2, acceptedBVersion: 2, respondBy: null, nextAction: 'SAFETY_ACK' });
    expect(acc.body.item.verifications).toHaveLength(6);
    expect(acc.body.item.verifications.every((v: any) => v.status === 'PENDING')).toBe(true);
    // no more negotiation after mutual acceptance
    const late = await call(t, B.user, 'POST', `/v1/exchanges/${exchangeId}/counter`, { expectedVersion: 2, guestsA: 1 });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('INVALID_STATE_TRANSITION');

    // a third user quotes a paid stay on B's (still free) counter dates — used for the hold attempt after confirmation
    const q = await call(t, outsider, 'POST', '/v1/booking/quotes', { propertyId: B.propertyId, checkIn: day(41), checkOut: day(43), guests: 2 });
    expect(q.status, show(q)).toBe(201);
    expect(q.body.item).toMatchObject({ nights: 2, subtotalMinor: SUBTOTAL, cleaningFeeMinor: CLEANING, platformFeeMinor: PLATFORM_FEE, taxMinor: TAX, totalMinor: QUOTE_TOTAL, currency: 'KRW' });
    preConfirmQuoteId = q.body.item.id;
  });

  it('5. verification gate: both safety-ack, verify; agreement exists only once every check passed', async () => {
    expect((await call(t, A.user, 'GET', `/v1/exchanges/${exchangeId}/agreement`)).status).toBe(404);
    const bad = await call(t, A.user, 'POST', `/v1/exchanges/${exchangeId}/safety-ack`, { acknowledged: false });
    expect(bad.status).toBe(400);
    const ackA = await act('s1-ackA', A.user, 'POST', `/v1/exchanges/${exchangeId}/safety-ack`, { acknowledged: true }, { 'user-agent': 'e2e-member-A/1.0' });
    expect(ackA.status, show(ackA)).toBe(200);
    expect(ackA.body.item.status).toBe('VERIFICATION_PENDING');
    expect(ackA.body.item.nextAction).toBe('AWAIT_VERIFICATION');
    const pending = ackA.body.checks.filter((c: any) => c.status !== 'PASSED');
    expect(pending).toEqual([expect.objectContaining({ partyUserId: B.user.id, checkType: 'SAFETY_ACK', status: 'PENDING' })]);
    expect(ackA.body.checks.filter((c: any) => c.status === 'PASSED')).toHaveLength(5);

    const v1 = await act('s1-verifyA', A.user, 'POST', `/v1/exchanges/${exchangeId}/verify`);
    expect(v1.status, show(v1)).toBe(200);
    expect(v1.body.item.status).toBe('VERIFICATION_PENDING');
    expect(v1.body.checks.find((c: any) => c.partyUserId === B.user.id && c.checkType === 'SAFETY_ACK').status).toBe('PENDING');
    expect((await getExchange(B.user, exchangeId)).nextAction).toBe('SAFETY_ACK');
    expect((await call(t, A.user, 'GET', `/v1/exchanges/${exchangeId}/agreement`)).status).toBe(404);

    const ackB = await act('s1-ackB', B.user, 'POST', `/v1/exchanges/${exchangeId}/safety-ack`, { acknowledged: true }, { 'user-agent': 'e2e-member-B/1.0' });
    expect(ackB.status, show(ackB)).toBe(200);
    expect(ackB.body.item.status).toBe('AGREEMENT_PENDING');
    expect(ackB.body.checks).toHaveLength(6);
    expect(ackB.body.checks.every((c: any) => c.status === 'PASSED')).toBe(true);
    expect(ackB.body.item.agreement).toMatchObject({ status: 'PENDING', termsVersion: TERMS_VERSION, offerVersion: 2, signedByRequester: false, signedByResponder: false });
    const again = await call(t, A.user, 'POST', `/v1/exchanges/${exchangeId}/verify`);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('6. agreement: both fetch the same terms hash, both sign it; the second signature confirms; confirm is idempotent', async () => {
    const agA = await call(t, A.user, 'GET', `/v1/exchanges/${exchangeId}/agreement`);
    const agB = await call(t, B.user, 'GET', `/v1/exchanges/${exchangeId}/agreement`);
    expect(agA.status, show(agA)).toBe(200);
    expect(agB.status).toBe(200);
    const ag = agA.body.item;
    agreementId = ag.id;
    termsHash = ag.termsHash;
    expect(agB.body.item.termsHash).toBe(termsHash);
    expect(termsHash).toBe(sha256(canonicalJson(ag.termsSnapshot)));
    expect(ag).toMatchObject({ status: 'PENDING', termsVersion: TERMS_VERSION, offerVersion: 2, signatures: { requester: null, responder: null } });
    expect(ag.termsSnapshot).toMatchObject({
      schema: 'jetpool.exchange.agreement/v1',
      exchangeId,
      offerVersion: 2,
      offer: { datesA: A_V1, datesB: B_V2, guestsA: 3, guestsB: 2, createdBy: B.user.id },
      parties: { requester: { userId: A.user.id, propertyId: A.propertyId }, responder: { userId: B.user.id, propertyId: B.propertyId } },
      homes: {
        A: { propertyId: A.propertyId, title: A.spec.title, houseRules: { quiet_hours: '22:00-07:00', smoking_allowed: false } },
        B: { propertyId: B.propertyId, title: B.spec.title, houseRules: { quiet_hours: '22:00-07:00', pets_allowed: false } },
      },
      platformTerms: { type: 'EXCHANGE_TERMS', version: TERMS_VERSION },
    });
    expect((await call(t, outsider, 'GET', `/v1/exchanges/${exchangeId}/agreement`)).status).toBe(404);

    const wrong = await call(t, A.user, 'POST', `/v1/exchanges/${exchangeId}/agreement/sign`, { termsHash: 'f'.repeat(64) });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe('TERMS_HASH_MISMATCH');
    const s1 = await act('s1-signA', A.user, 'POST', `/v1/exchanges/${exchangeId}/agreement/sign`, { termsHash }, { 'user-agent': 'e2e-member-A/1.0' });
    expect(s1.status, show(s1)).toBe(200);
    expect(s1.body.autoConfirm).toBeUndefined();
    expect(s1.body.item).toMatchObject({ status: 'AGREEMENT_PENDING', nextAction: 'AWAIT_COUNTERPARTY_SIGNATURE', addresses: null });
    expect(s1.body.item.agreement).toMatchObject({ status: 'PARTIALLY_SIGNED', signedByRequester: true, signedByResponder: false });
    const twice = await call(t, A.user, 'POST', `/v1/exchanges/${exchangeId}/agreement/sign`, { termsHash });
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('ALREADY_SIGNED');
    expect((await getExchange(B.user, exchangeId)).nextAction).toBe('SIGN_AGREEMENT');

    const s2 = await act('s1-signB', B.user, 'POST', `/v1/exchanges/${exchangeId}/agreement/sign`, { termsHash }, { 'user-agent': 'e2e-member-B/1.0' });
    expect(s2.status, show(s2)).toBe(200);
    expect(s2.body.autoConfirm).toEqual({ confirmed: true });
    expect(s2.body.item).toMatchObject({ status: 'CONFIRMED', nextAction: 'PREPARE_TRIP', version: 6 });
    expect(s2.body.item.confirmedAt).toBeTruthy();
    expect(s2.body.item.agreement).toMatchObject({ id: agreementId, status: 'SIGNED', termsHash, signedByRequester: true, signedByResponder: true });
    // exact addresses are revealed to the parties only after confirmation
    expect(s2.body.item.addresses).toMatchObject({ A: { line1: A.spec.line1, postalCode: A.spec.postalCode }, B: { line1: B.spec.line1, postalCode: B.spec.postalCode } });
    expect((await getExchange(A.user, exchangeId)).addresses.B.line1).toBe(B.spec.line1);

    // party view of the signed agreement: timestamps, no raw evidence
    const signed = await call(t, A.user, 'GET', `/v1/exchanges/${exchangeId}/agreement`);
    expect(signed.body.item.status).toBe('SIGNED');
    expect(signed.body.item.signatures.requester.signedAt).toBeTruthy();
    expect(signed.body.item.signatures.responder.signedAt).toBeTruthy();
    expect(signed.body.item.signatures.requester.evidence).toBeUndefined();
    // e-consent evidence (agreement_acceptances view): both parties accepted exactly the same terms
    const acceptances = await rows(`SELECT party, user_id, terms_version, terms_hash, offer_version, evidence FROM agreement_acceptances WHERE exchange_id = $1 ORDER BY party`, [exchangeId]);
    expect(acceptances).toHaveLength(2);
    expect(acceptances.map((x) => [x.party, x.user_id, x.terms_version, x.terms_hash, x.offer_version])).toEqual([
      ['A', A.user.id, TERMS_VERSION, termsHash, 2],
      ['B', B.user.id, TERMS_VERSION, termsHash, 2],
    ]);
    expect(acceptances[0].evidence).toMatchObject({ termsHash, termsVersion: TERMS_VERSION, offerVersion: 2, sessionId: A.user.sessionId, correlationId: cids['s1-signA'], userAgent: 'e2e-member-A/1.0' });
    expect(acceptances[1].evidence).toMatchObject({ termsHash, sessionId: B.user.sessionId, correlationId: cids['s1-signB'], userAgent: 'e2e-member-B/1.0' });
    expect(acceptances[0].evidence.ip).toBeTruthy();
    // AAL2 support staff may read the evidence; the read is audited as ELEVATED_ACCESS
    const staffRead = await act('s1-staffRead', support, 'GET', `/v1/exchanges/${exchangeId}/agreement`);
    expect(staffRead.status, show(staffRead)).toBe(200);
    expect(staffRead.body.item.signatures.requester.evidence).toMatchObject({ termsHash, correlationId: cids['s1-signA'] });
    const elevated = (await auditFor(agreementId)).filter((a) => a.action === 'exchange.agreement.read');
    expect(elevated).toHaveLength(1);
    expect(elevated[0]).toMatchObject({ actor_id: support.id, category: 'ELEVATED_ACCESS', resource_type: 'exchange_agreement', correlation_id: cids['s1-staffRead'] });

    // explicit confirm: Idempotency-Key required; an already-confirmed exchange is returned unchanged; replay is identical
    const noKey = await call(t, A.user, 'POST', `/v1/exchanges/${exchangeId}/confirm`);
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = idem();
    const conf = await call(t, A.user, 'POST', `/v1/exchanges/${exchangeId}/confirm`, undefined, key);
    expect(conf.status, show(conf)).toBe(200);
    expect(conf.body.alreadyConfirmed).toBe(true);
    expect(conf.body.item).toMatchObject({ status: 'CONFIRMED', version: 6 });
    const replay = await call(t, A.user, 'POST', `/v1/exchanges/${exchangeId}/confirm`, undefined, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(conf.body);
    expect((await call(t, outsider, 'POST', `/v1/exchanges/${exchangeId}/confirm`, undefined, idem())).status).toBe(404);
    expect(await exchangeBlocks(exchangeId)).toHaveLength(2);
  });

  it('7. agreement signing (legal e-consent) is recorded in the append-only audit log', async () => {
    const entries = [...(await auditFor(agreementId)), ...(await auditFor(exchangeId))];
    const signs = entries.filter((a) => /agreement/.test(a.action) && /sign/.test(a.action));
    expect(signs, `audit actions found: ${JSON.stringify(entries.map((e) => e.action))}`).toHaveLength(2);
    expect(signs.map((a) => a.actor_id).sort()).toEqual([A.user.id, B.user.id].sort());
    expect(signs.map((a) => a.correlation_id).sort()).toEqual([cids['s1-signA'], cids['s1-signB']].sort());
  });

  it('8. both homes are blocked: calendar booked, paid quote/hold and host block rejected 409, no reservation rows', async () => {
    const blocks = await exchangeBlocks(exchangeId);
    expect(blocks).toHaveLength(2);
    const byProp = Object.fromEntries(blocks.map((b) => [b.property_id, b]));
    expect(byProp[A.propertyId]).toMatchObject({ start: A_V1.start, end: A_V1.end, block_type: 'EXCHANGE', source_type: 'EXCHANGE', source_id: exchangeId, state: 'ACTIVE', expires_at: null });
    expect(byProp[B.propertyId]).toMatchObject({ start: B_V2.start, end: B_V2.end, block_type: 'EXCHANGE', source_type: 'EXCHANGE', source_id: exchangeId, state: 'ACTIVE', expires_at: null });
    // both blocks were written by one transaction (same now())
    expect(new Date(blocks[0].created_at).getTime()).toBe(new Date(blocks[1].created_at).getTime());

    // public calendars: every night of the respective range is "booked", the neighbours are not
    const calA = await calendar(A.propertyId, day(29), day(36));
    for (const d of nights(30, 35)) expect(calA[d], d).toBe('booked');
    expect(calA[day(29)]).not.toBe('booked');
    expect(calA[day(35)]).not.toBe('booked');
    const calB = await calendar(B.propertyId, day(40), day(47));
    for (const d of nights(41, 46)) expect(calB[d], d).toBe('booked');
    expect(calB[day(40)]).toBe('available');
    expect(calB[day(46)]).toBe('available');
    // host calendar shows the exchange as the block source
    const hc = await call(t, B.user, 'GET', `/v1/host/calendar?propertyId=${B.propertyId}&from=${day(40)}&to=${day(47)}`);
    expect(hc.status, show(hc)).toBe(200);
    expect(hc.body.item.blocks).toEqual([expect.objectContaining({ type: 'EXCHANGE', sourceType: 'EXCHANGE', sourceId: exchangeId, start: B_V2.start, end: B_V2.end, reservation: null })]);

    // a third user's paid stay cannot collide with the exchange (EXCH-05)
    for (const [ci, co] of [[42, 44], [45, 47], [40, 42]]) {
      const q = await call(t, outsider, 'POST', '/v1/booking/quotes', { propertyId: B.propertyId, checkIn: day(ci), checkOut: day(co), guests: 2 });
      expect(q.status, `${day(ci)}..${day(co)} ${show(q)}`).toBe(409);
      expect(q.body.code).toBe('INVENTORY_UNAVAILABLE');
    }
    const hold = await call(t, outsider, 'POST', '/v1/booking/holds', { quoteId: preConfirmQuoteId }, idem());
    expect(hold.status, show(hold)).toBe(409);
    expect(hold.body.code).toBe('INVENTORY_UNAVAILABLE');
    // adjacent nights stay sellable (half-open ranges), with exact deterministic amounts
    for (const [ci, co] of [[39, 41], [46, 48]]) {
      const q = await call(t, outsider, 'POST', '/v1/booking/quotes', { propertyId: B.propertyId, checkIn: day(ci), checkOut: day(co), guests: 2 });
      expect(q.status, show(q)).toBe(201);
      expect(q.body.item).toMatchObject({ nights: QUOTE_NIGHTS, subtotalMinor: SUBTOTAL, cleaningFeeMinor: CLEANING, platformFeeMinor: PLATFORM_FEE, taxMinor: TAX, discountMinor: 0, totalMinor: QUOTE_TOTAL, currency: 'KRW' });
    }
    // the exchange-only home is never paid-bookable
    const qa = await call(t, outsider, 'POST', '/v1/booking/quotes', { propertyId: A.propertyId, checkIn: day(31), checkOut: day(33), guests: 2 });
    expect(qa.status).toBe(422);
    expect(qa.body.code).toBe('PROPERTY_NOT_BOOKABLE');
    // the hosts themselves cannot block over the exchange either
    const hb = await call(t, A.user, 'POST', `/v1/properties/${A.propertyId}/blocks`, { start: day(33), end: day(37), note: 'renovation' });
    expect(hb.status).toBe(409);
    expect(hb.body.code).toBe('INVENTORY_UNAVAILABLE');
    // discovery is date-aware
    const dated = await call(t, A.user, 'GET', `/v1/exchange/homes?city=Busan&start=${day(42)}&end=${day(44)}`);
    expect(dated.body.items).toEqual([]);
    const free = await call(t, A.user, 'GET', `/v1/exchange/homes?city=Busan&start=${day(50)}&end=${day(52)}`);
    expect(free.body.items.map((i: any) => i.id)).toEqual([B.propertyId]);

    // independent FSM (invariant 2): the exchange never created reservation / hold rows
    const res = await rows(`SELECT count(*)::int AS n FROM reservations WHERE property_id = ANY($1::uuid[])`, [[A.propertyId, B.propertyId]]);
    expect(res[0].n).toBe(0);
    const holds = await rows(`SELECT count(*)::int AS n FROM reservation_holds WHERE property_id = ANY($1::uuid[])`, [[A.propertyId, B.propertyId]]);
    expect(holds[0].n).toBe(0);
    const otherBlocks = await rows(`SELECT block_type FROM inventory_blocks WHERE property_id = ANY($1::uuid[]) AND state = 'ACTIVE' AND block_type <> 'EXCHANGE'`, [[A.propertyId, B.propertyId]]);
    expect(otherBlocks).toEqual([]);
    for (const m of [A, B]) {
      const hr = await call(t, m.user, 'GET', '/v1/host/reservations');
      expect(hr.status, show(hr)).toBe(200);
      expect(hr.body.items).toEqual([]);
      const gr = await call(t, m.user, 'GET', '/v1/reservations');
      expect(gr.body.items).toEqual([]);
    }
  });

  it('9. messaging in the exchange conversation after confirmation (contact details allowed, idempotent sends)', async () => {
    const m = await act('s1-msgB', B.user, 'POST', `/v1/conversations/${conversationId}/messages`, { body: 'Confirmed! My number is 010-9876-5432', clientMessageId: 'b-1' });
    expect(m.status, show(m)).toBe(201);
    expect(m.body.item).toMatchObject({ senderId: B.user.id, type: 'TEXT', body: 'Confirmed! My number is 010-9876-5432', redacted: false });
    expect(m.body.item.metadata.contactInfoMasked).toBeUndefined();
    const dup = await call(t, B.user, 'POST', `/v1/conversations/${conversationId}/messages`, { body: 'Confirmed! My number is 010-9876-5432', clientMessageId: 'b-1' });
    expect(dup.status).toBe(200);
    expect(dup.body).toMatchObject({ replayed: true, item: { id: m.body.item.id } });

    const convA = await call(t, A.user, 'GET', '/v1/conversations');
    expect(convA.body.items.find((x: any) => x.id === conversationId)).toMatchObject({ unreadCount: 1, lastMessage: { id: m.body.item.id, senderId: B.user.id } });
    const list = await call(t, A.user, 'GET', `/v1/conversations/${conversationId}/messages`);
    expect(list.status, show(list)).toBe(200);
    expect(list.body.items.map((x: any) => x.senderId)).toEqual([B.user.id, A.user.id]); // newest first
    expect(list.body.items[1].body).toContain('[연락처 비공개]');
    const rd = await call(t, A.user, 'POST', `/v1/conversations/${conversationId}/read`);
    expect(rd.status).toBe(200);
    expect((await call(t, A.user, 'GET', '/v1/conversations')).body.items.find((x: any) => x.id === conversationId).unreadCount).toBe(0);
    expect((await call(t, outsider, 'GET', `/v1/conversations/${conversationId}/messages`)).status).toBe(404);
    const rows_ = await rows(`SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1`, [conversationId]);
    expect(rows_[0].n).toBe(2);
  });

  it('10. lifecycle job: CONFIRMED → IN_PROGRESS → COMPLETED (reviews locked until completion)', async () => {
    const early = await call(t, A.user, 'POST', '/v1/reviews', { transactionType: 'EXCHANGE', transactionId: exchangeId, targetType: 'EXCHANGE_PARTNER', rating: 5 });
    expect(early.status).toBe(422);
    expect(early.body.code).toBe('TRANSACTION_NOT_COMPLETED');
    await t.runJobs();
    expect((await getExchange(A.user, exchangeId)).status).toBe('CONFIRMED'); // stays are in the future

    // no clock API: move the stays so that the earliest one has started (dates only)
    await t.pool.query(`UPDATE exchange_requests SET dates_a = daterange($2::date, $3::date), dates_b = daterange($4::date, $5::date) WHERE id = $1`, [exchangeId, day(-1), day(3), day(0), day(4)]);
    await t.runJobs();
    const ip = await getExchange(B.user, exchangeId);
    expect(ip).toMatchObject({ status: 'IN_PROGRESS', nextAction: 'COMPLETE_AFTER_STAY' });
    expect(ip.startedAt).toBeTruthy();
    const notEnded = await call(t, A.user, 'POST', `/v1/exchanges/${exchangeId}/complete`);
    expect(notEnded.status).toBe(409);
    expect(notEnded.body.code).toBe('EXCHANGE_NOT_ENDED');
    const cancel = await call(t, A.user, 'POST', `/v1/exchanges/${exchangeId}/cancel`, { reason: 'too late to cancel' });
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe('INVALID_STATE_TRANSITION');

    // both stays ended
    await t.pool.query(`UPDATE exchange_requests SET dates_a = daterange($2::date, $3::date), dates_b = daterange($4::date, $5::date) WHERE id = $1`, [exchangeId, day(-6), day(-2), day(-5), day(-1)]);
    await t.runJobs();
    const done = await getExchange(A.user, exchangeId);
    expect(done).toMatchObject({ status: 'COMPLETED', nextAction: 'LEAVE_REVIEW' });
    expect(done.completedAt).toBeTruthy();
    const disp = await call(t, A.user, 'POST', `/v1/exchanges/${exchangeId}/dispute`, { reason: 'too late for a dispute here' });
    expect(disp.status).toBe(409);
  });

  it('11. both parties review each other via /v1/reviews → exchange REVIEWED (outbox)', async () => {
    const pendA = await call(t, A.user, 'GET', '/v1/me/reviews');
    expect(pendA.body.pending).toEqual([{ transaction_type: 'EXCHANGE', transaction_id: exchangeId, target_type: 'EXCHANGE_PARTNER' }]);
    const stranger = await call(t, outsider, 'POST', '/v1/reviews', { transactionType: 'EXCHANGE', transactionId: exchangeId, targetType: 'EXCHANGE_PARTNER', rating: 1 });
    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe('NOT_A_PARTY');
    const wrongTarget = await call(t, A.user, 'POST', '/v1/reviews', { transactionType: 'EXCHANGE', transactionId: exchangeId, targetType: 'EXCHANGE_PARTNER', targetId: A.user.id, rating: 5 });
    expect(wrongTarget.status).toBe(422);
    expect(wrongTarget.body.code).toBe('TARGET_NOT_IN_TRANSACTION');

    const ra = await act('s1-reviewA', A.user, 'POST', '/v1/reviews', { transactionType: 'EXCHANGE', transactionId: exchangeId, targetType: 'EXCHANGE_PARTNER', rating: 5, subRatings: { cleanliness: 5, communication: 5 }, body: 'Spotless home, wonderful hosts.' });
    expect(ra.status, show(ra)).toBe(201);
    expect(ra.body.item).toMatchObject({ authorId: A.user.id, targetType: 'EXCHANGE_PARTNER', targetId: B.user.id, transactionType: 'EXCHANGE', rating: 5, status: 'PUBLISHED' });
    const dupe = await call(t, A.user, 'POST', '/v1/reviews', { transactionType: 'EXCHANGE', transactionId: exchangeId, targetType: 'EXCHANGE_PARTNER', rating: 4 });
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe('REVIEW_EXISTS');
    await t.drain();
    expect((await getExchange(A.user, exchangeId)).status).toBe('COMPLETED'); // one side is not enough

    const rb = await act('s1-reviewB', B.user, 'POST', '/v1/reviews', { transactionType: 'EXCHANGE', transactionId: exchangeId, targetType: 'EXCHANGE_PARTNER', rating: 4, body: 'Great swap, a little noisy street.' });
    expect(rb.status, show(rb)).toBe(201);
    expect(rb.body.item).toMatchObject({ authorId: B.user.id, targetId: A.user.id, rating: 4 });
    await t.drain();
    const reviewed = await getExchange(B.user, exchangeId);
    expect(reviewed).toMatchObject({ status: 'REVIEWED', nextAction: null });

    const repB = await call(t, null, 'GET', `/v1/reviews?targetType=EXCHANGE_PARTNER&targetId=${B.user.id}`);
    expect(repB.status, show(repB)).toBe(200);
    expect(repB.body.items.map((r: any) => r.id)).toEqual([ra.body.item.id]);
    expect(repB.body.summary.reviewCount).toBe(1);
    expect(Number(repB.body.summary.ratingAvg)).toBe(5);
    const repA = await call(t, null, 'GET', `/v1/reviews?targetType=EXCHANGE_PARTNER&targetId=${A.user.id}`);
    expect(repA.body.summary.reviewCount).toBe(1);
    expect(Number(repA.body.summary.ratingAvg)).toBe(4);
    expect((await call(t, A.user, 'GET', '/v1/me/reviews')).body.pending).toEqual([]);
    expect((await call(t, B.user, 'GET', '/v1/me/reviews')).body.pending).toEqual([]);
  });

  it('12. full state history with correlation ids, outbox events, notifications, no money moved', async () => {
    const h = await history(exchangeId);
    expect(h.map((x) => [x.from_state, x.to_state])).toEqual([
      [null, 'REQUESTED'],
      ['REQUESTED', 'COUNTERED'],
      ['COUNTERED', 'MUTUAL_ACCEPTED'],
      ['MUTUAL_ACCEPTED', 'VERIFICATION_PENDING'],
      ['VERIFICATION_PENDING', 'AGREEMENT_PENDING'],
      ['AGREEMENT_PENDING', 'CONFIRMED'],
      ['CONFIRMED', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'COMPLETED'],
      ['COMPLETED', 'REVIEWED'],
    ]);
    const job = expect.stringMatching(/^job-exchange-lifecycle-\d+$/);
    expect(h.map((x) => x.correlation_id)).toEqual([
      cids['s1-request'], cids['s1-counter'], cids['s1-accept'], cids['s1-accept'], cids['s1-ackB'], cids['s1-signB'], job, job, cids['s1-reviewB'],
    ]);
    expect(h.map((x) => [x.actor_id, x.actor_type])).toEqual([
      [A.user.id, 'USER'],
      [B.user.id, 'USER'],
      [A.user.id, 'USER'],
      [A.user.id, 'SYSTEM'],
      [B.user.id, 'USER'],
      [B.user.id, 'USER'],
      [null, 'SYSTEM'],
      [null, 'SYSTEM'],
      [null, 'SYSTEM'],
    ]);
    expect(h[1].metadata).toEqual({ offerVersion: 2 });
    expect(h[2].metadata).toEqual({ offerVersion: 2 });
    const blocks = await exchangeBlocks(exchangeId);
    expect(h[5].metadata.agreementId).toBe(agreementId);
    expect([...h[5].metadata.blockIds].sort()).toEqual(blocks.map((b) => b.id).sort());
    // the spec view mirrors the log; nothing but the EXCHANGE machine ever transitioned this aggregate
    const view = await rows(`SELECT from_state, to_state, correlation_id FROM exchange_state_history WHERE exchange_id = $1 ORDER BY id`, [exchangeId]);
    expect(view.map((v) => [v.from_state, v.to_state, v.correlation_id])).toEqual(h.map((x) => [x.from_state, x.to_state, x.correlation_id]));
    const foreign = await rows(`SELECT aggregate_type FROM state_transitions WHERE aggregate_id = $1 AND aggregate_type <> 'EXCHANGE'`, [exchangeId]);
    expect(foreign).toEqual([]);

    // outbox: every domain event of the exchange, grouped by the request that caused it
    const label = Object.fromEntries(Object.entries(cids).map(([k, v]) => [v, k]));
    const evs = await rows(`SELECT event_type, correlation_id, payload, published_at, dead_lettered_at FROM outbox_events WHERE aggregate_type = 'exchange' AND aggregate_id = $1`, [exchangeId]);
    const got = evs.map((e) => `${label[e.correlation_id] ?? (String(e.correlation_id).startsWith('job-exchange-lifecycle-') ? 'job' : e.correlation_id)}:${e.event_type}`).sort();
    expect(got).toEqual(
      [
        's1-request:exchange.requested',
        's1-counter:exchange.countered',
        's1-accept:exchange.accepted',
        's1-accept:exchange.mutual_accepted',
        's1-accept:exchange.verification_pending',
        's1-ackB:exchange.verified',
        's1-ackB:exchange.agreement.created',
        's1-signA:exchange.agreement.signed',
        's1-signB:exchange.agreement.signed',
        's1-signB:exchange.calendar_blocked',
        's1-signB:exchange.confirmed',
        'job:exchange.started',
        'job:exchange.completed',
        's1-reviewB:exchange.reviews.completed',
        's1-reviewB:exchange.reviewed',
      ].sort(),
    );
    for (const e of evs) {
      expect(e.payload.exchangeId).toBe(exchangeId);
      expect(e.published_at, e.event_type).toBeTruthy();
      expect(e.dead_lettered_at).toBeNull();
    }
    const confirmed = evs.find((e) => e.event_type === 'exchange.confirmed')!.payload;
    expect(confirmed).toMatchObject({ requesterId: A.user.id, responderId: B.user.id, propertyAId: A.propertyId, propertyBId: B.propertyId, datesA: A_V1, datesB: B_V2, agreementId, termsHash });
    const signedEvs = evs.filter((e) => e.event_type === 'exchange.agreement.signed').map((e) => e.payload);
    expect(signedEvs.map((p) => [p.by, p.fullySigned, p.termsHash]).sort()).toEqual([[A.user.id, false, termsHash], [B.user.id, true, termsHash]].sort());

    // notifications reached both parties
    expect(await notificationKeys(A.user)).toEqual(expect.arrayContaining(['exchange.countered', 'exchange.verification_pending', 'exchange.agreement.created', 'exchange.confirmed', 'exchange.completed', 'review.received']));
    expect(await notificationKeys(B.user)).toEqual(expect.arrayContaining(['exchange.requested', 'exchange.verification_pending', 'exchange.agreement.created', 'exchange.confirmed', 'exchange.completed', 'review.received']));

    // Home Exchange moves no money: no payment, ledger untouched and balanced
    const pays = await rows(`SELECT count(*)::int AS n FROM payments WHERE subject_id::text = $1`, [exchangeId]);
    expect(pays[0].n).toBe(0);
    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
    expect(tb.currencies).toEqual(tb0.currencies);
    expect(tb.accounts).toEqual(tb0.accounts);

    // the outbox drained without failures or dead letters
    await t.drain();
    const ov = await call(t, admin, 'GET', '/v1/admin/overview');
    expect(ov.status, show(ov)).toBe(200);
    expect(ov.body.outbox).toMatchObject({ pending: 0, deadLetters: 0 });
  });
});

// ================================================================================================ scenario 2

describe('G4 E2E — cancellation after confirmation releases both blocks atomically', () => {
  it('confirmed exchange → concurrent cancels (one wins) → both blocks released in one tx → dates sellable again', async () => {
    const X = await onboardHost(homeSpec('Hana', 'Daegu', 'KR-27', 35.8714, 128.6014, ['Jeju']));
    const Y = await onboardHost(homeSpec('Joon', 'Jeju', 'KR-49', 33.4996, 126.5312, ['Daegu']));
    const X_D = range(50, 53);
    const Y_D = range(55, 58);
    const { id, hash } = await toAgreement('s2', X, Y, X_D, Y_D);
    expect((await act('s2-signA', X.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash })).status).toBe(200);
    const s2 = await act('s2-signB', Y.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash });
    expect(s2.status, show(s2)).toBe(200);
    expect(s2.body.item.status).toBe('CONFIRMED');
    const before = await exchangeBlocks(id);
    expect(before.map((b) => [b.property_id, b.start, b.end, b.state]).sort()).toEqual(
      [[X.propertyId, X_D.start, X_D.end, 'ACTIVE'], [Y.propertyId, Y_D.start, Y_D.end, 'ACTIVE']].sort(),
    );
    expect(Object.values(await calendar(X.propertyId, X_D.start, X_D.end))).toEqual(['booked', 'booked', 'booked']);
    expect(Object.values(await calendar(Y.propertyId, Y_D.start, Y_D.end))).toEqual(['booked', 'booked', 'booked']);

    const short = await call(t, X.user, 'POST', `/v1/exchanges/${id}/cancel`, { reason: 'no' });
    expect(short.status).toBe(400);
    expect((await call(t, outsider, 'POST', `/v1/exchanges/${id}/cancel`, { reason: 'not my exchange' })).status).toBe(404);

    // both parties cancel at the same time: exactly one transition wins
    const [cx, cy] = await Promise.all([
      act('s2-cancelX', X.user, 'POST', `/v1/exchanges/${id}/cancel`, { reason: 'family emergency' }),
      act('s2-cancelY', Y.user, 'POST', `/v1/exchanges/${id}/cancel`, { reason: 'work trip came up' }),
    ]);
    expect([cx.status, cy.status].sort()).toEqual([200, 409]);
    const winner = cx.status === 200 ? { r: cx, user: X.user, label: 's2-cancelX', reason: 'family emergency' } : { r: cy, user: Y.user, label: 's2-cancelY', reason: 'work trip came up' };
    const loser = cx.status === 200 ? cy : cx;
    expect(loser.body.code).toBe('INVALID_STATE_TRANSITION');
    expect(winner.r.body.item).toMatchObject({ status: 'CANCELLED', nextAction: null, agreement: { status: 'VOID' } });
    expect(winner.r.body.item.cancelledAt).toBeTruthy();

    // both blocks RELEASED by the same transaction (identical now()), nothing left ACTIVE
    const after = await exchangeBlocks(id);
    expect(after).toHaveLength(2);
    expect(after.every((b) => b.state === 'RELEASED' && b.released_at)).toBe(true);
    expect(new Date(after[0].released_at).getTime()).toBe(new Date(after[1].released_at).getTime());
    for (const [pid, r] of [[X.propertyId, X_D], [Y.propertyId, Y_D]] as const) {
      const cal = await calendar(pid, r.start, r.end);
      expect(Object.values(cal).some((s) => s === 'booked')).toBe(false);
    }
    const h = await history(id);
    expect(h.map((x) => x.to_state)).toEqual(['REQUESTED', 'MUTUAL_ACCEPTED', 'VERIFICATION_PENDING', 'AGREEMENT_PENDING', 'CONFIRMED', 'CANCELLED']);
    const last = h[h.length - 1];
    expect(last).toMatchObject({ from_state: 'CONFIRMED', actor_id: winner.user.id, actor_type: 'USER', reason: winner.reason, correlation_id: cids[winner.label] });
    expect(last.metadata).toMatchObject({ policy: 'STANDARD', cancelledBy: winner.user.id });
    expect([...last.metadata.releasedBlockIds].sort()).toEqual(before.map((b) => b.id).sort());
    expect(h.filter((x) => x.to_state === 'CANCELLED')).toHaveLength(1);
    const ev = await rows(`SELECT payload, correlation_id FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'exchange.cancelled'`, [id]);
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ by: winner.user.id, fromStatus: 'CONFIRMED', policy: 'STANDARD', reason: winner.reason });
    expect(ev[0].payload.releasedBlockIds).toHaveLength(2);
    const audits = (await auditFor(id)).filter((a) => a.action === 'exchange.cancelled_after_confirm');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor_id: winner.user.id, resource_type: 'exchange', correlation_id: cids[winner.label], reason: winner.reason, before_state: { status: 'CONFIRMED' }, after_state: { status: 'CANCELLED', policy: 'STANDARD' } });
    // the counterparty (not the canceller) is notified
    const counterparty = winner.user.id === X.user.id ? Y.user : X.user;
    expect(await notificationKeys(counterparty)).toContain('exchange.cancelled');
    expect(await notificationKeys(winner.user)).not.toContain('exchange.cancelled');
    // terminal: no further transitions
    expect((await call(t, X.user, 'POST', `/v1/exchanges/${id}/cancel`, { reason: 'once more' })).status).toBe(409);
    expect((await call(t, X.user, 'POST', `/v1/exchanges/${id}/confirm`, undefined, idem())).status).toBe(409);

    // the released dates are usable again: a host block and a fresh exchange request for the very same ranges
    const hb = await call(t, Y.user, 'POST', `/v1/properties/${Y.propertyId}/blocks`, { start: Y_D.start, end: Y_D.end, note: 'painting' });
    expect(hb.status, show(hb)).toBe(201);
    expect((await call(t, Y.user, 'DELETE', `/v1/properties/${Y.propertyId}/blocks/${hb.body.item.id}`)).status).toBe(204);
    const again = await call(t, X.user, 'POST', '/v1/exchanges', { myPropertyId: X.propertyId, theirPropertyId: Y.propertyId, datesA: X_D, datesB: Y_D, guestsA: 2, guestsB: 2 });
    expect(again.status, show(again)).toBe(201);
    expect(again.body.item.status).toBe('REQUESTED');
    const res = await rows(`SELECT count(*)::int AS n FROM reservations WHERE property_id = ANY($1::uuid[])`, [[X.propertyId, Y.propertyId]]);
    expect(res[0].n).toBe(0);
  }, 60_000);
});

// ================================================================================================ scenario 3

describe('G4 E2E — atomic calendar lock, explicit confirm, then a dispute through TRUST-03', () => {
  it('auto-confirm rolls back on a host block, explicit idempotent confirm succeeds, dispute row visible to both parties', async () => {
    const P = await onboardHost(homeSpec('Sora', 'Incheon', 'KR-28', 37.4563, 126.7052, ['Gangneung']));
    const Q = await onboardHost(homeSpec('Taeho', 'Gangneung', 'KR-42', 37.7519, 128.8761, ['Incheon']));
    const P_D = range(60, 63);
    const Q_D = range(64, 67);
    const { id, hash, agreementId: agId } = await toAgreement('s3', P, Q, P_D, Q_D);

    // the home locked SECOND (ascending property id) gets a host block, so the first acquisition must be rolled back
    const [first, second] = [
      { m: P, r: P_D },
      { m: Q, r: Q_D },
    ].sort((x, y) => (x.m.propertyId < y.m.propertyId ? -1 : 1));
    const hb = await call(t, second.m.user, 'POST', `/v1/properties/${second.m.propertyId}/blocks`, { start: second.r.start, end: second.r.end, note: 'plumber' });
    expect(hb.status, show(hb)).toBe(201);

    expect((await act('s3-signA', P.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash })).status).toBe(200);
    const s2 = await act('s3-signB', Q.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash });
    expect(s2.status, show(s2)).toBe(200);
    expect(s2.body.autoConfirm).toEqual({ confirmed: false, error: 'INVENTORY_UNAVAILABLE' });
    expect(s2.body.item).toMatchObject({ status: 'AGREEMENT_PENDING', nextAction: 'CONFIRM', addresses: null, agreement: { id: agId, status: 'SIGNED' } });
    expect(await exchangeBlocks(id)).toEqual([]); // nothing remained on the first home (invariant 6)
    const firstCal = await calendar(first.m.propertyId, first.r.start, first.r.end);
    expect(Object.values(firstCal).some((s) => s === 'booked')).toBe(false);
    const fail = await call(t, P.user, 'POST', `/v1/exchanges/${id}/confirm`, undefined, idem());
    expect(fail.status).toBe(409);
    expect(fail.body.code).toBe('INVENTORY_UNAVAILABLE');
    expect(await exchangeBlocks(id)).toEqual([]);

    // the host removes the block; explicit confirm with an Idempotency-Key locks both homes
    expect((await call(t, second.m.user, 'DELETE', `/v1/properties/${second.m.propertyId}/blocks/${hb.body.item.id}`)).status).toBe(204);
    const key = idem();
    const ok = await act('s3-confirm', P.user, 'POST', `/v1/exchanges/${id}/confirm`, undefined, key);
    expect(ok.status, show(ok)).toBe(200);
    expect(ok.body.alreadyConfirmed).toBeUndefined();
    expect(ok.body.item).toMatchObject({ status: 'CONFIRMED', nextAction: 'PREPARE_TRIP' });
    const replay = await call(t, P.user, 'POST', `/v1/exchanges/${id}/confirm`, undefined, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(ok.body);
    const blocks = await exchangeBlocks(id);
    expect(blocks.map((b) => [b.property_id, b.start, b.end, b.state]).sort()).toEqual([[P.propertyId, P_D.start, P_D.end, 'ACTIVE'], [Q.propertyId, Q_D.start, Q_D.end, 'ACTIVE']].sort());

    // dispute through the exchange endpoint → TRUST-03 owns the record
    expect((await call(t, outsider, 'POST', `/v1/exchanges/${id}/dispute`, { reason: 'not even a party' })).status).toBe(404);
    const d = await act('s3-dispute', P.user, 'POST', `/v1/exchanges/${id}/dispute`, { reason: 'home not as described', description: 'The second bedroom does not exist.', severity: 'HIGH' });
    expect(d.status, show(d)).toBe(201);
    expect(d.body.item).toMatchObject({ status: 'DISPUTED', nextAction: null });
    const disputeId = d.body.disputeId as string;
    expect(disputeId).toMatch(/^[0-9a-f-]{36}$/);

    for (const party of [P.user, Q.user]) {
      const list = await call(t, party, 'GET', '/v1/disputes');
      expect(list.status, show(list)).toBe(200);
      expect(list.body.items).toHaveLength(1);
      expect(list.body.items[0]).toMatchObject({ id: disputeId, context_type: 'EXCHANGE', context_id: id, status: 'OPEN', severity: 'HIGH', reason: 'home not as described', opened_by: P.user.id, counterparty_id: Q.user.id });
    }
    expect((await call(t, outsider, 'GET', '/v1/disputes')).body.items).toEqual([]);
    const det = await call(t, Q.user, 'GET', `/v1/disputes/${disputeId}`);
    expect(det.status, show(det)).toBe(200);
    expect(det.body.item.timeline.map((e: any) => e.event_type)).toEqual(['OPENED']);
    expect(det.body.item.evidence).toEqual([expect.objectContaining({ evidence_type: 'TEXT', content: 'The second bedroom does not exist.', sha256: sha256('The second bedroom does not exist.') })]);
    expect((await call(t, outsider, 'GET', `/v1/disputes/${disputeId}`)).status).toBe(404);
    const dupe = await call(t, P.user, 'POST', '/v1/disputes', { contextType: 'EXCHANGE', contextId: id, reason: 'again' });
    expect(dupe.status).toBe(409);
    expect(dupe.body.code).toBe('DISPUTE_ALREADY_OPEN');
    const dRows = await rows(`SELECT id FROM disputes WHERE context_type = 'EXCHANGE' AND context_id = $1`, [id]);
    expect(dRows.map((r) => r.id)).toEqual([disputeId]);
    const dAudit = (await auditFor(disputeId)).filter((a) => a.action === 'dispute.opened');
    expect(dAudit).toHaveLength(1);
    expect(dAudit[0]).toMatchObject({ actor_id: P.user.id, correlation_id: cids['s3-dispute'] });
    const dHist = await rows(`SELECT from_state, to_state, correlation_id FROM state_transitions WHERE aggregate_type = 'dispute' AND aggregate_id = $1 ORDER BY id`, [disputeId]);
    expect(dHist).toEqual([{ from_state: null, to_state: 'OPEN', correlation_id: cids['s3-dispute'] }]);
    expect(await notificationKeys(Q.user)).toEqual(expect.arrayContaining(['exchange.disputed', 'dispute.opened']));

    // the dispute freezes the exchange: blocks preserved, no cancel / complete
    expect((await exchangeBlocks(id)).every((b) => b.state === 'ACTIVE')).toBe(true);
    expect((await call(t, Q.user, 'POST', `/v1/exchanges/${id}/cancel`, { reason: 'let me out' })).status).toBe(409);
    expect((await call(t, Q.user, 'POST', `/v1/exchanges/${id}/complete`)).status).toBe(409);

    const h = await history(id);
    expect(h.map((x) => [x.from_state, x.to_state])).toEqual([
      [null, 'REQUESTED'],
      ['REQUESTED', 'MUTUAL_ACCEPTED'],
      ['MUTUAL_ACCEPTED', 'VERIFICATION_PENDING'],
      ['VERIFICATION_PENDING', 'AGREEMENT_PENDING'],
      ['AGREEMENT_PENDING', 'CONFIRMED'],
      ['CONFIRMED', 'DISPUTED'],
    ]);
    expect(h.map((x) => x.correlation_id)).toEqual([cids['s3-request'], cids['s3-accept'], cids['s3-accept'], cids['s3-ackB'], cids['s3-confirm'], cids['s3-dispute']]);
    expect(h[4]).toMatchObject({ actor_id: P.user.id, actor_type: 'USER' });
    expect(h[5]).toMatchObject({ actor_id: P.user.id, reason: 'home not as described', metadata: { disputeId } });
    const res = await rows(`SELECT count(*)::int AS n FROM reservations WHERE property_id = ANY($1::uuid[])`, [[P.propertyId, Q.propertyId]]);
    expect(res[0].n).toBe(0);
  }, 60_000);
});
