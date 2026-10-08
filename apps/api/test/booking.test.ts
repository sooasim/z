import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, createUser, call, day, enableFlags, idem, type TestApp, type TestUser } from './helpers.js';
import { withTx } from '../src/platform/db.js';
import { setFlag } from '../src/platform/flags.js';
import { applyBps } from '../src/platform/money.js';
import { paymentSubject } from '../src/platform/payment-subjects.js';
import type { Ctx } from '../src/platform/context.js';
import { expireHolds, autoCompleteStays, lockReservation } from '../src/modules/booking/reservations.js';
import { evaluateCancellation } from '../src/modules/booking/cancellation.js';
import { weekday } from '../src/modules/booking/dates.js';

let t: TestApp;
let host: TestUser;
let guest: TestUser;
let other: TestUser;
let admin: TestUser;
let moderateId: string;

const BASE = 100_000;
const CLEANING = 20_000;

async function makeProperty(opts: Partial<{ paid: boolean; minNights: number; maxGuests: number; timezone: string; hostId: string }> = {}) {
  const { rows } = await t.pool.query(
    `INSERT INTO properties(host_id, title, property_type, status, rental_enabled, paid_booking_enabled, base_price_minor, cleaning_fee_minor,
                            currency, max_guests, min_nights, timezone, country, cancellation_policy_id, published_at, city)
     VALUES ($1,'Test stay','HOUSE','PUBLISHED',true,$2,$3,$4,'KRW',$5,$6,$7,'KR',$8, now(), 'Seoul') RETURNING id`,
    [opts.hostId ?? host.id, opts.paid ?? true, BASE, CLEANING, opts.maxGuests ?? 4, opts.minNights ?? 1, opts.timezone ?? 'UTC', moderateId],
  );
  const id = rows[0].id as string;
  await t.pool.query(`INSERT INTO property_addresses(property_id, line1, city, country, public_area_label) VALUES ($1,'1 Secret-ro 42','Seoul','KR','Mapo-gu')`, [id]);
  return id;
}

async function quote(user: TestUser, propertyId: string, checkIn: string, checkOut: string, guests = 2) {
  return call(t, user, 'POST', '/v1/booking/quotes', { propertyId, checkIn, checkOut, guests });
}

async function quoteAndHold(user: TestUser, propertyId: string, checkIn: string, checkOut: string, guests = 2) {
  const q = await quote(user, propertyId, checkIn, checkOut, guests);
  expect(q.status, JSON.stringify(q.body)).toBe(201);
  const h = await call(t, user, 'POST', '/v1/booking/holds', { quoteId: q.body.item.id }, idem());
  expect(h.status, JSON.stringify(h.body)).toBe(201);
  return { quote: q.body.item, hold: h.body.item.hold, reservation: h.body.item.reservation };
}

const actorCtx = (u: TestUser): Ctx => ({ ...t.ctx(), actor: { userId: u.id, sessionId: u.sessionId, roles: ['USER'], aal: 'aal1', status: 'ACTIVE' } });

/** Simulate PAY-01: payable → created → provider-approved, via the registered payment subject handler. */
async function pay(reservationId: string, payer: TestUser) {
  const h = paymentSubject('RESERVATION');
  return withTx(t.pool, async (tx) => {
    const snap = await h.payable(tx, actorCtx(payer), reservationId);
    const paymentId = randomUUID();
    await h.onPaymentCreated!(tx, t.ctx(), reservationId, paymentId);
    // the provider-approved payment row (owned by PAY-01) that a later refund is drawn against
    await tx.query(
      `INSERT INTO payments(id, provider, provider_order_id, payment_key, payer_id, subject_type, subject_id, status, amount_minor, currency, approved_at, expires_at)
       VALUES ($1,'MOCK',$2,$3,$4,'RESERVATION',$5,'APPROVED',$6,$7, now(), now() + interval '10 minutes')`,
      [paymentId, `ord-${paymentId}`, `pk-${paymentId}`, snap.payerId, reservationId, snap.amountMinor, snap.currency],
    );
    await h.onPaymentApproved(tx, t.ctx(), reservationId, { id: paymentId, amountMinor: snap.amountMinor, currency: snap.currency });
    return { snap, paymentId };
  });
}

