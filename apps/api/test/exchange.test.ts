import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, day, enableFlags, idem, type TestApp, type TestUser } from './helpers.js';
import { withTx } from '../src/platform/db.js';
import { acquireBlock, isRangeFree, releaseBlock } from '../src/platform/inventory.js';
import { canonicalJson, sha256 } from '../src/platform/crypto.js';
import { emit } from '../src/platform/outbox.js';
import { advanceLifecycle, expireStaleRequests, markExchangeReviewed } from '../src/modules/exchange/service.js';

let t: TestApp;

interface Member { user: TestUser; propertyId: string }

async function member(opts: { city?: string; prefs?: string[]; verified?: boolean; profile?: boolean; home?: boolean } = {}): Promise<Member> {
  const user = await createUser(t, { verified: opts.verified ?? true });
  let propertyId = '';
  if (opts.home ?? true) {
    const { rows } = await t.pool.query(
      `INSERT INTO properties(host_id, title, property_type, max_guests, city, status, exchange_enabled, published_at)
       VALUES ($1,$2,'APARTMENT',4,$3,'PUBLISHED',true, now()) RETURNING id`,
      [user.id, `Home of ${user.email}`, opts.city ?? 'Seoul'],
    );
    propertyId = rows[0].id;
    await t.pool.query(`INSERT INTO property_addresses(property_id, line1, city) VALUES ($1,'123 Secret-ro',$2)`, [propertyId, opts.city ?? 'Seoul']);
    await t.pool.query(`INSERT INTO house_rules(property_id, quiet_hours) VALUES ($1,'22:00-07:00')`, [propertyId]);
  }
  if (opts.profile ?? true) {
    const r = await call(t, user, 'PUT', '/v1/exchange/profile', { homeDescription: 'A quiet, sunny family apartment.', preferredDestinations: opts.prefs ?? ['Busan'] });
    expect(r.status).toBe(200);
  }
  return { user, propertyId };
}

const A_DATES = { start: day(30), end: day(35) };
const B_DATES = { start: day(40), end: day(45) };

async function request(a: Member, b: Member, datesA = A_DATES, datesB = B_DATES) {
  const r = await call(t, a.user, 'POST', '/v1/exchanges', { myPropertyId: a.propertyId, theirPropertyId: b.propertyId, datesA, datesB, guestsA: 2, guestsB: 2, message: 'Swap?' });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.item.id as string;
}

/** request → accept → both safety-acks → AGREEMENT_PENDING; returns {id, hash} */
async function toAgreement(a: Member, b: Member, datesA = A_DATES, datesB = B_DATES) {
  const id = await request(a, b, datesA, datesB);
  const acc = await call(t, b.user, 'POST', `/v1/exchanges/${id}/accept`, { offerVersion: 1 });
  expect(acc.status, JSON.stringify(acc.body)).toBe(200);
  expect(acc.body.item.status).toBe('VERIFICATION_PENDING');
  expect((await call(t, a.user, 'POST', `/v1/exchanges/${id}/safety-ack`, { acknowledged: true })).body.item.status).toBe('VERIFICATION_PENDING');
  const ack = await call(t, b.user, 'POST', `/v1/exchanges/${id}/safety-ack`, { acknowledged: true });
  expect(ack.body.item.status).toBe('AGREEMENT_PENDING');
  const ag = await call(t, a.user, 'GET', `/v1/exchanges/${id}/agreement`);
  expect(ag.status).toBe(200);
  return { id, hash: ag.body.item.termsHash as string };
}

async function toConfirmed(a: Member, b: Member, datesA = A_DATES, datesB = B_DATES) {
  const { id, hash } = await toAgreement(a, b, datesA, datesB);
  expect((await call(t, a.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash })).status).toBe(200);
  const s2 = await call(t, b.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash });
  expect(s2.body.item.status).toBe('CONFIRMED');
  return id;
}

const exchangeBlocks = async (exchangeId: string) =>
  (await t.pool.query(`SELECT property_id, state, block_type FROM inventory_blocks WHERE source_type = 'EXCHANGE' AND source_id = $1`, [exchangeId])).rows;
