import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
let alice: TestUser;
let bob: TestUser;
let published: string;
let draft: string;

beforeAll(async () => {
  t = await createTestApp();
  alice = await createUser(t);
  bob = await createUser(t);
  const host = await createUser(t, { roles: ['HOST'] });
  const p = await t.pool.query(
    `INSERT INTO properties(host_id, slug, title, property_type, city, lat, lng, status, published_at, rental_enabled, base_price_minor)
     VALUES ($1,'fav-slug','Saved stay','HOUSE','Seoul',37.5,127.0,'PUBLISHED',now(),true,80000) RETURNING id`,
    [host.id],
  );
  published = p.rows[0].id;
  draft = (await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'Draft','HOUSE') RETURNING id`, [host.id])).rows[0].id;
});
afterAll(async () => t.close());

describe('STAY-05 favorites', () => {
  it('add/remove are idempotent and listed with public summaries', async () => {
    const body = { targetType: 'PROPERTY', targetId: published };
    const a1 = await call(t, alice, 'POST', '/v1/favorites', body);
    expect(a1.status).toBe(201);
    const a2 = await call(t, alice, 'POST', '/v1/favorites', body);
    expect(a2.status).toBe(200);
    expect(a2.body.created).toBe(false);
    // concurrent duplicate adds still produce exactly one row and one event
    await Promise.all(Array.from({ length: 5 }, () => call(t, bob, 'POST', '/v1/favorites', body)));
    const n = await t.pool.query(`SELECT count(*)::int AS n FROM favorites WHERE target_id = $1`, [published]);
    expect(n.rows[0].n).toBe(2);
    const ev = await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'favorite.added' AND aggregate_id = $1`, [bob.id]);
    expect(ev.rows[0].n).toBe(1);

    const list = await call(t, alice, 'GET', '/v1/favorites');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].target).toMatchObject({ available: true, slug: 'fav-slug', title: 'Saved stay', priceMinor: 80000 });
    expect(list.body.items[0].target.location.approximate).toBe(true);
    expect((await call(t, bob, 'GET', '/v1/favorites?targetType=GUIDE')).body.items).toEqual([]);

    const r1 = await call(t, alice, 'DELETE', `/v1/favorites?targetType=PROPERTY&targetId=${published}`);
    expect(r1.body.removed).toBe(true);
    const r2 = await call(t, alice, 'DELETE', `/v1/favorites/PROPERTY/${published}`);
    expect(r2.status).toBe(200);
    expect(r2.body.removed).toBe(false);
    expect((await call(t, alice, 'GET', '/v1/favorites')).body.items).toEqual([]);
  });

  it('rejects unpublished targets and anonymous users', async () => {
    expect((await call(t, alice, 'POST', '/v1/favorites', { targetType: 'PROPERTY', targetId: draft })).body.code).toBe('TARGET_NOT_AVAILABLE');
    expect((await call(t, alice, 'POST', '/v1/favorites', { targetType: 'PROPERTY', targetId: randomUUID() })).status).toBe(422);
    expect((await call(t, null, 'POST', '/v1/favorites', { targetType: 'PROPERTY', targetId: published })).status).toBe(401);
    expect((await call(t, null, 'GET', '/v1/favorites')).status).toBe(401);
    expect((await call(t, alice, 'POST', '/v1/favorites', { targetType: 'HOTEL', targetId: published })).status).toBe(400);
  });
});

