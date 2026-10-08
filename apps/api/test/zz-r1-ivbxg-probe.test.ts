import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, createUser, call, day, enableFlags, idem, type TestApp, type TestUser } from './helpers.js';
import { autoCompleteStays } from '../src/modules/booking/reservations.js';
import { listRequests } from '../src/modules/guide/requests.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t?.close());

async function exMember(city = 'Seoul') {
  const user = await createUser(t, { verified: true });
  const { rows } = await t.pool.query(
    `INSERT INTO properties(host_id, title, property_type, max_guests, city, status, exchange_enabled, published_at)
     VALUES ($1,$2,'APARTMENT',4,$3,'PUBLISHED',true, now()) RETURNING id`,
    [user.id, `Home ${user.email}`, city],
  );
  const r = await call(t, user, 'PUT', '/v1/exchange/profile', { homeDescription: 'A quiet, sunny family apartment.', preferredDestinations: ['Busan'] });
  expect(r.status).toBe(200);
  return { user, propertyId: rows[0].id as string };
}

describe('probe', () => {
  it('exchange invalid calendar date → status', async () => {
    await enableFlags(t, 'exchange.enabled');
    const a = await exMember();
    const b = await exMember('Busan');
    const y = new Date().getUTCFullYear() + 1;
    const r = await call(t, a.user, 'POST', '/v1/exchanges', {
      myPropertyId: a.propertyId, theirPropertyId: b.propertyId,
      datesA: { start: `${y}-02-30`, end: `${y}-03-05` }, datesB: { start: `${y}-04-01`, end: `${y}-04-05` },
    });
    console.log('EXCH create invalid date', r.status, r.body.code);
    const h = await call(t, a.user, 'GET', `/v1/exchange/homes?start=${y}-02-30&end=${y}-03-03`);
    console.log('EXCH homes invalid date', h.status, h.body.code);
    const h2 = await call(t, a.user, 'GET', `/v1/exchange/homes?start=${y}-13-01&end=${y}-13-05`);
    console.log('EXCH homes month 13', h2.status, h2.body.code);
  });

  it('public calendar year 0000 → status', async () => {
    const host = await createUser(t, { roles: ['HOST'] });
    const { rows } = await t.pool.query(
      `INSERT INTO properties(host_id, title, property_type, status, rental_enabled, base_price_minor, currency, max_guests, timezone, published_at)
       VALUES ($1,'x','HOUSE','PUBLISHED',true,1000,'KRW',2,'UTC', now()) RETURNING id`,
      [host.id],
    );
    const r = await call(t, null, 'GET', `/v1/properties/${rows[0].id}/calendar?from=0000-01-01&to=0000-01-05`);
    console.log('CAL year0', r.status, r.body.code);
  });

  it('guide qualification invalid date → status', async () => {
    const u = await createUser(t, { verified: true });
    expect((await call(t, u, 'POST', '/v1/guides/profile', { guideType: 'FRIEND' })).status).toBe(201);
    const { rows } = await t.pool.query(
      `INSERT INTO media_assets(owner_id, storage_key, purpose, mime_type, byte_size, status) VALUES ($1,$2,'VERIFICATION','application/pdf',100,'READY') RETURNING id`,
      [u.id, `test/${randomUUID()}`],
    );
    const r = await call(t, u, 'POST', '/v1/guides/qualifications', { qualificationType: 'OTHER', documentMediaId: rows[0].id, validUntil: '2099-02-30' });
    console.log('GUIDE qual invalid date', r.status, r.body.code);
  });

  it('property timezone accepted unvalidated; auto-complete job breaks for everyone', async () => {
    const host = await createUser(t, { roles: ['HOST'] });
    const p = await call(t, host, 'POST', '/v1/properties', { title: 'Draft home', propertyType: 'HOUSE', timezone: 'Not/AZone' });
    console.log('PROP create tz', p.status, p.body?.item?.timezone);
    const mk = async (tz: string) => {
      const { rows } = await t.pool.query(
        `INSERT INTO properties(host_id, title, property_type, status, rental_enabled, base_price_minor, currency, max_guests, timezone, published_at)
         VALUES ($1,'x','HOUSE','PUBLISHED',true,1000,'KRW',2,$2, now()) RETURNING id`,
        [host.id, tz],
      );
      return rows[0].id as string;
    };
    const guest = await createUser(t);
    const good = await mk('Asia/Seoul');
    const bad = await mk('UTC');
    const ins = async (pid: string) =>
      (await t.pool.query(
        `INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, guests, total_minor, currency, quote_snapshot, cancellation_policy_snapshot)
         VALUES ($1,$2,$3,'CHECKED_IN',$4,$5,1,1000,'KRW','{}','{}') RETURNING id`,
        [pid, host.id, guest.id, day(-3), day(-1)],
      )).rows[0].id as string;
    const rGood = await ins(good);
    await ins(bad);
    // host later changes timezone (PATCH accepts any string ≤ 64 chars)
    await t.pool.query(`UPDATE properties SET timezone = 'Not/AZone' WHERE id = $1`, [bad]);
    let err: any = null;
    try { await autoCompleteStays(t.app.ctx); } catch (e) { err = e; }
    console.log('AUTO-COMPLETE', err?.code, err?.message);
    const st = (await t.pool.query(`SELECT status FROM reservations WHERE id = $1`, [rGood])).rows[0].status;
    console.log('good reservation status after job', st);
    const hl = await call(t, host, 'GET', '/v1/host/reservations?filter=current');
    console.log('host list current', hl.status, hl.body.code);
  });

  it('guide request list cursor paging with same-ms rows', async () => {
    const trav = await createUser(t);
    // three requests whose created_at differ only in microseconds within one millisecond
    const base = '2030-01-01 00:00:00.123';
    for (const us of ['900', '500', '100']) {
      await t.pool.query(
        `INSERT INTO guide_requests(traveler_id, start_at, end_at, party_size, created_at) VALUES ($1, now() + interval '2 day', now() + interval '2 day 1 hour', 1, $2::timestamptz)`,
        [trav.id, `${base}${us}+00`],
      );
    }
    const actor = { userId: trav.id, sessionId: trav.sessionId, roles: ['USER'] as any, aal: 'aal1' as const, status: 'ACTIVE' };
    const p1 = await listRequests(t.pool, actor, { limit: 1 });
    const p2 = await listRequests(t.pool, actor, { limit: 1, cursor: p1.nextCursor ?? undefined });
    console.log('GUIDE paging p1', p1.items.length, 'p2', p2.items.length, 'next', !!p2.nextCursor);
  });
});