const activeBlocksOn = async (propertyId: string, blockType = 'EXCHANGE') =>
  (await t.pool.query(`SELECT * FROM inventory_blocks WHERE property_id = $1 AND state = 'ACTIVE' AND block_type = $2`, [propertyId, blockType])).rows;
const hostBlock = (propertyId: string, r: { start: string; end: string }) =>
  withTx(t.pool, (tx) => acquireBlock(tx, { propertyId, start: r.start, end: r.end, blockType: 'HOST_BLOCK', sourceType: 'HOST' }));

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t?.close());

describe('feature flag', () => {
  it('flag OFF → 403 FEATURE_DISABLED for request and discovery', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const r = await call(t, a.user, 'POST', '/v1/exchanges', { myPropertyId: a.propertyId, theirPropertyId: b.propertyId, datesA: A_DATES, datesB: B_DATES });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('FEATURE_DISABLED');
    expect((await call(t, a.user, 'GET', '/v1/exchange/homes')).status).toBe(403);
    await enableFlags(t, 'exchange.enabled');
  });
});

describe('EXCH-01 eligibility & discovery', () => {
  it('lists unmet predicates', async () => {
    const u = await member({ verified: false, home: false, profile: false });
    const r = await call(t, u.user, 'GET', '/v1/exchange/eligibility');
    expect(r.status).toBe(200);
    expect(r.body.item.eligible).toBe(false);
    expect(r.body.item.unmet).toEqual(expect.arrayContaining(['IDENTITY_NOT_VERIFIED', 'NO_EXCHANGE_HOME', 'PROFILE_INCOMPLETE']));
    expect((await call(t, null, 'GET', '/v1/exchange/eligibility')).status).toBe(401);
  });

  it('unpublished or non-exchange homes do not count; sanctions block; eligible member passes', async () => {
    const m = await member();
    expect((await call(t, m.user, 'GET', '/v1/exchange/eligibility')).body.item).toMatchObject({ eligible: true, unmet: [] });
    await t.pool.query(`UPDATE properties SET status = 'UNLISTED' WHERE id = $1`, [m.propertyId]);
    expect((await call(t, m.user, 'GET', '/v1/exchange/eligibility')).body.item.unmet).toContain('NO_EXCHANGE_HOME');
    await t.pool.query(`UPDATE properties SET status = 'PUBLISHED' WHERE id = $1`, [m.propertyId]);
    const admin = await createUser(t, { roles: ['ADMIN'] });
    await t.pool.query(`INSERT INTO sanctions(user_id, sanction_type, reason, issued_by) VALUES ($1,'LISTING_SUSPENSION','test',$2)`, [m.user.id, admin.id]);
    expect((await call(t, m.user, 'GET', '/v1/exchange/eligibility')).body.item.unmet).toEqual(['ACTIVE_SANCTION']);
    const other = await member({ city: 'Busan' });
    const r = await call(t, m.user, 'POST', '/v1/exchanges', { myPropertyId: m.propertyId, theirPropertyId: other.propertyId, datesA: A_DATES, datesB: B_DATES });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('NOT_ELIGIBLE');
    // and the counterparty side
    const r2 = await call(t, other.user, 'POST', '/v1/exchanges', { myPropertyId: other.propertyId, theirPropertyId: m.propertyId, datesA: A_DATES, datesB: B_DATES });
    expect(r2.status).toBe(422);
    expect(r2.body.code).toBe('COUNTERPARTY_NOT_ELIGIBLE');
  });

  it('cannot request with a home you do not own', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const r = await call(t, a.user, 'POST', '/v1/exchanges', { myPropertyId: b.propertyId, theirPropertyId: a.propertyId, datesA: A_DATES, datesB: B_DATES });
    expect(r.status).toBe(403);
  });

  it('discovery excludes own homes, is date-aware and scores mutual fit', async () => {
    const city = `Jeju-${Math.random().toString(36).slice(2, 7)}`;
    const me = await member({ city: 'Gangneung', prefs: [city] });
    const fit = await member({ city, prefs: ['Gangneung'] });
    const half = await member({ city, prefs: ['Nowhere'] });
    const r = await call(t, me.user, 'GET', `/v1/exchange/homes?city=${city}`);
    expect(r.status).toBe(200);
    const ids = r.body.items.map((i: any) => i.id);
    expect(ids).not.toContain(me.propertyId);
    expect(r.body.items[0].id).toBe(fit.propertyId);
    expect(r.body.items[0].mutualFit).toEqual({ score: 100, iWantTheirCity: true, theyWantMyCity: true });
    expect(r.body.items.find((i: any) => i.id === half.propertyId).mutualFit.score).toBe(50);
    expect(JSON.stringify(r.body)).not.toContain('Secret-ro');
    await hostBlock(fit.propertyId, { start: day(60), end: day(62) });
    const dated = await call(t, me.user, 'GET', `/v1/exchange/homes?city=${city}&start=${day(61)}&end=${day(63)}`);
    expect(dated.body.items.map((i: any) => i.id)).toEqual([half.propertyId]);
  });

  it('request requires both homes free at request time', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    await hostBlock(b.propertyId, B_DATES);
    const r = await call(t, a.user, 'POST', '/v1/exchanges', { myPropertyId: a.propertyId, theirPropertyId: b.propertyId, datesA: A_DATES, datesB: B_DATES });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('INVENTORY_UNAVAILABLE');
  });
});