async function status(id: string) {
  return (await t.pool.query(`SELECT status FROM reservations WHERE id = $1`, [id])).rows[0].status as string;
}
async function refundsOf(reservationId: string) {
  return (
    await t.pool.query(
      `SELECT r.amount_minor, r.currency, r.status, r.idempotency_key FROM refunds r JOIN payments p ON p.id = r.payment_id
        WHERE p.subject_type = 'RESERVATION' AND p.subject_id = $1 ORDER BY r.created_at`,
      [reservationId],
    )
  ).rows;
}
async function outbox(type: string, aggregateId: string) {
  return (await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = $1 AND aggregate_id = $2`, [type, aggregateId])).rows.map((r) => r.payload);
}

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
  guest = await createUser(t);
  other = await createUser(t);
  admin = await createUser(t, { roles: ['ADMIN'] });
  moderateId = (await t.pool.query(`SELECT id FROM cancellation_policies WHERE code = 'MODERATE'`)).rows[0].id;
  await enableFlags(t, 'stay.paid_booking');
  // approved jurisdiction rule without required permits so the compliance gate ALLOWs (STAY-03 contract)
  await t.pool.query(
    `INSERT INTO compliance_rules(rule_key, subject_type, jurisdiction, effective_from, status, approved_at, note)
     VALUES ('test-allow','PROPERTY','KR','2020-01-01','APPROVED', now(), 'test')`,
  );
  // approved finance rules: 10% guest service fee, 3% host fee, 10% VAT on the service fee
  await t.pool.query(
    `INSERT INTO finance_rules(rule_type, domain, jurisdiction, params, effective_from, status, approved_at) VALUES
       ('PLATFORM_FEE','STAY','KR','{"bps":1000}','2020-01-01','APPROVED', now()),
       ('HOST_FEE','STAY','KR','{"bps":300}','2020-01-01','APPROVED', now()),
       ('TAX','STAY','KR','{"bps":1000}','2020-01-01','APPROVED', now()),
       ('PLATFORM_FEE','STAY','KR','{"bps":9999}','2020-01-01','DRAFT', null)`,
  );
});
afterAll(async () => t?.close());

describe('STAY-07 quote', () => {
  it('is deterministic and itemized (override > season > weekend > base, extra guest, weekly discount, fees/tax)', async () => {
    const pid = await makeProperty();
    const ci = day(20);
    const nights = Array.from({ length: 7 }, (_, i) => day(20 + i));
    await t.pool.query(
      `INSERT INTO rate_rules(property_id, rule_type, params, valid_from, valid_until, priority) VALUES
        ($1,'WEEKEND','{"days":[5,6],"price_minor":150000}',null,null,100),
        ($1,'SEASON','{"price_minor":200000}',$2,$3,50),
        ($1,'EXTRA_GUEST','{"included_guests":2,"fee_minor":10000}',null,null,100),
        ($1,'WEEKLY_DISCOUNT','{"bps":1000}',null,null,100),
        ($1,'MONTHLY_DISCOUNT','{"bps":2500}',null,null,100)`,
      [pid, nights[2], nights[3]],
    );
    const ov = await call(t, host, 'PUT', `/v1/properties/${pid}/availability`, { ranges: [{ start: nights[1], end: nights[2], priceMinor: 90_000 }] });
    expect(ov.status).toBe(200);

    const expected = nights.map((d, i) => (i === 1 ? 90_000 : i === 2 || i === 3 ? 200_000 : [5, 6].includes(weekday(d)) ? 150_000 : BASE));
    const nightsTotal = expected.reduce((a, b) => a + b, 0);
    const extra = 1 * 10_000 * 7;
    const discount = applyBps(nightsTotal + extra, 1000);
    const subtotal = nightsTotal + extra - discount;
    const platformFee = applyBps(subtotal + CLEANING, 1000);
    const tax = applyBps(platformFee, 1000);
    const total = subtotal + CLEANING + platformFee + tax;

    const a = await quote(guest, pid, ci, day(27), 3);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await quote(guest, pid, ci, day(27), 3);
    const qa = a.body.item;
    expect(qa.breakdown.nights.map((n: any) => n.priceMinor)).toEqual(expected);
    expect(qa.breakdown.nights[1].source).toBe('OVERRIDE');
    expect(qa.breakdown.nights[2].source).toBe('SEASON');
    expect(qa.breakdown.discount.type).toBe('WEEKLY_DISCOUNT');
    expect(qa.breakdown.extraGuestFeeMinor).toBe(extra);
    expect(qa).toMatchObject({ nights: 7, subtotalMinor: subtotal, discountMinor: discount, cleaningFeeMinor: CLEANING, platformFeeMinor: platformFee, taxMinor: tax, totalMinor: total, currency: 'KRW' });
    expect(qa.breakdown.hostFeeMinor).toBe(applyBps(subtotal + CLEANING, 300));
    expect(qa.rulesVersion.finance.PLATFORM_FEE).toBeTruthy();
    expect(b.body.item.breakdown).toEqual(qa.breakdown);
    expect(b.body.item.id).not.toBe(qa.id);
    expect(new Date(qa.expiresAt).getTime()).toBeGreaterThan(Date.now());
    // immutable
    await expect(t.pool.query(`UPDATE booking_quotes SET total_minor = 1 WHERE id = $1`, [qa.id])).rejects.toThrow();
    // quote.created emitted
    expect(await outbox('quote.created', qa.id)).toHaveLength(1);
    // only owner can read
    expect((await call(t, other, 'GET', `/v1/booking/quotes/${qa.id}`)).status).toBe(404);
    expect((await call(t, guest, 'GET', `/v1/booking/quotes/${qa.id}`)).status).toBe(200);
  });

  it('rejects min-nights, per-day min-nights, max guests, past dates, unavailable nights, self booking and unauthenticated', async () => {
    const pid = await makeProperty({ minNights: 2, maxGuests: 3 });
    expect((await quote(guest, pid, day(10), day(11))).body.code).toBe('MIN_NIGHTS');
    await call(t, host, 'PUT', `/v1/properties/${pid}/availability`, { ranges: [{ start: day(12), end: day(13), minNights: 4 }] });
    const perDay = await quote(guest, pid, day(12), day(15));
    expect(perDay.status).toBe(422);
    expect(perDay.body.code).toBe('MIN_NIGHTS');
    expect((await quote(guest, pid, day(13), day(15))).status).toBe(201); // override only applies on check-in day
    const tooMany = await quote(guest, pid, day(10), day(12), 4);
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.code).toBe('MAX_GUESTS_EXCEEDED');
    const past = await quote(guest, pid, day(-2), day(1));
    expect(past.status).toBe(400);
    expect(past.body.code).toBe('DATE_IN_PAST');
    await call(t, host, 'PUT', `/v1/properties/${pid}/availability`, { ranges: [{ start: day(31), end: day(32), status: 'UNAVAILABLE' }] });
    const closed = await quote(guest, pid, day(30), day(33));
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('DATES_UNAVAILABLE');
    expect((await quote(host, pid, day(40), day(42))).body.code).toBe('SELF_BOOKING');
    expect((await quote(guest, pid, day(42), day(42))).status).toBe(400);
    expect((await call(t, null, 'POST', '/v1/booking/quotes', { propertyId: pid, checkIn: day(40), checkOut: day(42), guests: 1 })).status).toBe(401);
    await t.pool.query(`UPDATE properties SET status = 'UNLISTED' WHERE id = $1`, [pid]);
    expect((await quote(guest, pid, day(40), day(42))).body.code).toBe('PROPERTY_NOT_BOOKABLE');
  });
});

describe('STAY-08 hold', () => {
  it('requires the paid booking flag (403 when OFF) and the compliance gate (403 COMPLIANCE_BLOCKED)', async () => {
    const pid = await makeProperty();
    const q = await quote(guest, pid, day(50), day(52));
    await setFlag(t.pool, 'stay.paid_booking', false);
    const off = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId: q.body.item.id }, idem());
    await enableFlags(t, 'stay.paid_booking');
    expect(off.status).toBe(403);
    expect(off.body.code).toBe('FEATURE_DISABLED');

    const blocked = await makeProperty({ paid: false });
    const q2 = await quote(guest, blocked, day(50), day(52));
    const res = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId: q2.body.item.id }, idem());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('COMPLIANCE_BLOCKED');
    // no block was acquired
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM inventory_blocks WHERE property_id = $1`, [blocked])).rows[0].n).toBe(0);
  });

  it('requires Idempotency-Key, replays the same response and rejects key reuse with another body; others cannot use my quote', async () => {
    const pid = await makeProperty();
    const q = await quote(guest, pid, day(60), day(63));
    const quoteId = q.body.item.id;
    expect((await call(t, guest, 'POST', '/v1/booking/holds', { quoteId })).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await call(t, other, 'POST', '/v1/booking/holds', { quoteId }, idem())).status).toBe(404);
    const key = idem();
    const a = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId }, key);
    const b = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId }, key);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.body).toEqual(a.body);
    expect(a.body.item.reservation.status).toBe('HELD');
    const q2 = await quote(guest, pid, day(70), day(72));
    expect((await call(t, guest, 'POST', '/v1/booking/holds', { quoteId: q2.body.item.id }, key)).status).toBe(422);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM reservation_holds WHERE quote_id = $1`, [quoteId])).rows[0].n).toBe(1);
    // same quote, new key → already held
    expect((await call(t, guest, 'POST', '/v1/booking/holds', { quoteId }, idem())).status).toBe(409);
    // DRAFT→QUOTED→HELD history recorded with correlation id
    const hist = await t.pool.query(`SELECT from_state, to_state, correlation_id FROM state_transitions WHERE aggregate_type='RESERVATION' AND aggregate_id=$1 ORDER BY id`, [a.body.item.reservation.id]);
    expect(hist.rows.map((r) => `${r.from_state}->${r.to_state}`)).toEqual(['null->DRAFT', 'DRAFT->QUOTED', 'QUOTED->HELD']);
    expect(hist.rows.every((r) => r.correlation_id)).toBe(true);
    expect(await outbox('reservation.held', a.body.item.reservation.id)).toHaveLength(1);
  });

  it('20 parallel holds for overlapping dates → exactly one winner', async () => {
    const pid = await makeProperty();
    const users = await Promise.all(Array.from({ length: 20 }, () => createUser(t)));
    const quotes = [];
    for (const [i, u] of users.entries()) {
      const q = await quote(u, pid, day(80 + (i % 3)), day(84 + (i % 2)));
      expect(q.status, JSON.stringify(q.body)).toBe(201);
      quotes.push({ u, id: q.body.item.id });
    }
    const results = await Promise.all(quotes.map(({ u, id }) => call(t, u, 'POST', '/v1/booking/holds', { quoteId: id }, idem())));
    const codes = results.map((r) => r.status);
    expect(codes.filter((s) => s === 201)).toHaveLength(1);
    expect(codes.filter((s) => s === 409)).toHaveLength(19);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM inventory_blocks WHERE property_id = $1 AND state = 'ACTIVE'`, [pid])).rows[0].n).toBe(1);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM reservations WHERE property_id = $1`, [pid])).rows[0].n).toBe(1);
  });

  it('expiry job expires holds and releases the dates; guest can release a hold explicitly', async () => {
    const pid = await makeProperty();
    const { hold, reservation } = await quoteAndHold(guest, pid, day(90), day(92));
    const cal1 = await call(t, null, 'GET', `/v1/properties/${pid}/calendar?from=${day(90)}&to=${day(92)}`);
    expect(cal1.body.item.days.map((d: any) => d.status)).toEqual(['booked', 'booked']);
    // a competing quote is rejected while held
    expect((await quote(other, pid, day(91), day(93))).status).toBe(409);
    await t.pool.query(`UPDATE reservation_holds SET expires_at = now() - interval '1 second' WHERE id = $1`, [hold.id]);
    await t.pool.query(`UPDATE inventory_blocks SET expires_at = now() - interval '1 second' WHERE id = $1`, [hold.inventoryBlockId]);
    expect(await expireHolds(t.app.ctx)).toBeGreaterThanOrEqual(1);
    expect((await t.pool.query(`SELECT status FROM reservation_holds WHERE id = $1`, [hold.id])).rows[0].status).toBe('EXPIRED');
    expect((await t.pool.query(`SELECT state FROM inventory_blocks WHERE id = $1`, [hold.inventoryBlockId])).rows[0].state).toBe('EXPIRED');
    expect(await status(reservation.id)).toBe('EXPIRED');
    expect(await outbox('reservation.hold_expired', reservation.id)).toHaveLength(1);
    const cal2 = await call(t, null, 'GET', `/v1/properties/${pid}/calendar?from=${day(90)}&to=${day(92)}`);
    expect(cal2.body.item.days.map((d: any) => d.status)).toEqual(['available', 'available']);
    // expired reservation can no longer be paid
    await expect(withTx(t.pool, (tx) => paymentSubject('RESERVATION').payable(tx, actorCtx(guest), reservation.id))).rejects.toMatchObject({ code: 'RESERVATION_NOT_PAYABLE' });

    const second = await quoteAndHold(other, pid, day(91), day(93));
    expect((await call(t, guest, 'DELETE', `/v1/booking/holds/${second.hold.id}`)).status).toBe(403);
    expect((await call(t, other, 'DELETE', `/v1/booking/holds/${second.hold.id}`)).status).toBe(204);
    expect(await status(second.reservation.id)).toBe('EXPIRED');
    expect((await call(t, other, 'DELETE', `/v1/booking/holds/${second.hold.id}`)).status).toBe(409);
  });

  it('expiry job skips holds whose payment is CONFIRMING', async () => {
    const pid = await makeProperty();
    const { hold, reservation } = await quoteAndHold(guest, pid, day(95), day(97));
    await t.pool.query(
      `INSERT INTO payments(provider, provider_order_id, payer_id, subject_type, subject_id, status, amount_minor, currency, expires_at)
       VALUES ('MOCK',$1,$2,'RESERVATION',$3,'CONFIRMING',$4,'KRW', now() + interval '10 minutes')`,
      [`ord-${randomUUID()}`, guest.id, reservation.id, reservation.totalMinor],
    );
    await t.pool.query(`UPDATE reservation_holds SET expires_at = now() - interval '1 second' WHERE id = $1`, [hold.id]);
    await expireHolds(t.app.ctx);
    expect((await t.pool.query(`SELECT status, expires_at > now() AS live FROM reservation_holds WHERE id = $1`, [hold.id])).rows[0]).toEqual({ status: 'ACTIVE', live: true });
    expect(await status(reservation.id)).toBe('HELD');
  });
});

describe('STAY-09 reservation FSM', () => {
  it('hold → payment subject → CONFIRMED → check-in → complete; address only after confirmation; invalid transitions 409', async () => {
    const pid = await makeProperty();
    const { reservation } = await quoteAndHold(guest, pid, day(0), day(2));
    const before = await call(t, guest, 'GET', `/v1/reservations/${reservation.id}`);
    expect(before.body.item.property.address).toBeNull();
    // invalid transitions before payment
    const early = await call(t, host, 'POST', `/v1/reservations/${reservation.id}/complete`);
    expect(early.status, JSON.stringify(early.body)).toBe(409);
    expect((await call(t, guest, 'POST', `/v1/reservations/${reservation.id}/check-in`)).body.code).toBe('INVALID_STATE_TRANSITION');
    // payable: server-side amount & split
    const h = paymentSubject('RESERVATION');
    await expect(withTx(t.pool, (tx) => h.payable(tx, actorCtx(other), reservation.id))).rejects.toMatchObject({ status: 403 });
    // amount mismatch never confirms
    await expect(
      withTx(t.pool, (tx) => h.onPaymentApproved(tx, t.ctx(), reservation.id, { id: randomUUID(), amountMinor: reservation.totalMinor - 1, currency: 'KRW' })),
    ).rejects.toMatchObject({ code: 'PAYMENT_AMOUNT_MISMATCH' });
    const { snap, paymentId } = await pay(reservation.id, guest);
    const q = reservation.quote;
    expect(snap).toMatchObject({
      payerId: guest.id, amountMinor: reservation.totalMinor, currency: 'KRW', merchantOfRecord: 'JETPOOL',
      split: [{ payeeId: host.id, payeeType: 'HOST', grossMinor: q.subtotalMinor + q.cleaningFeeMinor, feeMinor: q.hostFeeMinor, taxMinor: q.taxMinor }],
    });
    expect(await status(reservation.id)).toBe('CONFIRMED');
    // idempotent replay of approval
    await withTx(t.pool, (tx) => h.onPaymentApproved(tx, t.ctx(), reservation.id, { id: paymentId, amountMinor: reservation.totalMinor, currency: 'KRW' }));
    const blockId = (await lockReservation(t.pool, reservation.id)).inventory_block_id;
    const block = (await t.pool.query(`SELECT block_type, source_id, expires_at FROM inventory_blocks WHERE id = $1`, [blockId])).rows[0];
    expect(block).toMatchObject({ block_type: 'RESERVATION', source_id: reservation.id, expires_at: null });
    expect((await t.pool.query(`SELECT status FROM reservation_holds WHERE id = $1`, [reservation.holdId])).rows[0].status).toBe('CONVERTED');
    const conv = await t.pool.query(
      `SELECT m.user_id, m.role FROM conversations c JOIN conversation_members m ON m.conversation_id = c.id WHERE c.context_type='RESERVATION' AND c.context_id=$1 ORDER BY m.role`,
      [reservation.id],
    );
    expect(conv.rows).toEqual([{ user_id: guest.id, role: 'GUEST' }, { user_id: host.id, role: 'HOST' }]);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE dedupe_key = $1`, [`reservation.confirmed:${reservation.id}`])).rows[0].n).toBe(2);
    expect(await outbox('reservation.confirmed', reservation.id)).toHaveLength(1);

    const after = await call(t, guest, 'GET', `/v1/reservations/${reservation.id}`);
    expect(after.body.item.property.address.line1).toBe('1 Secret-ro 42');
    expect(after.body.item.history.map((x: any) => x.to)).toEqual(['DRAFT', 'QUOTED', 'HELD', 'PAYMENT_PENDING', 'CONFIRMED']);
    expect((await call(t, host, 'GET', `/v1/reservations/${reservation.id}`)).status).toBe(200);
    expect((await call(t, admin, 'GET', `/v1/reservations/${reservation.id}`)).status).toBe(200);
    expect((await call(t, other, 'GET', `/v1/reservations/${reservation.id}`)).status).toBe(403);
    expect((await call(t, other, 'POST', `/v1/reservations/${reservation.id}/check-in`)).status).toBe(403);
    // no-show not allowed on the check-in day
    expect((await call(t, host, 'POST', `/v1/reservations/${reservation.id}/no-show`)).body.code).toBe('NO_SHOW_TOO_EARLY');

    const ci = await call(t, guest, 'POST', `/v1/reservations/${reservation.id}/check-in`);
    expect(ci.status, JSON.stringify(ci.body)).toBe(200);
    expect(ci.body.item.status).toBe('CHECKED_IN');
    expect((await call(t, guest, 'POST', `/v1/reservations/${reservation.id}/complete`)).status).toBe(403);
    // the host cannot complete before the stay has been delivered (check-out date in the property timezone)
    const tooEarly = await call(t, host, 'POST', `/v1/reservations/${reservation.id}/complete`);
    expect(tooEarly.status).toBe(409);
    expect(tooEarly.body.code).toBe('STAY_NOT_ENDED');
    await t.pool.query(`UPDATE reservations SET check_in = $2, check_out = $3 WHERE id = $1`, [reservation.id, day(-2), day(0)]);
    const done = await call(t, host, 'POST', `/v1/reservations/${reservation.id}/complete`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.item.status).toBe('COMPLETED');
    expect(await outbox('reservation.completed', reservation.id)).toHaveLength(1);
    expect((await call(t, host, 'POST', `/v1/reservations/${reservation.id}/complete`)).status).toBe(409);
    expect((await call(t, guest, 'POST', `/v1/reservations/${reservation.id}/cancel`, { reason: 'late' }, idem())).status).toBe(409);
    const hist = await t.pool.query(`SELECT actor_type, actor_id, correlation_id FROM state_transitions WHERE aggregate_id = $1 AND to_state = 'COMPLETED'`, [reservation.id]);
    expect(hist.rows[0]).toMatchObject({ actor_type: 'USER', actor_id: host.id });

    // lists
    expect((await call(t, guest, 'GET', '/v1/reservations')).body.items.some((x: any) => x.id === reservation.id)).toBe(true);
    expect((await call(t, other, 'GET', '/v1/reservations')).body.items.some((x: any) => x.id === reservation.id)).toBe(false);
    expect((await call(t, host, 'GET', '/v1/host/reservations?filter=completed')).body.items.map((x: any) => x.id)).toContain(reservation.id);
    expect((await call(t, host, 'GET', '/v1/host/reservations?filter=upcoming')).body.items.map((x: any) => x.id)).not.toContain(reservation.id);
  });

  it('payment failure → PAYMENT_FAILED → retry → CONFIRMED; job auto-completes past check-out', async () => {
    const pid = await makeProperty();
    const { reservation } = await quoteAndHold(guest, pid, day(0), day(1));
    const h = paymentSubject('RESERVATION');
    await withTx(t.pool, async (tx) => {
      await h.payable(tx, actorCtx(guest), reservation.id);
      const p1 = randomUUID();
      await h.onPaymentCreated!(tx, t.ctx(), reservation.id, p1);
      await h.onPaymentFailed!(tx, t.ctx(), reservation.id, { id: p1, reason: 'card declined' });
    });
    expect(await status(reservation.id)).toBe('PAYMENT_FAILED');
    await pay(reservation.id, guest);
    expect(await status(reservation.id)).toBe('CONFIRMED');
    expect((await call(t, host, 'POST', `/v1/reservations/${reservation.id}/check-in`)).status).toBe(200);
    await t.pool.query(`UPDATE reservations SET check_in = $2, check_out = $3 WHERE id = $1`, [reservation.id, day(-2), day(0)]);
    expect(await autoCompleteStays(t.app.ctx)).toBeGreaterThanOrEqual(1);
    expect(await status(reservation.id)).toBe('COMPLETED');
  });

  it('host can mark no-show after the check-in day', async () => {
    const pid = await makeProperty();
    const { reservation } = await quoteAndHold(guest, pid, day(3), day(5));
    await pay(reservation.id, guest);
    await t.pool.query(`UPDATE reservations SET check_in = $2, check_out = $3 WHERE id = $1`, [reservation.id, day(-1), day(1)]);
    expect((await call(t, guest, 'POST', `/v1/reservations/${reservation.id}/no-show`)).status).toBe(403);
    const ns = await call(t, host, 'POST', `/v1/reservations/${reservation.id}/no-show`, { reason: 'did not arrive' });
    expect(ns.body.item.status).toBe('NO_SHOW');
    expect(await outbox('reservation.no_show', reservation.id)).toHaveLength(1);
  });
});

