import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';

/** Regression tests for the trust r1 privacy finding: deletion with open obligations / bookable inventory. */
let t: TestApp;

const del = (u: TestUser) => call(t, u, 'POST', '/v1/privacy/delete', { confirm: 'DELETE', password: u.password });
const property = async (hostId: string, status = 'DRAFT') =>
  (await t.pool.query(`INSERT INTO properties(host_id, title, property_type, status) VALUES ($1,'P','HOUSE',$2) RETURNING id`, [hostId, status])).rows[0].id as string;
const reservation = async (propertyId: string, hostId: string, guestId: string, status: string) =>
  (
    await t.pool.query(
      `INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, total_minor, currency, quote_snapshot)
       VALUES ($1,$2,$3,$4, current_date + 30, current_date + 33, 100000, 'KRW', '{}') RETURNING id`,
      [propertyId, hostId, guestId, status],
    )
  ).rows[0].id as string;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

describe('account deletion respects open obligations', () => {
  it('a host with published listings or upcoming confirmed stays cannot request deletion', async () => {
    const host = await createUser(t, { roles: ['HOST'] });
    const guest = await createUser(t);
    const p = await property(host.id, 'PUBLISHED');
    const blocked = await del(host);
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('DELETION_BLOCKED');
    expect(blocked.body.details?.blockers ?? blocked.body.blockers).toContain('PUBLISHED_LISTINGS');
    expect((await t.pool.query(`SELECT status FROM users WHERE id = $1`, [host.id])).rows[0].status).toBe('ACTIVE');
    expect((await call(t, host, 'GET', '/v1/me')).status).toBe(200); // sessions not revoked

    await t.pool.query(`UPDATE properties SET status = 'UNLISTED' WHERE id = $1`, [p]);
    const res = await reservation(p, host.id, guest.id, 'CONFIRMED');
    for (const who of [host, guest]) {
      const r = await del(who);
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.body)).toContain('ACTIVE_RESERVATIONS');
    }
    await t.pool.query(`UPDATE reservations SET status = 'COMPLETED' WHERE id = $1`, [res]);
    expect((await del(guest)).status).toBe(202);
  });

  it('obligations that appear during the grace period defer the scrub until they are settled', async () => {
    const host = await createUser(t, { roles: ['HOST'] });
    const guest = await createUser(t);
    const p = await property(host.id);
    const req = await del(host);
    expect(req.status).toBe(202);
    // the host signs back in during the grace period and accepts a booking
    const res = await reservation(p, host.id, guest.id, 'CONFIRMED');
    await t.pool.query(`UPDATE privacy_requests SET requested_at = now() - interval '8 days' WHERE id = $1`, [req.body.item.id]);
    await t.runJobs();
    const pr = (await t.pool.query(`SELECT status, result FROM privacy_requests WHERE id = $1`, [req.body.item.id])).rows[0];
    expect(pr.status).toBe('REQUESTED');
    expect(pr.result).toMatchObject({ deferred: true, blockers: ['ACTIVE_RESERVATIONS'] });
    expect((await t.pool.query(`SELECT status FROM users WHERE id = $1`, [host.id])).rows[0].status).toBe('PENDING_DELETION');

    await t.pool.query(`UPDATE reservations SET status = 'COMPLETED' WHERE id = $1`, [res]);
    await t.runJobs();
    expect((await t.pool.query(`SELECT status FROM privacy_requests WHERE id = $1`, [req.body.item.id])).rows[0].status).toBe('COMPLETED');
    expect((await t.pool.query(`SELECT status FROM users WHERE id = $1`, [host.id])).rows[0].status).toBe('DELETED');
  });

  it('open disputes and unpaid settlements also block deletion', async () => {
    const u = await createUser(t, { roles: ['HOST'] });
    const opener = await createUser(t);
    const d = (
      await t.pool.query(`INSERT INTO disputes(opened_by, context_type, context_id, counterparty_id, reason) VALUES ($1,'OTHER',gen_random_uuid(),$2,'x') RETURNING id`, [opener.id, u.id])
    ).rows[0].id;
    expect(JSON.stringify((await del(u)).body)).toContain('OPEN_DISPUTES');
    await t.pool.query(`UPDATE disputes SET status = 'REJECTED' WHERE id = $1`, [d]);
    await t.pool.query(
      `INSERT INTO settlements(payee_id, payee_type, period_start, period_end, currency, gross_minor, fee_minor, refund_minor, net_minor, status)
       VALUES ($1,'HOST', current_date - 7, current_date, 'KRW', 1000, 100, 0, 900, 'APPROVED')`,
      [u.id],
    );
    expect(JSON.stringify((await del(u)).body)).toContain('UNSETTLED_PAYOUTS');
  });
});