describe('EXCH-02 request, counter, accept', () => {
  it('counter chain with optimistic version checks; both must accept the same version', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const id = await request(a, b);
    const conv = await t.pool.query(`SELECT c.id FROM conversations c JOIN exchange_requests e ON e.conversation_id = c.id WHERE e.id = $1`, [id]);
    expect(conv.rowCount).toBe(1);

    // the maker of the latest offer cannot counter it
    const own = await call(t, a.user, 'POST', `/v1/exchanges/${id}/counter`, { expectedVersion: 1, guestsA: 3 });
    expect(own.status).toBe(409);
    expect(own.body.code).toBe('NOT_YOUR_TURN');
    const stale = await call(t, b.user, 'POST', `/v1/exchanges/${id}/counter`, { expectedVersion: 2, guestsA: 3 });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('OFFER_VERSION_MISMATCH');

    const c = await call(t, b.user, 'POST', `/v1/exchanges/${id}/counter`, { expectedVersion: 1, datesA: { start: day(31), end: day(36) }, guestsA: 3 });
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.item).toMatchObject({ status: 'COUNTERED', currentOfferVersion: 2, acceptedAVersion: 1, acceptedBVersion: 2 });
    expect(c.body.item.offers).toHaveLength(2);
    expect(c.body.item.currentOffer).toMatchObject({ version: 2, guestsA: 3, guestsB: 2, datesA: { start: day(31), end: day(36) } });

    // stale acceptance rejected
    const accOld = await call(t, a.user, 'POST', `/v1/exchanges/${id}/accept`, { offerVersion: 1 });
    expect(accOld.status).toBe(409);
    expect(accOld.body.code).toBe('OFFER_VERSION_MISMATCH');
    // B "accepting" their own counter does not make it mutual
    const accOwn = await call(t, b.user, 'POST', `/v1/exchanges/${id}/accept`, { offerVersion: 2 });
    expect(accOwn.body.item.status).toBe('COUNTERED');

    const acc = await call(t, a.user, 'POST', `/v1/exchanges/${id}/accept`, { offerVersion: 2 });
    expect(acc.status).toBe(200);
    expect(acc.body.item.status).toBe('VERIFICATION_PENDING');
    expect(acc.body.item.verifications).toHaveLength(6);
    const hist = await t.pool.query(`SELECT from_state, to_state, actor_id FROM state_transitions WHERE aggregate_type = 'EXCHANGE' AND aggregate_id = $1 ORDER BY created_at, id`, [id]);
    expect(hist.rows.map((r) => r.to_state)).toEqual(['REQUESTED', 'COUNTERED', 'MUTUAL_ACCEPTED', 'VERIFICATION_PENDING']);
    // offers are immutable
    await expect(t.pool.query(`UPDATE exchange_offers SET guests_a = 9 WHERE exchange_id = $1`, [id])).rejects.toThrow(/append-only/);
    // invalid transition: cannot counter after mutual acceptance
    const late = await call(t, b.user, 'POST', `/v1/exchanges/${id}/counter`, { expectedVersion: 2, guestsA: 1 });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('decline / withdraw rules and list with role & next action', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const id = await request(a, b);
    const list = await call(t, b.user, 'GET', '/v1/exchanges');
    expect(list.body.items.find((x: any) => x.id === id)).toMatchObject({ role: 'RESPONDER', nextAction: 'RESPOND' });
    expect((await call(t, a.user, 'GET', '/v1/exchanges')).body.items[0]).toMatchObject({ id, role: 'REQUESTER', nextAction: 'AWAIT_RESPONSE' });
    expect((await call(t, a.user, 'POST', `/v1/exchanges/${id}/decline`, {})).body.code).toBe('CANNOT_DECLINE_OWN_OFFER');
    const d = await call(t, b.user, 'POST', `/v1/exchanges/${id}/decline`, { reason: 'busy' });
    expect(d.body.item.status).toBe('DECLINED');
    expect((await call(t, b.user, 'POST', `/v1/exchanges/${id}/accept`, { offerVersion: 1 })).status).toBe(409);

    const id2 = await request(a, b, { start: day(50), end: day(52) }, { start: day(55), end: day(57) });
    expect((await call(t, a.user, 'POST', `/v1/exchanges/${id2}/withdraw`, {})).body.item.status).toBe('WITHDRAWN');
  });

  it('expiry job expires unanswered requests', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const id = await request(a, b);
    await t.pool.query(`UPDATE exchange_requests SET respond_by = now() - interval '1 minute' WHERE id = $1`, [id]);
    expect(await expireStaleRequests(t.app.ctx)).toBeGreaterThanOrEqual(1);
    expect((await call(t, a.user, 'GET', `/v1/exchanges/${id}`)).body.item.status).toBe('EXPIRED');
  });

  it('third parties cannot read or act; AAL2 staff can read', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const c = await member({ city: 'Daegu' });
    const id = await request(a, b);
    expect((await call(t, c.user, 'GET', `/v1/exchanges/${id}`)).status).toBe(404);
    expect((await call(t, c.user, 'POST', `/v1/exchanges/${id}/accept`, { offerVersion: 1 })).status).toBe(404);
    expect((await call(t, c.user, 'POST', `/v1/exchanges/${id}/cancel`, { reason: 'not mine' })).status).toBe(404);
    expect((await call(t, c.user, 'GET', '/v1/exchanges')).body.items).toHaveLength(0);
    const staffAal1 = await createUser(t, { roles: ['SUPPORT'], aal: 'aal1' });
    expect((await call(t, staffAal1, 'GET', `/v1/exchanges/${id}`)).status).toBe(404);
    const staff = await createUser(t, { roles: ['SUPPORT'] });
    expect((await call(t, staff, 'GET', `/v1/exchanges/${id}`)).status).toBe(200);
    expect((await call(t, null, 'GET', `/v1/exchanges/${id}`)).status).toBe(401);
  });
});