describe('STAY-10 cancellation', () => {
  it('evaluates MODERATE tiers at exact boundaries in the property timezone', async () => {
    const pid = await makeProperty({ timezone: 'Asia/Seoul' });
    const { reservation } = await quoteAndHold(guest, pid, day(30), day(32));
    await pay(reservation.id, guest);
    const r = await lockReservation(t.pool, reservation.id);
    // check-in instant: check_in 15:00 Asia/Seoul = 06:00Z
    const checkInAt = Date.parse(`${r.check_in}T06:00:00Z`);
    const H = 3_600_000;
    // MODERATE: service fee not refundable → neither is the VAT charged on it
    const fee = r.quote_snapshot.platformFeeMinor + r.quote_snapshot.taxMinor;
    const base = r.total_minor - fee;
    expect(base).toBe(r.quote_snapshot.subtotalMinor + r.quote_snapshot.cleaningFeeMinor);
    const at = (ms: number) => evaluateCancellation(t.pool, r, 'GUEST', new Date(ms));
    const e120 = await at(checkInAt - 120 * H);
    expect(e120.checkInAt).toBe(new Date(checkInAt).toISOString());
    expect(e120).toMatchObject({ refundPct: 100, refundMinor: base, feeRefundMinor: 0, nonRefundableMinor: fee });
    expect(await at(checkInAt - 120 * H + 1000)).toMatchObject({ refundPct: 50, refundMinor: applyBps(base, 5000) });
    expect(await at(checkInAt - 24 * H)).toMatchObject({ refundPct: 50 });
    expect(await at(checkInAt - 24 * H + 1000)).toMatchObject({ refundPct: 0, refundMinor: 0 });
    expect(await at(checkInAt + H)).toMatchObject({ refundPct: 0, refundMinor: 0 });
    // host / staff always 100% including fees (the fee component is the service fee + its tax)
    expect(await evaluateCancellation(t.pool, r, 'HOST', new Date(checkInAt - H))).toMatchObject({ refundPct: 100, refundMinor: r.total_minor, feeRefundMinor: fee });
  });

  it('guest cancellation releases dates, records adjustment, requests refund, then refund callback → PARTIALLY_REFUNDED', async () => {
    const pid = await makeProperty();
    const { reservation } = await quoteAndHold(guest, pid, day(30), day(33));
    await pay(reservation.id, guest);
    const preview = await call(t, guest, 'GET', `/v1/reservations/${reservation.id}/cancellation-preview`);
    expect(preview.status).toBe(200);
    expect(preview.body.item.evaluation.refundPct).toBe(100);
    expect((await call(t, other, 'GET', `/v1/reservations/${reservation.id}/cancellation-preview`)).status).toBe(403);
    expect((await call(t, other, 'POST', `/v1/reservations/${reservation.id}/cancel`, { reason: 'x' }, idem())).status).toBe(403);
    expect((await call(t, guest, 'POST', `/v1/reservations/${reservation.id}/cancel`, { reason: 'x' })).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const key = idem();
    const c = await call(t, guest, 'POST', `/v1/reservations/${reservation.id}/cancel`, { reason: 'plans changed' }, key);
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    const expectedRefund = reservation.totalMinor - reservation.quote.platformFeeMinor - reservation.quote.taxMinor;
    expect(c.body.item.status).toBe('REFUND_PENDING');
    expect(c.body.item.cancellation.refundMinor).toBe(expectedRefund);
    const replay = await call(t, guest, 'POST', `/v1/reservations/${reservation.id}/cancel`, { reason: 'plans changed' }, key);
    expect(replay.body).toEqual(c.body);
    expect(await refundsOf(reservation.id)).toEqual([{ amount_minor: expectedRefund, currency: 'KRW', status: 'REQUESTED', idempotency_key: `reservation:${reservation.id}:cancellation` }]);
    expect(await outbox('reservation.cancelled', reservation.id)).toHaveLength(1);
    const adj = await t.pool.query(`SELECT adjustment_type, amount_minor, policy_evaluation, refund_id FROM reservation_adjustments WHERE reservation_id = $1`, [reservation.id]);
    expect(adj.rows).toHaveLength(1);
    expect(adj.rows[0]).toMatchObject({ adjustment_type: 'CANCELLATION_REFUND', amount_minor: expectedRefund });
    expect(adj.rows[0].policy_evaluation.policyCode).toBe('MODERATE');
    expect(adj.rows[0].refund_id).toBeTruthy();
    // historical quote snapshot untouched
    expect((await lockReservation(t.pool, reservation.id)).quote_snapshot).toEqual(reservation.quote);
    // dates free again
    const cal = await call(t, null, 'GET', `/v1/properties/${pid}/calendar?from=${day(30)}&to=${day(33)}`);
    expect(cal.body.item.days.every((d: any) => d.status === 'available')).toBe(true);
    // second cancel is an invalid transition
    expect((await call(t, guest, 'POST', `/v1/reservations/${reservation.id}/cancel`, { reason: 'again' }, idem())).status).toBe(409);

    await withTx(t.pool, (tx) =>
      paymentSubject('RESERVATION').onRefunded!(tx, t.ctx(), reservation.id, { paymentId: randomUUID(), refundId: randomUUID(), amountMinor: expectedRefund, totalRefundedMinor: expectedRefund, fullyRefunded: false }),
    );
    const final = await lockReservation(t.pool, reservation.id);
    expect(final.status).toBe('PARTIALLY_REFUNDED');
    expect(final.refunded_minor).toBe(expectedRefund);
  });

  it('guest cancellation inside 24h → 0 refund → CANCELLED only', async () => {
    const pid = await makeProperty();
    const { reservation } = await quoteAndHold(guest, pid, day(0), day(2));
    await pay(reservation.id, guest);
    const c = await call(t, guest, 'POST', `/v1/reservations/${reservation.id}/cancel`, { reason: 'sick' }, idem());
    expect(c.body.item.status).toBe('CANCELLED');
    expect(c.body.item.cancellation.refundMinor).toBe(0);
    expect(await refundsOf(reservation.id)).toHaveLength(0);
  });

  it('host cancellation → full refund + HOST_CANCELLATION_PENALTY → REFUNDED', async () => {
    const pid = await makeProperty();
    const { reservation } = await quoteAndHold(guest, pid, day(1), day(3));
    await pay(reservation.id, guest);
    const c = await call(t, host, 'POST', `/v1/reservations/${reservation.id}/cancel`, { reason: 'double booked' }, idem());
    expect(c.status, JSON.stringify(c.body)).toBe(200);
    expect(c.body.item.cancellation).toMatchObject({ actorRole: 'HOST', refundPct: 100, refundMinor: reservation.totalMinor });
    const adj = await t.pool.query(`SELECT adjustment_type FROM reservation_adjustments WHERE reservation_id = $1 ORDER BY adjustment_type`, [reservation.id]);
    expect(adj.rows.map((r) => r.adjustment_type)).toEqual(['CANCELLATION_REFUND', 'HOST_CANCELLATION_PENALTY']);
    expect((await refundsOf(reservation.id))[0].amount_minor).toBe(reservation.totalMinor);
    await withTx(t.pool, (tx) =>
      paymentSubject('RESERVATION').onRefunded!(tx, t.ctx(), reservation.id, { paymentId: randomUUID(), refundId: randomUUID(), amountMinor: reservation.totalMinor, totalRefundedMinor: reservation.totalMinor, fullyRefunded: true }),
    );
    expect(await status(reservation.id)).toBe('REFUNDED');
  });
});

describe('STAY-06 availability & calendar', () => {
  it('host blocks, overlay calendar, conflicts and permissions', async () => {
    const pid = await makeProperty();
    expect((await call(t, other, 'PUT', `/v1/properties/${pid}/availability`, { ranges: [{ start: day(100), end: day(101), status: 'UNAVAILABLE' }] })).status).toBe(403);
    expect((await call(t, other, 'POST', `/v1/properties/${pid}/blocks`, { start: day(100), end: day(102) })).status).toBe(403);
    const blk = await call(t, host, 'POST', `/v1/properties/${pid}/blocks`, { start: day(100), end: day(102), note: 'family' });
    expect(blk.status).toBe(201);
    expect(await outbox('availability.changed', pid)).not.toHaveLength(0);
    const { reservation } = await quoteAndHold(guest, pid, day(103), day(105));
    await pay(reservation.id, guest);
    // block over reserved dates fails
    const clash = await call(t, host, 'POST', `/v1/properties/${pid}/blocks`, { start: day(104), end: day(106) });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('INVENTORY_UNAVAILABLE');
    await call(t, host, 'PUT', `/v1/properties/${pid}/availability`, { ranges: [{ start: day(106), end: day(107), status: 'UNAVAILABLE' }] });

    const pub = await call(t, null, 'GET', `/v1/properties/${pid}/calendar?from=${day(100)}&to=${day(107)}`);
    expect(pub.status).toBe(200);
    expect(pub.body.item.days.map((d: any) => d.status)).toEqual(['blocked', 'blocked', 'available', 'booked', 'booked', 'available', 'blocked']);
    expect(pub.body.item.days[2].priceMinor).toBeGreaterThan(0);
    const raw = JSON.stringify(pub.body);
    expect(raw).not.toContain(guest.id);
    expect(raw).not.toContain(reservation.id);
    expect(raw).not.toContain('sourceId');

    expect((await call(t, other, 'GET', `/v1/host/calendar?propertyId=${pid}&from=${day(100)}&to=${day(107)}`)).status).toBe(403);
    const hc = await call(t, host, 'GET', `/v1/host/calendar?propertyId=${pid}&from=${day(100)}&to=${day(107)}`);
    expect(hc.status).toBe(200);
    const types = hc.body.item.blocks.map((b: any) => b.type);
    expect(types).toEqual(['HOST_BLOCK', 'RESERVATION']);
    const resBlock = hc.body.item.blocks[1];
    expect(resBlock).toMatchObject({ sourceType: 'RESERVATION', sourceId: reservation.id, reservation: { id: reservation.id, status: 'CONFIRMED' } });
    expect(hc.body.item.days[3].block).toMatchObject({ type: 'RESERVATION', reservationId: reservation.id });
    expect(hc.body.item.days[6].availability).toBe('UNAVAILABLE');
    // a fresh hold shows as HOLD overlay
    const held = await quoteAndHold(other, pid, day(110), day(111));
    const hc2 = await call(t, host, 'GET', `/v1/host/calendar?propertyId=${pid}&from=${day(110)}&to=${day(111)}`);
    expect(hc2.body.item.blocks[0]).toMatchObject({ type: 'HOLD', sourceId: held.hold.id, reservation: { id: held.reservation.id, status: 'HELD' } });

    // remove host block
    expect((await call(t, other, 'DELETE', `/v1/properties/${pid}/blocks/${blk.body.item.id}`)).status).toBe(403);
    expect((await call(t, host, 'DELETE', `/v1/properties/${pid}/blocks/${blk.body.item.id}`)).status).toBe(204);
    const pub2 = await call(t, null, 'GET', `/v1/properties/${pid}/calendar?from=${day(100)}&to=${day(102)}`);
    expect(pub2.body.item.days.map((d: any) => d.status)).toEqual(['available', 'available']);
    // cannot remove a reservation block through the host-block endpoint
    expect((await call(t, host, 'DELETE', `/v1/properties/${pid}/blocks/${resBlock.blockId}`)).status).toBe(403);
    // unpublished property calendar is hidden publicly
    await t.pool.query(`UPDATE properties SET status = 'UNLISTED' WHERE id = $1`, [pid]);
    expect((await call(t, null, 'GET', `/v1/properties/${pid}/calendar?from=${day(100)}&to=${day(102)}`)).status).toBe(404);
    expect((await call(t, host, 'GET', `/v1/properties/${pid}/calendar?from=${day(100)}&to=${day(102)}`)).status).toBe(200);
  });
});
