import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, createUser, call, idem, enableFlags, type TestApp, type TestUser } from './helpers.js';
import { withTx } from '../src/platform/db.js';
import { emit } from '../src/platform/outbox.js';
import { paymentSubject } from '../src/platform/payment-subjects.js';
import { computeGuideRefund, runBookingLifecycle } from '../src/modules/guide/bookings.js';
import { expireRequests } from '../src/modules/guide/requests.js';
import { zonedToUtc, subtractIntervals } from '../src/modules/guide/availability.js';
import type { Ctx } from '../src/platform/context.js';

let t: TestApp;
let compliance: TestUser;

const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();
const H = 60;

async function media(u: TestUser) {
  const { rows } = await t.pool.query(
    `INSERT INTO media_assets(owner_id, storage_key, purpose, mime_type, byte_size, status) VALUES ($1,$2,'VERIFICATION','application/pdf',100,'READY') RETURNING id`,
    [u.id, `test/${randomUUID()}`],
  );
  return rows[0].id as string;
}

async function addQualification(u: TestUser, type: string, verify = true) {
  const r = await call(t, u, 'POST', '/v1/guides/qualifications', { qualificationType: type, documentMediaId: await media(u), validUntil: '2099-12-31' });
  expect(r.status).toBe(201);
  if (verify) expect((await call(t, compliance, 'POST', `/v1/admin/guide-qualifications/${r.body.item.id}/verify`, {})).status).toBe(200);
  return r.body.item.id as string;
}

async function guide(type: 'FRIEND' | 'VOLUNTEER' | 'PAID' | 'PROFESSIONAL', extra: Record<string, unknown> = {}, publish = true) {
  const u = await createUser(t, { verified: true });
  const p = await call(t, u, 'POST', '/v1/guides/profile', { guideType: type, city: 'Seoul', languages: ['ko', 'en'], interests: ['food'], ...extra });
  expect(p.status).toBe(201);
  if (type === 'PAID') await addQualification(u, 'BUSINESS_REGISTRATION');
  if (type === 'PROFESSIONAL') {
    await addQualification(u, 'BUSINESS_REGISTRATION');
    await addQualification(u, 'GUIDE_LICENSE');
    await addQualification(u, 'INSURANCE');
  }
  if (publish) expect((await call(t, u, 'POST', '/v1/guides/profile/publish')).status).toBe(200);
  return u;
}

async function approvePaidRules() {
  if ((await t.pool.query(`SELECT 1 FROM compliance_rules WHERE rule_key = 'guide.paid.kr'`)).rowCount) return;
  await t.pool.query(
    `INSERT INTO compliance_rules(rule_key, subject_type, jurisdiction, applies_to, required_permit_types, effective_from, status, approved_at, note)
     VALUES ('guide.paid.kr','GUIDE','KR','{"guide_type":["PAID"]}','{BUSINESS_REGISTRATION}', current_date - 1, 'APPROVED', now(), 'test'),
            ('guide.pro.kr','GUIDE','KR','{"guide_type":["PROFESSIONAL"]}','{BUSINESS_REGISTRATION,GUIDE_LICENSE|TRAVEL_AGENCY_REGISTRATION,INSURANCE}', current_date - 1, 'APPROVED', now(), 'test')`,
  );
}

/** request → guide offer → traveler accept; returns booking */
async function book(g: TestUser, traveler: TestUser, startMin: number, durMin: number, offer: { paid?: boolean; priceMinor?: number } = {}) {
  const req = await call(t, traveler, 'POST', '/v1/guide-requests', { guideId: g.id, startAt: at(startMin), endAt: at(startMin + durMin), partySize: 2, languages: ['ko'] });
  expect(req.status).toBe(201);
  const o = await call(t, g, 'POST', `/v1/guide-requests/${req.body.item.id}/offers`, { startAt: at(startMin), endAt: at(startMin + durMin), paid: offer.paid ?? false, priceMinor: offer.priceMinor ?? 0, itinerary: 'Market tour' });
  expect(o.status).toBe(201);
  const a = await call(t, traveler, 'POST', `/v1/guide-requests/${req.body.item.id}/accept`, { offerVersion: o.body.offer.version }, idem());
  return { requestId: req.body.item.id as string, accept: a };
}

const ctxAs = (userId: string | null): Ctx => ({ ...t.ctx(), actor: userId ? { userId, sessionId: 'x', roles: ['USER'], aal: 'aal1', status: 'ACTIVE' } : null });

beforeAll(async () => {
  t = await createTestApp();
  compliance = await createUser(t, { roles: ['COMPLIANCE'] });
});
afterAll(async () => t.close());