describe('STAY-05 collections', () => {
  it('privacy: PRIVATE is owner-only; LINK shares by token; PRIVATE again revokes the token', async () => {
    const c = await call(t, alice, 'POST', '/v1/collections', { name: '제주 여행' });
    expect(c.status).toBe(201);
    expect(c.body.item).toMatchObject({ visibility: 'PRIVATE' });
    expect(c.body.item.shareToken).toBeUndefined();
    const id = c.body.item.id;
    const add = await call(t, alice, 'POST', `/v1/collections/${id}/items`, { targetType: 'PROPERTY', targetId: published, note: 'my private note' });
    expect(add.status).toBe(201);
    expect((await call(t, alice, 'POST', `/v1/collections/${id}/items`, { targetType: 'PROPERTY', targetId: published })).status).toBe(200);

    expect((await call(t, bob, 'GET', `/v1/collections/${id}`)).status).toBe(404);
    expect((await call(t, null, 'GET', `/v1/collections/${id}`)).status).toBe(404);
    expect((await call(t, bob, 'POST', `/v1/collections/${id}/items`, { targetType: 'PROPERTY', targetId: published })).status).toBe(404);
    expect((await call(t, bob, 'PATCH', `/v1/collections/${id}`, { visibility: 'PUBLIC' })).status).toBe(404);
    expect((await call(t, bob, 'DELETE', `/v1/collections/${id}`)).status).toBe(404);

    const own = await call(t, alice, 'GET', `/v1/collections/${id}`);
    expect(own.body.item.items[0]).toMatchObject({ note: 'my private note', target: { available: true } });

    const shared = await call(t, alice, 'PATCH', `/v1/collections/${id}`, { visibility: 'LINK' });
    const token = shared.body.item.shareToken;
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    const viaLink = await call(t, null, 'GET', `/v1/collections/shared/${token}`);
    expect(viaLink.status).toBe(200);
    expect(viaLink.body.item.shareToken).toBeUndefined();
    expect(viaLink.body.item.items[0].note).toBeUndefined();
    expect(viaLink.body.item.items[0].targetId).toBe(published);
    // LINK is not listed / not readable by id
    expect((await call(t, bob, 'GET', `/v1/collections/${id}`)).status).toBe(404);

    await call(t, alice, 'PATCH', `/v1/collections/${id}`, { visibility: 'PRIVATE' });
    expect((await call(t, null, 'GET', `/v1/collections/shared/${token}`)).status).toBe(404);
    const again = await call(t, alice, 'PATCH', `/v1/collections/${id}`, { visibility: 'PUBLIC' });
    expect(again.body.item.shareToken).not.toBe(token);
    expect((await call(t, null, 'GET', `/v1/collections/shared/${token}`)).status).toBe(404);
    const pub = await call(t, bob, 'GET', `/v1/collections/${id}`);
    expect(pub.status).toBe(200);
    expect(pub.body.item.name).toBe('제주 여행');
    // public collections are readable but not writable by others
    expect((await call(t, bob, 'POST', `/v1/collections/${id}/items`, { targetType: 'PROPERTY', targetId: published })).status).toBe(403);
  });

  it('hides unpublished items from viewers, supports item removal and deletion', async () => {
    const c = await call(t, alice, 'POST', '/v1/collections', { name: 'Public list', visibility: 'PUBLIC' });
    const id = c.body.item.id;
    expect(c.body.item.shareToken).toBeTruthy();
    await call(t, alice, 'POST', `/v1/collections/${id}/items`, { targetType: 'PROPERTY', targetId: published });
    expect((await call(t, alice, 'POST', `/v1/collections/${id}/items`, { targetType: 'PROPERTY', targetId: draft })).status).toBe(422);
    await t.pool.query(`UPDATE properties SET status = 'UNLISTED' WHERE id = $1`, [published]);
    expect((await call(t, bob, 'GET', `/v1/collections/${id}`)).body.item.items).toEqual([]);
    expect((await call(t, alice, 'GET', `/v1/collections/${id}`)).body.item.items[0].target).toEqual({ available: false });
    await t.pool.query(`UPDATE properties SET status = 'PUBLISHED' WHERE id = $1`, [published]);

    expect((await call(t, alice, 'GET', '/v1/collections')).body.items.find((x: any) => x.id === id).itemCount).toBe(1);
    expect((await call(t, alice, 'DELETE', `/v1/collections/${id}/items/PROPERTY/${published}`)).body.removed).toBe(true);
    expect((await call(t, alice, 'DELETE', `/v1/collections/${id}/items/PROPERTY/${published}`)).body.removed).toBe(false);
    expect((await call(t, alice, 'DELETE', `/v1/collections/${id}`)).body.deleted).toBe(true);
    expect((await call(t, alice, 'GET', `/v1/collections/${id}`)).status).toBe(404);
  });
});
