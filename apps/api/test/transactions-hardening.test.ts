/**
 * QA hardening r1 — transactions group (booking STAY-06..10, exchange EXCH-01..06, guide GUIDE-01..05).
 * Each describe block is a regression test for a confirmed defect; it fails on the pre-fix code.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, createUser, call, day, enableFlags, idem, type TestApp, type TestUser } from './helpers.js';
import { allocate, applyBps } from '../src/platform/money.js';
import { autoCompleteStays, MAX_ACTIVE_HOLDS_PER_GUEST, MAX_HOLDS_PER_GUEST_PROPERTY_PER_DAY } from '../src/modules/booking/reservations.js';
import { coarseDistanceKm } from '../src/modules/guide/search.js';
import { runQualificationExpiry } from '../src/modules/guide/index.js';

let t: TestApp;
let admin: TestUser;
let compliance: TestUser;
let moderateId: string;
let flexibleId: string;

const show = (r: { body: any }) => JSON.stringify(r.body);

// ------------------------------------------------------------------------------------------------ stay fixtures

const NIGHTLY = 100_000;
const CLEANING = 20_000;
const FEE_BASE = 2 * NIGHTLY + CLEANING; // 2-night stays
const PLATFORM_FEE = applyBps(FEE_BASE, 1000);
const HOST_FEE = applyBps(FEE_BASE, 300);
const TAX = applyBps(PLATFORM_FEE, 1000);
const TOTAL = FEE_BASE + PLATFORM_FEE + TAX;
const HOST_NET = FEE_BASE - HOST_FEE;

async function makeStay(opts: { policyId?: string } = {}) {
  const host = await createUser(t, { roles: ['HOST'] });
  const { rows } = await t.pool.query(
    `INSERT INTO properties(host_id, title, property_type, status, rental_enabled, paid_booking_enabled, base_price_minor, cleaning_fee_minor,
                            currency, max_guests, min_nights, timezone, country, cancellation_policy_id, published_at, city)
     VALUES ($1,'Stay','HOUSE','PUBLISHED',true,true,$2,$3,'KRW',4,1,'UTC','KR',$4, now(), 'Seoul') RETURNING id`,
    [host.id, NIGHTLY, CLEANING, opts.policyId ?? moderateId],
  );
  await t.pool.query(`INSERT INTO property_addresses(property_id, line1, city, country, public_area_label) VALUES ($1,'1 Secret-ro 42','Seoul','KR','Mapo-gu')`, [rows[0].id]);
  return { host, propertyId: rows[0].id as string };
}

async function quoteHold(guest: TestUser, propertyId: string, checkIn: string, checkOut: string) {
  const q = await call(t, guest, 'POST', '/v1/booking/quotes', { propertyId, checkIn, checkOut, guests: 2 });
  expect(q.status, show(q)).toBe(201);
  const h = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId: q.body.item.id }, idem());
  expect(h.status, show(h)).toBe(201);
  return { reservationId: h.body.item.reservation.id as string, holdId: h.body.item.hold.id as string, blockId: h.body.item.hold.inventoryBlockId as string };
}

async function payViaMock(payer: TestUser, subjectType: 'RESERVATION' | 'GUIDE_BOOKING', subjectId: string) {
  const p = await call(t, payer, 'POST', '/v1/payments/toss/prepare', { subjectType, subjectId }, idem());
  expect(p.status, show(p)).toBe(201);
  const c = await call(t, payer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${randomUUID().replace(/-/g, '')}`, orderId: p.body.orderId, amount: p.body.amount }, idem());
  expect(c.status, show(c)).toBe(200);
  return { paymentId: p.body.paymentId as string, confirm: c };
}

async function bookAndPay(guest: TestUser, propertyId: string, checkIn: string, checkOut: string) {
  const { reservationId } = await quoteHold(guest, propertyId, checkIn, checkOut);
  const { paymentId, confirm } = await payViaMock(guest, 'RESERVATION', reservationId);
  expect(confirm.body.item.status).toBe('APPROVED');
  return { reservationId, paymentId };
}

const resStatus = async (id: string) => (await t.pool.query(`SELECT status FROM reservations WHERE id = $1`, [id])).rows[0].status as string;
const auditRows = async (actorId: string, action: string) =>
  (await t.pool.query(`SELECT action, category, reason, resource_id, after_state, user_agent, ip FROM audit_logs WHERE actor_id = $1 AND action = $2 ORDER BY created_at`, [actorId, action])).rows;
const balance = async (code: string) => Number((await t.pool.query(`SELECT balance_minor FROM ledger_balances WHERE code = $1`, [code])).rows[0]?.balance_minor ?? 0);
const refundReversal = async (paymentId: string) =>
  (
    await t.pool.query(
      `SELECT a.code, e.debit_minor, e.credit_minor FROM ledger_transactions x JOIN ledger_entries e ON e.transaction_id = x.id
         JOIN ledger_accounts a ON a.id = e.account_id JOIN refunds r ON r.id = x.source_id
        WHERE x.transaction_type = 'REFUND' AND r.payment_id = $1`,
      [paymentId],
    )
  ).rows as Array<{ code: string; debit_minor: number; credit_minor: number }>;

// ------------------------------------------------------------------------------------------------ exchange fixtures

interface Member { user: TestUser; propertyId: string }
const A_DATES = { start: day(30), end: day(35) };
const B_DATES = { start: day(40), end: day(45) };

async function member(city = 'Seoul'): Promise<Member> {
  const user = await createUser(t, { verified: true });
  const { rows } = await t.pool.query(
    `INSERT INTO properties(host_id, title, property_type, max_guests, city, status, exchange_enabled, published_at)
     VALUES ($1,$2,'APARTMENT',4,$3,'PUBLISHED',true, now()) RETURNING id`,
    [user.id, `Home of ${user.email}`, city],
  );
  await t.pool.query(`INSERT INTO property_addresses(property_id, line1, city) VALUES ($1,'123 Secret-ro',$2)`, [rows[0].id, city]);
  await t.pool.query(`INSERT INTO house_rules(property_id, quiet_hours) VALUES ($1,'22:00-07:00')`, [rows[0].id]);
  const r = await call(t, user, 'PUT', '/v1/exchange/profile', { homeDescription: 'A quiet, sunny family apartment.', preferredDestinations: ['Busan'] });
  expect(r.status).toBe(200);
  return { user, propertyId: rows[0].id as string };
}

async function requestExchange(a: Member, b: Member, message = 'Swap?') {
  const r = await call(t, a.user, 'POST', '/v1/exchanges', { myPropertyId: a.propertyId, theirPropertyId: b.propertyId, datesA: A_DATES, datesB: B_DATES, guestsA: 2, guestsB: 2, message });
  expect(r.status, show(r)).toBe(201);
  return r.body.item.id as string;
}

async function toConfirmed(a: Member, b: Member, message?: string) {
  const id = await requestExchange(a, b, message);
  expect((await call(t, b.user, 'POST', `/v1/exchanges/${id}/accept`, { offerVersion: 1 })).status).toBe(200);
  expect((await call(t, a.user, 'POST', `/v1/exchanges/${id}/safety-ack`, { acknowledged: true })).status).toBe(200);
  expect((await call(t, b.user, 'POST', `/v1/exchanges/${id}/safety-ack`, { acknowledged: true })).body.item.status).toBe('AGREEMENT_PENDING');
  const hash = (await call(t, a.user, 'GET', `/v1/exchanges/${id}/agreement`)).body.item.termsHash as string;
  expect((await call(t, a.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash })).status).toBe(200);
  expect((await call(t, b.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash })).body.item.status).toBe('CONFIRMED');
  return id;
}

const exchangeBlocks = async (exchangeId: string) =>
  (await t.pool.query(`SELECT property_id, state FROM inventory_blocks WHERE source_type = 'EXCHANGE' AND source_id = $1`, [exchangeId])).rows as Array<{ property_id: string; state: string }>;

// ------------------------------------------------------------------------------------------------ guide fixtures

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

async function media(u: TestUser) {
  const { rows } = await t.pool.query(
    `INSERT INTO media_assets(owner_id, storage_key, purpose, mime_type, byte_size, status) VALUES ($1,$2,'VERIFICATION','application/pdf',100,'READY') RETURNING id`,
    [u.id, `test/${randomUUID()}`],
  );
  return rows[0].id as string;
}

async function guide(type: 'FRIEND' | 'PAID', extra: Record<string, unknown> = {}) {
  const u = await createUser(t, { verified: true });
  const p = await call(t, u, 'POST', '/v1/guides/profile', { guideType: type, city: 'Seoul', languages: ['ko', 'en'], interests: ['food'], ...extra });
  expect(p.status, show(p)).toBe(201);
  if (type === 'PAID') {
    const q = await call(t, u, 'POST', '/v1/guides/qualifications', { qualificationType: 'BUSINESS_REGISTRATION', documentMediaId: await media(u), validUntil: '2099-12-31' });
    expect(q.status).toBe(201);
    expect((await call(t, compliance, 'POST', `/v1/admin/guide-qualifications/${q.body.item.id}/verify`, {})).status).toBe(200);
  }
  expect((await call(t, u, 'POST', '/v1/guides/profile/publish')).status).toBe(200);
  return u;
}

async function book(g: TestUser, traveler: TestUser, startMin: number, durMin: number, offer: { paid?: boolean; priceMinor?: number } = {}) {
  const req = await call(t, traveler, 'POST', '/v1/guide-requests', { guideId: g.id, startAt: at(startMin), endAt: at(startMin + durMin), partySize: 2, languages: ['ko'] });
  expect(req.status, show(req)).toBe(201);
  const o = await call(t, g, 'POST', `/v1/guide-requests/${req.body.item.id}/offers`, { startAt: at(startMin), endAt: at(startMin + durMin), paid: offer.paid ?? false, priceMinor: offer.priceMinor ?? 0 });
  expect(o.status, show(o)).toBe(201);
  const a = await call(t, traveler, 'POST', `/v1/guide-requests/${req.body.item.id}/accept`, { offerVersion: o.body.offer.version }, idem());
  expect(a.status, show(a)).toBe(201);
  return a.body.booking.id as string;
}

const bookingStatus = async (id: string) => (await t.pool.query(`SELECT status FROM guide_bookings WHERE id = $1`, [id])).rows[0].status as string;
const guideRefunds = async (id: string) =>
  (await t.pool.query(`SELECT r.amount_minor, r.status FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.subject_type = 'GUIDE_BOOKING' AND p.subject_id = $1`, [id])).rows;

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  compliance = await createUser(t, { roles: ['COMPLIANCE'] });
  moderateId = (await t.pool.query(`SELECT id FROM cancellation_policies WHERE code = 'MODERATE'`)).rows[0].id;
  flexibleId = (await t.pool.query(`SELECT id FROM cancellation_policies WHERE code = 'FLEXIBLE'`)).rows[0].id;
  await enableFlags(t, 'stay.paid_booking', 'exchange.enabled', 'guide.paid');
  await t.pool.query(
    `INSERT INTO compliance_rules(rule_key, subject_type, jurisdiction, effective_from, status, approved_at, note)
     VALUES ('test-allow','PROPERTY','KR','2020-01-01','APPROVED', now(), 'test')`,
  );
  await t.pool.query(
    `INSERT INTO compliance_rules(rule_key, subject_type, jurisdiction, applies_to, required_permit_types, effective_from, status, approved_at, note)
     VALUES ('guide.paid.kr','GUIDE','KR','{"guide_type":["PAID"]}','{BUSINESS_REGISTRATION}', current_date - 1, 'APPROVED', now(), 'test')`,
  );
  // 10% guest service fee, 3% host fee, 10% VAT on the service fee
  await t.pool.query(
    `INSERT INTO finance_rules(rule_type, domain, jurisdiction, params, effective_from, status, approved_at) VALUES
       ('PLATFORM_FEE','STAY','KR','{"bps":1000}','2020-01-01','APPROVED', now()),
       ('HOST_FEE','STAY','KR','{"bps":300}','2020-01-01','APPROVED', now()),
       ('TAX','STAY','KR','{"bps":1000}','2020-01-01','APPROVED', now())`,
  );
});
afterAll(async () => t?.close());

// ================================================================================================ booking

describe('STAY staff overrides are role-scoped (EDITOR / COMPLIANCE get no reservation powers)', () => {
  let stay: Awaited<ReturnType<typeof makeStay>>;
  let rid: string;
  const staff: Record<string, TestUser> = {};
  beforeAll(async () => {
    stay = await makeStay();
    rid = (await bookAndPay(await createUser(t), stay.propertyId, day(10), day(12))).reservationId;
    for (const role of ['EDITOR', 'COMPLIANCE', 'SUPPORT', 'ACCOUNTING'] as const) staff[role] = await createUser(t, { roles: [role] });
  });

  it('EDITOR and COMPLIANCE (AAL2) cannot read, cancel, operate or reprice someone else’s reservation / listing', async () => {
    for (const role of ['EDITOR', 'COMPLIANCE']) {
      const u = staff[role];
      const read = await call(t, u, 'GET', `/v1/reservations/${rid}`);
      expect(read.status, role).toBe(403);
      expect(read.body.code).toBe('ROLE_REQUIRED');
      expect((await call(t, u, 'GET', `/v1/reservations/${rid}/cancellation-preview`)).status).toBe(403);
      expect((await call(t, u, 'POST', `/v1/reservations/${rid}/cancel`, { reason: 'x' }, idem())).status).toBe(403);
      for (const action of ['check-in', 'complete', 'no-show']) {
        expect((await call(t, u, 'POST', `/v1/reservations/${rid}/${action}`, { reason: 'ops' })).status, `${role} ${action}`).toBe(403);
      }
      expect((await call(t, u, 'PUT', `/v1/properties/${stay.propertyId}/availability`, { ranges: [{ start: day(20), end: day(22), priceMinor: 1 }] })).status).toBe(403);
      expect((await call(t, u, 'POST', `/v1/properties/${stay.propertyId}/blocks`, { start: day(30), end: day(32) })).status).toBe(403);
      expect((await call(t, u, 'GET', `/v1/host/calendar?propertyId=${stay.propertyId}&from=${day(10)}&to=${day(12)}`)).status).toBe(403);
    }
    expect(await resStatus(rid)).toBe('CONFIRMED');
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM availability_days WHERE property_id = $1 AND price_minor = 1`, [stay.propertyId])).rows[0].n).toBe(0);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM inventory_blocks WHERE property_id = $1 AND block_type = 'HOST_BLOCK'`, [stay.propertyId])).rows[0].n).toBe(0);
  });

  it('SUPPORT reads with an ELEVATED_ACCESS audit row but cannot cancel (PAY-02 refund roles) or reprice; staff acts need a reason', async () => {
    const u = staff.SUPPORT;
    const r = await call(t, u, 'GET', `/v1/reservations/${rid}`);
    expect(r.status, show(r)).toBe(200);
    expect(r.body.item.viewerRole).toBe('STAFF');
    expect(r.body.item.property.address.line1).toBe('1 Secret-ro 42');
    expect(await auditRows(u.id, 'reservation.read')).toEqual([expect.objectContaining({ category: 'ELEVATED_ACCESS', resource_id: rid })]);
    const pv = await call(t, u, 'GET', `/v1/reservations/${rid}/cancellation-preview`);
    expect(pv.status).toBe(200);
    expect(pv.body.item.cancellable).toBe(false);
    expect(await auditRows(u.id, 'reservation.cancellation_preview.read')).toHaveLength(1);
    const cx = await call(t, u, 'POST', `/v1/reservations/${rid}/cancel`, { reason: 'guest asked' }, idem());
    expect(cx.status).toBe(403);
    expect(cx.body.code).toBe('ROLE_REQUIRED');
    expect((await call(t, u, 'PUT', `/v1/properties/${stay.propertyId}/availability`, { ranges: [{ start: day(20), end: day(22), priceMinor: 1 }] })).body.code).toBe('ROLE_REQUIRED');
    const noReason = await call(t, u, 'POST', `/v1/reservations/${rid}/no-show`);
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe('REASON_REQUIRED');
    expect(await resStatus(rid)).toBe('CONFIRMED');
  });

  it('ACCOUNTING may cancel with a full refund (MONEY audit) and never sees the exact address', async () => {
    const u = staff.ACCOUNTING;
    const r = await call(t, u, 'GET', `/v1/reservations/${rid}`);
    expect(r.status).toBe(200);
    expect(r.body.item.property.address).toBeNull();
    const cx = await call(t, u, 'POST', `/v1/reservations/${rid}/cancel`, { reason: 'chargeback prevention' }, idem());
    expect(cx.status, show(cx)).toBe(200);
    expect(cx.body.item.cancellation).toMatchObject({ actorRole: 'STAFF', basis: 'STAFF_CANCELLATION', refundPct: 100, refundMinor: TOTAL });
    expect(await auditRows(u.id, 'reservation.staff_cancelled')).toEqual([expect.objectContaining({ category: 'MONEY', reason: 'chargeback prevention', resource_id: rid })]);
  });

  it('only ADMIN may change another host’s prices / calendar, and the override is audited', async () => {
    const r = await call(t, admin, 'PUT', `/v1/properties/${stay.propertyId}/availability`, { ranges: [{ start: day(20), end: day(22), status: 'UNAVAILABLE' }] });
    expect(r.status, show(r)).toBe(200);
    expect(await auditRows(admin.id, 'availability.staff_updated')).toEqual([expect.objectContaining({ category: 'PERMISSION', resource_id: stay.propertyId })]);
    // the owner's own edits are not staff overrides
    expect((await call(t, stay.host, 'PUT', `/v1/properties/${stay.propertyId}/availability`, { ranges: [{ start: day(22), end: day(23), priceMinor: 90_000 }] })).status).toBe(200);
    expect(await auditRows(stay.host.id, 'availability.staff_updated')).toHaveLength(0);
  });
});

describe('STAY guest cancellation is a component refund (service fee + its VAT stay with the platform)', () => {
  it('FLEXIBLE full guest refund reverses the host payable completely; FEE_REVENUE and TAX_PAYABLE keep the kept fee', async () => {
    const stay = await makeStay({ policyId: flexibleId });
    const guest = await createUser(t);
    const { reservationId, paymentId } = await bookAndPay(guest, stay.propertyId, day(10), day(12));
    const c = await call(t, guest, 'POST', `/v1/reservations/${reservationId}/cancel`, { reason: 'plans changed' }, idem());
    expect(c.status, show(c)).toBe(200);
    expect(c.body.item.cancellation).toMatchObject({ refundPct: 100, refundMinor: FEE_BASE, feeRefundMinor: 0, nonRefundableMinor: PLATFORM_FEE + TAX });
    await t.drain();
    expect((await t.pool.query(`SELECT amount_minor, fee_refund_minor FROM refunds WHERE payment_id = $1`, [paymentId])).rows).toEqual([{ amount_minor: FEE_BASE, fee_refund_minor: 0 }]);
    const rev = await refundReversal(paymentId);
    const debit = (code: string) => rev.find((e) => e.code === code)?.debit_minor ?? 0;
    expect(debit(`PAYEE:${stay.host.id}:PAYABLE:KRW`)).toBe(HOST_NET);
    expect(debit('PLATFORM:FEE_REVENUE:KRW')).toBe(HOST_FEE);
    expect(debit('PLATFORM:TAX_PAYABLE:KRW')).toBe(0);
    // nothing is left for the host to be paid for a stay the guest got fully refunded
    expect(await balance(`PAYEE:${stay.host.id}:PAYABLE:KRW`)).toBe(0);
  });

  it('MODERATE 50 % tier: the host keeps exactly its share of the retained stay gross', async () => {
    const stay = await makeStay();
    const guest = await createUser(t);
    const { reservationId, paymentId } = await bookAndPay(guest, stay.propertyId, day(3), day(5));
    const refund = applyBps(FEE_BASE, 5000);
    const c = await call(t, guest, 'POST', `/v1/reservations/${reservationId}/cancel`, { reason: 'plans changed' }, idem());
    expect(c.body.item.cancellation).toMatchObject({ refundPct: 50, refundableBaseMinor: FEE_BASE, refundMinor: refund, feeRefundMinor: 0 });
    await t.drain();
    const [hostPart, commissionPart] = allocate(refund, [HOST_NET, HOST_FEE]);
    const rev = await refundReversal(paymentId);
    const debit = (code: string) => rev.find((e) => e.code === code)?.debit_minor ?? 0;
    expect(debit(`PAYEE:${stay.host.id}:PAYABLE:KRW`)).toBe(hostPart);
    expect(debit('PLATFORM:FEE_REVENUE:KRW')).toBe(commissionPart);
    expect(debit('PLATFORM:TAX_PAYABLE:KRW')).toBe(0);
    expect(await balance(`PAYEE:${stay.host.id}:PAYABLE:KRW`)).toBe(HOST_NET - hostPart);
  });
});

describe('STAY completion only once the stay has been delivered', () => {
  it('host check-in + complete on day one of a 7-night stay is refused; the stay stays CHECKED_IN', async () => {
    const stay = await makeStay();
    const guest = await createUser(t);
    const { reservationId } = await bookAndPay(guest, stay.propertyId, day(0), day(7));
    expect((await call(t, stay.host, 'POST', `/v1/reservations/${reservationId}/check-in`)).status).toBe(200);
    const done = await call(t, stay.host, 'POST', `/v1/reservations/${reservationId}/complete`);
    expect(done.status).toBe(409);
    expect(done.body).toMatchObject({ code: 'STAY_NOT_ENDED', details: { checkOut: day(7) } });
    const support = await createUser(t, { roles: ['SUPPORT'] });
    expect((await call(t, support, 'POST', `/v1/reservations/${reservationId}/complete`, { reason: 'host asked' })).body.code).toBe('STAY_NOT_ENDED');
    expect(await resStatus(reservationId)).toBe('CHECKED_IN');
  });
});

describe('STAY hold squatting', () => {
  it('re-preparing a payment never extends a hold past its absolute deadline', async () => {
    const { HOLD_TTL_SEC: H, PAYMENT_TTL_SEC: P } = t.app.ctx.config;
    const stay = await makeStay();
    const guest = await createUser(t);
    // control: a fresh hold is extended for the payment window
    const fresh = await quoteHold(guest, stay.propertyId, day(60), day(62));
    await payPrepareOnly(guest, fresh.reservationId, 201);
    const left0 = Number((await t.pool.query(`SELECT extract(epoch FROM expires_at - now()) AS s FROM reservation_holds WHERE id = $1`, [fresh.holdId])).rows[0].s);
    expect(left0).toBeGreaterThan(P - 30);

    const { reservationId, holdId, blockId } = await quoteHold(guest, stay.propertyId, day(40), day(42));
    // the hold is 10 s from its absolute deadline (created_at + HOLD_TTL + PAYMENT_TTL) with 5 s left
    await t.pool.query(`UPDATE reservation_holds SET created_at = now() - make_interval(secs => $2), expires_at = now() + interval '5 seconds' WHERE id = $1`, [holdId, H + P - 10]);
    await t.pool.query(`UPDATE inventory_blocks SET expires_at = now() + interval '5 seconds' WHERE id = $1`, [blockId]);
    for (let i = 0; i < 3; i++) await payPrepareOnly(guest, reservationId, 201);
    const h = (await t.pool.query(
      `SELECT extract(epoch FROM h.expires_at - h.created_at) AS life, extract(epoch FROM h.expires_at - now()) AS left, b.expires_at = h.expires_at AS same
         FROM reservation_holds h JOIN inventory_blocks b ON b.id = h.inventory_block_id WHERE h.id = $1`,
      [holdId],
    )).rows[0];
    expect(Number(h.life)).toBeLessThanOrEqual(H + P + 0.01);
    expect(Number(h.left)).toBeLessThan(15); // not now() + PAYMENT_TTL
    expect(h.same).toBe(true);
    // once the deadline passed the hold is dead: another prepare cannot revive it
    await t.pool.query(`UPDATE reservation_holds SET created_at = now() - make_interval(secs => $2), expires_at = now() - interval '1 second' WHERE id = $1`, [holdId, H + P + 60]);
    await t.pool.query(`UPDATE inventory_blocks SET expires_at = now() - interval '1 second' WHERE id = $1`, [blockId]);
    const late = await payPrepareOnly(guest, reservationId, 409);
    expect(late.body.code).toBe('HOLD_EXPIRED');
  });

  it('a guest keeps at most 3 live holds (also under concurrency) and re-holding one listing is capped per 24 h', async () => {
    const guest = await createUser(t);
    const stays = [];
    for (let i = 0; i < 5; i++) stays.push(await makeStay());
    const quotes: string[] = [];
    for (const s of stays) {
      const q = await call(t, guest, 'POST', '/v1/booking/quotes', { propertyId: s.propertyId, checkIn: day(50), checkOut: day(52), guests: 1 });
      expect(q.status).toBe(201);
      quotes.push(q.body.item.id);
    }
    const res = await Promise.all(quotes.map((quoteId) => call(t, guest, 'POST', '/v1/booking/holds', { quoteId }, idem())));
    expect(res.filter((r) => r.status === 201)).toHaveLength(MAX_ACTIVE_HOLDS_PER_GUEST);
    expect(res.filter((r) => r.status === 429).map((r) => r.body.code)).toEqual(['HOLD_LIMIT', 'HOLD_LIMIT']);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM reservation_holds WHERE guest_id = $1 AND status = 'ACTIVE'`, [guest.id])).rows[0].n).toBe(MAX_ACTIVE_HOLDS_PER_GUEST);

    // release + re-hold loop on one listing
    const first = res.find((r) => r.status === 201)!;
    const propertyId = first.body.item.hold.propertyId as string;
    let holdId = first.body.item.hold.id as string;
    let holds = 1;
    let last: Awaited<ReturnType<typeof call>> | null = null;
    for (let i = 0; i < 20; i++) {
      expect((await call(t, guest, 'DELETE', `/v1/booking/holds/${holdId}`)).status).toBe(204);
      const q = await call(t, guest, 'POST', '/v1/booking/quotes', { propertyId, checkIn: day(50), checkOut: day(52), guests: 1 });
      last = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId: q.body.item.id }, idem());
      if (last.status !== 201) break;
      holdId = last.body.item.hold.id;
      holds++;
    }
    expect(holds).toBe(MAX_HOLDS_PER_GUEST_PROPERTY_PER_DAY);
    expect(last!.status).toBe(429);
    expect(last!.body.code).toBe('HOLD_RATE_LIMIT');
    // the listing is bookable by someone else
    const other = await createUser(t);
    const q = await call(t, other, 'POST', '/v1/booking/quotes', { propertyId, checkIn: day(50), checkOut: day(52), guests: 1 });
    expect((await call(t, other, 'POST', '/v1/booking/holds', { quoteId: q.body.item.id }, idem())).status).toBe(201);
  });
});

async function payPrepareOnly(payer: TestUser, reservationId: string, expected: number) {
  const p = await call(t, payer, 'POST', '/v1/payments/toss/prepare', { subjectType: 'RESERVATION', subjectId: reservationId }, idem());
  expect(p.status, show(p)).toBe(expected);
  return p;
}

describe('STAY auto-completion is robust to one bad listing', () => {
  it('a listing whose time zone PostgreSQL does not know does not stall auto-completion for everyone else', async () => {
    const bad = await makeStay();
    const good = await makeStay();
    const guest = await createUser(t);
    const rBad = (await bookAndPay(guest, bad.propertyId, day(0), day(2))).reservationId;
    const rGood = (await bookAndPay(guest, good.propertyId, day(0), day(2))).reservationId;
    for (const [s, r] of [[bad, rBad], [good, rGood]] as const) expect((await call(t, s.host, 'POST', `/v1/reservations/${r}/check-in`)).status).toBe(200);
    await t.pool.query(`UPDATE reservations SET check_in = $2, check_out = $3 WHERE id = ANY($1::uuid[])`, [[rBad, rGood], day(-2), day(0)]);
    // a legacy / out-of-band row (the listing API validates zones): bypass the write-time guard
    await t.pool.query(`ALTER TABLE properties DISABLE TRIGGER USER`);
    try {
      await t.pool.query(`UPDATE properties SET timezone = 'Not/AZone' WHERE id = $1`, [bad.propertyId]);
    } finally {
      await t.pool.query(`ALTER TABLE properties ENABLE TRIGGER USER`);
    }
    try {
      expect(await autoCompleteStays(t.app.ctx)).toBeGreaterThanOrEqual(1);
      expect(await resStatus(rGood)).toBe('COMPLETED');
      expect(await resStatus(rBad)).toBe('CHECKED_IN');
    } finally {
      await t.pool.query(`ALTER TABLE properties DISABLE TRIGGER USER`);
      await t.pool.query(`UPDATE properties SET timezone = 'UTC' WHERE id = $1`, [bad.propertyId]);
      await t.pool.query(`ALTER TABLE properties ENABLE TRIGGER USER`);
    }
  });
});

// ================================================================================================ exchange

describe('EXCH verification rows never expose the counterparty’s personal or trust data', () => {
  it('no ip / user agent / sanction / safety-report detail reaches the other member', async () => {
    const a = await member();
    const b = await member('Busan');
    const id = await requestExchange(a, b);
    expect((await call(t, b.user, 'POST', `/v1/exchanges/${id}/accept`, { offerVersion: 1 })).status).toBe(200);
    const ackA = await call(t, a.user, 'POST', `/v1/exchanges/${id}/safety-ack`, { acknowledged: true }, { 'user-agent': 'VictimUA/1.0' });
    expect(ackA.status, show(ackA)).toBe(200);

    const seenByB = await call(t, b.user, 'GET', `/v1/exchanges/${id}`);
    expect(JSON.stringify(seenByB.body)).not.toContain('VictimUA');
    const aAck = seenByB.body.item.verifications.find((v: any) => v.partyUserId === a.user.id && v.checkType === 'SAFETY_ACK');
    expect(aAck).toEqual({ partyUserId: a.user.id, checkType: 'SAFETY_ACK', status: 'PASSED', checkedAt: expect.anything() });
    // the stored check holds no personal data; the acknowledgement evidence is in the append-only audit log
    const row = (await t.pool.query(`SELECT detail FROM exchange_verifications WHERE exchange_id = $1 AND party_user_id = $2 AND check_type = 'SAFETY_ACK'`, [id, a.user.id])).rows[0];
    expect(Object.keys(row.detail)).toEqual(['acknowledgedAt']);
    expect(await auditRows(a.user.id, 'exchange.safety_acknowledged')).toEqual([expect.objectContaining({ category: 'COMPLIANCE', resource_id: id, user_agent: 'VictimUA/1.0' })]);

    // A is sanctioned and a third user reports B's home
    await t.pool.query(`INSERT INTO sanctions(user_id, sanction_type, reason, issued_by) VALUES ($1,'LISTING_SUSPENSION','test',$2)`, [a.user.id, admin.id]);
    const reporter = await createUser(t);
    await t.pool.query(`INSERT INTO safety_reports(reporter_id, subject_type, subject_id, category) VALUES ($1,'PROPERTY',$2,'SAFETY')`, [reporter.id, b.propertyId]);
    const ackB = await call(t, b.user, 'POST', `/v1/exchanges/${id}/safety-ack`, { acknowledged: true }, { 'user-agent': 'OwnerUA/2.0' });
    expect(ackB.status, show(ackB)).toBe(200);
    expect(ackB.body.item.status).toBe('VERIFICATION_PENDING');
    const rawB = JSON.stringify(ackB.body);
    for (const leak of ['ACTIVE_SANCTION', 'OPEN_SAFETY_REPORT', 'VictimUA', reporter.id]) expect(rawB).not.toContain(leak);
    // B learns only that its own home is under review (actionable), and only the status of A's checks
    expect(ackB.body.checks.find((c: any) => c.partyUserId === b.user.id && c.checkType === 'PROPERTY')).toMatchObject({ status: 'FAILED', detail: { failures: ['PROPERTY_UNDER_REVIEW'] } });
    const aIdentity = ackB.body.checks.find((c: any) => c.partyUserId === a.user.id && c.checkType === 'IDENTITY');
    expect(aIdentity.status).toBe('FAILED');
    expect(aIdentity).not.toHaveProperty('detail');

    const seenByA = await call(t, a.user, 'GET', `/v1/exchanges/${id}`);
    const rawA = JSON.stringify(seenByA.body);
    for (const leak of ['OPEN_SAFETY_REPORT', 'PROPERTY_UNDER_REVIEW', 'OwnerUA']) expect(rawA).not.toContain(leak);
    expect(seenByA.body.item.verifications.find((v: any) => v.partyUserId === a.user.id && v.checkType === 'IDENTITY').detail.failures).toEqual(['ACTIVE_SANCTION']);
  });
});

describe('EXCH staff reads are case-scoped (invariant 10)', () => {
  it('only exchange case staff may read; private offer messages and addresses need an elevated-access grant', async () => {
    const a = await member();
    const b = await member('Busan');
    const secret = 'PRIVATE: my kid has asthma, call me at 010-1234-5678';
    const id = await toConfirmed(a, b, secret);
    for (const role of ['EDITOR', 'ACCOUNTING'] as const) {
      const u = await createUser(t, { roles: [role] });
      expect((await call(t, u, 'GET', `/v1/exchanges/${id}`)).status, role).toBe(404);
      expect((await call(t, u, 'GET', `/v1/exchanges/${id}/agreement`)).status, role).toBe(404);
    }
    const support = await createUser(t, { roles: ['SUPPORT'] });
    const s1 = await call(t, support, 'GET', `/v1/exchanges/${id}`);
    expect(s1.status, show(s1)).toBe(200);
    expect(s1.body.item.offers[0]).toMatchObject({ version: 1, message: null, messageWithheld: true });
    expect(s1.body.item.currentOffer.message).toBeNull();
    expect(s1.body.item.addresses).toBeNull();
    expect(s1.body.item.staffAccess).toEqual({ elevatedGrantId: null, privateContent: false });
    expect(JSON.stringify(s1.body)).not.toContain('010-1234-5678');
    expect(JSON.stringify(s1.body)).not.toContain('Secret-ro');
    expect(await auditRows(support.id, 'exchange.read')).toEqual([expect.objectContaining({ category: 'ELEVATED_ACCESS', resource_id: id })]);

    // a dispute on the exchange + a case-scoped grant on the exchange conversation
    const d = await call(t, a.user, 'POST', `/v1/exchanges/${id}/dispute`, { reason: 'home not as described' });
    expect(d.status, show(d)).toBe(201);
    const g = await call(t, support, 'POST', `/v1/admin/disputes/${d.body.disputeId}/elevated-access`, { conversationId: s1.body.item.conversationId, reason: 'reviewing the negotiation for the open dispute' });
    expect(g.status, show(g)).toBe(201);
    const s2 = await call(t, support, 'GET', `/v1/exchanges/${id}`);
    expect(s2.body.item.offers[0].message).toBe(secret);
    expect(s2.body.item.addresses.A.line1).toBe('123 Secret-ro');
    expect(s2.body.item.staffAccess).toEqual({ elevatedGrantId: g.body.item.id, privateContent: true });
    // the parties always see their own negotiation
    expect((await call(t, b.user, 'GET', `/v1/exchanges/${id}`)).body.item.offers[0].message).toBe(secret);
  });
});

describe('EXCH impossible calendar dates', () => {
  it('Feb 30 / month 13 are a 400, never a 500 (discovery, request and counter)', async () => {
    const a = await member();
    const b = await member('Busan');
    const y = new Date().getUTCFullYear() + 1;
    for (const qs of [`start=${y}-02-30&end=${y}-03-03`, `start=${y}-13-01&end=${y}-13-05`]) {
      const r = await call(t, a.user, 'GET', `/v1/exchange/homes?${qs}`);
      expect(r.status, qs).toBe(400);
    }
    expect((await call(t, a.user, 'GET', `/v1/exchange/homes?start=${y}-03-01&end=${y}-03-03`)).status).toBe(200);
    const bad = await call(t, a.user, 'POST', '/v1/exchanges', { myPropertyId: a.propertyId, theirPropertyId: b.propertyId, datesA: { start: `${y}-02-30`, end: `${y}-03-03` }, datesB: B_DATES });
    expect(bad.status).toBe(400);
    const id = await requestExchange(a, b);
    const counter = await call(t, b.user, 'POST', `/v1/exchanges/${id}/counter`, { expectedVersion: 1, datesB: { start: `${y}-02-31`, end: `${y}-03-05` } });
    expect(counter.status).toBe(400);
  });
});

describe('EXCH dispute resolution lifts the DISPUTED freeze', () => {
  it('an upheld dispute cancels the exchange and frees both calendars', async () => {
    const a = await member();
    const b = await member('Busan');
    const id = await toConfirmed(a, b);
    const d = await call(t, a.user, 'POST', `/v1/exchanges/${id}/dispute`, { reason: 'changed my mind' });
    expect(d.status).toBe(201);
    // while the dispute is open B cannot use its dates
    expect((await call(t, b.user, 'POST', `/v1/properties/${b.propertyId}/blocks`, B_DATES)).status).toBe(409);
    const res = await call(t, admin, 'POST', `/v1/admin/disputes/${d.body.disputeId}/resolve`, { outcome: 'RESOLVED', resolution: 'exchange cancelled, B not at fault', detail: { favour: 'B' } });
    expect(res.status, show(res)).toBe(200);
    await t.drain();
    expect((await call(t, b.user, 'GET', `/v1/exchanges/${id}`)).body.item.status).toBe('CANCELLED');
    expect((await exchangeBlocks(id)).map((x) => x.state)).toEqual(['RELEASED', 'RELEASED']);
    expect((await call(t, b.user, 'POST', `/v1/properties/${b.propertyId}/blocks`, B_DATES)).status).toBe(201);
    const hist = (await t.pool.query(`SELECT from_state, to_state, metadata FROM state_transitions WHERE aggregate_type = 'EXCHANGE' AND aggregate_id = $1 ORDER BY id`, [id])).rows;
    expect(hist.at(-1)).toMatchObject({ from_state: 'DISPUTED', to_state: 'CANCELLED', metadata: { disputeId: d.body.disputeId, outcome: 'RESOLVED' } });
  });

  it('a rejected dispute restores CONFIRMED (blocks kept); leaving then needs a normal cancellation', async () => {
    const a = await member();
    const b = await member('Busan');
    const id = await toConfirmed(a, b);
    const d = await call(t, a.user, 'POST', `/v1/exchanges/${id}/dispute`, { reason: 'want out without the late policy' });
    expect(d.status).toBe(201);
    expect((await call(t, a.user, 'POST', `/v1/exchanges/${id}/cancel`, { reason: 'let me out' })).status).toBe(409);
    expect((await call(t, admin, 'POST', `/v1/admin/disputes/${d.body.disputeId}/resolve`, { outcome: 'REJECTED', resolution: 'no merit' })).status).toBe(200);
    await t.drain();
    expect((await call(t, a.user, 'GET', `/v1/exchanges/${id}`)).body.item.status).toBe('CONFIRMED');
    expect((await exchangeBlocks(id)).every((x) => x.state === 'ACTIVE')).toBe(true);
    const cx = await call(t, a.user, 'POST', `/v1/exchanges/${id}/cancel`, { reason: 'I need to leave anyway' });
    expect(cx.status, show(cx)).toBe(200);
    expect(cx.body.item.status).toBe('CANCELLED');
    expect((await exchangeBlocks(id)).every((x) => x.state === 'RELEASED')).toBe(true);
  });
});

// ================================================================================================ guide

describe('GUIDE qualification review is four-eyes', () => {
  it('a compliance officer cannot verify (or reject) their own qualification to unlock paid guiding', async () => {
    const officer = await createUser(t, { roles: ['COMPLIANCE'], verified: true });
    expect((await call(t, officer, 'POST', '/v1/guides/profile', { guideType: 'PAID', hourlyPriceMinor: 30000 })).status).toBe(201);
    const q = await call(t, officer, 'POST', '/v1/guides/qualifications', { qualificationType: 'BUSINESS_REGISTRATION', documentMediaId: await media(officer), validUntil: '2099-12-31' });
    expect(q.status).toBe(201);
    for (const action of ['verify', 'reject']) {
      const self = await call(t, officer, 'POST', `/v1/admin/guide-qualifications/${q.body.item.id}/${action}`, {});
      expect(self.status, action).toBe(403);
      expect(self.body.code).toBe('FOUR_EYES_REQUIRED');
    }
    expect((await call(t, officer, 'POST', '/v1/guides/profile/publish')).status).toBe(422);
    const ok = await call(t, compliance, 'POST', `/v1/admin/guide-qualifications/${q.body.item.id}/verify`, {});
    expect(ok.status).toBe(200);
    expect(ok.body.item.verified_by).toBe(compliance.id);
    expect((await call(t, officer, 'POST', '/v1/guides/profile/publish')).body.item).toMatchObject({ status: 'PUBLISHED', paid_enabled: true });
  });
});

describe('GUIDE search distance', () => {
  it('distanceKm is derived from the public ≈1 km point only, so it cannot be trilaterated', async () => {
    const city = `Tria${randomUUID().slice(0, 6)}`;
    const g1 = await guide('FRIEND', { city, lat: 37.564912, lng: 126.984937 });
    const g2 = await guide('FRIEND', { city, lat: 37.5612, lng: 126.9761 }); // another exact point in the same public cell
    expect((await call(t, null, 'GET', `/v1/guides/${g1.id}`)).body.item).toMatchObject({ approxLat: 37.56, approxLng: 126.98 });
    for (const [lat, lng] of [[37.58, 126.96], [37.55, 126.97], [37.57, 127.01], [37.5649, 126.9849]]) {
      const r = await call(t, null, 'GET', `/v1/search/guides?city=${city}&lat=${lat}&lng=${lng}`);
      expect(r.status).toBe(200);
      const m1 = r.body.items.find((x: any) => x.guide.guideId === g1.id);
      const m2 = r.body.items.find((x: any) => x.guide.guideId === g2.id);
      expect(Number.isInteger(m1.distanceKm)).toBe(true);
      expect(m1.distanceKm).toBe(coarseDistanceKm(lat, lng, 37.56, 126.98));
      // two different exact locations in the same cell are indistinguishable in every returned number
      expect(m2.distanceKm).toBe(m1.distanceKm);
      expect(m2.components.distance).toBe(m1.components.distance);
      expect(m2.score).toBe(m1.score);
    }
  });
});

describe('GUIDE cancellation / completion around the activity time', () => {
  it('a traveler cannot cancel a started activity (dispute instead); the guide completes only after the end', async () => {
    const g = await guide('PAID', { hourlyPriceMinor: 100000 });
    const traveler = await createUser(t);
    const id = await book(g, traveler, 20, 180, { paid: true, priceMinor: 100000 });
    await payViaMock(traveler, 'GUIDE_BOOKING', id);
    expect(await bookingStatus(id)).toBe('CONFIRMED');
    expect((await call(t, g, 'POST', `/v1/guide-bookings/${id}/start`)).body.item.status).toBe('IN_PROGRESS');
    const tc = await call(t, traveler, 'POST', `/v1/guide-bookings/${id}/cancel`, { reason: 'after the tour' }, idem());
    expect(tc.status).toBe(409);
    expect(tc.body.code).toBe('ACTIVITY_STARTED');
    const early = await call(t, g, 'POST', `/v1/guide-bookings/${id}/complete`);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('ACTIVITY_NOT_ENDED');
    // the tour is over but inside the auto-complete grace: still no automatic half refund for the traveler
    await t.pool.query(`UPDATE guide_bookings SET start_at = now() - interval '190 minutes', end_at = now() - interval '10 minutes' WHERE id = $1`, [id]);
    expect((await call(t, traveler, 'POST', `/v1/guide-bookings/${id}/cancel`, { reason: 'after the tour' }, idem())).body.code).toBe('ACTIVITY_STARTED');
    await t.drain();
    expect(await guideRefunds(id)).toEqual([]);
    const done = await call(t, g, 'POST', `/v1/guide-bookings/${id}/complete`);
    expect(done.status, show(done)).toBe(200);
    expect(done.body.item.status).toBe('COMPLETED');
  });

  it('once the start time passed a CONFIRMED booking is not traveler-cancellable; the guide still can (full refund)', async () => {
    const g = await guide('PAID', { hourlyPriceMinor: 60000 });
    const traveler = await createUser(t);
    const id = await book(g, traveler, 20, 60, { paid: true, priceMinor: 60000 });
    await payViaMock(traveler, 'GUIDE_BOOKING', id);
    await t.pool.query(`UPDATE guide_bookings SET start_at = now() - interval '1 minute', end_at = now() + interval '59 minutes' WHERE id = $1`, [id]);
    expect((await call(t, traveler, 'POST', `/v1/guide-bookings/${id}/cancel`, {}, idem())).body.code).toBe('ACTIVITY_STARTED');
    const gc = await call(t, g, 'POST', `/v1/guide-bookings/${id}/cancel`, { reason: 'sick' }, idem());
    expect(gc.status, show(gc)).toBe(200);
    expect(gc.body.refund).toMatchObject({ refundMinor: 60000, refundPct: 100, policy: 'GUIDE_OR_SYSTEM_CANCEL_FULL' });
  });
});

describe('GUIDE booking disputes go through TRUST-03', () => {
  it('a dispute opens a case for staff; a rejected dispute returns the booking to COMPLETED (settlement-eligible)', async () => {
    const g = await guide('PAID', { hourlyPriceMinor: 50000 });
    const traveler = await createUser(t);
    const id = await book(g, traveler, 20, 60, { paid: true, priceMinor: 50000 });
    await payViaMock(traveler, 'GUIDE_BOOKING', id);
    expect((await call(t, g, 'POST', `/v1/guide-bookings/${id}/start`)).status).toBe(200);
    expect((await call(t, traveler, 'POST', `/v1/guide-bookings/${id}/complete`)).body.item.status).toBe('COMPLETED');
    const d = await call(t, traveler, 'POST', `/v1/guide-bookings/${id}/dispute`, { reason: 'the guide left after 10 minutes' });
    expect(d.status, show(d)).toBe(200);
    expect(d.body.item.status).toBe('DISPUTED');
    const rows = (await t.pool.query(`SELECT id, context_type, opened_by, counterparty_id, status FROM disputes WHERE context_id = $1`, [id])).rows;
    expect(rows).toEqual([{ id: d.body.disputeId, context_type: 'GUIDE_BOOKING', opened_by: traveler.id, counterparty_id: g.id, status: 'OPEN' }]);
    const queue = await call(t, admin, 'GET', '/v1/admin/disputes');
    expect(queue.body.items.map((x: any) => x.id)).toContain(d.body.disputeId);
    expect((await call(t, admin, 'POST', `/v1/admin/disputes/${d.body.disputeId}/resolve`, { outcome: 'REJECTED', resolution: 'activity was delivered' })).status).toBe(200);
    await t.drain();
    expect(await bookingStatus(id)).toBe('COMPLETED');
    const hist = (await t.pool.query(`SELECT from_state, to_state, metadata FROM state_transitions WHERE aggregate_type = 'GUIDE_BOOKING' AND aggregate_id = $1 ORDER BY id`, [id])).rows;
    expect(hist.slice(-2).map((h) => [h.from_state, h.to_state])).toEqual([['COMPLETED', 'DISPUTED'], ['DISPUTED', 'COMPLETED']]);
    expect(hist.at(-2).metadata.disputeId).toBe(d.body.disputeId);
  });

  it('an upheld dispute on a future booking can cancel it; without an outcome the booking resumes', async () => {
    const g = await guide('FRIEND');
    const traveler = await createUser(t);
    const first = await book(g, traveler, 3 * 24 * 60, 60);
    const d1 = await call(t, traveler, 'POST', `/v1/guide-bookings/${first}/dispute`, { reason: 'the guide asked me to pay cash' });
    expect(d1.status).toBe(200);
    expect((await call(t, admin, 'POST', `/v1/admin/disputes/${d1.body.disputeId}/resolve`, { outcome: 'RESOLVED', resolution: 'booking cancelled', detail: { bookingOutcome: 'CANCELLED' } })).status).toBe(200);
    const second = await book(g, traveler, 4 * 24 * 60, 60);
    const d2 = await call(t, traveler, 'POST', `/v1/guide-bookings/${second}/dispute`, { reason: 'meeting point unclear' });
    expect((await call(t, admin, 'POST', `/v1/admin/disputes/${d2.body.disputeId}/resolve`, { outcome: 'RESOLVED', resolution: 'clarified with both parties' })).status).toBe(200);
    await t.drain();
    expect(await bookingStatus(first)).toBe('CANCELLED');
    expect(await bookingStatus(second)).toBe('CONFIRMED');
  });
});

describe('GUIDE payment re-checks the paid gate (invariant 7)', () => {
  it('a lapsed qualification or a suspended guide is never paid', async () => {
    // A: the qualification lapses after the traveler accepted → prepare is refused
    const gA = await guide('PAID', { hourlyPriceMinor: 50000 });
    const tA = await createUser(t);
    const idA = await book(gA, tA, 3 * 24 * 60, 60, { paid: true, priceMinor: 50000 });
    await t.pool.query(`UPDATE guide_qualifications SET valid_until = current_date - 1 WHERE guide_id = $1`, [gA.id]);
    expect(await runQualificationExpiry(t.app.ctx)).toBeGreaterThanOrEqual(1);
    const pA = await call(t, tA, 'POST', '/v1/payments/toss/prepare', { subjectType: 'GUIDE_BOOKING', subjectId: idA }, idem());
    expect(pA.status, show(pA)).toBe(409);
    expect(pA.body).toMatchObject({ code: 'NOT_PAYABLE', details: { reason: 'GUIDE_NOT_PUBLISHED' } });

    // B: the guide is suspended between prepare and the provider confirmation → captured, cancelled, refunded in full
    const gB = await guide('PAID', { hourlyPriceMinor: 40000 });
    const tB = await createUser(t);
    const idB = await book(gB, tB, 3 * 24 * 60, 60, { paid: true, priceMinor: 40000 });
    const idB2 = await book(gB, tB, 5 * 24 * 60, 60, { paid: true, priceMinor: 40000 });
    const p = await call(t, tB, 'POST', '/v1/payments/toss/prepare', { subjectType: 'GUIDE_BOOKING', subjectId: idB }, idem());
    expect(p.status).toBe(201);
    expect((await call(t, admin, 'POST', `/v1/admin/users/${gB.id}/suspend`, { reason: 'fraud investigation' })).status).toBe(200);
    const c = await call(t, tB, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${randomUUID().replace(/-/g, '')}`, orderId: p.body.orderId, amount: p.body.amount }, idem());
    expect(c.status, show(c)).toBe(200);
    expect(await bookingStatus(idB)).toBe('CANCELLED');
    expect((await guideRefunds(idB)).map((r) => r.amount_minor)).toEqual([40000]);
    // and an accepted booking of the suspended guide cannot even be prepared
    const p2 = await call(t, tB, 'POST', '/v1/payments/toss/prepare', { subjectType: 'GUIDE_BOOKING', subjectId: idB2 }, idem());
    expect(p2.status).toBe(409);
    expect(p2.body.details.reason).toBe('GUIDE_ACCOUNT_NOT_ACTIVE');
  });
});
