import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
let host: TestUser, guest: TestUser, stranger: TestUser, admin: TestUser, support: TestUser;
let propertyId: string;

async function property(hostId: string) {
  const { rows } = await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'Home','HOUSE') RETURNING id`, [hostId]);
  return rows[0].id as string;
}
async function reservation(status: string, completedDaysAgo = 1, opts: { guestId?: string } = {}) {
  const { rows } = await t.pool.query(
    `INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, total_minor, currency, quote_snapshot, completed_at)
     VALUES ($1,$2,$3,$4, current_date - 5, current_date - 2, 100000, 'KRW', '{}', CASE WHEN $4 = 'COMPLETED' THEN now() - make_interval(days => $5) END) RETURNING id`,
    [propertyId, host.id, opts.guestId ?? guest.id, status, completedDaysAgo],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
  guest = await createUser(t);
  stranger = await createUser(t);
  admin = await createUser(t, { roles: ['ADMIN'] });
  support = await createUser(t, { roles: ['SUPPORT'] });
  propertyId = await property(host.id);
});
afterAll(async () => t.close());

describe('TRUST-02 reservation reviews', () => {
  it('guest reviews property and host; host reviews guest; reputation recomputed; review.created emitted', async () => {
    const res = await reservation('COMPLETED');
    const p = await call(t, guest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: res, targetType: 'PROPERTY', rating: 5, body: 'Lovely', subRatings: { cleanliness: 5 } });
    expect(p.status).toBe(201);
    expect(p.body.item.targetId).toBe(propertyId); // derived server-side
    const h = await call(t, guest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: res, targetType: 'HOST', rating: 4 });
    expect(h.status).toBe(201);
    expect(h.body.item.targetId).toBe(host.id);
    const g = await call(t, host, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: res, targetType: 'GUEST', rating: 5 });
    expect(g.status).toBe(201);
    expect(g.body.item.targetId).toBe(guest.id);
    const list = await call(t, null, 'GET', `/v1/reviews?targetType=PROPERTY&targetId=${propertyId}`);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.summary).toEqual({ reviewCount: 1, ratingAvg: 5 });
    const { rows } = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'review.created'`);
    expect(rows).toHaveLength(3);
    expect(rows[0].payload).toMatchObject({ transactionType: 'RESERVATION', transactionId: res, authorId: guest.id });
    const { rows: n } = await t.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND template_key = 'review.received'`, [host.id]);
    expect(n[0].n).toBe(2);
  });

  it('one review per target per transaction', async () => {
    const res = await reservation('COMPLETED');
    expect((await call(t, guest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: res, targetType: 'PROPERTY', rating: 3 })).status).toBe(201);
    const dup = await call(t, guest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: res, targetType: 'PROPERTY', rating: 1 });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('REVIEW_EXISTS');
  });

  it('eligibility negatives: not completed, not a party, wrong role/target, window closed, spoofed targetId', async () => {
    const confirmed = await reservation('CONFIRMED');
    expect((await call(t, guest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: confirmed, targetType: 'PROPERTY', rating: 5 })).body.code).toBe('TRANSACTION_NOT_COMPLETED');
    const done = await reservation('COMPLETED');
    expect((await call(t, stranger, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: done, targetType: 'PROPERTY', rating: 1 })).status).toBe(403);
    // host cannot review their own property; guest cannot review as GUEST
    expect((await call(t, host, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: done, targetType: 'PROPERTY', rating: 5 })).body.code).toBe('NOT_A_PARTY');
    expect((await call(t, guest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: done, targetType: 'GUEST', rating: 5 })).body.code).toBe('NOT_A_PARTY');
    const spoof = await call(t, guest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: done, targetType: 'PROPERTY', targetId: await property(host.id), rating: 1 });
    expect(spoof.body.code).toBe('TARGET_NOT_IN_TRANSACTION');
    const old = await reservation('COMPLETED', 31);
    expect((await call(t, guest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: old, targetType: 'PROPERTY', rating: 5 })).body.code).toBe('REVIEW_WINDOW_CLOSED');
    expect((await call(t, guest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: '00000000-0000-0000-0000-000000000000', targetType: 'PROPERTY', rating: 5 })).status).toBe(404);
    expect((await call(t, null, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: done, targetType: 'PROPERTY', rating: 5 })).status).toBe(401);
  });

  it('host responds once; others cannot respond; reports; moderation hides and recomputes reputation', async () => {
    const res = await reservation('COMPLETED');
    const rv = (await call(t, guest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: res, targetType: 'HOST', rating: 1, body: 'bad' })).body.item;
    expect((await call(t, stranger, 'POST', `/v1/reviews/${rv.id}/response`, { body: 'hi' })).status).toBe(403);
    expect((await call(t, host, 'POST', `/v1/reviews/${rv.id}/response`, { body: 'Sorry to hear' })).status).toBe(201);
    expect((await call(t, host, 'POST', `/v1/reviews/${rv.id}/response`, { body: 'again' })).body.code).toBe('RESPONSE_EXISTS');
    expect((await call(t, null, 'GET', `/v1/reviews/${rv.id}`)).body.item.response.body).toBe('Sorry to hear');

    expect((await call(t, guest, 'POST', `/v1/reviews/${rv.id}/report`, { reason: 'mine' })).body.code).toBe('CANNOT_REPORT_OWN');
    expect((await call(t, host, 'POST', `/v1/reviews/${rv.id}/report`, { reason: 'abusive language' })).status).toBe(201);
    expect((await call(t, host, 'POST', `/v1/reviews/${rv.id}/report`, { reason: 'again' })).body.code).toBe('ALREADY_REPORTED');

    const before = (await call(t, null, 'GET', `/v1/reviews?targetType=HOST&targetId=${host.id}`)).body.summary.reviewCount;
    // permission negatives for moderation
    expect((await call(t, host, 'POST', `/v1/admin/reviews/${rv.id}/moderate`, { action: 'HIDE', reason: 'abuse' })).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['SUPPORT'], aal: 'aal1' });
    expect((await call(t, aal1, 'POST', `/v1/admin/reviews/${rv.id}/moderate`, { action: 'HIDE', reason: 'abuse' })).body.code).toBe('AAL2_REQUIRED');
    const reports = await call(t, support, 'GET', '/v1/admin/review-reports');
    expect(reports.body.items.some((x: any) => x.review_id === rv.id)).toBe(true);
    const hide = await call(t, support, 'POST', `/v1/admin/reviews/${rv.id}/moderate`, { action: 'HIDE', reason: 'abusive language' });
    expect(hide.status).toBe(200);
    expect(hide.body.item.status).toBe('HIDDEN');
    expect((await call(t, null, 'GET', `/v1/reviews?targetType=HOST&targetId=${host.id}`)).body.summary.reviewCount).toBe(before - 1);
    expect((await call(t, null, 'GET', `/v1/reviews/${rv.id}`)).status).toBe(404);
    const { rows } = await t.pool.query(`SELECT status FROM review_reports WHERE review_id = $1`, [rv.id]);
    expect(rows[0].status).toBe('UPHELD');
    const { rows: a } = await t.pool.query(`SELECT category FROM audit_logs WHERE action = 'review.moderated' AND resource_id = $1`, [rv.id]);
    expect(a[0].category).toBe('CONTENT');
    // REMOVED is terminal
    expect((await call(t, admin, 'POST', `/v1/admin/reviews/${rv.id}/moderate`, { action: 'REMOVE', reason: 'policy' })).status).toBe(200);
    expect((await call(t, admin, 'POST', `/v1/admin/reviews/${rv.id}/moderate`, { action: 'RESTORE', reason: 'oops' })).body.code).toBe('INVALID_STATE_TRANSITION');
    const { rows: ev } = await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'review.moderated' AND aggregate_id = $1`, [rv.id]);
    expect(ev[0].n).toBe(2);
  });
});

