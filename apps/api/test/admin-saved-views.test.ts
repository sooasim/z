import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
let admin: TestUser, support: TestUser, accounting: TestUser, user: TestUser;

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  support = await createUser(t, { roles: ['SUPPORT'] });
  accounting = await createUser(t, { roles: ['ACCOUNTING'] });
  user = await createUser(t);
});
afterAll(async () => t.close());

const adminEvents = async (resourceId: string) =>
  (await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'admin.action.performed' AND aggregate_id = $1 ORDER BY created_at, id`, [resourceId])).rows.map((r) => r.payload);

describe('OPS-02 saved views', () => {
  let privateId: string, sharedId: string;

  it('requires a staff role with AAL2', async () => {
    const body = { viewType: 'RESERVATIONS', name: 'Mine' };
    expect((await call(t, user, 'GET', '/v1/admin/saved-views')).status).toBe(403);
    expect((await call(t, user, 'POST', '/v1/admin/saved-views', body)).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['SUPPORT'], aal: 'aal1' });
    expect((await call(t, aal1, 'POST', '/v1/admin/saved-views', body)).body.code).toBe('AAL2_REQUIRED');
    expect((await call(t, null, 'GET', '/v1/admin/saved-views')).status).toBe(401);
  });

  it('creates private and shared views; duplicate names per owner+type conflict; emits admin.action.performed', async () => {
    const p = await call(t, support, 'POST', '/v1/admin/saved-views', {
      viewType: 'RESERVATIONS',
      name: 'Overdue check-ins',
      filters: { status: 'CONFIRMED', dateField: 'CHECK_IN', from: '2026-10-01' },
      columns: ['code', 'status', 'checkIn', 'guestName'],
      sort: [{ field: 'createdAt', direction: 'desc' }],
    });
    expect(p.status).toBe(201);
    expect(p.body.item).toMatchObject({ viewType: 'RESERVATIONS', name: 'Overdue check-ins', shared: false, isOwner: true, ownerId: support.id, columns: ['code', 'status', 'checkIn', 'guestName'] });
    privateId = p.body.item.id;

    const s = await call(t, support, 'POST', '/v1/admin/saved-views', { viewType: 'REFUNDS', name: 'Team refunds', filters: { status: ['PENDING', 'FAILED'] }, shared: true });
    expect(s.status).toBe(201);
    sharedId = s.body.item.id;

    const dup = await call(t, support, 'POST', '/v1/admin/saved-views', { viewType: 'RESERVATIONS', name: 'Overdue check-ins' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('SAVED_VIEW_EXISTS');
    // same name, different console or different owner is fine
    expect((await call(t, support, 'POST', '/v1/admin/saved-views', { viewType: 'EXCHANGES', name: 'Overdue check-ins' })).status).toBe(201);
    expect((await call(t, admin, 'POST', '/v1/admin/saved-views', { viewType: 'RESERVATIONS', name: 'Overdue check-ins' })).status).toBe(201);

    const ev = await adminEvents(privateId);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ action: 'saved_view.created', resourceType: 'admin_saved_view', resourceId: privateId, actorId: support.id, viewType: 'RESERVATIONS' });
  });

  it('validates view type, filters, columns and sort', async () => {
    const bad = [
      { viewType: 'NOPE', name: 'x' },
      { viewType: 'USERS', name: '' },
      { viewType: 'USERS', name: 'x', filters: { nested: { deep: true } } },
      { viewType: 'USERS', name: 'x', columns: ['ok', 'bad column;'] },
      { viewType: 'USERS', name: 'x', sort: [{ field: 'createdAt', direction: 'sideways' }] },
      { viewType: 'USERS', name: 'x', sort: Array.from({ length: 6 }, () => ({ field: 'a', direction: 'asc' })) },
    ];
    for (const b of bad) expect((await call(t, support, 'POST', '/v1/admin/saved-views', b)).status, JSON.stringify(b)).toBe(400);
  });

  it('shared views are readable by all staff; private views are invisible to others (404)', async () => {
    const own = await call(t, support, 'GET', '/v1/admin/saved-views');
    expect(own.body.items.map((v: any) => v.id)).toEqual(expect.arrayContaining([privateId, sharedId]));

    const other = await call(t, accounting, 'GET', '/v1/admin/saved-views');
    const ids = other.body.items.map((v: any) => v.id);
    expect(ids).toContain(sharedId);
    expect(ids).not.toContain(privateId);
    expect(other.body.items.find((v: any) => v.id === sharedId).isOwner).toBe(false);
    expect((await call(t, accounting, 'GET', `/v1/admin/saved-views/${sharedId}`)).body.item.filters).toEqual({ status: ['PENDING', 'FAILED'] });
    expect((await call(t, accounting, 'GET', `/v1/admin/saved-views/${privateId}`)).status).toBe(404);

    // filters: by console type, and mine=true hides other people's shared views
    const refunds = await call(t, accounting, 'GET', '/v1/admin/saved-views?viewType=REFUNDS');
    expect(refunds.body.items.map((v: any) => v.id)).toEqual([sharedId]);
    expect((await call(t, accounting, 'GET', '/v1/admin/saved-views?mine=true')).body.items).toHaveLength(0);
  });

  it('only the owner can edit or delete (shared -> 403, private -> 404)', async () => {
    const edit = await call(t, accounting, 'PATCH', `/v1/admin/saved-views/${sharedId}`, { name: 'hijacked' });
    expect(edit.status).toBe(403);
    expect(edit.body.code).toBe('NOT_VIEW_OWNER');
    expect((await call(t, admin, 'DELETE', `/v1/admin/saved-views/${sharedId}`)).body.code).toBe('NOT_VIEW_OWNER');
    expect((await call(t, accounting, 'PATCH', `/v1/admin/saved-views/${privateId}`, { name: 'hijacked' })).status).toBe(404);
    expect((await call(t, accounting, 'DELETE', `/v1/admin/saved-views/${privateId}`)).status).toBe(404);
    const row = await t.pool.query(`SELECT name FROM admin_saved_views WHERE id = $1`, [sharedId]);
    expect(row.rows[0].name).toBe('Team refunds');
  });

  it('owner updates (rename conflict checked, empty patch rejected) and deletes', async () => {
    expect((await call(t, support, 'PATCH', `/v1/admin/saved-views/${privateId}`, {})).status).toBe(400);
    // rename onto an existing name of the same owner+type
    await call(t, support, 'POST', '/v1/admin/saved-views', { viewType: 'RESERVATIONS', name: 'Taken' });
    expect((await call(t, support, 'PATCH', `/v1/admin/saved-views/${privateId}`, { name: 'Taken' })).body.code).toBe('SAVED_VIEW_EXISTS');

    const u = await call(t, support, 'PATCH', `/v1/admin/saved-views/${privateId}`, { name: 'Check-ins today', shared: true, columns: ['code'] });
    expect(u.status).toBe(200);
    expect(u.body.item).toMatchObject({ name: 'Check-ins today', shared: true, columns: ['code'], filters: { status: 'CONFIRMED' } });
    expect(new Date(u.body.item.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(u.body.item.createdAt).getTime());
    // now shared: visible to other staff
    expect((await call(t, accounting, 'GET', `/v1/admin/saved-views/${privateId}`)).status).toBe(200);

    const d = await call(t, support, 'DELETE', `/v1/admin/saved-views/${privateId}`);
    expect(d.body.item).toEqual({ id: privateId, deleted: true });
    expect((await call(t, support, 'GET', `/v1/admin/saved-views/${privateId}`)).status).toBe(404);
    expect((await adminEvents(privateId)).map((e) => e.action)).toEqual(['saved_view.created', 'saved_view.updated', 'saved_view.deleted']);
  });

  it('concurrent creates with the same name: exactly one wins', async () => {
    const body = { viewType: 'AUDIT', name: 'Race' };
    const res = await Promise.all([1, 2, 3, 4].map(() => call(t, admin, 'POST', '/v1/admin/saved-views', body)));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(3);
  });
});
