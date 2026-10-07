/**
 * G4 end-to-end release gate — Travel Commerce chain, driven over HTTP only (call(t, user, ...)), flag travel.commerce.
 *
 * Chain: approved TRAVEL fee/tax rules (maker-checker) → supplier applies → admin approves (merchant of record
 * JETPOOL, commission) → supplier creates a product with options + departures → submits → admin publishes →
 * public catalog lists it (seller / merchant-of-record role) → buyer creates an order (Idempotency-Key) for 2 seats
 * → payments prepare (ORDER) → MOCK confirm → order PAID with vouchers → ledger posting → itinerary with the product
 * + a published stay → buyer cancels per the product's cancellation terms → refund executed via the outbox →
 * compensating ledger entries → ledger balanced.
 * Concurrency: departure capacity 3, 6 parallel 1-seat orders → exactly 3 succeed (no oversell); unpaid orders
 * expire through the jobs (t.runJobs()) and release their seats; a paid order is never expired.
 * Supplier merchant of record: payment posts to the supplier pass-through account, the order is fulfilled when the
 * departure starts, settlement generation includes it (maker-checker) and the manual payout drains pass-through.
 * Charter: content page + lead request work; every direct booking endpoint is 403 FEATURE_DISABLED while the flag is OFF.
 *
 * Test-setup hooks without an API (documented, no SQL anywhere in this file):
 *  - users and sessions are created with createUser() (sign-up is covered by e2e-stay); staff accounts are AAL2
 *    (staff MFA onboarding is out of scope), the MoR supplier gets an AAL2 session because payout-account
 *    registration requires MFA;
 *  - feature flags are switched with enableFlags() (G9 legal gates have no self-service API);
 *  - unpaid-order expiry: there is no time-travel API, so the order payment window (config HOLD_TTL_SEC) is shortened
 *    to a few seconds for the orders created in the expiry scenario only, and the test waits for real time to pass;
 *  - "fulfilled after departure": the MoR departure is created a few seconds in the future and the test waits for it
 *    to start before running the jobs (the departure lifecycle job is what marks orders FULFILLED);
 *  - the dev "presigned PUT" of the media pipeline is performed with t.app.inject (unauthenticated, token in URL);
 *  - the MOCK payment provider's call log is inspected to prove when the provider was (not) called.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createTestApp, createUser, call, day, enableFlags, idem, type TestApp, type TestUser } from './helpers.js';
import { allocate } from '../src/platform/money.js';
import type { MockProvider } from '../src/modules/payments/provider.js';

// ------------------------------------------------------------------------------------------------ fixtures

const PLATFORM_FEE_BPS = 500; // 5% buyer service fee (TRAVEL)
const TAX_BPS = 1000; // 10% VAT on the service fee
const COMMISSION_S1_BPS = 1500; // JETPOOL-MoR supplier commission
const COMMISSION_S2_BPS = 1000; // supplier-MoR commission

// product A (JETPOOL merchant of record)
const BASE_A = 90_000;
const HANBOK = 15_000;
const PHOTO = 25_000;
const D2_PRICE = 85_000;
const TERMS_A = {
  tiers: [
    { min_hours_before: 72, refund_pct: 100 },
    { min_hours_before: 24, refund_pct: 50 },
    { min_hours_before: 0, refund_pct: 0 },
  ],
  fee_refundable: false,
  note: 'Full refund up to 72h before departure, 50% up to 24h, none afterwards. Service fee is non-refundable.',
};

// main order: D1 × 2 seats + Hanbok option
const MAIN_SUBTOTAL = 2 * (BASE_A + HANBOK); // 210,000
const MAIN_PLATFORM_FEE = 10_500; // 5%
const MAIN_TAX = 1_050; // 10% of the fee
const MAIN_TOTAL = MAIN_SUBTOTAL + MAIN_PLATFORM_FEE + MAIN_TAX; // 221,550
const MAIN_COMMISSION = 31_500; // 15% of the supplier gross
const MAIN_PAYEE_NET = MAIN_SUBTOTAL - MAIN_COMMISSION; // 178,500
const MAIN_FEE_REVENUE = MAIN_PLATFORM_FEE + MAIN_COMMISSION; // 42,000
const MAIN_REFUND = 105_000; // 48–72h before departure → 50% of the subtotal, fee not refundable

// concurrency order: D2 × 1 seat
const D2_FEE = 4_250;
const D2_TAX = 425;
const D2_TOTAL = D2_PRICE + D2_FEE + D2_TAX; // 89,675
const D2_COMMISSION = 12_750;
const D2_PAYEE_NET = D2_PRICE - D2_COMMISSION; // 72,250

// product B (supplier merchant of record): 1 ticket
const BASE_B = 120_000;
const B_FEE = 6_000;
const B_TAX = 600;
const B_TOTAL = BASE_B + B_FEE + B_TAX; // 126,600
const B_COMMISSION = 12_000;
const B_PASS_THROUGH = BASE_B - B_COMMISSION; // 108,000

const PG = 'PLATFORM:PG_CLEARING:KRW';
const BANK = 'PLATFORM:BANK:KRW';
const FEE_REVENUE = 'PLATFORM:FEE_REVENUE:KRW';
const TAX_PAYABLE = 'PLATFORM:TAX_PAYABLE:KRW';
const payable = (userId: string) => `PAYEE:${userId}:PAYABLE:KRW`;
const passThrough = (userId: string) => `PASS_THROUGH:${userId}:KRW`;

const show = (r: { status: number; body: any }) => JSON.stringify(r.body);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString();
const shiftDate = (yyyyMmDd: string, n: number) => {
  const d = new Date(`${yyyyMmDd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const sha256hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

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
const pdf = (label: string) => Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(`% ${label}\n`), Buffer.alloc(256, 0x20), Buffer.from('\n%%EOF\n')]);

// ------------------------------------------------------------------------------------------------ state

let t: TestApp;
let provider: MockProvider;
let admin: TestUser; // ADMIN + COMPLIANCE, AAL2
let adminAal1: TestUser; // ADMIN at AAL1 (must be refused)
let acctA: TestUser; // ACCOUNTING maker
let acctB: TestUser; // ACCOUNTING checker
let s1: TestUser; // supplier, JETPOOL merchant of record
let s2: TestUser; // supplier, SUPPLIER merchant of record (AAL2 for payout account)
let buyer: TestUser;
let outsider: TestUser;
let host: TestUser;

let supplier1Id: string;
let supplier2Id: string;
let productA: string;
let productASlug: string;
let optHanbok: string;
let optPhoto: string;
let optRetired: string;
let d1: string; // main departure (~60h out, capacity 10, min 2)
let d1StartsAt: string;
let d2: string; // concurrency departure (10 days out, capacity 3, priced 85,000)
let propertyId: string;
let propertySlug: string;
let mainOrderId: string;
let mainPaymentId: string;
let mainPaymentKey: string;
let mainApprovalTx: any;
let mainRefundTx: any;
let concurrencyPaidOrder: string;
let concurrencyPaymentId: string;
let concurrencyPayer: TestUser;
let productB: string;
let d3: string;
let mborOrderId: string;
let mborPaymentId: string;
let settlementId: string;

// ------------------------------------------------------------------------------------------------ helpers

async function upload(user: TestUser, purpose: string, mimeType: string, bytes: Buffer) {
  const sha = sha256hex(bytes);
  const r = await call(t, user, 'POST', '/v1/media/upload-url', { purpose, mimeType, byteSize: bytes.length, sha256: sha });
  expect(r.status, show(r)).toBe(201);
  const u = new URL(r.body.upload.url);
  const put = await t.app.inject({ method: 'PUT', url: u.pathname + u.search, payload: bytes, headers: { 'content-type': mimeType } });
  expect(put.statusCode, put.body).toBe(200);
  const c = await call(t, user, 'POST', `/v1/media/${r.body.media.id}/complete`);
  expect(c.status, show(c)).toBe(200);
  expect(c.body.item.status).toBe('READY');
  return { ...c.body.item, sha256: sha } as { id: string; visibility: string; sha256: string };
}

async function getOrder(user: TestUser, id: string) {
  const r = await call(t, user, 'GET', `/v1/orders/${id}`);
  expect(r.status, show(r)).toBe(200);
  return r.body.item;
}

async function publicDepartures(productId: string) {
  const r = await call(t, null, 'GET', `/v1/travel-products/${productId}/departures`);
  expect(r.status, show(r)).toBe(200);
  const by = (id: string) => r.body.items.find((d: any) => d.id === id);
  return { items: r.body.items as any[], by };
}

async function order(user: TestUser, items: Array<{ departureId: string; qty: number; optionIds?: string[] }>, headers: Record<string, string> = idem()) {
  return call(t, user, 'POST', '/v1/orders', { items }, headers);
}

async function prepare(user: TestUser, orderId: string, headers: Record<string, string> = idem()) {
  return call(t, user, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: orderId }, headers);
}

async function confirm(user: TestUser, prep: { orderId: string; amount: number }, paymentKey = `mock_${randomUUID().replace(/-/g, '')}`, headers: Record<string, string> = idem()) {
  return call(t, user, 'POST', '/v1/payments/toss/confirm', { paymentKey, orderId: prep.orderId, amount: prep.amount }, headers);
}

async function payOrder(user: TestUser, orderId: string, expectedAmount: number) {
  const p = await prepare(user, orderId);
  expect(p.status, show(p)).toBe(201);
  expect(p.body).toMatchObject({ amount: expectedAmount, currency: 'KRW', provider: 'MOCK' });
  const paymentKey = `mock_${randomUUID().replace(/-/g, '')}`;
  const c = await confirm(user, p.body, paymentKey);
  expect(c.status, show(c)).toBe(200);
  expect(c.body.item).toMatchObject({ id: p.body.paymentId, status: 'APPROVED', amountMinor: expectedAmount, subjectType: 'ORDER', subjectId: orderId, paymentKey });
  return { paymentId: p.body.paymentId as string, paymentKey };
}

async function ledgerTx(sourceType: string, sourceId: string) {
  const r = await call(t, acctA, 'GET', `/v1/admin/ledger/transactions?sourceType=${sourceType}&sourceId=${sourceId}`);
  expect(r.status, show(r)).toBe(200);
  return r.body.items as Array<{ id: string; type: string; memo: string | null; reversesTransactionId: string | null; entries: Array<{ account: string; debitMinor: number; creditMinor: number; currency: string }> }>;
}

async function ledgerAccounts(ownerId?: string) {
  const r = await call(t, acctA, 'GET', `/v1/admin/ledger/accounts?currency=KRW${ownerId ? `&ownerId=${ownerId}` : ''}`);
  expect(r.status, show(r)).toBe(200);
  const by = (code: string) => r.body.items.find((a: any) => a.code === code);
  return { items: r.body.items as any[], by, balance: (code: string) => (by(code)?.balance_minor ?? 0) as number };
}

async function trialBalance() {
  const tb = await call(t, acctA, 'GET', '/v1/admin/ledger/trial-balance');
  expect(tb.status, show(tb)).toBe(200);
  return tb.body;
}

async function notifications(user: TestUser) {
  const r = await call(t, user, 'GET', '/v1/notifications?limit=100');
  expect(r.status, show(r)).toBe(200);
  return r.body.items as Array<{ templateKey: string; data: any }>;
}

async function auditActions(category: string) {
  const r = await call(t, admin, 'GET', `/v1/admin/audit-logs?category=${category}&limit=200`);
  expect(r.status, show(r)).toBe(200);
  return r.body.items as Array<{ action: string; resource_type: string; resource_id: string | null; category: string; correlation_id: string; actor_id: string | null }>;
}

const providerCalls = (op: string, pred: (args: any) => boolean = () => true) => provider.calls.filter((c) => c.op === op && pred(c.args));

// ------------------------------------------------------------------------------------------------ setup

beforeAll(async () => {
  t = await createTestApp();
  provider = t.app.ctx.adapters.get('payments.provider') as MockProvider;
  admin = await createUser(t, { roles: ['ADMIN', 'COMPLIANCE'], aal: 'aal2', displayName: 'Ops Admin' });
  adminAal1 = await createUser(t, { roles: ['ADMIN'], aal: 'aal1', displayName: 'Admin without MFA' });
  acctA = await createUser(t, { roles: ['ACCOUNTING'], aal: 'aal2', displayName: 'Accountant A' });
  acctB = await createUser(t, { roles: ['ACCOUNTING'], aal: 'aal2', displayName: 'Accountant B' });
  s1 = await createUser(t, { displayName: 'Seoul Heritage Tours owner' });
  s2 = await createUser(t, { aal: 'aal2', displayName: 'Han River Cruise owner' });
  buyer = await createUser(t, { displayName: 'Alex Buyer' });
  outsider = await createUser(t, { displayName: 'Outsider' });
  host = await createUser(t, { displayName: 'Minji Host' });
});
afterAll(async () => t?.close());

// ------------------------------------------------------------------------------------------------ chain

describe('G4 E2E — travel commerce chain (HTTP only)', () => {
  it('0. TRAVEL fee/tax rules are configured and approved through the API (maker-checker)', async () => {
    const effectiveFrom = new Date(Date.now() - 86_400_000).toISOString();
    for (const [ruleType, bps] of [['PLATFORM_FEE', PLATFORM_FEE_BPS], ['TAX', TAX_BPS]] as const) {
      const created = await call(t, acctA, 'POST', '/v1/finance/rules', { ruleType, domain: 'TRAVEL', jurisdiction: 'KR', params: { bps }, effectiveFrom, note: 'G9 travel fee approval' });
      expect(created.status, show(created)).toBe(201);
      expect(created.body.item).toMatchObject({ ruleType, domain: 'TRAVEL', status: 'DRAFT', createdBy: acctA.id });
      const self = await call(t, acctA, 'POST', `/v1/finance/rules/${created.body.item.id}/approve`);
      expect(self.status).toBe(403);
      expect(self.body.code).toBe('MAKER_CHECKER_VIOLATION');
      const ok = await call(t, acctB, 'POST', `/v1/finance/rules/${created.body.item.id}/approve`);
      expect(ok.status, show(ok)).toBe(200);
      expect(ok.body.item).toMatchObject({ status: 'APPROVED', approvedBy: acctB.id });
    }
    const fq = await call(t, acctA, 'GET', `/v1/finance/quote?domain=TRAVEL&amountMinor=${MAIN_SUBTOTAL}&currency=KRW`);
    expect(fq.status, show(fq)).toBe(200);
    expect(fq.body.item).toMatchObject({ platformFeeMinor: MAIN_PLATFORM_FEE, taxMinor: MAIN_TAX, hostFeeMinor: 0 });
  });

  it('1. supplier applies → admin approves with merchant of record JETPOOL and commission (SUPPLIER role granted)', async () => {
    expect((await call(t, s1, 'GET', '/v1/suppliers/me')).status).toBe(404);
    // the extranet is closed before approval
    const early = await call(t, s1, 'POST', '/v1/supplier/products', { type: 'TOUR', title: 'Too early' });
    expect(early.status).toBe(403);

    const apply = await call(t, s1, 'POST', '/v1/suppliers', { name: 'Seoul Heritage Tours', supplierType: 'TOUR_OPERATOR' });
    expect(apply.status, show(apply)).toBe(201);
    expect(apply.body.item).toMatchObject({ ownerUserId: s1.id, name: 'Seoul Heritage Tours', supplierType: 'TOUR_OPERATOR', status: 'PENDING' });
    supplier1Id = apply.body.item.id;
    const dup = await call(t, s1, 'POST', '/v1/suppliers', { name: 'Again', supplierType: 'TICKET' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('SUPPLIER_EXISTS');

    const queue = await call(t, admin, 'GET', '/v1/admin/suppliers?status=PENDING');
    expect(queue.status, show(queue)).toBe(200);
    expect(queue.body.items.map((s: any) => s.id)).toContain(supplier1Id);
    expect((await call(t, buyer, 'GET', '/v1/admin/suppliers')).status).toBe(403);

    const terms = { merchantOfRecord: 'JETPOOL', commissionBps: COMMISSION_S1_BPS, reason: 'G9 merchant-of-record approval MOR-2026-11' };
    const byBuyer = await call(t, buyer, 'POST', `/v1/admin/suppliers/${supplier1Id}/approve`, terms);
    expect(byBuyer.status).toBe(403);
    const byAal1 = await call(t, adminAal1, 'POST', `/v1/admin/suppliers/${supplier1Id}/approve`, terms);
    expect(byAal1.status).toBe(403);
    expect(byAal1.body.code).toBe('AAL2_REQUIRED');
    const badBps = await call(t, admin, 'POST', `/v1/admin/suppliers/${supplier1Id}/approve`, { ...terms, commissionBps: 10_001 });
    expect(badBps.status).toBe(400);

    const ok = await call(t, admin, 'POST', `/v1/admin/suppliers/${supplier1Id}/approve`, terms);
    expect(ok.status, show(ok)).toBe(200);
    expect(ok.body.item).toMatchObject({ id: supplier1Id, status: 'APPROVED', merchantOfRecord: 'JETPOOL', commissionBps: COMMISSION_S1_BPS });
    const again = await call(t, admin, 'POST', `/v1/admin/suppliers/${supplier1Id}/approve`, terms);
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('INVALID_STATE_TRANSITION');

    const me = await call(t, s1, 'GET', '/v1/suppliers/me');
    expect(me.status, show(me)).toBe(200);
    expect(me.body.item).toMatchObject({ id: supplier1Id, status: 'APPROVED', merchantOfRecord: 'JETPOOL', commissionBps: COMMISSION_S1_BPS });
    const who = await call(t, s1, 'GET', '/v1/me');
    expect(who.status).toBe(200);
    expect(who.body.user.roles).toContain('SUPPLIER');
  });

  it('2. supplier creates a product with options + departures → submits → admin publishes', async () => {
    const created = await call(t, s1, 'POST', '/v1/supplier/products', {
      type: 'TOUR',
      title: 'Gyeongbokgung Hanbok Night Tour',
      summary: 'Evening palace walk in hanbok with a licensed guide',
      description: 'Meet at Gwanghwamun, walk the palace grounds after sunset and finish with tea in Bukchon.',
      city: 'Seoul',
      country: 'KR',
      durationMinutes: 180,
      basePriceMinor: BASE_A,
      currency: 'KRW',
      cancellationTerms: TERMS_A,
      options: [
        { name: 'Hanbok rental', priceMinor: HANBOK },
        { name: 'Palace photo pack', priceMinor: PHOTO },
      ],
    });
    expect(created.status, show(created)).toBe(201);
    const p = created.body.item;
    productA = p.id;
    expect(p).toMatchObject({ supplierId: supplier1Id, type: 'TOUR', status: 'DRAFT', basePriceMinor: BASE_A, currency: 'KRW', city: 'Seoul', country: 'KR', durationMinutes: 180, slug: null });
    expect(p.cancellationTerms).toEqual(TERMS_A);
    expect(p.options.map((o: any) => [o.name, o.priceMinor, o.active])).toEqual([
      ['Hanbok rental', HANBOK, true],
      ['Palace photo pack', PHOTO, true],
    ]);
    optHanbok = p.options.find((o: any) => o.name === 'Hanbok rental').id;
    optPhoto = p.options.find((o: any) => o.name === 'Palace photo pack').id;

    // options are upserted; a retired option is kept inactive (orders may reference options)
    const patched = await call(t, s1, 'PATCH', `/v1/supplier/products/${productA}`, {
      options: [
        { id: optHanbok, name: 'Hanbok rental', priceMinor: HANBOK },
        { id: optPhoto, name: 'Palace photo pack', priceMinor: PHOTO },
        { name: 'Lantern (retired)', priceMinor: 5_000, active: false },
      ],
    });
    expect(patched.status, show(patched)).toBe(200);
    expect(patched.body.item.options).toHaveLength(3);
    optRetired = patched.body.item.options.find((o: any) => o.name === 'Lantern (retired)').id;
    expect(patched.body.item.options.find((o: any) => o.id === optRetired).active).toBe(false);

    // only the owning approved supplier can edit / add departures
    expect((await call(t, buyer, 'PATCH', `/v1/supplier/products/${productA}`, { title: 'Hijacked' })).status).toBe(403);
    expect((await call(t, buyer, 'POST', `/v1/travel-products/${productA}/departures`, { startsAt: isoIn(48 * 3600_000), capacity: 3 })).status).toBe(403);

    // departure validation
    const past = await call(t, s1, 'POST', `/v1/travel-products/${productA}/departures`, { startsAt: isoIn(-3600_000), capacity: 5 });
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('DEPARTURE_IN_PAST');
    const minTooHigh = await call(t, s1, 'POST', `/v1/travel-products/${productA}/departures`, { startsAt: isoIn(48 * 3600_000), capacity: 2, minParticipants: 3 });
    expect(minTooHigh.status).toBe(400);

    d1StartsAt = isoIn(60 * 3600_000);
    const dep1 = await call(t, s1, 'POST', `/v1/travel-products/${productA}/departures`, { startsAt: d1StartsAt, capacity: 10, minParticipants: 2 });
    expect(dep1.status, show(dep1)).toBe(201);
    expect(dep1.body.item).toMatchObject({ productId: productA, capacity: 10, booked: 0, remaining: 10, minParticipants: 2, priceMinor: null, status: 'OPEN', guaranteed: false });
    d1 = dep1.body.item.id;
    const dep2 = await call(t, s1, 'POST', `/v1/travel-products/${productA}/departures`, { startsAt: isoIn(10 * 86_400_000), capacity: 3, priceMinor: D2_PRICE });
    expect(dep2.status, show(dep2)).toBe(201);
    expect(dep2.body.item).toMatchObject({ capacity: 3, remaining: 3, minParticipants: 1, priceMinor: D2_PRICE, status: 'OPEN' });
    d2 = dep2.body.item.id;

    // drafts are invisible to the public, visible to the owner
    expect((await call(t, null, 'GET', `/v1/travel-products/${productA}`)).status).toBe(404);
    expect((await call(t, buyer, 'GET', `/v1/travel-products/${productA}/departures`)).status).toBe(404);
    expect((await call(t, s1, 'GET', `/v1/travel-products/${productA}`)).status).toBe(200);
    const notListed = await call(t, null, 'GET', '/v1/travel-products?city=Seoul');
    expect(notListed.body.items.map((x: any) => x.id)).not.toContain(productA);

    // review workflow: DRAFT → IN_REVIEW → PUBLISHED (admin only)
    const tooEarly = await call(t, admin, 'POST', `/v1/admin/travel-products/${productA}/publish`, {});
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.code).toBe('INVALID_STATE_TRANSITION');
    const sub = await call(t, s1, 'POST', `/v1/supplier/products/${productA}/submit`);
    expect(sub.status, show(sub)).toBe(200);
    expect(sub.body.item.status).toBe('IN_REVIEW');
    const reviewQ = await call(t, admin, 'GET', '/v1/admin/travel-products?status=IN_REVIEW');
    expect(reviewQ.status).toBe(200);
    expect(reviewQ.body.items.find((x: any) => x.id === productA)?.seller).toMatchObject({ supplierId: supplier1Id, name: 'Seoul Heritage Tours', merchantOfRecord: 'JETPOOL' });
    expect((await call(t, s1, 'POST', `/v1/admin/travel-products/${productA}/publish`, {})).status).toBe(403);
    expect((await call(t, adminAal1, 'POST', `/v1/admin/travel-products/${productA}/publish`, {})).body.code).toBe('AAL2_REQUIRED');

    const pub = await call(t, admin, 'POST', `/v1/admin/travel-products/${productA}/publish`, { note: 'content and terms reviewed' });
    expect(pub.status, show(pub)).toBe(200);
    expect(pub.body.item.status).toBe('PUBLISHED');
    expect(pub.body.item.slug).toMatch(/^gyeongbokgung-hanbok-night-tour-[0-9a-f]{8}$/);
    productASlug = pub.body.item.slug;
    const twice = await call(t, admin, 'POST', `/v1/admin/travel-products/${productA}/publish`, {});
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('3. the public catalog lists it with seller and merchant-of-record role; detail shows active options + departures', async () => {
    const list = await call(t, null, 'GET', '/v1/travel-products?city=Seoul&type=TOUR');
    expect(list.status, show(list)).toBe(200);
    const card = list.body.items.find((x: any) => x.id === productA);
    expect(card, 'published product must be listed').toBeTruthy();
    expect(card).toMatchObject({
      status: 'PUBLISHED',
      slug: productASlug,
      title: 'Gyeongbokgung Hanbok Night Tour',
      basePriceMinor: BASE_A,
      fromPriceMinor: D2_PRICE, // cheapest open future departure
      currency: 'KRW',
      seller: { supplierId: supplier1Id, name: 'Seoul Heritage Tours', merchantOfRecord: 'JETPOOL' },
    });
    expect(JSON.stringify(card)).not.toContain(s1.id); // supplier owner identity is not public
    expect(JSON.stringify(card)).not.toContain('commission');

    const ids = async (qs: string) => (await call(t, null, 'GET', `/v1/travel-products?${qs}`)).body.items.map((x: any) => x.id);
    expect(await ids('q=hanbok')).toContain(productA);
    expect(await ids('q=helicopter')).not.toContain(productA);
    expect(await ids('type=TICKET')).not.toContain(productA);
    const dDay = d1StartsAt.slice(0, 10);
    expect(await ids(`from=${shiftDate(dDay, -1)}&to=${shiftDate(dDay, 1)}`)).toContain(productA);
    expect(await ids(`from=${day(40)}&to=${day(45)}`)).not.toContain(productA);

    const detail = await call(t, null, 'GET', `/v1/travel-products/${productA}`);
    expect(detail.status, show(detail)).toBe(200);
    const d = detail.body.item;
    expect(d.seller).toEqual({ supplierId: supplier1Id, name: 'Seoul Heritage Tours', merchantOfRecord: 'JETPOOL' });
    expect(d.cancellationTerms).toEqual(TERMS_A);
    expect(d.options.map((o: any) => o.id).sort()).toEqual([optHanbok, optPhoto].sort()); // retired option hidden
    expect(d.departures.map((x: any) => [x.id, x.capacity, x.remaining, x.minParticipants, x.status])).toEqual([
      [d1, 10, 10, 2, 'OPEN'],
      [d2, 3, 3, 1, 'OPEN'],
    ]);
    expect(JSON.stringify(d)).not.toContain(s1.id);

    const deps = await publicDepartures(productA);
    expect(deps.items.map((x: any) => x.id)).toEqual([d1, d2]);
  });

  it('4. a published stay exists (host onboarding through the API) for the itinerary', async () => {
    const app = await call(t, host, 'POST', '/v1/host-applications', { displayName: 'Minji', about: 'Hosting a quiet riverside flat in Mapo since 2019.' });
    expect(app.status, show(app)).toBe(201);
    const doc = await upload(host, 'VERIFICATION', 'application/pdf', pdf('host business registration'));
    const vc = await call(t, host, 'POST', '/v1/verifications', { subjectType: 'HOST', documents: [{ documentType: 'BUSINESS_REGISTRATION', mediaId: doc.id, sha256: doc.sha256 }] });
    expect(vc.status, show(vc)).toBe(201);
    expect((await call(t, admin, 'POST', `/v1/admin/verifications/${vc.body.item.id}/start-review`)).status).toBe(200);
    const va = await call(t, admin, 'POST', `/v1/admin/verifications/${vc.body.item.id}/approve`, { reason: 'documents match' });
    expect(va.status, show(va)).toBe(200);
    const ok = await call(t, admin, 'POST', `/v1/admin/host-applications/${app.body.item.id}/approve`, { reason: 'checklist complete' });
    expect(ok.status, show(ok)).toBe(200);

    const draft = await call(t, host, 'POST', '/v1/properties', {
      title: 'Hangang View Apartment Mapo',
      description: 'A bright two-bedroom apartment overlooking the Han river, five minutes from Mapo station, with a full kitchen.',
      propertyType: 'APARTMENT',
      roomType: 'ENTIRE',
      maxGuests: 4,
      bedrooms: 2,
      beds: 2,
      bathrooms: 1,
      lat: 37.5446,
      lng: 126.9496,
      country: 'KR',
      region: 'KR-11',
      city: 'Seoul',
      timezone: 'Asia/Seoul',
      // rental + exchange: publishes (exchange-only) without a stay compliance rule — paid-stay compliance is e2e-stay's scope
      rentalEnabled: true,
      exchangeEnabled: true,
      basePriceMinor: 120_000,
      currency: 'KRW',
      address: { line1: 'Mapo-daero 123, Unit 1502', postalCode: '04100', city: 'Seoul', region: 'KR-11', country: 'KR', publicAreaLabel: 'Mapo-gu' },
    });
    expect(draft.status, show(draft)).toBe(201);
    propertyId = draft.body.item.id;
    propertySlug = draft.body.item.slug;
    const photos = [];
    for (const [w, h] of [[1600, 1067], [1200, 800], [1024, 768]]) photos.push(await upload(host, 'PROPERTY', 'image/png', png(w, h)));
    const att = await call(t, host, 'PUT', `/v1/properties/${propertyId}/media`, { items: photos.map((m, i) => ({ mediaId: m.id, caption: `photo ${i + 1}` })) });
    expect(att.status, show(att)).toBe(200);
    const pub = await call(t, host, 'POST', `/v1/properties/${propertyId}/publish`);
    expect(pub.status, show(pub)).toBe(200);
    expect(pub.body.item.status).toBe('PUBLISHED');
    expect((await call(t, null, 'GET', `/v1/properties/by-slug/${propertySlug}`)).status).toBe(200);
  });

  it('5. orders are gated by travel.commerce; buyer creates an order (Idempotency-Key) for 2 seats, totals server-side', async () => {
    const off = await order(buyer, [{ departureId: d1, qty: 2 }]);
    expect(off.status).toBe(403);
    expect(off.body.code).toBe('FEATURE_DISABLED');
    expect((await publicDepartures(productA)).by(d1).booked).toBe(0);

    await enableFlags(t, 'travel.commerce');

    const noKey = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: d1, qty: 2 }] });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const self = await order(s1, [{ departureId: d1, qty: 1 }]);
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_PURCHASE');
    const retired = await order(buyer, [{ departureId: d1, qty: 1, optionIds: [optRetired] }]);
    expect(retired.status).toBe(400);
    expect(retired.body.code).toBe('INVALID_OPTION');
    const tooMany = await order(buyer, [{ departureId: d1, qty: 11 }]);
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.code).toBe('SOLD_OUT');
    const dupDep = await order(buyer, [{ departureId: d1, qty: 1 }, { departureId: d1, qty: 1 }]);
    expect(dupDep.status).toBe(400);
    expect(dupDep.body.code).toBe('DUPLICATE_DEPARTURE');
    expect((await publicDepartures(productA)).by(d1).booked).toBe(0); // failed attempts reserve nothing

    const key = idem();
    // a client-sent total is never authoritative
    const body = { items: [{ departureId: d1, qty: 2, optionIds: [optHanbok] }], totalMinor: 1, subtotalMinor: 1 };
    const created = await call(t, buyer, 'POST', '/v1/orders', body, key);
    expect(created.status, show(created)).toBe(201);
    const o = created.body.item;
    mainOrderId = o.id;
    expect(o).toMatchObject({
      buyerId: buyer.id,
      status: 'PENDING',
      currency: 'KRW',
      subtotalMinor: MAIN_SUBTOTAL,
      feeMinor: MAIN_PLATFORM_FEE + MAIN_TAX,
      totalMinor: MAIN_TOTAL,
      refundedMinor: 0,
      merchantOfRecord: 'JETPOOL',
      fulfilledAt: null,
      cancelledAt: null,
    });
    expect(o.code).toBeTruthy();
    const ttl = new Date(o.expiresAt).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(10 * 60_000);
    expect(ttl).toBeLessThanOrEqual(15 * 60_000);
    expect(o.items.map((i: any) => [i.sellableType, i.sellableId, i.supplierId, i.qty, i.unitPriceMinor, i.amountMinor, i.status, i.vouchers])).toEqual(
      expect.arrayContaining([
        ['TRAVEL_DEPARTURE', d1, supplier1Id, 2, BASE_A, 2 * BASE_A, 'ACTIVE', []],
        ['TRAVEL_OPTION', optHanbok, supplier1Id, 2, HANBOK, 2 * HANBOK, 'ACTIVE', []],
      ]),
    );
    expect(o.items).toHaveLength(2);
    expect(o.items.reduce((a: number, i: any) => a + i.amountMinor, 0)).toBe(MAIN_SUBTOTAL);
    expect(o.pricing).toMatchObject({ subtotalMinor: MAIN_SUBTOTAL, platformFeeMinor: MAIN_PLATFORM_FEE, taxMinor: MAIN_TAX, totalMinor: MAIN_TOTAL });
    expect(Object.keys(o.pricing.rulesVersion).sort()).toEqual(['PLATFORM_FEE', 'TAX']);
    expect(o.pricing.cancellationTerms[productA]).toEqual(TERMS_A); // terms snapshotted at purchase
    // the internal settlement split (supplier owner id, G9 commission terms) is not part of the buyer view
    expect(o.pricing.suppliers).toBeUndefined();
    expect(JSON.stringify(o)).not.toContain(s1.id);
    expect(JSON.stringify(o)).not.toContain('commission');

    const replay = await call(t, buyer, 'POST', '/v1/orders', body, key);
    expect(replay.status).toBe(201);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.item.id).toBe(mainOrderId);
    const reused = await call(t, buyer, 'POST', '/v1/orders', { items: [{ departureId: d1, qty: 1 }] }, key);
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    const dep = (await publicDepartures(productA)).by(d1);
    expect(dep).toMatchObject({ booked: 2, remaining: 8 }); // the replay reserved nothing more

    expect((await call(t, outsider, 'GET', `/v1/orders/${mainOrderId}`)).status).toBe(404);
    expect((await getOrder(s1, mainOrderId)).id).toBe(mainOrderId); // the selling supplier may read it
    const mine = await call(t, buyer, 'GET', '/v1/orders');
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((x: any) => x.id)).toEqual([mainOrderId]);
    expect((await call(t, outsider, 'GET', '/v1/orders')).body.items).toEqual([]);
  });

  it('6. payments prepare (ORDER) → MOCK confirm → order PAID with vouchers; ledger posting', async () => {
    const stranger = await prepare(outsider, mainOrderId);
    expect(stranger.status).toBe(403);
    expect(stranger.body.code).toBe('NOT_PAYER');
    expect((await call(t, buyer, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: mainOrderId })).status).toBe(400);

    const key = idem();
    const prep = await prepare(buyer, mainOrderId, key);
    expect(prep.status, show(prep)).toBe(201);
    expect(prep.body).toMatchObject({ amount: MAIN_TOTAL, currency: 'KRW', provider: 'MOCK', orderName: 'Gyeongbokgung Hanbok Night Tour' });
    mainPaymentId = prep.body.paymentId;
    const prepReplay = await prepare(buyer, mainOrderId, key);
    expect(prepReplay.status).toBe(201);
    expect(prepReplay.headers['idempotent-replayed']).toBe('true');
    expect(prepReplay.body.paymentId).toBe(mainPaymentId);
    expect((await getOrder(buyer, mainOrderId)).status).toBe('PAYMENT_PENDING');

    // the client amount is never authoritative: a mismatch is refused before the PG is called
    const wrong = await confirm(buyer, { orderId: prep.body.orderId, amount: MAIN_TOTAL - 1 });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('AMOUNT_MISMATCH');
    expect(providerCalls('confirm', (a) => a.orderId === prep.body.orderId)).toHaveLength(0);
    expect((await getOrder(buyer, mainOrderId)).status).toBe('PAYMENT_PENDING');

    mainPaymentKey = `mock_${randomUUID().replace(/-/g, '')}`;
    const ckey = idem();
    const c = await confirm(buyer, prep.body, mainPaymentKey, ckey);
    expect(c.status, show(c)).toBe(200);
    expect(c.body.item).toMatchObject({ id: mainPaymentId, status: 'APPROVED', amountMinor: MAIN_TOTAL, currency: 'KRW', subjectType: 'ORDER', subjectId: mainOrderId, paymentKey: mainPaymentKey });
    const again = await confirm(buyer, prep.body, mainPaymentKey, ckey);
    expect(again.status).toBe(200);
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(providerCalls('confirm', (a) => a.orderId === prep.body.orderId)).toHaveLength(1);

    const paid = await getOrder(buyer, mainOrderId);
    expect(paid).toMatchObject({ status: 'PAID', totalMinor: MAIN_TOTAL, refundedMinor: 0, expiresAt: null });
    const depLine = paid.items.find((i: any) => i.sellableType === 'TRAVEL_DEPARTURE');
    const optLine = paid.items.find((i: any) => i.sellableType === 'TRAVEL_OPTION');
    expect(depLine.vouchers).toHaveLength(2); // one voucher per seat
    expect(depLine.vouchers.every((v: any) => v.status === 'ISSUED' && /^TV[0-9A-F]{12}$/.test(v.code))).toBe(true);
    expect(new Set(depLine.vouchers.map((v: any) => v.code)).size).toBe(2);
    expect(optLine.vouchers).toEqual([]);

    const repay = await prepare(buyer, mainOrderId);
    expect(repay.status).toBe(409);
    expect(repay.body.code).toBe('ORDER_NOT_PAYABLE');

    const pay = await call(t, buyer, 'GET', `/v1/payments/${mainPaymentId}`);
    expect(pay.status).toBe(200);
    expect(pay.body.item).toMatchObject({ status: 'APPROVED', refundedMinor: 0, refundableMinor: MAIN_TOTAL, refunds: [], method: 'CARD' });
    expect((await call(t, outsider, 'GET', `/v1/payments/${mainPaymentId}`)).status).toBe(404);
    const rc = await call(t, buyer, 'GET', '/v1/receipts');
    expect(rc.body.items.filter((x: any) => x.paymentId === mainPaymentId)).toEqual([expect.objectContaining({ receiptType: 'PAYMENT', amountMinor: MAIN_TOTAL, currency: 'KRW' })]);

    const so = await call(t, s1, 'GET', '/v1/supplier/orders');
    expect(so.status, show(so)).toBe(200);
    const sOrder = so.body.items.find((x: any) => x.id === mainOrderId);
    expect(sOrder).toMatchObject({ status: 'PAID', totalMinor: MAIN_TOTAL, buyerId: buyer.id });
    expect(sOrder.items.every((i: any) => i.supplierId === supplier1Id)).toBe(true);
    expect(sOrder.pricing.suppliers).toEqual([expect.objectContaining({ supplierId: supplier1Id, grossMinor: MAIN_SUBTOTAL, commissionMinor: MAIN_COMMISSION })]); // own entry only
    expect((await call(t, buyer, 'GET', '/v1/supplier/orders')).status).toBe(403);

    await t.drain();
    expect((await notifications(buyer)).find((n) => n.templateKey === 'order.paid')?.data).toMatchObject({ orderId: mainOrderId });
    expect((await notifications(buyer)).map((n) => n.templateKey)).toContain('payment.approved');
    expect((await notifications(s1)).find((n) => n.templateKey === 'supplier.order.paid')?.data).toMatchObject({ orderId: mainOrderId });

    // ledger: Dr PG clearing total / Cr supplier payable (gross − commission) / Cr VAT / Cr fee revenue (fee + commission)
    const txs = await ledgerTx('PAYMENT', mainPaymentId);
    expect(txs).toHaveLength(1);
    mainApprovalTx = txs[0];
    expect(mainApprovalTx).toMatchObject({ type: 'PAYMENT_APPROVED', memo: 'merchant_of_record=JETPOOL' });
    const entry = (a: string) => mainApprovalTx.entries.find((e: any) => e.account === a);
    expect(mainApprovalTx.entries).toHaveLength(4);
    expect(entry(PG)).toMatchObject({ debitMinor: MAIN_TOTAL, creditMinor: 0 });
    expect(entry(payable(s1.id))).toMatchObject({ debitMinor: 0, creditMinor: MAIN_PAYEE_NET });
    expect(entry(TAX_PAYABLE)).toMatchObject({ debitMinor: 0, creditMinor: MAIN_TAX });
    expect(entry(FEE_REVENUE)).toMatchObject({ debitMinor: 0, creditMinor: MAIN_FEE_REVENUE });
    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
  });

  it('7. itinerary is built with the travel product + the stay (versioned, private)', async () => {
    const dDay = d1StartsAt.slice(0, 10);
    const created = await call(t, buyer, 'POST', '/v1/itineraries', { title: 'Seoul long weekend', startDate: shiftDate(dDay, -1), endDate: shiftDate(dDay, 1) });
    expect(created.status, show(created)).toBe(201);
    const itId = created.body.item.id as string;
    expect(created.body.item).toMatchObject({ ownerId: buyer.id, title: 'Seoul long weekend', startDate: shiftDate(dDay, -1), endDate: shiftDate(dDay, 1), visibility: 'PRIVATE', version: 1, items: [] });

    const add = (item: Record<string, unknown>, user: TestUser = buyer) => call(t, user, 'POST', `/v1/itineraries/${itId}/items`, item);
    const stay = await add({ dayIndex: 0, itemType: 'STAY', refId: propertyId, title: 'Hangang View Apartment Mapo', startTime: '15:00', note: 'check-in' });
    expect(stay.status, show(stay)).toBe(201);
    expect(stay.body.item.version).toBe(2);
    const tour = await add({ dayIndex: 1, itemType: 'TRAVEL_PRODUCT', refId: productA, title: 'Gyeongbokgung Hanbok Night Tour', startTime: '19:00', endTime: '22:00' });
    expect(tour.status, show(tour)).toBe(201);
    const note = await add({ dayIndex: 1, itemType: 'NOTE', title: 'Dinner in Insadong' });
    expect(note.status, show(note)).toBe(201);
    expect(note.body.item.version).toBe(4);

    // references are validated against the owning domains
    const noRef = await add({ dayIndex: 1, itemType: 'TRAVEL_PRODUCT', title: 'Ghost tour' });
    expect(noRef.status).toBe(400);
    expect(noRef.body.code).toBe('REF_REQUIRED');
    const badProduct = await add({ dayIndex: 1, itemType: 'TRAVEL_PRODUCT', refId: randomUUID(), title: 'Ghost tour' });
    expect(badProduct.status).toBe(400);
    expect(badProduct.body.code).toBe('REF_NOT_FOUND');
    const badStay = await add({ dayIndex: 0, itemType: 'STAY', refId: randomUUID(), title: 'Ghost flat' });
    expect(badStay.status).toBe(400);
    expect(badStay.body.code).toBe('REF_NOT_FOUND');

    // private: other users can neither read nor write it
    expect((await call(t, outsider, 'GET', `/v1/itineraries/${itId}`)).status).toBe(404);
    expect((await add({ dayIndex: 0, itemType: 'NOTE', title: 'spam' }, outsider)).status).toBe(404);

    const stale = await call(t, buyer, 'PATCH', `/v1/itineraries/${itId}`, { title: 'Renamed', version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');

    const cur = (await call(t, buyer, 'GET', `/v1/itineraries/${itId}`)).body.item;
    const tourItem = cur.items.find((i: any) => i.itemType === 'TRAVEL_PRODUCT');
    const noteItem = cur.items.find((i: any) => i.itemType === 'NOTE');
    const re = await call(t, buyer, 'POST', `/v1/itineraries/${itId}/items/reorder`, { items: [{ id: noteItem.id, dayIndex: 1, sortOrder: 0 }, { id: tourItem.id, dayIndex: 1, sortOrder: 1 }] });
    expect(re.status, show(re)).toBe(200);
    expect(re.body.item.version).toBe(5);
    const fin = await call(t, buyer, 'GET', `/v1/itineraries/${itId}`);
    expect(fin.status).toBe(200);
    expect(fin.body.item.items.map((i: any) => [i.dayIndex, i.sortOrder, i.itemType, i.refId])).toEqual([
      [0, 0, 'STAY', propertyId],
      [1, 0, 'NOTE', null],
      [1, 1, 'TRAVEL_PRODUCT', productA],
    ]);
    expect(fin.body.item.items.find((i: any) => i.itemType === 'TRAVEL_PRODUCT')).toMatchObject({ startTime: expect.stringMatching(/^19:00/), endTime: expect.stringMatching(/^22:00/) });
    const lst = await call(t, buyer, 'GET', '/v1/itineraries');
    expect(lst.body.items.map((i: any) => i.id)).toEqual([itId]);
  });

  it('8. buyer cancels per the cancellation terms → refund executed via the outbox → compensating ledger entries', async () => {
    expect((await call(t, outsider, 'POST', `/v1/orders/${mainOrderId}/cancel`, { reason: 'not mine' }, idem())).status).toBe(404);
    const noKey = await call(t, buyer, 'POST', `/v1/orders/${mainOrderId}/cancel`, { reason: 'Family emergency' });
    expect(noKey.status).toBe(400);
    expect(noKey.body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const key = idem();
    const cx = await call(t, buyer, 'POST', `/v1/orders/${mainOrderId}/cancel`, { reason: 'Family emergency' }, key);
    expect(cx.status, show(cx)).toBe(200);
    expect(cx.body.item.status).toBe('CANCELLED');
    expect(cx.body.item.cancelledAt).toBeTruthy();
    // ~60h before departure → 50% tier on the subtotal; the service fee is non-refundable per the terms
    expect(cx.body.refund).toMatchObject({ status: 'REQUESTED', amountMinor: MAIN_REFUND });
    const refundId = cx.body.refund.refundId as string;
    expect(refundId).toBeTruthy();
    const replay = await call(t, buyer, 'POST', `/v1/orders/${mainOrderId}/cancel`, { reason: 'Family emergency' }, key);
    expect(replay.status).toBe(200);
    expect(replay.body.refund.refundId).toBe(refundId);

    // seats released and vouchers voided immediately
    const cancelled = await getOrder(buyer, mainOrderId);
    expect(cancelled.items.every((i: any) => i.status === 'CANCELLED')).toBe(true);
    expect(cancelled.items.find((i: any) => i.sellableType === 'TRAVEL_DEPARTURE').vouchers.map((v: any) => v.status)).toEqual(['VOID', 'VOID']);
    expect((await publicDepartures(productA)).by(d1)).toMatchObject({ booked: 0, remaining: 10 });

    // the refund intent is recorded; the provider cancel runs asynchronously through the outbox
    const pending = await call(t, buyer, 'GET', `/v1/payments/${mainPaymentId}`);
    expect(pending.body.item.status).toBe('APPROVED');
    expect(pending.body.item.refunds).toEqual([expect.objectContaining({ id: refundId, amountMinor: MAIN_REFUND, status: 'REQUESTED' })]);
    expect(pending.body.item.refundableMinor).toBe(MAIN_TOTAL - MAIN_REFUND);
    expect(providerCalls('cancel', (a) => a.paymentKey === mainPaymentKey)).toHaveLength(0);
    expect(await ledgerTx('REFUND', refundId)).toEqual([]);

    await t.drain();

    expect(providerCalls('cancel', (a) => a.paymentKey === mainPaymentKey).map((c) => (c.args as any).cancelAmount)).toEqual([MAIN_REFUND]);
    expect(provider.payments.get(mainPaymentKey)).toMatchObject({ status: 'PARTIAL_CANCELED', balanceAmount: MAIN_TOTAL - MAIN_REFUND });
    const pay = await call(t, buyer, 'GET', `/v1/payments/${mainPaymentId}`);
    expect(pay.body.item).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedMinor: MAIN_REFUND, refundableMinor: MAIN_TOTAL - MAIN_REFUND });
    expect(pay.body.item.refunds).toEqual([expect.objectContaining({ id: refundId, amountMinor: MAIN_REFUND, status: 'PARTIAL', currency: 'KRW' })]);
    const after = await getOrder(buyer, mainOrderId);
    expect(after).toMatchObject({ status: 'CANCELLED', refundedMinor: MAIN_REFUND, totalMinor: MAIN_TOTAL });

    // compensating entries for exactly the components the terms refunded; balanced; nothing mutated.
    // 50% of the supplier subtotal is returned → the supplier payable and the commission on the refunded gross are
    // reversed pro rata to the approval split; the non-refundable service fee keeps its fee revenue and output VAT.
    const rev = await ledgerTx('REFUND', refundId);
    expect(rev).toHaveLength(1);
    mainRefundTx = rev[0];
    expect(mainRefundTx).toMatchObject({ type: 'REFUND', reversesTransactionId: mainApprovalTx.id });
    const [refundedPayee, refundedCommission] = allocate(MAIN_REFUND, [MAIN_PAYEE_NET, MAIN_COMMISSION]);
    expect([refundedPayee, refundedCommission]).toEqual([MAIN_PAYEE_NET / 2, MAIN_COMMISSION / 2]);
    expect(mainRefundTx.entries.map((e: any) => [e.account, e.debitMinor, e.creditMinor]).sort()).toEqual([
      [payable(s1.id), refundedPayee, 0],
      [PG, 0, MAIN_REFUND],
      [FEE_REVENUE, refundedCommission, 0],
    ].sort());
    expect(mainRefundTx.entries.find((x: any) => x.account === TAX_PAYABLE), 'VAT on the non-refundable fee is not reversed').toBeUndefined();
    expect(mainRefundTx.entries.reduce((a: number, e: any) => a + e.debitMinor, 0)).toBe(MAIN_REFUND);
    expect(mainRefundTx.entries.reduce((a: number, e: any) => a + e.creditMinor, 0)).toBe(MAIN_REFUND);
    expect(await ledgerTx('PAYMENT', mainPaymentId)).toEqual([mainApprovalTx]); // append-only
    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
    expect(tb.unbalancedTransactionIds).toEqual([]);

    const rcp = await call(t, buyer, 'GET', '/v1/receipts');
    expect(rcp.body.items.filter((x: any) => x.paymentId === mainPaymentId).map((x: any) => [x.receiptType, x.amountMinor]).sort()).toEqual([['PAYMENT', MAIN_TOTAL], ['REFUND', MAIN_REFUND]]);
    const keys = (await notifications(buyer)).map((n) => n.templateKey);
    expect(keys).toEqual(expect.arrayContaining(['order.cancelled', 'payment.refunded']));
    const money = await auditActions('MONEY');
    expect(money).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'refund.requested', resource_id: mainPaymentId }),
      expect.objectContaining({ action: 'refund.completed', resource_id: mainPaymentId }),
    ]));

    const twice = await call(t, buyer, 'POST', `/v1/orders/${mainOrderId}/cancel`, { reason: 'again' }, idem());
    expect(twice.status).toBe(409);
    expect(twice.body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await call(t, buyer, 'GET', `/v1/payments/${mainPaymentId}`)).body.item.refunds).toHaveLength(1);

    // permission-negative on replay: another user presenting the buyer's Idempotency-Key must not receive the
    // buyer's stored cancellation (order, vouchers, refund) — authorization is checked on every request
    const foreign = await call(t, outsider, 'POST', `/v1/orders/${mainOrderId}/cancel`, { reason: 'Family emergency' }, key);
    expect(foreign.status, `foreign replay leaked the buyer's response: ${show(foreign)}`).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain(buyer.id);
  });

  it('9. concurrency: capacity 3, 6 parallel 1-seat orders → exactly 3; unpaid orders expire via jobs and release seats', async () => {
    const buyers = await Promise.all(Array.from({ length: 6 }, (_, i) => createUser(t, { displayName: `Racer ${i}` })));
    const late = await createUser(t, { displayName: 'Late buyer' });
    const cfg = t.app.ctx.config as any;
    const ttl = cfg.HOLD_TTL_SEC;
    let results: Array<{ status: number; body: any }>;
    cfg.HOLD_TTL_SEC = 5; // test-setup: short payment window for the orders of this scenario only (no time-travel API)
    try {
      results = await Promise.all(buyers.map((u) => order(u, [{ departureId: d2, qty: 1 }])));
    } finally {
      cfg.HOLD_TTL_SEC = ttl;
    }
    const won = results.map((r, i) => ({ r, u: buyers[i] })).filter((x) => x.r.status === 201);
    const lost = results.filter((r) => r.status !== 201);
    expect(won, results.map(show).join('\n')).toHaveLength(3);
    expect(lost).toHaveLength(3);
    expect(lost.every((r) => r.status === 409 && r.body.code === 'SOLD_OUT'), lost.map(show).join('\n')).toBe(true);
    for (const { r } of won) {
      expect(r.body.item).toMatchObject({ status: 'PENDING', subtotalMinor: D2_PRICE, feeMinor: D2_FEE + D2_TAX, totalMinor: D2_TOTAL });
    }
    expect((await publicDepartures(productA)).by(d2)).toMatchObject({ capacity: 3, booked: 3, remaining: 0 });
    const soldOut = await order(late, [{ departureId: d2, qty: 1 }]);
    expect(soldOut.status).toBe(409);
    expect(soldOut.body.code).toBe('SOLD_OUT');

    // one winner pays inside the window; the other two abandon checkout
    const [payer, ...abandoned] = won;
    concurrencyPaidOrder = payer.r.body.item.id;
    concurrencyPayer = payer.u;
    concurrencyPaymentId = (await payOrder(payer.u, concurrencyPaidOrder, D2_TOTAL)).paymentId;
    expect((await getOrder(payer.u, concurrencyPaidOrder)).status).toBe('PAID');

    const deadline = Math.max(...abandoned.map((x) => new Date(x.r.body.item.expiresAt).getTime()));
    await sleep(Math.max(0, deadline - Date.now()) + 500);
    // past the window an abandoned order can no longer be paid
    const tooLate = await prepare(abandoned[0].u, abandoned[0].r.body.item.id);
    expect(tooLate.status).toBe(409);
    expect(tooLate.body.code).toBe('ORDER_EXPIRED');

    await t.runJobs();

    for (const { u, r } of abandoned) {
      const o = await getOrder(u, r.body.item.id);
      expect(o.status).toBe('EXPIRED');
      expect(o.items.every((i: any) => i.status === 'CANCELLED')).toBe(true);
      const p = await prepare(u, o.id);
      expect(p.status).toBe(409);
      expect(p.body.code).toBe('ORDER_NOT_PAYABLE');
      const c = await call(t, u, 'POST', `/v1/orders/${o.id}/cancel`, { reason: 'too late' }, idem());
      expect(c.status).toBe(409);
      expect(c.body.code).toBe('INVALID_STATE_TRANSITION');
    }
    const paidStill = await getOrder(payer.u, concurrencyPaidOrder);
    expect(paidStill.status).toBe('PAID'); // a paid order is never expired
    expect(paidStill.items.find((i: any) => i.sellableType === 'TRAVEL_DEPARTURE').vouchers).toHaveLength(1);
    // capacity released; minimum participants (1) reached by the paid seat → GUARANTEED (explicit status)
    expect((await publicDepartures(productA)).by(d2)).toMatchObject({ booked: 1, remaining: 2, status: 'GUARANTEED', guaranteed: true });
    // D1 (min 2, nothing paid, before its cutoff) is untouched by the lifecycle job
    expect((await publicDepartures(productA)).by(d1)).toMatchObject({ booked: 0, status: 'OPEN', guaranteed: false });

    const lateOk = await order(late, [{ departureId: d2, qty: 2 }]);
    expect(lateOk.status, show(lateOk)).toBe(201);
    expect((await publicDepartures(productA)).by(d2)).toMatchObject({ booked: 3, remaining: 0 });
    expect((await order(outsider, [{ departureId: d2, qty: 1 }])).body.code).toBe('SOLD_OUT');
    // the late buyer changes their mind before paying: seats come back immediately
    const lateCancel = await call(t, late, 'POST', `/v1/orders/${lateOk.body.item.id}/cancel`, { reason: 'changed plans' }, idem());
    expect(lateCancel.status, show(lateCancel)).toBe(200);
    expect(lateCancel.body).toMatchObject({ item: { status: 'CANCELLED' }, refund: { refundId: null, amountMinor: 0 } });
    expect((await publicDepartures(productA)).by(d2)).toMatchObject({ booked: 1, remaining: 2 });

    // ledger for the paid concurrency order
    const txs = await ledgerTx('PAYMENT', concurrencyPaymentId);
    expect(txs).toHaveLength(1);
    const entry = (a: string) => txs[0].entries.find((e: any) => e.account === a);
    expect(entry(PG)).toMatchObject({ debitMinor: D2_TOTAL });
    expect(entry(payable(s1.id))).toMatchObject({ creditMinor: D2_PAYEE_NET });
    expect(entry(TAX_PAYABLE)).toMatchObject({ creditMinor: D2_TAX });
    expect(entry(FEE_REVENUE)).toMatchObject({ creditMinor: D2_FEE + D2_COMMISSION });
  }, 60_000);

  it('10. supplier merchant of record: pass-through posting → fulfilled after departure → settlement includes it → payout', async () => {
    const apply = await call(t, s2, 'POST', '/v1/suppliers', { name: 'Han River Cruise Co.', supplierType: 'TICKET' });
    expect(apply.status, show(apply)).toBe(201);
    supplier2Id = apply.body.item.id;
    const ok = await call(t, admin, 'POST', `/v1/admin/suppliers/${supplier2Id}/approve`, { merchantOfRecord: 'SUPPLIER', commissionBps: COMMISSION_S2_BPS, reason: 'licensed operator sells as merchant of record' });
    expect(ok.status, show(ok)).toBe(200);
    expect(ok.body.item).toMatchObject({ status: 'APPROVED', merchantOfRecord: 'SUPPLIER', commissionBps: COMMISSION_S2_BPS });
    // a supplier cannot touch another supplier's product
    expect((await call(t, s2, 'PATCH', `/v1/supplier/products/${productA}`, { title: 'Hijacked' })).status).toBe(404);
    expect((await call(t, s2, 'POST', `/v1/travel-products/${productA}/departures`, { startsAt: isoIn(86_400_000), capacity: 1 })).status).toBe(404);

    const created = await call(t, s2, 'POST', '/v1/supplier/products', { type: 'TICKET', title: 'Han River Sunset Cruise', city: 'Seoul', basePriceMinor: BASE_B, currency: 'KRW' });
    expect(created.status, show(created)).toBe(201);
    productB = created.body.item.id;
    // the departure starts a few seconds from now; the min-participant decision is taken at departure time
    const startsAt = isoIn(7_000);
    const dep = await call(t, s2, 'POST', `/v1/travel-products/${productB}/departures`, { startsAt, cutoffAt: startsAt, capacity: 20 });
    expect(dep.status, show(dep)).toBe(201);
    d3 = dep.body.item.id;
    expect((await call(t, s2, 'POST', `/v1/supplier/products/${productB}/submit`)).body.item.status).toBe('IN_REVIEW');
    const pub = await call(t, admin, 'POST', `/v1/admin/travel-products/${productB}/publish`, {});
    expect(pub.status, show(pub)).toBe(200);

    const cat = await call(t, null, 'GET', '/v1/travel-products?type=TICKET');
    expect(cat.body.items.find((x: any) => x.id === productB)?.seller).toEqual({ supplierId: supplier2Id, name: 'Han River Cruise Co.', merchantOfRecord: 'SUPPLIER' });

    const mixed = await order(buyer, [{ departureId: d1, qty: 1 }, { departureId: d3, qty: 1 }]);
    expect(mixed.status).toBe(400);
    expect(mixed.body.code).toBe('MIXED_MERCHANT_OF_RECORD');
    expect((await publicDepartures(productA)).by(d1).booked).toBe(0);

    const o = await order(buyer, [{ departureId: d3, qty: 1 }]);
    expect(o.status, show(o)).toBe(201);
    mborOrderId = o.body.item.id;
    expect(o.body.item).toMatchObject({ merchantOfRecord: 'SUPPLIER', subtotalMinor: BASE_B, feeMinor: B_FEE + B_TAX, totalMinor: B_TOTAL });
    const paid = await payOrder(buyer, mborOrderId, B_TOTAL);
    mborPaymentId = paid.paymentId;
    expect((await getOrder(buyer, mborOrderId)).status).toBe('PAID');
    // a second buyer reserves a seat but has not paid when the departure starts
    const straggler = await order(outsider, [{ departureId: d3, qty: 1 }]);
    expect(straggler.status, show(straggler)).toBe(201);

    // ledger: the supplier's net goes to its pass-through liability, not to a JETPOOL payee payable
    const txs = await ledgerTx('PAYMENT', mborPaymentId);
    expect(txs).toHaveLength(1);
    expect(txs[0]).toMatchObject({ type: 'PAYMENT_APPROVED', memo: 'merchant_of_record=SUPPLIER' });
    const entry = (a: string) => txs[0].entries.find((e: any) => e.account === a);
    expect(txs[0].entries).toHaveLength(4);
    expect(entry(PG)).toMatchObject({ debitMinor: B_TOTAL, creditMinor: 0 });
    expect(entry(passThrough(s2.id))).toMatchObject({ debitMinor: 0, creditMinor: B_PASS_THROUGH });
    expect(entry(payable(s2.id))).toBeUndefined();
    expect(entry(TAX_PAYABLE)).toMatchObject({ creditMinor: B_TAX });
    expect(entry(FEE_REVENUE)).toMatchObject({ creditMinor: B_FEE + B_COMMISSION });
    const s2Accounts = await ledgerAccounts(s2.id);
    expect(s2Accounts.items.map((a: any) => [a.code, a.purpose, a.account_type, a.owner_type, a.balance_minor])).toEqual([[passThrough(s2.id), 'PASS_THROUGH', 'LIABILITY', 'USER', B_PASS_THROUGH]]);

    // the departure starts → DEPARTED, the order is FULFILLED by the lifecycle job
    await sleep(Math.max(0, new Date(startsAt).getTime() - Date.now()) + 500);
    await t.runJobs();
    const own = await call(t, s2, 'GET', `/v1/travel-products/${productB}/departures?includePast=true`);
    expect(own.status, show(own)).toBe(200);
    expect(own.body.items.find((x: any) => x.id === d3)).toMatchObject({ status: 'DEPARTED', booked: 2 });
    const closed = await order(outsider, [{ departureId: d3, qty: 1 }]);
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('DEPARTURE_CLOSED'); // sales close when the departure starts
    const fulfilled = await getOrder(buyer, mborOrderId);
    expect(fulfilled.status).toBe('FULFILLED');
    expect(fulfilled.fulfilledAt).toBeTruthy();
    expect((await getOrder(concurrencyPayer, concurrencyPaidOrder)).status).toBe('PAID'); // its departure has not started

    // the PG settles the collected funds into the bank
    const pgs = await call(t, acctA, 'POST', '/v1/admin/ledger/pg-settlements', { currency: 'KRW', amountMinor: B_TOTAL, reference: `PG-${day(0)}-TRAVEL-001` }, idem());
    expect(pgs.status, show(pgs)).toBe(201);

    const gen = await call(t, acctA, 'POST', '/v1/admin/settlements/generate', { periodStart: day(-1), periodEnd: day(1) }, idem());
    expect(gen.status, show(gen)).toBe(201);
    expect(gen.body.skipped).toEqual([]);
    // only the fulfilled supplier-MoR order is due: the cancelled and the not-yet-departed JETPOOL orders are not
    expect(gen.body.items.map((x: any) => x.payeeId)).toEqual([s2.id]);
    const s = gen.body.items[0];
    settlementId = s.id;
    expect(s).toMatchObject({ payeeType: 'SUPPLIER', status: 'APPROVAL_PENDING', grossMinor: BASE_B, feeMinor: B_COMMISSION, refundMinor: 0, netMinor: B_PASS_THROUGH, currency: 'KRW', generatedBy: acctA.id });
    const detail = await call(t, acctA, 'GET', `/v1/admin/settlements/${settlementId}`);
    expect(detail.status, show(detail)).toBe(200);
    expect(detail.body.item.items.map((i: any) => [i.source_type, i.source_id, i.payee_account_code, i.gross_minor, i.fee_minor, i.refund_minor])).toEqual([
      ['ORDER', mborOrderId, passThrough(s2.id), BASE_B, B_COMMISSION, 0],
    ]);
    const earn = await call(t, s2, 'GET', '/v1/provider/settlements');
    expect(earn.status, show(earn)).toBe(200);
    expect(earn.body.items.find((x: any) => x.id === settlementId)?.lines).toEqual([
      { sourceType: 'ORDER', sourceId: mborOrderId, grossMinor: BASE_B, feeMinor: B_COMMISSION, refundMinor: 0, netMinor: B_PASS_THROUGH },
    ]);
    expect(earn.body.balances).toEqual([expect.objectContaining({ purpose: 'PASS_THROUGH', balanceMinor: B_PASS_THROUGH })]);
    expect((await call(t, s1, 'GET', '/v1/provider/settlements')).body.items).toEqual([]);

    // maker-checker approval, manual payout rail (payout.automatic is OFF)
    const self = await call(t, acctA, 'POST', `/v1/admin/settlements/${settlementId}/approve`);
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('MAKER_CHECKER_VIOLATION');
    const appr = await call(t, acctB, 'POST', `/v1/admin/settlements/${settlementId}/approve`);
    expect(appr.status, show(appr)).toBe(200);
    expect(appr.body.item).toMatchObject({ status: 'APPROVED', approvedBy: acctB.id });

    const noAccount = await call(t, acctB, 'POST', `/v1/admin/settlements/${settlementId}/payout`, undefined, idem());
    expect(noAccount.status).toBe(409);
    expect(noAccount.body.code).toBe('PAYOUT_ACCOUNT_REQUIRED');
    const acc = await call(t, s2, 'POST', '/v1/payout-accounts', { bankCode: '004', accountLast4: '7788', accountToken: 'tok_e2e_cruise_payout', holderName: 'Han River Cruise Co.' });
    expect(acc.status, show(acc)).toBe(201);
    const vacc = await call(t, acctA, 'POST', `/v1/admin/payout-accounts/${acc.body.item.id}/verify`, { decision: 'VERIFIED' });
    expect(vacc.status, show(vacc)).toBe(200);
    const po = await call(t, acctB, 'POST', `/v1/admin/settlements/${settlementId}/payout`, undefined, idem());
    expect(po.status, show(po)).toBe(200);
    expect(po.body.mode).toBe('MANUAL');
    expect(po.body.item).toMatchObject({ status: 'PAYOUT_PENDING', netMinor: B_PASS_THROUGH });
    const csv = await call(t, acctB, 'GET', '/v1/admin/settlements/payout-export');
    expect(csv.status).toBe(200);
    expect(String(csv.body)).toContain(settlementId);
    expect(String(csv.body)).toContain(String(B_PASS_THROUGH));
    const mp = await call(t, acctB, 'POST', `/v1/admin/settlements/${settlementId}/mark-paid`, { payoutRef: 'KB-TRANSFER-20261007-01' }, idem());
    expect(mp.status, show(mp)).toBe(200);
    expect(mp.body.item).toMatchObject({ status: 'PAID', payoutRef: 'KB-TRANSFER-20261007-01', netMinor: B_PASS_THROUGH });

    const after = await ledgerAccounts();
    expect(after.balance(passThrough(s2.id))).toBe(0); // pass-through fully paid out to the supplier
    expect(after.balance(BANK)).toBe(B_TOTAL - B_PASS_THROUGH);
    const stmt = await call(t, s2, 'GET', '/v1/receipts');
    expect(stmt.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ receiptType: 'SETTLEMENT_STATEMENT', amountMinor: B_PASS_THROUGH })]));
    // re-generating the same period settles nothing twice
    const regen = await call(t, acctA, 'POST', '/v1/admin/settlements/generate', { periodStart: day(-1), periodEnd: day(1) }, idem());
    expect(regen.status, show(regen)).toBe(201);
    expect(regen.body.items).toEqual([]);

    // the straggler's unpaid seat on the departed tour can no longer be paid either (no capture for a tour that left)
    const lateCheckout = await prepare(outsider, straggler.body.item.id);
    expect(lateCheckout.status, `payment accepted for a departed tour: ${show(lateCheckout)}`).toBe(409);
  }, 60_000);

  it('11. charter: content page + lead request work; every direct booking endpoint is 403 while the flag is OFF', async () => {
    const content = await call(t, null, 'GET', '/v1/content/charter');
    expect(content.status, show(content)).toBe(200);
    expect(content.body.item).toMatchObject({ slug: 'jetpool-charter', directBooking: false, cta: { action: 'POST /v1/charter/requests' } });
    expect(content.body.item.title).toBeTruthy();
    expect(content.body.item.sections.length).toBeGreaterThan(0);

    const lead = { contactName: 'Alex Buyer', contactEmail: 'alex.buyer@e2e.jetpool.kr', contactPhone: '+82 10-1234-5678', origin: 'Gimpo (GMP)', destination: 'Jeju (CJU)', preferredDate: day(30), partySize: 6, message: 'Family trip, flexible by a day.' };
    const anon = await call(t, null, 'POST', '/v1/charter/requests', { ...lead, contactEmail: 'anon.lead@e2e.jetpool.kr' });
    expect(anon.status, show(anon)).toBe(201);
    expect(anon.body.item).toMatchObject({ status: 'NEW' });
    const mine = await call(t, buyer, 'POST', '/v1/charter/requests', lead);
    expect(mine.status, show(mine)).toBe(201);
    const leadId = mine.body.item.id as string;
    const bot = await call(t, null, 'POST', '/v1/charter/requests', { ...lead, website: 'http://spam.example' });
    expect(bot.status).toBe(400);
    const past = await call(t, null, 'POST', '/v1/charter/requests', { ...lead, preferredDate: day(-1) });
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('DATE_IN_PAST');

    const ml = await call(t, buyer, 'GET', '/v1/charter/requests/mine');
    expect(ml.status).toBe(200);
    expect(ml.body.items.map((x: any) => x.id)).toEqual([leadId]);
    expect(ml.body.items[0]).toMatchObject({ origin: 'Gimpo (GMP)', destination: 'Jeju (CJU)', partySize: 6, status: 'NEW' });
    expect(ml.body.items[0].adminNote).toBeUndefined();
    expect((await call(t, buyer, 'GET', '/v1/admin/charter/requests')).status).toBe(403);
    const q = await call(t, admin, 'GET', '/v1/admin/charter/requests?status=NEW');
    expect(q.status, show(q)).toBe(200);
    expect(q.body.items.map((x: any) => x.id)).toEqual(expect.arrayContaining([leadId, anon.body.item.id]));
    const upd = await call(t, admin, 'PATCH', `/v1/admin/charter/requests/${leadId}`, { status: 'CONTACTED', adminNote: 'Called back, sent operator quote.' });
    expect(upd.status, show(upd)).toBe(200);
    expect(upd.body.item.status).toBe('CONTACTED');
    expect((await notifications(admin)).find((n) => n.templateKey === 'charter.requested' && n.data.requestId === leadId)).toBeTruthy();

    // every transactional charter endpoint in the published contract is gated (travel.commerce ON does not open it)
    const spec = JSON.parse(readFileSync(new URL('../../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
    const gated = Object.entries(spec.paths as Record<string, Record<string, unknown>>)
      .filter(([p]) => p.startsWith('/v1/charter/') && p !== '/v1/charter/requests' && p !== '/v1/charter/requests/mine')
      .flatMap(([p, ops]) => Object.keys(ops).filter((m) => ['post', 'put', 'patch', 'delete'].includes(m)).map((m) => [m.toUpperCase(), p.replace(/\{[^}]+\}/g, randomUUID())] as const));
    expect(gated.map(([, p]) => p.replace(/[0-9a-f-]{36}/g, ':id')).sort()).toEqual(['/v1/charter/bookings', '/v1/charter/bookings/:id/pay', '/v1/charter/flight-shares/:id/seats']);
    for (const [method, url] of gated) {
      for (const user of [null, buyer, admin]) {
        const r = await call(t, user, method as any, url, { partySize: 2, amountMinor: 1_000_000 }, idem());
        expect(r.status, `${method} ${url} as ${user?.id ?? 'anonymous'}: ${show(r)}`).toBe(403);
        expect(r.body.code).toBe('FEATURE_DISABLED');
      }
    }
    // and no charter payment subject exists
    const prepCharter = await call(t, buyer, 'POST', '/v1/payments/toss/prepare', { subjectType: 'CHARTER', subjectId: leadId }, idem());
    expect(prepCharter.status).toBe(400);
  });

  it('12. global: ledger balanced with expected balances, reconciliation clean, audit trail, outbox healthy', async () => {
    const tb = await trialBalance();
    expect(tb.balanced).toBe(true);
    expect(tb.unbalancedTransactionIds).toEqual([]);
    expect(tb.currencies).toEqual([expect.objectContaining({ currency: 'KRW', differenceMinor: 0 })]);

    const share = (account: string) => mainRefundTx.entries.find((e: any) => e.account === account)?.debitMinor ?? 0;
    const acc = await ledgerAccounts();
    expect(acc.balance(PG)).toBe(MAIN_TOTAL - MAIN_REFUND + D2_TOTAL + B_TOTAL - B_TOTAL);
    expect(acc.balance(BANK)).toBe(B_TOTAL - B_PASS_THROUGH);
    expect(acc.balance(payable(s1.id))).toBe(MAIN_PAYEE_NET - share(payable(s1.id)) + D2_PAYEE_NET);
    expect(acc.balance(FEE_REVENUE)).toBe(MAIN_FEE_REVENUE - share(FEE_REVENUE) + D2_FEE + D2_COMMISSION + B_FEE + B_COMMISSION);
    expect(acc.balance(TAX_PAYABLE)).toBe(MAIN_TAX - share(TAX_PAYABLE) + D2_TAX + B_TAX);
    expect(acc.balance(passThrough(s2.id))).toBe(0);
    // assets = liabilities + revenue
    const assets = acc.balance(PG) + acc.balance(BANK);
    const claims = acc.balance(payable(s1.id)) + acc.balance(FEE_REVENUE) + acc.balance(TAX_PAYABLE) + acc.balance(passThrough(s2.id));
    expect(assets).toBe(claims);

    const rec = await call(t, acctA, 'GET', '/v1/admin/payments/reconciliation?checkProvider=true');
    expect(rec.status, show(rec)).toBe(200);
    const ours = rec.body.items.filter((i: any) => [mainPaymentId, concurrencyPaymentId, mborPaymentId].includes(i.paymentId));
    expect(ours).toHaveLength(3);
    expect(ours.filter((i: any) => !i.ok), JSON.stringify(ours)).toEqual([]);
    expect(rec.body.discrepancies).toBe(0);

    const comp = await auditActions('COMPLIANCE');
    const decisions = comp.filter((a) => a.action === 'supplier.decision').map((a) => a.resource_id);
    expect(decisions).toEqual(expect.arrayContaining([supplier1Id, supplier2Id]));
    const money = await auditActions('MONEY');
    expect(money.filter((a) => a.action === 'supplier.commercial_terms').map((a) => a.resource_id)).toEqual(expect.arrayContaining([supplier1Id, supplier2Id]));
    for (const a of ['finance.rule.create', 'finance.rule.approve', 'refund.requested', 'refund.completed', 'ledger.pg_settlement', 'settlement.generate', 'settlement.approve', 'settlement.payout', 'settlement.paid']) {
      expect(money.map((m) => m.action), `MONEY audit ${a}`).toContain(a);
    }
    expect(money.every((m) => !!m.correlation_id)).toBe(true);
    const content = await auditActions('CONTENT');
    expect(content.filter((a) => a.action === 'travel_product.publish').map((a) => a.resource_id)).toEqual(expect.arrayContaining([productA, productB]));
    const perm = await auditActions('PERMISSION');
    expect(perm).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: 'role.granted', resource_id: s1.id, actor_id: admin.id }),
      expect.objectContaining({ action: 'role.granted', resource_id: s2.id, actor_id: admin.id }),
    ]));

    await t.drain();
    const ov = await call(t, admin, 'GET', '/v1/admin/overview');
    expect(ov.status, show(ov)).toBe(200);
    const dl = await call(t, admin, 'GET', '/v1/admin/outbox/dead-letters');
    expect(ov.body.outbox, `outbox not drained cleanly; dead letters: ${JSON.stringify(dl.body)}`).toMatchObject({ pending: 0, deadLetters: 0 });
  });
});
