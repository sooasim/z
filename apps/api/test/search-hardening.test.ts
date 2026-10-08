/**
 * QA round 1 — PLAT-01 search projection with an EXTERNAL engine (Meilisearch): engine HTTP calls never run inside
 * the outbox dispatch transaction and are bounded by a timeout, so a hung engine cannot stall unrelated events.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestApp, createUser, type TestApp, type TestUser } from './helpers.js';
import { emit } from '../src/platform/outbox.js';
import { SEARCH_ADAPTER } from '../src/modules/search/adapter.js';
import { MeiliSearchAdapter } from '../src/modules/search/meili-adapter.js';
import { flushPendingProjections, rebuildIndex } from '../src/modules/search/service.js';

let t: TestApp;
let host: TestUser;
let server: http.Server;
let mode: 'ok' | 'hang' = 'ok';
const requests: string[] = [];
let taskUid = 0;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    req.resume();
    if (mode === 'hang') return; // accept and never answer (GC pause / partition)
    const now = new Date().toISOString();
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET' && req.url?.startsWith('/tasks/')) {
      res.end(JSON.stringify({ uid: Number(req.url.split('/')[2]), indexUid: 'properties', status: 'succeeded', type: 'documentAdditionOrUpdate', enqueuedAt: now, startedAt: now, finishedAt: now }));
      return;
    }
    res.statusCode = 202;
    res.end(JSON.stringify({ taskUid: ++taskUid, indexUid: 'properties', status: 'enqueued', type: 'documentAdditionOrUpdate', enqueuedAt: now }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t = await createTestApp({ MEILI_HOST: url });
  // same adapter with a short per-request timeout so the test runs fast
  t.app.ctx.adapters.set(SEARCH_ADAPTER, new MeiliSearchAdapter(url, undefined, 'properties', 300));
  host = await createUser(t, { roles: ['HOST'] });
});
afterAll(async () => {
  await t.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

async function seedPublished(title: string) {
  const { rows } = await t.pool.query(
    `INSERT INTO properties(host_id, slug, title, property_type, status, rental_enabled, base_price_minor, city, region, lat, lng, published_at)
     VALUES ($1,$2,$3,'HOUSE','PUBLISHED',true,50000,'Seoul','KR-11',37.55,126.92, now()) RETURNING id`,
    [host.id, `meili-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title],
  );
  await emit(t.pool, t.ctx(), { aggregateType: 'property', aggregateId: rows[0].id, eventType: 'property.published', payload: { propertyId: rows[0].id } });
  return rows[0].id as string;
}

describe('#14 Meilisearch projection is decoupled from the outbox transaction and time-bounded', () => {
  it('a hung engine does not block the outbox; flush times out, marks FAILED, and recovers', async () => {
    mode = 'hang';
    const id = await seedPublished('Meili hang probe');
    await emit(t.pool, t.ctx(), { aggregateType: 'favorite', aggregateId: host.id, eventType: 'favorite.added', payload: { userId: host.id, targetType: 'PROPERTY', targetId: id } });
    const before = requests.length;
    const started = Date.now();
    await t.drain();
    expect(Date.now() - started).toBeLessThan(2000);
    expect(requests.length).toBe(before); // no engine HTTP inside the dispatch transaction
    const pending = await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE published_at IS NULL AND dead_lettered_at IS NULL`);
    expect(pending.rows[0].n).toBe(0); // every event (incl. the unrelated one) was dispatched
    expect((await t.pool.query(`SELECT status FROM search_sync_state WHERE document_id = $1`, [id])).rows[0].status).toBe('PENDING');

    const f0 = Date.now();
    const failed = await flushPendingProjections(t.app.ctx);
    expect(Date.now() - f0).toBeLessThan(3000); // bounded by the client timeout
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect((await t.pool.query(`SELECT status FROM search_sync_state WHERE document_id = $1`, [id])).rows[0].status).toBe('FAILED');

    mode = 'ok';
    const ok = await flushPendingProjections(t.app.ctx);
    expect(ok.synced).toBeGreaterThanOrEqual(1);
    expect((await t.pool.query(`SELECT status FROM search_sync_state WHERE document_id = $1`, [id])).rows[0].status).toBe('SYNCED');
    expect(requests.some((r) => r.startsWith('POST /indexes/properties/documents'))).toBe(true);
  });

  it('flush is a singleton across replicas and admin rebuild still indexes through the external engine', async () => {
    mode = 'ok';
    await seedPublished('Meili rebuild probe');
    await t.drain();
    const lock = await t.pool.connect();
    try {
      await lock.query(`SELECT pg_advisory_lock(hashtext('jetpool:search.flush'))`);
      expect(await flushPendingProjections(t.app.ctx)).toMatchObject({ skipped: true });
      await lock.query(`SELECT pg_advisory_unlock(hashtext('jetpool:search.flush'))`);
    } finally {
      lock.release();
    }
    const res = await rebuildIndex(t.ctx(), { reset: true });
    expect(res).toMatchObject({ adapter: 'meilisearch' });
    expect(res.indexed).toBeGreaterThanOrEqual(2);
    const st = await t.pool.query(`SELECT status, count(*)::int AS n FROM search_sync_state GROUP BY status`);
    expect(st.rows).toEqual([{ status: 'SYNCED', n: res.indexed }]);
  });
});