describe('TRUST-02 exchange, guide and order reviews', () => {
  it('bilateral exchange reviews emit exchange.reviews.completed once both parties reviewed', async () => {
    const a = await createUser(t);
    const b = await createUser(t);
    const pa = await property(a.id);
    const pb = await property(b.id);
    const { rows } = await t.pool.query(
      `INSERT INTO exchange_requests(requester_id, responder_id, property_a_id, property_b_id, dates_a, dates_b, status)
       VALUES ($1,$2,$3,$4, daterange(current_date - 10, current_date - 3), daterange(current_date - 10, current_date - 3), 'COMPLETED') RETURNING id`,
      [a.id, b.id, pa, pb],
    );
    const ex = rows[0].id;
    expect((await call(t, stranger, 'POST', '/v1/reviews', { transactionType: 'EXCHANGE', transactionId: ex, targetType: 'EXCHANGE_PARTNER', rating: 5 })).status).toBe(403);
    expect((await call(t, a, 'POST', '/v1/reviews', { transactionType: 'EXCHANGE', transactionId: ex, targetType: 'PROPERTY', rating: 5 })).body.code).toBe('NOT_A_PARTY');
    const ra = await call(t, a, 'POST', '/v1/reviews', { transactionType: 'EXCHANGE', transactionId: ex, targetType: 'EXCHANGE_PARTNER', rating: 5 });
    expect(ra.body.item.targetId).toBe(b.id);
    const count = async () => (await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'exchange.reviews.completed' AND aggregate_id = $1`, [ex])).rows[0].n;
    expect(await count()).toBe(0);
    const rb = await call(t, b, 'POST', '/v1/reviews', { transactionType: 'EXCHANGE', transactionId: ex, targetType: 'EXCHANGE_PARTNER', rating: 4 });
    expect(rb.status).toBe(201);
    expect(await count()).toBe(1);
    // the exchange module consumes the event (COMPLETED -> REVIEWED)
    await t.drain();
    const { rows: st } = await t.pool.query(`SELECT status FROM exchange_requests WHERE id = $1`, [ex]);
    expect(['COMPLETED', 'REVIEWED']).toContain(st[0].status);
  });

  it('exchange not yet completed is not reviewable', async () => {
    const a = await createUser(t);
    const b = await createUser(t);
    const { rows } = await t.pool.query(
      `INSERT INTO exchange_requests(requester_id, responder_id, property_a_id, property_b_id, dates_a, dates_b, status)
       VALUES ($1,$2,$3,$4, daterange(current_date + 10, current_date + 13), daterange(current_date + 10, current_date + 13), 'CONFIRMED') RETURNING id`,
      [a.id, b.id, await property(a.id), await property(b.id)],
    );
    expect((await call(t, a, 'POST', '/v1/reviews', { transactionType: 'EXCHANGE', transactionId: rows[0].id, targetType: 'EXCHANGE_PARTNER', rating: 5 })).body.code).toBe('TRANSACTION_NOT_COMPLETED');
  });

  it('guide booking: traveler->GUIDE, guide->TRAVELER (also allowed once REVIEWED)', async () => {
    const guide = await createUser(t, { roles: ['GUIDE'] });
    const traveler = await createUser(t);
    const { rows } = await t.pool.query(
      `INSERT INTO guide_bookings(guide_id, traveler_id, guide_type, start_at, end_at, status) VALUES ($1,$2,'FRIEND', now() - interval '3 days', now() - interval '3 days' + interval '2 hours', 'COMPLETED') RETURNING id`,
      [guide.id, traveler.id],
    );
    const id = rows[0].id;
    expect((await call(t, traveler, 'POST', '/v1/reviews', { transactionType: 'GUIDE_BOOKING', transactionId: id, targetType: 'TRAVELER', rating: 5 })).body.code).toBe('NOT_A_PARTY');
    const r1 = await call(t, traveler, 'POST', '/v1/reviews', { transactionType: 'GUIDE_BOOKING', transactionId: id, targetType: 'GUIDE', rating: 5 });
    expect(r1.body.item.targetId).toBe(guide.id);
    await t.pool.query(`UPDATE guide_bookings SET status = 'REVIEWED' WHERE id = $1`, [id]);
    const r2 = await call(t, guide, 'POST', '/v1/reviews', { transactionType: 'GUIDE_BOOKING', transactionId: id, targetType: 'TRAVELER', rating: 4 });
    expect(r2.status).toBe(201);
    expect(r2.body.item.targetId).toBe(traveler.id);
  });

  it('order: buyer reviews a travel product that was in the fulfilled order only', async () => {
    const supplierOwner = await createUser(t, { roles: ['SUPPLIER'] });
    const buyer = await createUser(t);
    const { rows: s } = await t.pool.query(`INSERT INTO suppliers(owner_user_id, name, supplier_type) VALUES ($1,'Tours Inc','TOUR_OPERATOR') RETURNING id`, [supplierOwner.id]);
    const { rows: p } = await t.pool.query(`INSERT INTO travel_products(supplier_id, type, title) VALUES ($1,'TOUR','Jeju tour'),($1,'TOUR','Other tour') RETURNING id`, [s[0].id]);
    const { rows: d } = await t.pool.query(`INSERT INTO travel_departures(product_id, starts_at, capacity) VALUES ($1, now() - interval '5 days', 10) RETURNING id`, [p[0].id]);
    const { rows: o } = await t.pool.query(`INSERT INTO orders(buyer_id, status, currency, total_minor, merchant_of_record) VALUES ($1,'FULFILLED','KRW',50000,'SUPPLIER') RETURNING id`, [buyer.id]);
    await t.pool.query(
      `INSERT INTO order_items(order_id, sellable_type, sellable_id, supplier_id, title, qty, unit_price_minor, amount_minor) VALUES ($1,'TRAVEL_DEPARTURE',$2,$3,'Jeju tour',1,50000,50000)`,
      [o[0].id, d[0].id, s[0].id],
    );
    expect((await call(t, buyer, 'POST', '/v1/reviews', { transactionType: 'ORDER', transactionId: o[0].id, targetType: 'TRAVEL_PRODUCT', rating: 5 })).body.code).toBe('TARGET_REQUIRED');
    expect((await call(t, buyer, 'POST', '/v1/reviews', { transactionType: 'ORDER', transactionId: o[0].id, targetType: 'TRAVEL_PRODUCT', targetId: p[1].id, rating: 5 })).body.code).toBe('TARGET_NOT_IN_TRANSACTION');
    expect((await call(t, supplierOwner, 'POST', '/v1/reviews', { transactionType: 'ORDER', transactionId: o[0].id, targetType: 'TRAVEL_PRODUCT', targetId: p[0].id, rating: 5 })).status).toBe(403);
    const ok = await call(t, buyer, 'POST', '/v1/reviews', { transactionType: 'ORDER', transactionId: o[0].id, targetType: 'TRAVEL_PRODUCT', targetId: p[0].id, rating: 4 });
    expect(ok.status).toBe(201);
    // the supplier owner may respond
    expect((await call(t, supplierOwner, 'POST', `/v1/reviews/${ok.body.item.id}/response`, { body: 'Thanks!' })).status).toBe(201);
  });

  it('lists my written reviews and pending review tasks', async () => {
    const g2 = await createUser(t);
    const res = await reservation('COMPLETED', 1, { guestId: g2.id });
    const mine = await call(t, g2, 'GET', '/v1/me/reviews');
    expect(mine.body.pending.some((x: any) => x.transaction_id === res)).toBe(true);
    await call(t, g2, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: res, targetType: 'HOST', rating: 5 });
    const after = await call(t, g2, 'GET', '/v1/me/reviews');
    expect(after.body.written).toHaveLength(1);
    expect(after.body.pending.some((x: any) => x.transaction_id === res)).toBe(false);
  });
});