describe('GUIDE-01 profile & publication gate', () => {
  it('FRIEND/VOLUNTEER cannot set a price', async () => {
    const u = await createUser(t, { verified: true });
    const r = await call(t, u, 'POST', '/v1/guides/profile', { guideType: 'FRIEND', hourlyPriceMinor: 10000 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('FREE_GUIDE_PRICE_NOT_ALLOWED');
    expect((await call(t, u, 'POST', '/v1/guides/profile', { guideType: 'VOLUNTEER' })).status).toBe(201);
    expect((await call(t, u, 'PATCH', '/v1/guides/profile', { hourlyPriceMinor: 5000 })).body.code).toBe('FREE_GUIDE_PRICE_NOT_ALLOWED');
    expect((await call(t, u, 'POST', '/v1/guides/profile', { guideType: 'FRIEND' })).status).toBe(409);
  });

  it('publication requires identity verification; first publish grants GUIDE role with history + audit', async () => {
    const u = await createUser(t, { verified: false });
    await call(t, u, 'POST', '/v1/guides/profile', { guideType: 'FRIEND', city: 'Busan' });
    const denied = await call(t, u, 'POST', '/v1/guides/profile/publish');
    expect(denied.status).toBe(422);
    expect(denied.body.code).toBe('GUIDE_PUBLICATION_DENIED');
    expect(denied.body.details.reasons).toContain('IDENTITY_NOT_VERIFIED');
    // the DENY decision is durable even though the request failed
    const dec = await t.pool.query(`SELECT decision FROM compliance_decisions WHERE subject_type = 'GUIDE' AND subject_id = $1`, [u.id]);
    expect(dec.rows.map((r) => r.decision)).toEqual(['DENY']);
    expect((await call(t, null, 'GET', `/v1/guides/${u.id}`)).status).toBe(404);

    await t.pool.query(`UPDATE users SET identity_verified_at = now() WHERE id = $1`, [u.id]);
    const ok = await call(t, u, 'POST', '/v1/guides/profile/publish');
    expect(ok.status).toBe(200);
    expect(ok.body.item.paid_enabled).toBe(false);
    const roles = await t.pool.query(`SELECT role FROM user_roles WHERE user_id = $1`, [u.id]);
    expect(roles.rows.map((r) => r.role)).toContain('GUIDE');
    expect((await t.pool.query(`SELECT 1 FROM role_grants WHERE user_id = $1 AND role = 'GUIDE' AND action = 'GRANT'`, [u.id])).rowCount).toBe(1);
    expect((await t.pool.query(`SELECT 1 FROM audit_logs WHERE resource_id = $1 AND category = 'PERMISSION'`, [u.id])).rowCount).toBe(1);
    const pub = await call(t, null, 'GET', `/v1/guides/${u.id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.item).toMatchObject({ guideType: 'FRIEND', free: true, verified: true });
    const me = await call(t, u, 'GET', '/v1/guides/me');
    expect(me.body.eligibility.publishable).toBe(true);
  });

  it('paid publication is denied without approved rule, qualification, or flag (fail closed)', async () => {
    const u = await createUser(t, { verified: true });
    await call(t, u, 'POST', '/v1/guides/profile', { guideType: 'PAID', hourlyPriceMinor: 30000 });
    let r = await call(t, u, 'POST', '/v1/guides/profile/publish');
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('GUIDE_PAID_GATE_FAILED');
    expect(r.body.details.reasons).toEqual(expect.arrayContaining(['NO_APPROVED_COMPLIANCE_RULE', 'FEATURE_DISABLED:guide.paid']));

    // a DRAFT (unapproved) rule does not count
    await t.pool.query(`INSERT INTO compliance_rules(rule_key, subject_type, jurisdiction, applies_to, required_permit_types, effective_from, status)
                        VALUES ('guide.paid.draft','GUIDE','KR','{"guide_type":["PAID"]}','{OTHER}', current_date - 1, 'DRAFT')`);
    r = await call(t, u, 'POST', '/v1/guides/profile/publish');
    expect(r.body.details.reasons).toContain('NO_APPROVED_COMPLIANCE_RULE');

    await approvePaidRules();
    r = await call(t, u, 'POST', '/v1/guides/profile/publish');
    expect(r.body.details.reasons).toContain('QUALIFICATION_MISSING:BUSINESS_REGISTRATION');
    expect(r.body.details.reasons).not.toContain('NO_APPROVED_COMPLIANCE_RULE');

    const qid = await addQualification(u, 'BUSINESS_REGISTRATION', false); // pending ≠ verified
    r = await call(t, u, 'POST', '/v1/guides/profile/publish');
    expect(r.body.details.reasons).toContain('QUALIFICATION_MISSING:BUSINESS_REGISTRATION');
    expect((await call(t, compliance, 'POST', `/v1/admin/guide-qualifications/${qid}/verify`, {})).status).toBe(200);
    expect((await t.pool.query(`SELECT 1 FROM audit_logs WHERE resource_id = $1 AND category = 'COMPLIANCE'`, [qid])).rowCount).toBe(1);

    r = await call(t, u, 'POST', '/v1/guides/profile/publish');
    expect(r.status).toBe(422);
    expect(r.body.details.reasons).toEqual(['FEATURE_DISABLED:guide.paid']);
    expect((await t.pool.query(`SELECT paid_enabled, status FROM guide_profiles WHERE user_id = $1`, [u.id])).rows[0]).toEqual({ paid_enabled: false, status: 'DRAFT' });

    await enableFlags(t, 'guide.paid');
    r = await call(t, u, 'POST', '/v1/guides/profile/publish');
    expect(r.status).toBe(200);
    expect(r.body.item).toMatchObject({ status: 'PUBLISHED', paid_enabled: true, verification_status: 'VERIFIED' });
  });

  it('PROFESSIONAL needs every configured requirement incl. any-of groups; rejection lapses paid selling', async () => {
    const u = await createUser(t, { verified: true });
    await call(t, u, 'POST', '/v1/guides/profile', { guideType: 'PROFESSIONAL', hourlyPriceMinor: 80000 });
    await addQualification(u, 'BUSINESS_REGISTRATION');
    await addQualification(u, 'TRAVEL_AGENCY_REGISTRATION'); // satisfies GUIDE_LICENSE|TRAVEL_AGENCY_REGISTRATION
    let r = await call(t, u, 'POST', '/v1/guides/profile/publish');
    expect(r.status).toBe(422);
    expect(r.body.details.reasons).toEqual(['QUALIFICATION_MISSING:INSURANCE']);
    const ins = await addQualification(u, 'INSURANCE');
    r = await call(t, u, 'POST', '/v1/guides/profile/publish');
    expect(r.status).toBe(200);
    expect(r.body.item.paid_enabled).toBe(true);
    // insurance later expires → job hides profile and disables paid selling
    await t.pool.query(`UPDATE guide_qualifications SET valid_until = current_date - 1 WHERE id = $1`, [ins]);
    const { runQualificationExpiry } = await import('../src/modules/guide/index.js');
    await runQualificationExpiry(t.app.ctx);
    expect((await t.pool.query(`SELECT paid_enabled, status FROM guide_profiles WHERE user_id = $1`, [u.id])).rows[0]).toEqual({ paid_enabled: false, status: 'HIDDEN' });
  });

  it('qualification review requires COMPLIANCE/ADMIN with AAL2', async () => {
    const u = await createUser(t, { verified: true });
    await call(t, u, 'POST', '/v1/guides/profile', { guideType: 'PAID' });
    const q = await call(t, u, 'POST', '/v1/guides/qualifications', { qualificationType: 'BUSINESS_REGISTRATION', documentMediaId: await media(u) });
    const other = await createUser(t);
    expect((await call(t, u, 'POST', '/v1/guides/qualifications', { qualificationType: 'OTHER', documentMediaId: await media(other) })).body.code).toBe('DOCUMENT_NOT_FOUND');
    expect((await call(t, u, 'POST', `/v1/admin/guide-qualifications/${q.body.item.id}/verify`, {})).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['COMPLIANCE'], aal: 'aal1' });
    const r = await call(t, aal1, 'POST', `/v1/admin/guide-qualifications/${q.body.item.id}/verify`, {});
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('AAL2_REQUIRED');
    expect((await call(t, compliance, 'POST', `/v1/admin/guide-qualifications/${q.body.item.id}/reject`, { reason: 'blurry' })).body.item.status).toBe('REJECTED');
    expect((await call(t, compliance, 'POST', `/v1/admin/guide-qualifications/${q.body.item.id}/verify`, {})).status).toBe(409);
  });
});

describe('GUIDE-04/05 free flow', () => {
  it('FRIEND: request → offer → accept → CONFIRMED (no payment) → start → complete → REVIEWED', async () => {
    const g = await guide('FRIEND');
    const traveler = await createUser(t);
    const req = await call(t, traveler, 'POST', '/v1/guide-requests', { guideId: g.id, startAt: at(10), endAt: at(70), partySize: 2, languages: ['ko'], interests: ['food'] });
    expect(req.status).toBe(201);
    expect(req.body.item.status).toBe('REQUESTED');
    // FRIEND cannot sell
    const bad = await call(t, g, 'POST', `/v1/guide-requests/${req.body.item.id}/offers`, { startAt: at(10), endAt: at(70), paid: true, priceMinor: 1000 });
    expect(bad.body.code).toBe('FREE_GUIDE_PRICE_NOT_ALLOWED');
    const o = await call(t, g, 'POST', `/v1/guide-requests/${req.body.item.id}/offers`, { startAt: at(10), endAt: at(70), paid: false });
    expect(o.status).toBe(201);
    expect(o.body.item).toMatchObject({ status: 'OFFERED', current_offer_version: 1 });

    expect((await call(t, traveler, 'POST', `/v1/guide-requests/${req.body.item.id}/accept`, { offerVersion: 1 })).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const key = idem();
    const a = await call(t, traveler, 'POST', `/v1/guide-requests/${req.body.item.id}/accept`, { offerVersion: 1 }, key);
    expect(a.status).toBe(201);
    const b = a.body.booking;
    expect(b).toMatchObject({ status: 'CONFIRMED', paid: false, price_minor: 0 });
    expect(b.conversation_id).toBeTruthy();
    const replay = await call(t, traveler, 'POST', `/v1/guide-requests/${req.body.item.id}/accept`, { offerVersion: 1 }, key);
    expect(replay.status).toBe(201);
    expect(replay.body.booking.id).toBe(b.id);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM guide_bookings WHERE request_id = $1`, [req.body.item.id])).rows[0].n).toBe(1);
    expect((await t.pool.query(`SELECT 1 FROM payments WHERE subject_id = $1`, [b.id]).catch(() => ({ rowCount: 0 }))).rowCount).toBe(0);
    const evs = (await t.pool.query(`SELECT event_type FROM outbox_events WHERE aggregate_id IN ($1,$2)`, [b.id, req.body.item.id])).rows.map((r) => r.event_type);
    expect(evs).toEqual(expect.arrayContaining(['guide.requested', 'guide.offer.created', 'guide.offer.accepted', 'guide.booking.created', 'guide.booking.confirmed']));
    expect((await t.pool.query(`SELECT 1 FROM conversation_members WHERE conversation_id = $1`, [b.conversation_id])).rowCount).toBe(2);

    // invalid transition + permissions
    expect((await call(t, g, 'POST', `/v1/guide-bookings/${b.id}/complete`)).body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await call(t, traveler, 'POST', `/v1/guide-bookings/${b.id}/start`)).status).toBe(403);
    const stranger = await createUser(t);
    expect((await call(t, stranger, 'GET', `/v1/guide-bookings/${b.id}`)).status).toBe(404);
    expect((await call(t, stranger, 'POST', `/v1/guide-bookings/${b.id}/cancel`, {}, idem())).status).toBe(403);

    expect((await call(t, g, 'POST', `/v1/guide-bookings/${b.id}/start`)).body.item.status).toBe('IN_PROGRESS');
    expect((await call(t, traveler, 'POST', `/v1/guide-bookings/${b.id}/complete`)).body.item.status).toBe('COMPLETED');
    const mine = await call(t, traveler, 'GET', '/v1/guide-bookings?role=traveler');
    expect(mine.body.items.map((x: any) => x.id)).toContain(b.id);
    const detail = await call(t, g, 'GET', `/v1/guide-bookings/${b.id}`);
    expect(detail.body.item.history.map((h: any) => h.to_state)).toEqual(['ACCEPTED', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED']);

    // review.created (TRUST-02) from the traveler → REVIEWED + rating refresh
    const { rows } = await t.pool.query(
      `INSERT INTO reviews(author_id, target_type, target_id, transaction_type, transaction_id, rating) VALUES ($1,'GUIDE',$2,'GUIDE_BOOKING',$3,4) RETURNING id`,
      [traveler.id, g.id, b.id],
    );
    await withTx(t.pool, (tx) => emit(tx, t.ctx(), { aggregateType: 'review', aggregateId: rows[0].id, eventType: 'review.created', payload: { reviewId: rows[0].id, authorId: traveler.id, transactionType: 'GUIDE_BOOKING', transactionId: b.id } }));
    await t.drain();
    expect((await t.pool.query(`SELECT status FROM guide_bookings WHERE id = $1`, [b.id])).rows[0].status).toBe('REVIEWED');
    expect((await call(t, null, 'GET', `/v1/guides/${g.id}`)).body.item.ratingAvg).toBe(4);
  });

  it('counter-offer versioning: only the non-author accepts, and only the current version', async () => {
    const g = await guide('VOLUNTEER');
    const traveler = await createUser(t);
    const req = (await call(t, traveler, 'POST', '/v1/guide-requests', { guideId: g.id, startAt: at(5 * 24 * H), endAt: at(5 * 24 * H + 120) })).body.item;
    await call(t, g, 'POST', `/v1/guide-requests/${req.id}/offers`, { startAt: at(5 * 24 * H), endAt: at(5 * 24 * H + 120), paid: false });
    expect((await call(t, g, 'POST', `/v1/guide-requests/${req.id}/accept`, { offerVersion: 1 }, idem())).body.code).toBe('CANNOT_ACCEPT_OWN_OFFER');
    const c = await call(t, traveler, 'POST', `/v1/guide-requests/${req.id}/counter`, { startAt: at(5 * 24 * H + 60), endAt: at(5 * 24 * H + 180), priceMinor: 0 });
    expect(c.status).toBe(201);
    expect(c.body.item).toMatchObject({ status: 'COUNTERED', current_offer_version: 2 });
    expect((await call(t, g, 'POST', `/v1/guide-requests/${req.id}/counter`, { startAt: at(5 * 24 * H), endAt: at(5 * 24 * H + 60) })).status).toBe(403);
    expect((await call(t, traveler, 'POST', `/v1/guide-requests/${req.id}/accept`, { offerVersion: 2 }, idem())).body.code).toBe('CANNOT_ACCEPT_OWN_OFFER');
    const stale = await call(t, g, 'POST', `/v1/guide-requests/${req.id}/accept`, { offerVersion: 1 }, idem());
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OFFER_VERSION_MISMATCH');
    const ok = await call(t, g, 'POST', `/v1/guide-requests/${req.id}/accept`, { offerVersion: 2 }, idem());
    expect(ok.status).toBe(201);
    expect(new Date(ok.body.booking.start_at).toISOString()).toBe(new Date(c.body.offer.start_at).toISOString());
    const offers = (await call(t, traveler, 'GET', `/v1/guide-requests/${req.id}`)).body.item.offers;
    expect(offers.map((o: any) => [o.version, o.status])).toEqual([[1, 'SUPERSEDED'], [2, 'ACCEPTED']]);
  });

  it('request permissions: strangers cannot see/offer; traveler cancels, guide declines', async () => {
    const g = await guide('FRIEND');
    const traveler = await createUser(t);
    const stranger = await guide('FRIEND');
    const req = (await call(t, traveler, 'POST', '/v1/guide-requests', { guideId: g.id, startAt: at(3 * 24 * H), endAt: at(3 * 24 * H + 60) })).body.item;
    expect((await call(t, stranger, 'GET', `/v1/guide-requests/${req.id}`)).status).toBe(404);
    expect((await call(t, stranger, 'POST', `/v1/guide-requests/${req.id}/offers`, { startAt: at(3 * 24 * H), endAt: at(3 * 24 * H + 60), paid: false })).body.code).toBe('NOT_REQUEST_GUIDE');
    expect((await call(t, traveler, 'POST', '/v1/guide-requests', { guideId: traveler.id, startAt: at(60), endAt: at(120) })).status).toBe(422);
    expect((await call(t, traveler, 'POST', `/v1/guide-requests/${req.id}/decline`, {})).body.code).toBe('NOT_YOUR_TURN');
    expect((await call(t, g, 'POST', `/v1/guide-requests/${req.id}/decline`, { reason: 'busy' })).body.item.status).toBe('DECLINED');
    expect((await call(t, traveler, 'POST', `/v1/guide-requests/${req.id}/cancel`, {})).body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('double booking of the same guide for overlapping time → 409 GUIDE_UNAVAILABLE (also under concurrency)', async () => {
    const g = await guide('FRIEND');
    const t1 = await createUser(t), t2 = await createUser(t), t3 = await createUser(t);
    const first = await book(g, t1, 2 * 24 * H, 120);
    expect(first.accept.status).toBe(201);
    // overlapping offer is refused up-front
    const r2 = (await call(t, t2, 'POST', '/v1/guide-requests', { guideId: g.id, startAt: at(2 * 24 * H + 60), endAt: at(2 * 24 * H + 180) })).body.item;
    const o2 = await call(t, g, 'POST', `/v1/guide-requests/${r2.id}/offers`, { startAt: at(2 * 24 * H + 60), endAt: at(2 * 24 * H + 180), paid: false });
    expect(o2.status).toBe(409);
    expect(o2.body.code).toBe('GUIDE_UNAVAILABLE');

    // two open offers for the same new window; concurrent accepts → exactly one booking
    const mk = async (u: TestUser) => {
      const r = (await call(t, u, 'POST', '/v1/guide-requests', { guideId: g.id, startAt: at(4 * 24 * H), endAt: at(4 * 24 * H + 90) })).body.item;
      await call(t, g, 'POST', `/v1/guide-requests/${r.id}/offers`, { startAt: at(4 * 24 * H), endAt: at(4 * 24 * H + 90), paid: false });
      return r.id as string;
    };
    const [ra, rb] = [await mk(t2), await mk(t3)];
    const res = await Promise.all([
      call(t, t2, 'POST', `/v1/guide-requests/${ra}/accept`, { offerVersion: 1 }, idem()),
      call(t, t3, 'POST', `/v1/guide-requests/${rb}/accept`, { offerVersion: 1 }, idem()),
    ]);
    expect(res.map((x) => x.status).sort()).toEqual([201, 409]);
    expect(res.find((x) => x.status === 409)!.body.code).toBe('GUIDE_UNAVAILABLE');
  });
});

describe('GUIDE-05 paid flow & payment subject', () => {
  beforeAll(async () => {
    await approvePaidRules();
    await enableFlags(t, 'guide.paid');
  });
  it('PAID: accept → payable() → created → approved → CONFIRMED; amount validated; payer enforced', async () => {
    await t.pool.query(`INSERT INTO finance_rules(rule_type, domain, params, effective_from, status, approved_at) VALUES ('PLATFORM_FEE','GUIDE','{"bps":1000}', now() - interval '1 day', 'APPROVED', now())`);
    const g = await guide('PAID', { hourlyPriceMinor: 30000 });
    const traveler = await createUser(t);
    const req = (await call(t, traveler, 'POST', '/v1/guide-requests', { guideId: g.id, startAt: at(3 * 24 * H), endAt: at(3 * 24 * H + 120) })).body.item;
    expect((await call(t, g, 'POST', `/v1/guide-requests/${req.id}/offers`, { startAt: at(3 * 24 * H), endAt: at(3 * 24 * H + 120), paid: false })).body.code).toBe('PAID_FLAG_MISMATCH');
    await call(t, g, 'POST', `/v1/guide-requests/${req.id}/offers`, { startAt: at(3 * 24 * H), endAt: at(3 * 24 * H + 120), paid: true, priceMinor: 50000 });
    const a = await call(t, traveler, 'POST', `/v1/guide-requests/${req.id}/accept`, { offerVersion: 1 }, idem());
    expect(a.status).toBe(201);
    const id = a.body.booking.id;
    expect(a.body.booking).toMatchObject({ status: 'ACCEPTED', paid: true, price_minor: 50000 });

    const h = paymentSubject('GUIDE_BOOKING');
    await expect(withTx(t.pool, (tx) => h.payable(tx, ctxAs(g.id), id))).rejects.toMatchObject({ code: 'NOT_PAYER' });
    const snap = await withTx(t.pool, (tx) => h.payable(tx, ctxAs(traveler.id), id));
    expect(snap).toMatchObject({ payerId: traveler.id, amountMinor: 50000, currency: 'KRW', merchantOfRecord: 'JETPOOL' });
    expect(snap.split).toEqual([{ payeeId: g.id, payeeType: 'GUIDE', grossMinor: 50000, feeMinor: 5000, taxMinor: 0 }]);

    const pid = randomUUID();
    await withTx(t.pool, (tx) => h.onPaymentCreated!(tx, t.ctx(), id, pid));
    expect((await t.pool.query(`SELECT status FROM guide_bookings WHERE id = $1`, [id])).rows[0].status).toBe('PAYMENT_PENDING');
    await expect(withTx(t.pool, (tx) => h.payable(tx, ctxAs(traveler.id), id))).rejects.toMatchObject({ code: 'NOT_PAYABLE' });
    await expect(withTx(t.pool, (tx) => h.onPaymentApproved(tx, t.ctx(), id, { id: pid, amountMinor: 100, currency: 'KRW' }))).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_MISMATCH' });
    await withTx(t.pool, (tx) => h.onPaymentApproved(tx, t.ctx(), id, { id: pid, amountMinor: 50000, currency: 'KRW' }));
    await withTx(t.pool, (tx) => h.onPaymentApproved(tx, t.ctx(), id, { id: pid, amountMinor: 50000, currency: 'KRW' })); // replay no-op
    const b = (await t.pool.query(`SELECT status, conversation_id FROM guide_bookings WHERE id = $1`, [id])).rows[0];
    expect(b.status).toBe('CONFIRMED');
    expect(b.conversation_id).toBeTruthy();
    const hist = (await t.pool.query(`SELECT to_state FROM state_transitions WHERE aggregate_id = $1 ORDER BY created_at, id`, [id])).rows.map((r) => r.to_state);
    expect(hist).toEqual(['ACCEPTED', 'PAYMENT_PENDING', 'CONFIRMED']);
  });

  it('payment failure → PAYMENT_FAILED → retry payable; free bookings are not payable', async () => {
    const g = await guide('PAID', { hourlyPriceMinor: 20000 });
    const traveler = await createUser(t);
    const { accept } = await book(g, traveler, 6 * 24 * H, 60, { paid: true, priceMinor: 20000 });
    const id = accept.body.booking.id;
    const h = paymentSubject('GUIDE_BOOKING');
    await withTx(t.pool, (tx) => h.onPaymentCreated!(tx, t.ctx(), id, randomUUID()));
    await withTx(t.pool, (tx) => h.onPaymentFailed!(tx, t.ctx(), id, { id: randomUUID(), reason: 'card declined' }));
    expect((await t.pool.query(`SELECT status FROM guide_bookings WHERE id = $1`, [id])).rows[0].status).toBe('PAYMENT_FAILED');
    expect((await withTx(t.pool, (tx) => h.payable(tx, ctxAs(traveler.id), id))).amountMinor).toBe(20000);

    const f = await guide('FRIEND');
    const free = await book(f, traveler, 6 * 24 * H, 60);
    await expect(withTx(t.pool, (tx) => h.payable(tx, ctxAs(traveler.id), free.accept.body.booking.id))).rejects.toMatchObject({ code: 'NOT_PAYABLE' });
  });

  it('refund policy math', () => {
    const start = new Date('2026-12-01T10:00:00Z');
    expect(computeGuideRefund({ priceMinor: 50000, startAt: start, cancelledAt: new Date('2026-11-29T10:00:00Z'), cancelledBy: 'TRAVELER' })).toMatchObject({ refundMinor: 50000, policy: 'TRAVELER_24H_PLUS_FULL' });
    expect(computeGuideRefund({ priceMinor: 50000, startAt: start, cancelledAt: new Date('2026-11-30T10:00:00Z'), cancelledBy: 'TRAVELER' }).refundMinor).toBe(50000); // exactly 24h
    expect(computeGuideRefund({ priceMinor: 50001, startAt: start, cancelledAt: new Date('2026-11-30T10:00:01Z'), cancelledBy: 'TRAVELER' })).toMatchObject({ refundMinor: 25001, refundPct: 50 });
    expect(computeGuideRefund({ priceMinor: 50000, startAt: start, cancelledAt: new Date('2026-12-01T09:00:00Z'), cancelledBy: 'GUIDE' }).refundMinor).toBe(50000);
    expect(computeGuideRefund({ priceMinor: 50000, refundedMinor: 40000, startAt: start, cancelledAt: new Date('2026-11-01T00:00:00Z'), cancelledBy: 'TRAVELER' }).refundMinor).toBe(10000);
  });

  it('cancelling a confirmed paid booking requests the policy refund', async () => {
    const g = await guide('PAID', { hourlyPriceMinor: 40000 });
    const traveler = await createUser(t);
    const h = paymentSubject('GUIDE_BOOKING');
    const confirmed = async (startMin: number) => {
      const { accept } = await book(g, traveler, startMin, 60, { paid: true, priceMinor: 40000 });
      const id = accept.body.booking.id as string;
      // simulate the PAY-01 side: an approved provider payment for this subject
      const { rows } = await t.pool.query(
        `INSERT INTO payments(provider, provider_order_id, payer_id, subject_type, subject_id, status, amount_minor, currency, approved_at, expires_at)
         VALUES ('MOCK',$1,$2,'GUIDE_BOOKING',$3,'APPROVED',40000,'KRW',now(), now() + interval '1 hour') RETURNING id`,
        [`test-${randomUUID()}`, traveler.id, id],
      );
      await withTx(t.pool, (tx) => h.onPaymentApproved(tx, t.ctx(), id, { id: rows[0].id, amountMinor: 40000, currency: 'KRW' }));
      return id;
    };
    const refunds = async (id: string) =>
      (await t.pool.query(`SELECT r.amount_minor FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.subject_type = 'GUIDE_BOOKING' AND p.subject_id = $1`, [id])).rows.map((r) => r.amount_minor);

    const early = await confirmed(48 * H);
    const r1 = await call(t, traveler, 'POST', `/v1/guide-bookings/${early}/cancel`, { reason: 'plans changed' }, idem());
    expect(r1.status).toBe(200);
    expect(r1.body.item.status).toBe('CANCELLED');
    expect(r1.body.refund).toMatchObject({ refundMinor: 40000, policy: 'TRAVELER_24H_PLUS_FULL' });

    const late = await confirmed(10 * H);
    const r2 = await call(t, traveler, 'POST', `/v1/guide-bookings/${late}/cancel`, {}, idem());
    expect(r2.body.refund).toMatchObject({ refundMinor: 20000, refundPct: 50 });

    const byGuide = await confirmed(12 * H);
    const r3 = await call(t, g, 'POST', `/v1/guide-bookings/${byGuide}/cancel`, {}, idem());
    expect(r3.body.refund.refundMinor).toBe(40000);

    const cancelled = async (id: string) =>
      (await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'guide.booking.cancelled' AND aggregate_id = $1`, [id])).rows[0].payload;
    expect(await cancelled(early)).toMatchObject({ cancelledBy: 'TRAVELER', refundMinor: 40000 });
    expect(await cancelled(byGuide)).toMatchObject({ cancelledBy: 'GUIDE', refundMinor: 40000 });
    // PAY-02 requestRefund recorded one refund intent per cancellation with the policy amount
    expect(await refunds(early)).toEqual([40000]);
    expect(await refunds(late)).toEqual([20000]);
    expect(await refunds(byGuide)).toEqual([40000]);
    expect(r2.body.refund.refundId).toBeTruthy();
    expect((await t.pool.query(`SELECT 1 FROM audit_logs WHERE resource_id = $1 AND category = 'MONEY'`, [late])).rowCount).toBe(1);
    // already cancelled → invalid transition
    expect((await call(t, traveler, 'POST', `/v1/guide-bookings/${late}/cancel`, {}, idem())).body.code).toBe('INVALID_STATE_TRANSITION');
    // refunded webhook updates the display state
    await withTx(t.pool, (tx) => h.onRefunded!(tx, t.ctx(), late, { paymentId: randomUUID(), refundId: randomUUID(), amountMinor: 20000, totalRefundedMinor: 20000, fullyRefunded: false }));
    expect((await t.pool.query(`SELECT refunded_minor FROM guide_bookings WHERE id = $1`, [late])).rows[0].refunded_minor).toBe(20000);
  });

  it('paid offers are refused when guide.paid is turned OFF', async () => {
    const g = await guide('PAID', { hourlyPriceMinor: 10000 });
    const traveler = await createUser(t);
    const req = (await call(t, traveler, 'POST', '/v1/guide-requests', { guideId: g.id, startAt: at(9 * 24 * H), endAt: at(9 * 24 * H + 60) })).body.item;
    await t.pool.query(`UPDATE feature_flags SET enabled = false WHERE flag_key = 'guide.paid'`);
    try {
      const o = await call(t, g, 'POST', `/v1/guide-requests/${req.id}/offers`, { startAt: at(9 * 24 * H), endAt: at(9 * 24 * H + 60), paid: true, priceMinor: 10000 });
      expect(o.status).toBe(403);
      expect(o.body.code).toBe('FEATURE_DISABLED');
    } finally {
      await enableFlags(t, 'guide.paid');
    }
  });
});

describe('GUIDE-02/03 availability, search & matching', () => {
  it('availability: free slots minus bookings; weekly template is timezone-deterministic', async () => {
    expect(zonedToUtc('2026-12-07', '09:00', 'Asia/Seoul').toISOString()).toBe('2026-12-07T00:00:00.000Z');
    expect(zonedToUtc('2026-07-06', '09:00', 'America/New_York').toISOString()).toBe('2026-07-06T13:00:00.000Z');
    expect(zonedToUtc('2026-12-07', '09:00', 'America/New_York').toISOString()).toBe('2026-12-07T14:00:00.000Z');
    expect(subtractIntervals([{ start: 0, end: 10 }], [{ start: 2, end: 4 }, { start: 8, end: 12 }])).toEqual([{ start: 0, end: 2 }, { start: 4, end: 8 }]);

    const g = await guide('FRIEND');
    const base = Math.ceil(Date.now() / 3600_000) * 3600_000 + 7 * 24 * 3600_000;
    const iso = (h: number) => new Date(base + h * 3600_000).toISOString();
    const s = iso(0), e = iso(8);
    const put = await call(t, g, 'PUT', '/v1/guides/me/availability', { slots: [{ startAt: s, endAt: e }] });
    expect(put.status).toBe(200);
    const traveler = await createUser(t);
    const rq = (await call(t, traveler, 'POST', '/v1/guide-requests', { guideId: g.id, startAt: iso(2), endAt: iso(3) })).body.item;
    expect((await call(t, g, 'POST', `/v1/guide-requests/${rq.id}/offers`, { startAt: iso(2), endAt: iso(3), paid: false })).status).toBe(201);
    expect((await call(t, traveler, 'POST', `/v1/guide-requests/${rq.id}/accept`, { offerVersion: 1 }, idem())).status).toBe(201);
    const free = await call(t, null, 'GET', `/v1/guides/${g.id}/availability?from=${encodeURIComponent(s)}&to=${encodeURIComponent(e)}`);
    expect(free.body.items).toHaveLength(2);
    expect(free.body.items).toEqual([{ startAt: iso(0), endAt: iso(2) }, { startAt: iso(3), endAt: iso(8) }]);
    // outside published slots → unavailable
    const r = (await call(t, traveler, 'POST', '/v1/guide-requests', { guideId: g.id, startAt: at(7 * 24 * H + 10 * H), endAt: at(7 * 24 * H + 11 * H) })).body.item;
    expect((await call(t, g, 'POST', `/v1/guide-requests/${r.id}/offers`, { startAt: at(7 * 24 * H + 10 * H), endAt: at(7 * 24 * H + 11 * H), paid: false })).body.code).toBe('GUIDE_UNAVAILABLE');

    const weekly = await call(t, g, 'PUT', '/v1/guides/me/availability', {
      from: '2099-01-01T00:00:00Z', to: '2099-01-15T00:00:00Z',
      weekly: { timezone: 'Asia/Seoul', fromDate: '2099-01-01', toDate: '2099-01-14', rules: [{ weekday: 1, start: '09:00', end: '12:00' }] },
    });
    expect(weekly.body.item.added).toBe(2); // two Mondays
    const slots = await t.pool.query(`SELECT start_at FROM guide_availability WHERE guide_id = $1 AND start_at >= '2099-01-01' ORDER BY start_at`, [g.id]);
    expect(slots.rows.map((x) => x.start_at.toISOString())).toEqual(['2099-01-05T00:00:00.000Z', '2099-01-12T00:00:00.000Z']);
  });

  it('search ranks by language, interest, availability, rating and distance with explanations', async () => {
    const city = `Rank${randomUUID().slice(0, 6)}`;
    const s = at(20 * 24 * H), e = at(20 * 24 * H + 2 * H);
    const best = await guide('FRIEND', { city, languages: ['ko', 'en'], interests: ['food', 'history'], lat: 37.5665, lng: 126.978 });
    await call(t, best, 'PUT', '/v1/guides/me/availability', { slots: [{ startAt: s, endAt: e }] });
    const mid = await guide('VOLUNTEER', { city, languages: ['en'], interests: ['food'], lat: 37.6, lng: 127.1 });
    const low = await guide('FRIEND', { city, languages: ['en'], interests: ['hiking'] });
    await call(t, low, 'PUT', '/v1/guides/me/availability', { slots: [{ startAt: at(21 * 24 * H), endAt: at(21 * 24 * H + 60) }] });
    await guide('FRIEND', { city, languages: ['ja'], interests: ['food'] }); // filtered out by language

    const qs = new URLSearchParams({ city, languages: 'ko,en', interests: 'food,history', from: s, to: e, lat: '37.5665', lng: '126.978' });
    const r = await call(t, null, 'GET', `/v1/search/guides?${qs}`);
    expect(r.status).toBe(200);
    expect(r.body.items.map((x: any) => x.guide.guideId)).toEqual([best.id, mid.id, low.id]);
    const top = r.body.items[0];
    expect(top.components).toMatchObject({ language: 1, interest: 1, availability: 1 });
    expect(top.availability).toBe('AVAILABLE');
    expect(top.explanation.join(' | ')).toMatch(/Speaks ko, en/);
    expect(top.explanation.join(' | ')).toMatch(/Shares interests: food, history/);
    // distance is computed from the public ≈1 km point and bucketed to whole km (never the exact location)
    expect(top.distanceKm).toBe(1);
    expect(r.body.items[1].availability).toBe('ON_REQUEST');
    expect(r.body.items[2].availability).toBe('UNAVAILABLE');
    const only = await call(t, null, 'GET', `/v1/search/guides?${qs}&availableOnly=true`);
    expect(only.body.items.map((x: any) => x.guide.guideId)).toEqual([best.id]);
    const paidOnly = await call(t, null, 'GET', `/v1/search/guides?city=${city}&pricing=paid`);
    expect(paidOnly.body.items).toHaveLength(0);
  });

  it('open request notifies top matching guides; first offering guide claims it', async () => {
    const city = `Open${randomUUID().slice(0, 6)}`;
    const g1 = await guide('FRIEND', { city, languages: ['ko'], interests: ['art'] });
    const g2 = await guide('FRIEND', { city, languages: ['ko'], interests: ['art'] });
    const traveler = await createUser(t);
    const req = await call(t, traveler, 'POST', '/v1/guide-requests', { city, startAt: at(30 * 24 * H), endAt: at(30 * 24 * H + 60), languages: ['ko'], interests: ['art'] });
    expect(req.status).toBe(201);
    const notes = await t.pool.query(`SELECT user_id FROM notifications WHERE template_key = 'guide.request.match' AND data->>'requestId' = $1`, [req.body.item.id]);
    expect(notes.rows.map((x) => x.user_id).sort()).toEqual([g1.id, g2.id].sort());
    const open = await call(t, g2, 'GET', '/v1/guide-requests?role=open');
    expect(open.body.items.map((x: any) => x.id)).toContain(req.body.item.id);
    expect((await call(t, traveler, 'GET', '/v1/guide-requests?role=open')).status).toBe(403);
    const o = await call(t, g1, 'POST', `/v1/guide-requests/${req.body.item.id}/offers`, { startAt: at(30 * 24 * H), endAt: at(30 * 24 * H + 60), paid: false });
    expect(o.body.item.guide_id).toBe(g1.id);
    expect((await call(t, g2, 'POST', `/v1/guide-requests/${req.body.item.id}/offers`, { startAt: at(30 * 24 * H), endAt: at(30 * 24 * H + 60), paid: false })).status).toBe(403);
  });
});

describe('GUIDE jobs', () => {
  it('lifecycle job starts and auto-completes; request expiry job expires stale negotiations', async () => {
    const g = await guide('FRIEND');
    const traveler = await createUser(t);
    const { accept } = await book(g, traveler, 40 * 24 * H, 60);
    const id = accept.body.booking.id;
    await t.pool.query(`UPDATE guide_bookings SET start_at = now() - interval '4 hours', end_at = now() - interval '3 hours' WHERE id = $1`, [id]);
    const res = await runBookingLifecycle(t.app.ctx);
    expect(res.started).toBeGreaterThanOrEqual(1);
    expect((await t.pool.query(`SELECT status FROM guide_bookings WHERE id = $1`, [id])).rows[0].status).toBe('COMPLETED');

    const req = (await call(t, traveler, 'POST', '/v1/guide-requests', { guideId: g.id, startAt: at(50 * 24 * H), endAt: at(50 * 24 * H + 60) })).body.item;
    await t.pool.query(`UPDATE guide_requests SET created_at = now() - interval '8 days' WHERE id = $1`, [req.id]);
    expect(await expireRequests(t.app.ctx)).toBeGreaterThanOrEqual(1);
    expect((await call(t, traveler, 'GET', `/v1/guide-requests/${req.id}`)).body.item.status).toBe('EXPIRED');
  });
});