describe('EXCH-03/04 verification and agreement', () => {
  it('verification gate blocks the agreement until every check passes', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const id = await request(a, b);
    await call(t, b.user, 'POST', `/v1/exchanges/${id}/accept`, { offerVersion: 1 });
    // signing is impossible before the agreement exists
    expect((await call(t, a.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: 'a'.repeat(64) })).status).toBe(409);
    await t.pool.query(`UPDATE users SET identity_verified_at = NULL WHERE id = $1`, [a.user.id]);
    await t.pool.query(`INSERT INTO safety_reports(reporter_id, subject_type, subject_id, category) VALUES ($1,'PROPERTY',$2,'SAFETY')`, [a.user.id, b.propertyId]);
    await call(t, a.user, 'POST', `/v1/exchanges/${id}/safety-ack`, { acknowledged: true });
    const v = await call(t, b.user, 'POST', `/v1/exchanges/${id}/safety-ack`, { acknowledged: true });
    expect(v.body.item.status).toBe('VERIFICATION_PENDING');
    const failed = v.body.checks.filter((c: any) => c.status === 'FAILED');
    expect(failed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ partyUserId: a.user.id, checkType: 'IDENTITY' }),
        expect.objectContaining({ partyUserId: b.user.id, checkType: 'PROPERTY' }),
      ]),
    );
    expect((await call(t, a.user, 'GET', `/v1/exchanges/${id}/agreement`)).status).toBe(404);

    await t.pool.query(`UPDATE users SET identity_verified_at = now() WHERE id = $1`, [a.user.id]);
    await t.pool.query(`UPDATE safety_reports SET status = 'CLOSED' WHERE subject_id = $1`, [b.propertyId]);
    const ok = await call(t, a.user, 'POST', `/v1/exchanges/${id}/verify`);
    expect(ok.status).toBe(200);
    expect(ok.body.item.status).toBe('AGREEMENT_PENDING');
    expect(ok.body.checks.every((c: any) => c.status === 'PASSED')).toBe(true);

    const ag = await call(t, b.user, 'GET', `/v1/exchanges/${id}/agreement`);
    expect(ag.body.item.termsHash).toBe(sha256(canonicalJson(ag.body.item.termsSnapshot)));
    expect(ag.body.item.termsVersion).toBe('2026-10-draft');
    expect(ag.body.item.termsSnapshot.homes.A.houseRules.quiet_hours).toBe('22:00-07:00');
    const verifyAgain = await call(t, a.user, 'POST', `/v1/exchanges/${id}/verify`);
    expect(verifyAgain.status).toBe(409);
  });

  it('both sign the same hash; wrong hash rejected; evidence write-once; second signature auto-confirms', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const { id, hash } = await toAgreement(a, b);
    const wrong = await call(t, a.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: 'f'.repeat(64) });
    expect(wrong.status).toBe(409);
    expect(wrong.body.code).toBe('TERMS_HASH_MISMATCH');
    const bad = await call(t, a.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: 'nothex' });
    expect(bad.status).toBe(400);

    const s1 = await call(t, a.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash }, { 'user-agent': 'vitest-A' });
    expect(s1.body.item.agreement).toMatchObject({ status: 'PARTIALLY_SIGNED', signedByRequester: true, signedByResponder: false });
    expect(s1.body.item.nextAction).toBe('AWAIT_COUNTERPARTY_SIGNATURE');
    const again = await call(t, a.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash });
    expect(again.body.code).toBe('ALREADY_SIGNED');
    const ev = await t.pool.query(`SELECT accepted_a_evidence FROM exchange_agreements WHERE exchange_id = $1`, [id]);
    expect(ev.rows[0].accepted_a_evidence).toMatchObject({ termsHash: hash, userAgent: 'vitest-A' });
    expect(ev.rows[0].accepted_a_evidence.ip).toBeTruthy();

    // address hidden before confirmation
    expect((await call(t, b.user, 'GET', `/v1/exchanges/${id}`)).body.item.addresses).toBeNull();
    const s2 = await call(t, b.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash });
    expect(s2.status).toBe(200);
    expect(s2.body.autoConfirm).toEqual({ confirmed: true });
    expect(s2.body.item.status).toBe('CONFIRMED');
    expect(s2.body.item.agreement.status).toBe('SIGNED');
    expect(s2.body.item.addresses.A.line1).toBe('123 Secret-ro');
    const blocks = await exchangeBlocks(id);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((b) => b.property_id).sort()).toEqual([a.propertyId, b.propertyId].sort());
    const evs = await t.pool.query(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at, id`, [id]);
    expect(evs.rows.map((r) => r.event_type)).toEqual(
      expect.arrayContaining(['exchange.requested', 'exchange.mutual_accepted', 'exchange.verified', 'exchange.agreement.created', 'exchange.agreement.signed', 'exchange.calendar_blocked', 'exchange.confirmed']),
    );
  });
});

describe('EXCH-05 calendar lock', () => {
  it('confirm is atomic: one home blocked → 409 and NO block remains; then idempotent confirm succeeds', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const { id, hash } = await toAgreement(a, b);
    // Block the home that is locked SECOND (sorted by id) so the first acquisition must be rolled back.
    const [, second] = [{ p: a.propertyId, r: A_DATES }, { p: b.propertyId, r: B_DATES }].sort((x, y) => (x.p < y.p ? -1 : 1));
    const firstProperty = second.p === a.propertyId ? b.propertyId : a.propertyId;
    const blocker = await hostBlock(second.p, second.r);

    await call(t, a.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash });
    const s2 = await call(t, b.user, 'POST', `/v1/exchanges/${id}/agreement/sign`, { termsHash: hash });
    expect(s2.status).toBe(200);
    expect(s2.body.autoConfirm).toEqual({ confirmed: false, error: 'INVENTORY_UNAVAILABLE' });
    expect(s2.body.item.status).toBe('AGREEMENT_PENDING');
    expect(s2.body.item.agreement.status).toBe('SIGNED');
    expect(s2.body.item.nextAction).toBe('CONFIRM');

    expect((await call(t, a.user, 'POST', `/v1/exchanges/${id}/confirm`)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const fail = await call(t, a.user, 'POST', `/v1/exchanges/${id}/confirm`, undefined, idem());
    expect(fail.status).toBe(409);
    expect(fail.body.code).toBe('INVENTORY_UNAVAILABLE');
    expect(await activeBlocksOn(firstProperty)).toHaveLength(0);
    expect(await exchangeBlocks(id)).toHaveLength(0);
    expect(await isRangeFree(t.pool, firstProperty, A_DATES.start, B_DATES.end)).toBe(true);

    await releaseBlock(t.pool, blocker.id);
    const key = idem();
    const ok = await call(t, a.user, 'POST', `/v1/exchanges/${id}/confirm`, undefined, key);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.item.status).toBe('CONFIRMED');
    const replay = await call(t, a.user, 'POST', `/v1/exchanges/${id}/confirm`, undefined, key);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body).toEqual(ok.body);
    expect(await exchangeBlocks(id)).toHaveLength(2);
    // a different key on an already confirmed exchange is a no-op
    const again = await call(t, b.user, 'POST', `/v1/exchanges/${id}/confirm`, undefined, idem());
    expect(again.body.alreadyConfirmed).toBe(true);
    expect(await exchangeBlocks(id)).toHaveLength(2);
  });

  it('concurrent confirms of two exchanges competing for the same home dates → exactly one wins', async () => {
    const a = await member();
    const c = await member({ city: 'Daegu' });
    const b = await member({ city: 'Busan' });
    const x = await toAgreement(a, b, A_DATES, B_DATES);
    const y = await toAgreement(c, b, { start: day(70), end: day(72) }, { start: day(42), end: day(47) });
    const blocker = await hostBlock(b.propertyId, { start: day(40), end: day(47) });
    for (const [ex, req] of [[x, a], [y, c]] as const) {
      await call(t, req.user, 'POST', `/v1/exchanges/${ex.id}/agreement/sign`, { termsHash: ex.hash });
      const s = await call(t, b.user, 'POST', `/v1/exchanges/${ex.id}/agreement/sign`, { termsHash: ex.hash });
      expect(s.body.item.status).toBe('AGREEMENT_PENDING');
    }
    await releaseBlock(t.pool, blocker.id);
    const results = await Promise.all([
      call(t, a.user, 'POST', `/v1/exchanges/${x.id}/confirm`, undefined, idem()),
      call(t, c.user, 'POST', `/v1/exchanges/${y.id}/confirm`, undefined, idem()),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('INVENTORY_UNAVAILABLE');
    expect(await activeBlocksOn(b.propertyId)).toHaveLength(1);
    // the loser left nothing on its other home either
    const loser = results[0].status === 409 ? x : y;
    expect(await exchangeBlocks(loser.id)).toHaveLength(0);
  });

  it('confirm before signatures is rejected (invalid transition)', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const { id } = await toAgreement(a, b);
    const r = await call(t, a.user, 'POST', `/v1/exchanges/${id}/confirm`, undefined, idem());
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('AGREEMENT_NOT_SIGNED');
  });

  it('cancelling a confirmed exchange releases both blocks atomically', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const id = await toConfirmed(a, b);
    const r = await call(t, b.user, 'POST', `/v1/exchanges/${id}/cancel`, { reason: 'family emergency' });
    expect(r.status).toBe(200);
    expect(r.body.item.status).toBe('CANCELLED');
    expect(r.body.item.agreement.status).toBe('VOID');
    expect((await exchangeBlocks(id)).every((x) => x.state === 'RELEASED')).toBe(true);
    expect(await isRangeFree(t.pool, a.propertyId, A_DATES.start, A_DATES.end)).toBe(true);
    expect(await isRangeFree(t.pool, b.propertyId, B_DATES.start, B_DATES.end)).toBe(true);
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE aggregate_id = $1 AND event_type = 'exchange.cancelled'`, [id]);
    expect(ev.rows[0].payload).toMatchObject({ fromStatus: 'CONFIRMED', policy: 'STANDARD' });
    expect(ev.rows[0].payload.releasedBlockIds).toHaveLength(2);
    expect((await call(t, a.user, 'POST', `/v1/exchanges/${id}/cancel`, { reason: 'again' })).status).toBe(409);
  });
});

