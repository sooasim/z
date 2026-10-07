import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, day, type TestApp, type TestUser } from './helpers.js';
import { isEnabled } from '../src/platform/flags.js';
import { normalizeFlagRules } from '../src/modules/admin/service.js';

let t: TestApp;
let admin: TestUser, support: TestUser, accounting: TestUser, compliance: TestUser, editor: TestUser, user: TestUser;
let host: TestUser, guest: TestUser, guide: TestUser;
let propA: string, propB: string;
const res: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  support = await createUser(t, { roles: ['SUPPORT'] });
  accounting = await createUser(t, { roles: ['ACCOUNTING'] });
  compliance = await createUser(t, { roles: ['COMPLIANCE'] });
  editor = await createUser(t, { roles: ['EDITOR'] });
  user = await createUser(t);
  host = await createUser(t, { roles: ['HOST'], displayName: 'Host Kim' });
  guest = await createUser(t, { roles: ['HOST'], displayName: 'Guest Lee' });
  guide = await createUser(t, { roles: ['GUIDE'] });
  propA = (await t.pool.query(`INSERT INTO properties(host_id, title, property_type, city, status, rental_enabled, lat, lng) VALUES ($1,'Seaside Hanok','HANOK','Busan','PUBLISHED',true, 35.1, 129.0) RETURNING id`, [host.id])).rows[0].id;
  propB = (await t.pool.query(`INSERT INTO properties(host_id, title, property_type, city, status, exchange_enabled) VALUES ($1,'Mapo 100%_Flat','APARTMENT','Seoul','IN_REVIEW',true) RETURNING id`, [guest.id])).rows[0].id;
  const ins = async (key: string, status: string, ci: number, co: number, createdAgo: string) => {
    res[key] = (
      await t.pool.query(
        `INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, total_minor, currency, quote_snapshot, guest_message, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,100000,'KRW','{}','my phone is 010-1234-5678', now() - $7::interval) RETURNING id`,
        [propA, host.id, guest.id, status, day(ci), day(co), createdAgo],
      )
    ).rows[0].id;
  };
  await ins('confirmed', 'CONFIRMED', 10, 12, '3 days');
  await ins('cancelled', 'CANCELLED', 20, 22, '2 days');
  await ins('held', 'HELD', 30, 31, '1 day');
  await ins('completed', 'COMPLETED', -10, -8, '30 days');
  await t.pool.query(
    `INSERT INTO exchange_requests(requester_id, responder_id, property_a_id, property_b_id, dates_a, dates_b, status)
     VALUES ($1,$2,$3,$4, daterange($5::date,$6::date), daterange($5::date,$6::date), 'REQUESTED'),
            ($2,$1,$4,$3, daterange($7::date,$8::date), daterange($7::date,$8::date), 'CONFIRMED')`,
    [host.id, guest.id, propA, propB, day(40), day(45), day(60), day(65)],
  );
  await t.pool.query(
    `INSERT INTO guide_bookings(guide_id, traveler_id, guide_type, start_at, end_at, status, paid, price_minor)
     VALUES ($1,$2,'FRIEND', now() + interval '5 days', now() + interval '5 days 2 hours', 'CONFIRMED', false, 0),
            ($1,$2,'PRO', now() + interval '9 days', now() + interval '9 days 3 hours', 'PAYMENT_PENDING', true, 50000)`,
    [guide.id, guest.id],
  );
});
afterAll(async () => t.close());

