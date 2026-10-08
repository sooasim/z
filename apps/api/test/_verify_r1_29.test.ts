import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, createUser, call, day, enableFlags, idem, type TestApp, type TestUser } from './helpers.js';
import { hostPublishBlockers } from '../src/modules/hosts/service.js';

let t: TestApp;
let admin: TestUser;
let guest: TestUser;
let moderateId: string;
const log: string[] = [];
const show = (label: string, r: any) => log.push(`${label}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`);

async function eligibleHost(): Promise<TestUser> {
  const h = await createUser(t, { roles: ['HOST'], verified: true });
  await t.pool.query(`INSERT INTO host_profiles(user_id, display_name, status, verification_status) VALUES ($1,'Fraud Host','APPROVED','VERIFIED')`, [h.id]);
  return h;
}

async function liveListing(hostId: string, city: string) {
  const { rows } = await t.pool.query(
    `INSERT INTO properties(host_id, title, property_type, status, rental_enabled, paid_booking_enabled, instant_book, base_price_minor, cleaning_fee_minor,
                            currency, max_guests, min_nights, timezone, country, cancellation_policy_id, published_at, city, slug, lat, lng)
     VALUES ($1,'Live stay','HOUSE','PUBLISHED',true,true,true,100000,20000,'KRW',4,1,'UTC','KR',$2, now(), $3, $4, 37.55, 126.92) RETURNING id, slug`,
    [hostId, moderateId, city, `live-${randomUUID().slice(0, 8)}`],
  );
  await t.pool.query(`INSERT INTO property_addresses(property_id, line1, city, country, public_area_label) VALUES ($1,'1 Secret-ro 42',$2,'KR','Mapo-gu')`, [rows[0].id, city]);
  return rows[0] as { id: string; slug: string };
}

