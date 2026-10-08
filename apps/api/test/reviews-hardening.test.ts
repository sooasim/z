import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';

/** Regression tests for the trust r1 reviews findings (moderation conflict of interest, concurrency). */
let t: TestApp;
let host: TestUser, admin: TestUser;

const property = async (hostId: string) => (await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'Home','HOUSE') RETURNING id`, [hostId])).rows[0].id as string;
async function completedStay(propertyId: string, hostId: string, guestId: string) {
  const { rows } = await t.pool.query(
    `INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, total_minor, currency, quote_snapshot, completed_at)
     VALUES ($1,$2,$3,'COMPLETED', current_date - 5, current_date - 2, 100000, 'KRW', '{}', now() - interval '1 day') RETURNING id`,
    [propertyId, hostId, guestId],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
  admin = await createUser(t, { roles: ['ADMIN'] });
});
afterAll(async () => t.close());

describe('review moderation conflict of interest', () => {
  it('staff cannot hide reviews about their own listing, restore their own review or dismiss reports on them', async () => {
    const supportHost = await createUser(t, { roles: ['SUPPORT', 'HOST'] });
    const myProperty = await property(supportHost.id);
    const critic = await createUser(t);
    const bad = await call(t, critic, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: await completedStay(myProperty, supportHost.id, critic.id), targetType: 'PROPERTY', rating: 1, body: 'dirty' });
    expect(bad.status).toBe(201);
    const hide = await call(t, supportHost, 'POST', `/v1/admin/reviews/${bad.body.item.id}/moderate`, { action: 'HIDE', reason: 'policy' });
    expect(hide.status).toBe(403);
    expect(hide.body.code).toBe('CONFLICT_OF_INTEREST');
    expect((await call(t, null, 'GET', `/v1/reviews/${bad.body.item.id}`)).status).toBe(200);
    // the host-side review about the guest is authored by the staff member
    const reporter = await createUser(t);
    const report = await call(t, reporter, 'POST', `/v1/reviews/${bad.body.item.id}/report`, { reason: 'seems fake' });
    expect(report.status).toBe(201);
    const dismiss = await call(t, supportHost, 'POST', `/v1/admin/review-reports/${report.body.item.id}/dismiss`);
    expect(dismiss.status).toBe(403);
    expect(dismiss.body.code).toBe('CONFLICT_OF_INTEREST');

    // own review: a SUPPORT agent who is also a guest cannot restore their hidden review
    const supportGuest = await createUser(t, { roles: ['SUPPORT'] });
    const mine = await call(t, supportGuest, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: await completedStay(await property(host.id), host.id, supportGuest.id), targetType: 'PROPERTY', rating: 5 });
    expect((await call(t, admin, 'POST', `/v1/admin/reviews/${mine.body.item.id}/moderate`, { action: 'HIDE', reason: 'incentivised review' })).status).toBe(200);
    const restore = await call(t, supportGuest, 'POST', `/v1/admin/reviews/${mine.body.item.id}/moderate`, { action: 'RESTORE', reason: 'fine' });
    expect(restore.status).toBe(403);
    expect(restore.body.code).toBe('CONFLICT_OF_INTEREST');
    // an unrelated moderator can act
    expect((await call(t, admin, 'POST', `/v1/admin/reviews/${bad.body.item.id}/moderate`, { action: 'HIDE', reason: 'abusive' })).status).toBe(200);
  });
});

describe('review concurrency', () => {
  it('concurrent bilateral exchange reviews emit exchange.reviews.completed exactly once', async () => {
    for (let round = 0; round < 4; round++) {
      const a = await createUser(t);
      const b = await createUser(t);
      const { rows } = await t.pool.query(
        `INSERT INTO exchange_requests(requester_id, responder_id, property_a_id, property_b_id, dates_a, dates_b, status, completed_at)
         VALUES ($1,$2,$3,$4, daterange(current_date - 10, current_date - 3), daterange(current_date - 10, current_date - 3), 'COMPLETED', now()) RETURNING id`,
        [a.id, b.id, await property(a.id), await property(b.id)],
      );
      const ex = rows[0].id;
      const res = await Promise.all(
        [a, b].map((u) => call(t, u, 'POST', '/v1/reviews', { transactionType: 'EXCHANGE', transactionId: ex, targetType: 'EXCHANGE_PARTNER', rating: 5 })),
      );
      expect(res.map((r) => r.status)).toEqual([201, 201]);
      const n = (await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'exchange.reviews.completed' AND aggregate_id = $1`, [ex])).rows[0].n;
      expect(n).toBe(1);
    }
  });

  it('concurrent reviews of one target keep the reputation projection exact', async () => {
    const p = await property(host.id);
    const guests = await Promise.all(Array.from({ length: 6 }, () => createUser(t)));
    const stays: string[] = [];
    for (const g of guests) stays.push(await completedStay(p, host.id, g.id));
    const ratings = [5, 1, 4, 2, 3, 5];
    const res = await Promise.all(
      guests.map((g, i) => call(t, g, 'POST', '/v1/reviews', { transactionType: 'RESERVATION', transactionId: stays[i], targetType: 'PROPERTY', rating: ratings[i] })),
    );
    expect(res.every((r) => r.status === 201)).toBe(true);
    const { rows } = await t.pool.query(`SELECT review_count, rating_avg FROM reputation_scores WHERE target_type = 'PROPERTY' AND target_id = $1`, [p]);
    expect(rows[0]).toMatchObject({ review_count: 6, rating_avg: 3.33 });
  });
});

describe('tampered pagination cursors', () => {
  const cursor = (ts: string) => Buffer.from(JSON.stringify([ts, '00000000-0000-4000-8000-000000000000'])).toString('base64url');
  const bad = ['2026-13-45T00:00:00Z', '0000-01-01T00:00:00Z', '2026-01-01T25:61:61Z', '2026-01-01T00:00:00+99:99', '2026-02-30T00:00:00Z'];

  it('out-of-range cursor timestamps restart the listing instead of failing with 500', async () => {
    const u = await createUser(t);
    for (const ts of bad) {
      const pub = await call(t, null, 'GET', `/v1/reviews?targetType=HOST&targetId=${host.id}&cursor=${cursor(ts)}`);
      expect(pub.status, ts).toBe(200);
      expect((await call(t, u, 'GET', `/v1/disputes?cursor=${cursor(ts)}`)).status, ts).toBe(200);
      expect((await call(t, u, 'GET', `/v1/support/cases?cursor=${cursor(ts)}`)).status, ts).toBe(200);
    }
    expect((await call(t, null, 'GET', `/v1/reviews?targetType=HOST&targetId=${host.id}&cursor=${cursor('2026-01-01T00:00:00Z')}`)).status).toBe(200);
  });

  it('a year-0000 datetime filter is a 400, not a 500', async () => {
    const r = await call(t, admin, 'GET', '/v1/admin/risk/events?since=0000-01-01T00:00:00Z');
    expect(r.status).toBe(400);
  });
});