describe('OPS-02 console lists (read-only)', () => {
  it('reservations: role-gated (ADMIN/SUPPORT/ACCOUNTING, AAL2), newest first, no guest message leaked', async () => {
    expect((await call(t, user, 'GET', '/v1/admin/reservations')).status).toBe(403);
    expect((await call(t, editor, 'GET', '/v1/admin/reservations')).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['SUPPORT'], aal: 'aal1' });
    expect((await call(t, aal1, 'GET', '/v1/admin/reservations')).body.code).toBe('AAL2_REQUIRED');
    for (const who of [admin, support, accounting]) expect((await call(t, who, 'GET', '/v1/admin/reservations')).status).toBe(200);

    const r = await call(t, support, 'GET', '/v1/admin/reservations');
    expect(r.body.items.map((x: any) => x.id)).toEqual([res.held, res.cancelled, res.confirmed, res.completed]);
    expect(r.body.items[0]).toMatchObject({ propertyId: propA, propertyTitle: 'Seaside Hanok', hostName: 'Host Kim', guestName: 'Guest Lee', totalMinor: 100000, currency: 'KRW' });
    expect(JSON.stringify(r.body)).not.toContain('010-1234-5678');
    expect(r.body.nextCursor).toBeNull();
  });

  it('reservations: status list, user, property, code and date-range filters', async () => {
    const st = await call(t, support, 'GET', '/v1/admin/reservations?status=CONFIRMED,CANCELLED');
    expect(st.body.items.map((x: any) => x.id).sort()).toEqual([res.confirmed, res.cancelled].sort());
    expect((await call(t, support, 'GET', '/v1/admin/reservations?status=CONFIRMED,BOGUS')).body.code).toBe('INVALID_STATUS');

    expect((await call(t, support, 'GET', `/v1/admin/reservations?userId=${guest.id}`)).body.items).toHaveLength(4);
    expect((await call(t, support, 'GET', `/v1/admin/reservations?userId=${host.id}`)).body.items).toHaveLength(4);
    expect((await call(t, support, 'GET', `/v1/admin/reservations?userId=${user.id}`)).body.items).toHaveLength(0);
    expect((await call(t, support, 'GET', `/v1/admin/reservations?propertyId=${propB}`)).body.items).toHaveLength(0);

    const code = (await t.pool.query(`SELECT code FROM reservations WHERE id = $1`, [res.held])).rows[0].code;
    expect((await call(t, support, 'GET', `/v1/admin/reservations?code=${code.toLowerCase()}`)).body.items.map((x: any) => x.id)).toEqual([res.held]);

    const ci = await call(t, support, 'GET', `/v1/admin/reservations?dateField=CHECK_IN&from=${day(15)}&to=${day(30)}`);
    expect(ci.body.items.map((x: any) => x.id)).toEqual([res.held, res.cancelled]);
    // created range (business days): last 7 days excludes the 30-day-old reservation
    const created = await call(t, support, 'GET', `/v1/admin/reservations?from=${day(-7)}&to=${day(1)}`);
    expect(created.body.items.map((x: any) => x.id)).not.toContain(res.completed);
    expect(created.body.items).toHaveLength(3);
    expect((await call(t, support, 'GET', `/v1/admin/reservations?from=${day(5)}&to=${day(1)}`)).body.code).toBe('INVALID_RANGE');
    expect((await call(t, support, 'GET', `/v1/admin/reservations?from=2026-13-45`)).status).toBe(400);
    expect((await call(t, support, 'GET', `/v1/admin/reservations?to=2026-02-30`)).status).toBe(400);
  });

  it('keyset pagination walks every row exactly once; malformed cursors are rejected', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const pg: any = await call(t, admin, 'GET', `/v1/admin/reservations?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...pg.body.items.map((x: any) => x.id));
      cursor = pg.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([res.held, res.cancelled, res.confirmed, res.completed]);
    expect((await call(t, admin, 'GET', '/v1/admin/reservations?cursor=not-a-cursor')).body.code).toBe('INVALID_CURSOR');
    const forged = Buffer.from(JSON.stringify(['yesterday', "x' OR 1=1 --"])).toString('base64url');
    expect((await call(t, admin, 'GET', `/v1/admin/reservations?cursor=${forged}`)).body.code).toBe('INVALID_CURSOR');
  });

  it('exchanges: ADMIN/SUPPORT only; status, user, property and start-date filters', async () => {
    expect((await call(t, accounting, 'GET', '/v1/admin/exchanges')).status).toBe(403);
    const all = await call(t, support, 'GET', '/v1/admin/exchanges');
    expect(all.body.items).toHaveLength(2);
    expect(all.body.items[0]).toHaveProperty('datesA.start');
    expect((await call(t, support, 'GET', '/v1/admin/exchanges?status=CONFIRMED')).body.items).toHaveLength(1);
    expect((await call(t, support, 'GET', `/v1/admin/exchanges?userId=${guest.id}`)).body.items).toHaveLength(2);
    expect((await call(t, support, 'GET', `/v1/admin/exchanges?propertyId=${propB}`)).body.items).toHaveLength(2);
    const start = await call(t, support, 'GET', `/v1/admin/exchanges?dateField=START&from=${day(50)}`);
    expect(start.body.items.map((x: any) => x.status)).toEqual(['CONFIRMED']);
    expect(start.body.items[0].datesA).toEqual({ start: day(60), end: day(65) });
  });

  it('guide bookings: paid filter, start range; COMPLIANCE cannot list', async () => {
    expect((await call(t, compliance, 'GET', '/v1/admin/guide-bookings')).status).toBe(403);
    expect((await call(t, accounting, 'GET', '/v1/admin/guide-bookings')).body.items).toHaveLength(2);
    const paid = await call(t, accounting, 'GET', '/v1/admin/guide-bookings?paid=true');
    expect(paid.body.items).toHaveLength(1);
    expect(paid.body.items[0]).toMatchObject({ guideType: 'PRO', priceMinor: 50000, status: 'PAYMENT_PENDING', guideId: guide.id, travelerId: guest.id });
    expect((await call(t, accounting, 'GET', `/v1/admin/guide-bookings?dateField=START&from=${day(7)}&to=${day(12)}`)).body.items).toHaveLength(1);
    expect((await call(t, accounting, 'GET', `/v1/admin/guide-bookings?userId=${guide.id}&status=CONFIRMED`)).body.items).toHaveLength(1);
  });

  it('listings: status/city/q filters with LIKE-escaping; exact location never returned', async () => {
    expect((await call(t, accounting, 'GET', '/v1/admin/listings')).status).toBe(403);
    const all = await call(t, compliance, 'GET', '/v1/admin/listings');
    expect(all.body.items).toHaveLength(2);
    expect(all.body.items.every((x: any) => !('lat' in x) && !('lng' in x))).toBe(true);
    expect((await call(t, support, 'GET', '/v1/admin/listings?status=IN_REVIEW')).body.items.map((x: any) => x.id)).toEqual([propB]);
    expect((await call(t, support, 'GET', '/v1/admin/listings?city=Busan')).body.items.map((x: any) => x.id)).toEqual([propA]);
    expect((await call(t, support, 'GET', `/v1/admin/listings?q=${encodeURIComponent('100%_')}`)).body.items.map((x: any) => x.id)).toEqual([propB]);
    expect((await call(t, support, 'GET', `/v1/admin/listings?q=${encodeURIComponent('%')}`)).body.items.map((x: any) => x.id)).toEqual([propB]);
    expect((await call(t, support, 'GET', '/v1/admin/listings?rentalEnabled=true')).body.items.map((x: any) => x.id)).toEqual([propA]);
    expect((await call(t, support, 'GET', `/v1/admin/listings?userId=${guest.id}&exchangeEnabled=true`)).body.items.map((x: any) => x.id)).toEqual([propB]);
  });

  it('pagination is exact for rows sharing the same created_at (microsecond ties broken by id)', async () => {
    const h2 = await createUser(t, { roles: ['HOST'] });
    const g2 = await createUser(t);
    const p2 = (await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'Tie','HOUSE') RETURNING id`, [h2.id])).rows[0].id;
    // one statement => identical now() for all rows
    const ids = (
      await t.pool.query(
        `INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, total_minor, currency, quote_snapshot, created_at)
         SELECT $1,$2,$3,'CONFIRMED', current_date + 100 + g * 3, current_date + 101 + g * 3, 1000, 'KRW', '{}', now() - interval '1 hour'
           FROM generate_series(1, 5) g RETURNING id`,
        [p2, h2.id, g2.id],
      )
    ).rows.map((r) => r.id);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const pg: any = await call(t, admin, 'GET', `/v1/admin/reservations?userId=${g2.id}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...pg.body.items.map((x: any) => x.id));
      cursor = pg.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect([...seen].sort()).toEqual([...ids].sort());
  });

  it('console lists never mutate domain tables', async () => {
    const before = (await t.pool.query(`SELECT count(*)::int AS n FROM state_transitions`)).rows[0].n;
    await call(t, admin, 'GET', '/v1/admin/reservations');
    await call(t, admin, 'GET', '/v1/admin/exchanges');
    await call(t, admin, 'GET', '/v1/admin/guide-bookings');
    await call(t, admin, 'GET', '/v1/admin/listings');
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM state_transitions`)).rows[0].n).toBe(before);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'admin.action.performed'`)).rows[0].n).toBe(0);
  });
});

describe('PLAT-06 feature flag rules (admin validation + storage)', () => {
  const patch = (body: Record<string, unknown>) => call(t, admin, 'PATCH', '/v1/admin/feature-flags', { reason: 'rollout plan', ...body });

  it('accepts rollout_pct / kill_switch / allow_user_ids / allow_roles and stores them normalized', async () => {
    const r = await patch({ flagKey: 'ai.recommendations', rules: { rollout_pct: 25, kill_switch: false, allow_user_ids: [user.id, user.id.toUpperCase()], allow_roles: ['HOST', 'HOST', 'GUIDE'] } });
    expect(r.status).toBe(200);
    expect(r.body.item.rules).toEqual({ rollout_pct: 25, kill_switch: false, allow_user_ids: [user.id], allow_roles: ['HOST', 'GUIDE'] });
    const row = await t.pool.query(`SELECT rules FROM feature_flags WHERE flag_key = 'ai.recommendations'`);
    expect(row.rows[0].rules).toEqual({ rollout_pct: 25, kill_switch: false, allow_user_ids: [user.id], allow_roles: ['HOST', 'GUIDE'] });
    // the allowlist keeps working through the platform evaluator
    expect(await isEnabled(t.pool, 'ai.recommendations', { userId: user.id })).toBe(true);

    const ks = await patch({ flagKey: 'ai.recommendations', enabled: true, rules: { kill_switch: true } });
    expect(ks.body.item).toMatchObject({ enabled: true, rules: { kill_switch: true } });
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'config.changed' AND aggregate_id = 'ai.recommendations' ORDER BY created_at DESC, id DESC LIMIT 1`);
    expect(ev.rows[0].payload).toMatchObject({ key: 'ai.recommendations', killSwitch: true, rolloutPct: null });
    const act = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'admin.action.performed' AND aggregate_id = 'ai.recommendations'`);
    expect(act.rows.length).toBe(2);
    expect(act.rows[0].payload).toMatchObject({ action: 'feature_flag.updated', resourceType: 'feature_flag', actorId: admin.id, reason: 'rollout plan', rulesChanged: true });
    // omitting rules keeps them
    expect((await patch({ flagKey: 'ai.recommendations', enabled: false })).body.item.rules).toEqual({ kill_switch: true });
  });

  it('rejects invalid rules without changing the flag', async () => {
    const before = (await t.pool.query(`SELECT rules, updated_at FROM feature_flags WHERE flag_key = 'ai.recommendations'`)).rows[0];
    const invalid = [
      { rollout_pct: 101 },
      { rollout_pct: -1 },
      { rollout_pct: 12.5 },
      { rollout_pct: '50' },
      { kill_switch: 'yes' },
      { allow_user_ids: ['not-a-uuid'] },
      { allow_roles: ['SUPERUSER'] },
      { allow_roles: ['admin'] },
      { unknown_rule: true },
    ];
    for (const rules of invalid) {
      const r = await patch({ flagKey: 'ai.recommendations', rules });
      expect(r.status, JSON.stringify(rules)).toBe(400);
    }
    const after = (await t.pool.query(`SELECT rules, updated_at FROM feature_flags WHERE flag_key = 'ai.recommendations'`)).rows[0];
    expect(after).toEqual(before);
    // service-level guard for non-HTTP callers
    expect(() => normalizeFlagRules({ rollout_pct: 500 })).toThrow(/invalid/i);
    expect(normalizeFlagRules({})).toEqual({});
  });

  it('rules changes stay ADMIN + AAL2 only and are never exposed publicly', async () => {
    expect((await call(t, support, 'PATCH', '/v1/admin/feature-flags', { flagKey: 'ai.recommendations', rules: { rollout_pct: 100 }, reason: 'sneaky change' })).status).toBe(403);
    await patch({ flagKey: 'guide.paid', rules: { rollout_pct: 10, allow_user_ids: [guest.id] } });
    const pub = await call(t, null, 'GET', '/v1/config/public');
    expect(JSON.stringify(pub.body)).not.toContain('rollout_pct');
    expect(JSON.stringify(pub.body)).not.toContain(guest.id);
  });
});