async function bookAndPay(propertyId: string, offset: number) {
  const q = await call(t, guest, 'POST', '/v1/booking/quotes', { propertyId, checkIn: day(offset), checkOut: day(offset + 2), guests: 2 });
  show('quote', q);
  expect(q.status).toBe(201);
  const h = await call(t, guest, 'POST', '/v1/booking/holds', { quoteId: q.body.item.id }, idem());
  show('hold', h);
  expect(h.status).toBe(201);
  const rid = h.body.item.reservation.id;
  const p = await call(t, guest, 'POST', '/v1/payments/toss/prepare', { subjectType: 'RESERVATION', subjectId: rid }, idem());
  show('prepare', p);
  expect(p.status).toBe(201);
  const c = await call(t, guest, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${randomUUID().replace(/-/g, '')}`, orderId: p.body.orderId, amount: p.body.amount }, idem());
  show('confirm', c);
  expect(c.status).toBe(200);
  const r = await call(t, guest, 'GET', `/v1/reservations/${rid}`);
  show('reservation', { status: r.status, body: { status: r.body.item?.status, hostId: r.body.item?.hostId } });
  return r.body.item.status as string;
}

async function assertStillLive(label: string, prop: { id: string; slug: string }, city: string, offset: number) {
  const s = await call(t, null, 'GET', `/v1/search/properties?city=${city}`);
  log.push(`[${label}] search ids contain property: ${s.body.items?.map((i: any) => i.id).includes(prop.id)} (status ${s.status})`);
  expect(s.body.items.map((i: any) => i.id)).toContain(prop.id);
  const d = await call(t, null, 'GET', `/v1/properties/by-slug/${prop.slug}`);
  log.push(`[${label}] public detail by slug: ${d.status} status=${d.body.item?.status} paidBookingEnabled=${d.body.item?.paidBookingEnabled}`);
  expect(d.status).toBe(200);
  const row = (await t.pool.query(`SELECT status, paid_booking_enabled FROM properties WHERE id = $1`, [prop.id])).rows[0];
  log.push(`[${label}] DB property row after drain+runJobs: ${JSON.stringify(row)}`);
  expect(row).toEqual({ status: 'PUBLISHED', paid_booking_enabled: true });
  const st = await bookAndPay(prop.id, offset);
  log.push(`[${label}] guest reservation status: ${st}`);
  expect(st).toBe('CONFIRMED');
}

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  guest = await createUser(t, { verified: true });
  moderateId = (await t.pool.query(`SELECT id FROM cancellation_policies WHERE code = 'MODERATE'`)).rows[0].id;
  await enableFlags(t, 'stay.paid_booking');
  await t.pool.query(
    `INSERT INTO compliance_rules(rule_key, subject_type, jurisdiction, effective_from, status, approved_at, note)
     VALUES ('test-allow','PROPERTY','KR','2020-01-01','APPROVED', now(), 'test')`,
  );
  await t.pool.query(
    `INSERT INTO finance_rules(rule_type, domain, jurisdiction, params, effective_from, status, approved_at) VALUES
       ('PLATFORM_FEE','STAY','KR','{"bps":1000}','2020-01-01','APPROVED', now()),
       ('HOST_FEE','STAY','KR','{"bps":300}','2020-01-01','APPROVED', now()),
       ('TAX','STAY','KR','{"bps":1000}','2020-01-01','APPROVED', now())`,
  );
});
afterAll(async () => {
  console.log('\n===== EVIDENCE =====\n' + log.join('\n') + '\n====================');
  await t?.close();
});

describe('sanctioned / suspended / deleted hosts keep live, bookable listings', () => {
  it('LISTING_SUSPENSION sanction has no effect on an already-PUBLISHED listing', async () => {
    const host = await eligibleHost();
    log.push(`[LISTING_SUSPENSION] blockers before: ${JSON.stringify(await hostPublishBlockers(t.pool, host.id))}`);
    const prop = await liveListing(host.id, 'Seoul');
    await t.runJobs(); // search.reconcile projects it
    const s = await call(t, admin, 'POST', '/v1/admin/sanctions', { userId: host.id, sanctionType: 'LISTING_SUSPENSION', reason: 'fraudulent host — take listings down' });
    show('[LISTING_SUSPENSION] POST /v1/admin/sanctions', s);
    expect(s.status).toBe(201);
    await t.drain();
    await t.runJobs();
    log.push(`[LISTING_SUSPENSION] blockers after: ${JSON.stringify(await hostPublishBlockers(t.pool, host.id))}`);
    await assertStillLive('LISTING_SUSPENSION', prop, 'Seoul', 20);
  });

  it('BAN (account suspended) has no effect on an already-PUBLISHED listing', async () => {
    const host = await eligibleHost();
    const prop = await liveListing(host.id, 'Busan');
    await t.runJobs();
    const s = await call(t, admin, 'POST', '/v1/admin/sanctions', { userId: host.id, sanctionType: 'BAN', reason: 'fraud ring' });
    show('[BAN] POST /v1/admin/sanctions', s);
    expect(s.status).toBe(201);
    await t.drain();
    await t.runJobs();
    const u = (await t.pool.query(`SELECT status FROM users WHERE id = $1`, [host.id])).rows[0];
    log.push(`[BAN] host user status: ${u.status}; blockers: ${JSON.stringify(await hostPublishBlockers(t.pool, host.id))}`);
    const hostPage = await call(t, null, 'GET', `/v1/hosts/${host.id}`);
    log.push(`[BAN] public host page GET /v1/hosts/:id -> ${hostPage.status}`);
    await assertStillLive('BAN', prop, 'Busan', 30);
  });

  it('privacy deletion (DELETED account) has no effect on an already-PUBLISHED listing', async () => {
    const host = await eligibleHost();
    const prop = await liveListing(host.id, 'Jeju');
    await t.runJobs();
    const del = await call(t, host, 'POST', '/v1/privacy/delete', { confirm: 'DELETE', password: host.password, reason: 'leaving' });
    show('[DELETE] POST /v1/privacy/delete', del);
    expect(del.status).toBe(202);
    await t.pool.query(`UPDATE privacy_requests SET requested_at = now() - interval '30 days' WHERE user_id = $1`, [host.id]);
    await t.runJobs(); // privacy.deletion job scrubs the account
    await t.drain();
    await t.runJobs();
    const u = (await t.pool.query(`SELECT status, display_name FROM users WHERE id = $1`, [host.id])).rows[0];
    log.push(`[DELETE] host user: ${JSON.stringify(u)}`);
    expect(u.status).toBe('DELETED');
    await assertStillLive('DELETE', prop, 'Jeju', 40);
  });
});