describe('EXCH-06 completion, review, dispute', () => {
  it('lifecycle job starts and completes; review event marks REVIEWED', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const id = await toConfirmed(a, b);
    // simulate time passing: the stays started
    await t.pool.query(`UPDATE exchange_requests SET dates_a = daterange($2::date, $3::date), dates_b = daterange($4::date, $5::date) WHERE id = $1`, [id, day(-1), day(3), day(0), day(4)]);
    let res = await advanceLifecycle(t.app.ctx);
    expect(res.started).toBeGreaterThanOrEqual(1);
    expect((await call(t, a.user, 'GET', `/v1/exchanges/${id}`)).body.item.status).toBe('IN_PROGRESS');
    const early = await call(t, a.user, 'POST', `/v1/exchanges/${id}/complete`);
    expect(early.body.code).toBe('EXCHANGE_NOT_ENDED');
    expect((await call(t, a.user, 'POST', `/v1/exchanges/${id}/cancel`, { reason: 'too late now' })).status).toBe(409);
    // both stays ended
    await t.pool.query(`UPDATE exchange_requests SET dates_a = daterange($2::date, $3::date), dates_b = daterange($4::date, $5::date) WHERE id = $1`, [id, day(-6), day(-2), day(-5), day(-1)]);
    res = await advanceLifecycle(t.app.ctx);
    expect(res.completed).toBeGreaterThanOrEqual(1);
    const done = await call(t, b.user, 'GET', `/v1/exchanges/${id}`);
    expect(done.body.item).toMatchObject({ status: 'COMPLETED', nextAction: 'LEAVE_REVIEW' });
    expect((await call(t, a.user, 'POST', `/v1/exchanges/${id}/dispute`, { reason: 'too late' })).status).toBe(409);

    await withTx(t.pool, (tx) => emit(tx, t.ctx(), { aggregateType: 'review', aggregateId: id, eventType: 'exchange.reviews.completed', payload: { exchangeId: id } }));
    await t.drain();
    expect((await call(t, a.user, 'GET', `/v1/exchanges/${id}`)).body.item.status).toBe('REVIEWED');
    // idempotent contract
    expect(await withTx(t.pool, (tx) => markExchangeReviewed(tx, t.ctx(), id))).toEqual({ changed: false, status: 'REVIEWED' });
  });

  it('party can complete after end dates', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const id = await toConfirmed(a, b);
    await t.pool.query(`UPDATE exchange_requests SET dates_a = daterange($2::date, $3::date), dates_b = daterange($4::date, $5::date) WHERE id = $1`, [id, day(-6), day(-2), day(-5), day(-1)]);
    const r = await call(t, b.user, 'POST', `/v1/exchanges/${id}/complete`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.item.status).toBe('COMPLETED');
  });

  it('dispute moves a confirmed exchange to DISPUTED and opens an EXCHANGE dispute', async () => {
    const a = await member();
    const b = await member({ city: 'Busan' });
    const id = await toConfirmed(a, b);
    const r = await call(t, a.user, 'POST', `/v1/exchanges/${id}/dispute`, { reason: 'home not as described' });
    expect(r.status).toBe(201);
    expect(r.body.item.status).toBe('DISPUTED');
    const d = await t.pool.query(`SELECT * FROM disputes WHERE id = $1`, [r.body.disputeId]);
    expect(d.rows[0]).toMatchObject({ context_type: 'EXCHANGE', context_id: id, opened_by: a.user.id, counterparty_id: b.user.id });
    // blocks preserved during dispute
    expect((await exchangeBlocks(id)).every((x) => x.state === 'ACTIVE')).toBe(true);
  });
});
