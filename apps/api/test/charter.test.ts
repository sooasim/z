import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, enableFlags, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
let admin: TestUser;
let user: TestUser;

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  user = await createUser(t);
});
afterAll(async () => t.close());

const lead = { contactName: '홍길동', contactEmail: 'hong@example.com', origin: 'Seoul (GMP)', destination: 'Jeju (CJU)', partySize: 6, message: '가족 여행' };

describe('JET-01 charter scope gate', () => {
  it('serves default charter content until the CMS page is published, then the CMS page', async () => {
    const d = await call(t, null, 'GET', '/v1/content/charter');
    expect(d.status).toBe(200);
    expect(d.body.item.source).toBe('DEFAULT');
    expect(d.body.item.directBooking).toBe(false);
    await t.pool.query(
      `INSERT INTO cms_entries(entry_type, slug, title, summary, body_md, status, published_at) VALUES ('PAGE','jetpool-charter','JETPOOL Charter','s','# body','PUBLISHED', now())`,
    );
    const c = await call(t, null, 'GET', '/v1/content/charter');
    expect(c.body.item).toMatchObject({ source: 'CMS', title: 'JETPOOL Charter', bodyMd: '# body', directBooking: false });
  });

  it('captures leads publicly with validation and notifies admins', async () => {
    expect((await call(t, null, 'POST', '/v1/charter/requests', { ...lead, contactEmail: 'nope' })).status).toBe(400);
    expect((await call(t, null, 'POST', '/v1/charter/requests', { ...lead, partySize: 0 })).status).toBe(400);
    expect((await call(t, null, 'POST', '/v1/charter/requests', { ...lead, website: 'spam' })).status).toBe(400);
    const r = await call(t, null, 'POST', '/v1/charter/requests', lead);
    expect(r.status).toBe(201);
    expect(r.body.item.status).toBe('NEW');
    const mine = await call(t, user, 'POST', '/v1/charter/requests', lead);
    expect(mine.status).toBe(201);
    expect((await call(t, user, 'GET', '/v1/charter/requests/mine')).body.items).toHaveLength(1);
    const n = await t.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND template_key = 'charter.requested'`, [admin.id]);
    expect(n.rows[0].n).toBe(2);
    const ev = await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'charter.requested'`);
    expect(ev.rows[0].n).toBe(2);
  });

  it('admin lead pipeline: list and status transitions; other users denied', async () => {
    expect((await call(t, user, 'GET', '/v1/admin/charter/requests')).status).toBe(403);
    const list = await call(t, admin, 'GET', '/v1/admin/charter/requests?status=NEW');
    expect(list.status).toBe(200);
    const id = list.body.items[0].id;
    const p = await call(t, admin, 'PATCH', `/v1/admin/charter/requests/${id}`, { status: 'CONTACTED', adminNote: 'called back', assigneeId: admin.id });
    expect(p.body.item).toMatchObject({ status: 'CONTACTED', adminNote: 'called back', assigneeId: admin.id });
    expect((await call(t, admin, 'PATCH', `/v1/admin/charter/requests/${id}`, { status: 'CLOSED' })).body.item.status).toBe('CLOSED');
    const bad = await call(t, admin, 'PATCH', `/v1/admin/charter/requests/${id}`, { status: 'CONTACTED' });
    expect(bad.body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('paid direct charter booking is disabled (403 FEATURE_DISABLED) while the flag is OFF', async () => {
    for (const url of ['/v1/charter/bookings', `/v1/charter/bookings/${admin.id}/pay`, `/v1/charter/flight-shares/${admin.id}/seats`]) {
      const r = await call(t, user, 'POST', url, {});
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('FEATURE_DISABLED');
    }
    expect((await call(t, null, 'POST', '/v1/charter/bookings', {})).body.code).toBe('FEATURE_DISABLED');
    // even with the flag on, no paid booking logic exists beyond the gate
    await enableFlags(t, 'charter.direct_booking');
    expect((await call(t, user, 'POST', '/v1/charter/bookings', {})).status).toBe(501);
  });
});
