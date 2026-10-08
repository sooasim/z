import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, enableFlags, type TestApp, type TestUser } from './helpers.js';
import { signAccessToken } from '../src/platform/auth.js';
import { loadConfig } from '../src/platform/config.js';
import { withTx } from '../src/platform/db.js';
import { dispatchOutbox, emit, onEvent } from '../src/platform/outbox.js';
import { sendMessage } from '../src/modules/messaging/service.js';
import { MAX_STREAMS_PER_USER, startMessageBridge } from '../src/modules/messaging/index.js';
import { analyticsEventSchema, stripPii } from '../src/modules/analytics/service.js';
import { travelIntentSchema } from '../src/modules/ai/intent.js';
import type { AssistantLlm } from '../src/modules/ai/llm.js';

/** Regression tests for the ops-group r1 findings (messaging, realtime, AI, analytics, CMS, config, outbox). */

let t: TestApp;
let host: TestUser, guest: TestUser, admin: TestUser;
let propertyId: string;
let convId: string;
let address: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
  guest = await createUser(t);
  admin = await createUser(t, { roles: ['ADMIN'] });
  const { rows } = await t.pool.query(
    `INSERT INTO properties(host_id, title, property_type, status, city, rental_enabled, paid_booking_enabled, base_price_minor, max_guests, published_at)
     VALUES ($1,'Hanok','HANOK','PUBLISHED','서울', true, true, 100000, 4, now()) RETURNING id`,
    [host.id],
  );
  propertyId = rows[0].id;
  const c = await call(t, guest, 'POST', '/v1/conversations', { targetType: 'PROPERTY', targetId: propertyId, message: '안녕하세요' });
  expect(c.status).toBe(201);
  convId = c.body.item.id;
  address = await t.app.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => t.close());

// ------------------------------------------------------------------------------------------------ SSE helper
async function openStream(token: string) {
  const ac = new AbortController();
  const res = await fetch(`${address}/v1/realtime/stream?token=${token}`, { signal: ac.signal });
  const reader = res.body?.getReader();
  const dec = new TextDecoder();
  let pending: Promise<ReadableStreamReadResult<Uint8Array>> | null = null;
  const s = {
    status: res.status,
    buf: '',
    done: false,
    async readUntil(pred: (buf: string) => boolean, ms = 3000) {
      const deadline = Date.now() + ms;
      while (reader && !pred(s.buf) && !s.done) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        pending ??= reader.read();
        pending.catch(() => {});
        const r = await Promise.race([pending, sleep(left).then(() => null)]);
        if (!r) break;
        pending = null;
        if (r.done) {
          s.done = true;
          break;
        }
        s.buf += dec.decode(r.value, { stream: true });
      }
      return pred(s.buf);
    },
    close() {
      ac.abort();
    },
  };
  return s;
}

describe('COMMS-01 concurrent senders (r1)', () => {
  it('parallel messages from both members never deadlock (no 500s) and last_message_at stays the newest', async () => {
    for (let round = 0; round < 3; round++) {
      const sends = Array.from({ length: 6 }, (_, i) => call(t, i % 2 ? host : guest, 'POST', `/v1/conversations/${convId}/messages`, { body: `burst ${round}-${i}` }));
      const res = await Promise.all(sends);
      expect(res.map((r) => r.status)).toEqual([201, 201, 201, 201, 201, 201]);
    }
    const { rows } = await t.pool.query(
      `SELECT c.last_message_at = (SELECT max(created_at) FROM messages WHERE conversation_id = c.id) AS newest FROM conversations c WHERE c.id = $1`,
      [convId],
    );
    expect(rows[0].newest).toBe(true);
  });
});

describe('COMMS-01 SSE stream re-validation (r1)', () => {
  it('stops delivering and closes the stream once the session is revoked (logout-all)', async () => {
    const victim = await createUser(t, { roles: ['HOST'] });
    const p = await t.pool.query(`INSERT INTO properties(host_id, title, property_type, status) VALUES ($1,'V','HOUSE','PUBLISHED') RETURNING id`, [victim.id]);
    const c = await call(t, guest, 'POST', '/v1/conversations', { targetType: 'PROPERTY', targetId: p.rows[0].id, message: 'hi' });
    const s = await openStream(victim.token);
    expect(s.status).toBe(200);
    expect(await s.readUntil((b) => b.includes('event: ready'))).toBe(true);
    await call(t, guest, 'POST', `/v1/conversations/${c.body.item.id}/messages`, { body: 'before revoke' });
    expect(await s.readUntil((b) => b.includes('before revoke'))).toBe(true);
    expect((await call(t, victim, 'POST', '/v1/auth/logout-all')).status).toBe(200);
    await call(t, guest, 'POST', `/v1/conversations/${c.body.item.id}/messages`, { body: 'secret after logout-all 010-9999-8888' });
    await s.readUntil((b) => b.includes('event: revoked'));
    expect(s.buf).toContain('event: revoked');
    expect(s.buf).not.toContain('secret after logout-all');
    await s.readUntil(() => false, 1000);
    expect(s.done).toBe(true);
    s.close();
  });

  it('closes an idle stream on the periodic re-check when the account is suspended', async () => {
    t.app.ctx.adapters.set('messaging.sseRecheckMs', 150);
    try {
      const u = await createUser(t);
      const s = await openStream(u.token);
      expect(await s.readUntil((b) => b.includes('event: ready'))).toBe(true);
      await t.pool.query(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [u.id]);
      expect(await s.readUntil((b) => b.includes('event: revoked'), 3000)).toBe(true);
      await s.readUntil(() => false, 1000);
      expect(s.done).toBe(true);
      s.close();
    } finally {
      t.app.ctx.adapters.delete('messaging.sseRecheckMs');
    }
  });

  it('ends the stream when the access token expires', async () => {
    const u = await createUser(t);
    const short = await signAccessToken({ ...t.app.ctx.config, ACCESS_TOKEN_TTL_SEC: 2 }, { sub: u.id, sid: u.sessionId, aal: 'aal1' });
    const s = await openStream(short);
    expect(s.status).toBe(200);
    expect(await s.readUntil((b) => b.includes('event: expired'), 4000)).toBe(true);
    await s.readUntil(() => false, 1000);
    expect(s.done).toBe(true);
    s.close();
  });

  it(`caps concurrent streams per user (${MAX_STREAMS_PER_USER})`, async () => {
    const u = await createUser(t);
    const open = [];
    for (let i = 0; i < MAX_STREAMS_PER_USER; i++) {
      const s = await openStream(u.token);
      expect(s.status).toBe(200);
      open.push(s);
    }
    const extra = await openStream(u.token);
    expect(extra.status).toBe(429);
    open.pop()!.close();
    await sleep(200);
    const again = await openStream(u.token);
    expect(again.status).toBe(200);
    again.close();
    for (const s of open) s.close();
  });
});

describe('COMMS-01 LISTEN bridge resilience (r1)', () => {
  it('keeps reconnecting through a database outage and falls back to in-process delivery meanwhile', async () => {
    const target = new URL(t.app.ctx.config.DATABASE_URL);
    const sockets = new Set<net.Socket>();
    let down = false;
    const proxy = net.createServer((client) => {
      if (down) return void client.destroy();
      const upstream = net.connect(Number(target.port || 5432), target.hostname);
      sockets.add(client);
      sockets.add(upstream);
      const kill = () => {
        client.destroy();
        upstream.destroy();
        sockets.delete(client);
        sockets.delete(upstream);
      };
      client.on('error', kill).on('close', kill);
      upstream.on('error', kill).on('close', kill);
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', () => r()));
    const port = (proxy.address() as net.AddressInfo).port;
    const proxied = new URL(t.app.ctx.config.DATABASE_URL);
    proxied.hostname = '127.0.0.1';
    proxied.port = String(port);
    // same adapters/realtime as the app; only the LISTEN connection goes through the proxy
    const bridgeCtx = { ...t.app.ctx, config: { ...t.app.ctx.config, DATABASE_URL: proxied.toString() } };
    const got: string[] = [];
    const unsub = t.app.ctx.realtime.subscribe(`user:${host.id}`, (e) => got.push(e.message?.body));
    const waitFor = async (pred: () => boolean, ms: number) => {
      const deadline = Date.now() + ms;
      while (!pred() && Date.now() < deadline) await sleep(25);
      return pred();
    };
    const stop = await startMessageBridge(bridgeCtx, { retryMs: 100, maxRetryMs: 300 });
    try {
      expect(t.app.ctx.adapters.has('messaging.bridge')).toBe(true);
      await withTx(t.pool, (tx) => sendMessage(tx, t.ctx(), { conversationId: convId, senderId: guest.id, body: 'via bridge 1' }));
      expect(await waitFor(() => got.includes('via bridge 1'), 3000)).toBe(true);

      // outage: the LISTEN socket dies and reconnects are refused for a while
      down = true;
      for (const s of sockets) s.destroy();
      expect(await waitFor(() => !t.app.ctx.adapters.has('messaging.bridge'), 3000)).toBe(true);
      // meanwhile the API delivers in-process instead of relying on the dead bridge
      const r = await call(t, guest, 'POST', `/v1/conversations/${convId}/messages`, { body: 'during outage' });
      expect(r.status).toBe(201);
      expect(await waitFor(() => got.includes('during outage'), 2000)).toBe(true);
      await sleep(1000); // several failed reconnect attempts

      down = false;
      expect(await waitFor(() => t.app.ctx.adapters.has('messaging.bridge'), 5000)).toBe(true);
      await withTx(t.pool, (tx) => sendMessage(tx, t.ctx(), { conversationId: convId, senderId: guest.id, body: 'via bridge 2' }));
      expect(await waitFor(() => got.includes('via bridge 2'), 3000)).toBe(true);
    } finally {
      unsub();
      await stop();
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => proxy.close(() => r()));
    }
    expect(t.app.ctx.adapters.has('messaging.bridge')).toBe(false);
  });
});

describe('AI-01 travel assistant holds no transaction across LLM calls (r1)', () => {
  it('runs the LLM with no pooled connection checked out, re-checks ownership on write, caps per-user concurrency', async () => {
    await enableFlags(t, 'ai.assistant', 'stay.paid_booking');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered = 0;
    const slow: AssistantLlm = {
      model: 'slow-llm',
      async extractIntent(_m, _today, fallback) {
        entered++;
        await gate;
        return fallback;
      },
      async phrase() {
        return 'phrased';
      },
    };
    t.app.ctx.adapters.set('ai.llm', slow);
    try {
      const u = await createUser(t);
      const reqs = [0, 1, 2].map(() => call(t, u, 'POST', '/v1/ai/travel-assistant', { message: '서울 숙소 2명' }));
      const deadline = Date.now() + 3000;
      while (entered < 3 && Date.now() < deadline) await sleep(20);
      expect(entered).toBe(3);
      const idle = await t.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`);
      expect(idle.rows[0].n).toBe(0);
      // a 4th concurrent request from the same user is refused instead of queueing more LLM calls
      const busy = await call(t, u, 'POST', '/v1/ai/travel-assistant', { message: '서울 숙소' });
      expect(busy.status).toBe(429);
      expect(busy.body.code).toBe('ASSISTANT_BUSY');
      release();
      const res = await Promise.all(reqs);
      expect(res.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(res[0].body).toMatchObject({ model: 'slow-llm', reply: 'phrased', requiresUserConfirmation: true });
      const recs = await t.pool.query(`SELECT count(*)::int AS n FROM ai_recommendations WHERE user_id = $1`, [u.id]);
      expect(recs.rows[0].n).toBe(3);
      // someone else's session id is refused
      const other = await createUser(t);
      expect((await call(t, other, 'POST', '/v1/ai/travel-assistant', { message: '부산', sessionId: res[0].body.sessionId })).status).toBe(404);
      // continuing one's own session works
      expect((await call(t, u, 'POST', '/v1/ai/travel-assistant', { message: '부산', sessionId: res[0].body.sessionId })).body.sessionId).toBe(res[0].body.sessionId);
    } finally {
      t.app.ctx.adapters.delete('ai.llm');
    }
  });

  it('LLM-produced impossible dates fail intent validation (never reach ::date casts)', () => {
    const base = { destination: null, nights: null, guests: null, budget: null, interests: [], modes: ['stay'], language: 'ko' };
    expect(travelIntentSchema.safeParse({ ...base, checkIn: '2026-02-30', checkOut: '2026-03-02' }).success).toBe(false);
    expect(travelIntentSchema.safeParse({ ...base, checkIn: '2026-13-01', checkOut: null }).success).toBe(false);
    expect(travelIntentSchema.safeParse({ ...base, checkIn: '2026-02-27', checkOut: '2026-03-02' }).success).toBe(true);
  });
});

describe('AI-02 concurrent personalised recommendations (r1)', () => {
  it('parallel rails for the same user all succeed (no 409 on recommendation_features_pkey)', async () => {
    await enableFlags(t, 'ai.recommendations', 'stay.paid_booking');
    const u = await createUser(t);
    for (const city of ['서울', '부산', '제주']) {
      const p = await t.pool.query(
        `INSERT INTO properties(host_id, title, property_type, status, city, rental_enabled, paid_booking_enabled, base_price_minor, max_guests, published_at)
         VALUES ($1,$2,'HOUSE','PUBLISHED',$3, true, true, 90000, 4, now()) RETURNING id`,
        [host.id, `R ${city}`, city],
      );
      await t.pool.query(`INSERT INTO favorites(user_id, target_type, target_id) VALUES ($1,'PROPERTY',$2)`, [u.id, p.rows[0].id]);
    }
    for (let round = 0; round < 4; round++) {
      const res = await Promise.all(['home', 'stay', 'guide', 'travel', 'exchange'].map((s) => call(t, u, 'GET', `/v1/recommendations?surface=${s}`)));
      expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    }
    const f = await t.pool.query(`SELECT feature_key FROM recommendation_features WHERE user_id = $1 ORDER BY 1`, [u.id]);
    expect(f.rows.map((r) => r.feature_key)).toEqual(expect.arrayContaining(['city:부산', 'city:서울', 'city:제주', 'property_type:HOUSE']));
    // stale features are still removed
    await t.pool.query(`DELETE FROM favorites WHERE user_id = $1 AND target_id IN (SELECT id FROM properties WHERE city = '제주')`, [u.id]);
    await call(t, u, 'GET', '/v1/recommendations');
    const g = await t.pool.query(`SELECT feature_key FROM recommendation_features WHERE user_id = $1`, [u.id]);
    expect(g.rows.map((r) => r.feature_key)).not.toContain('city:제주');
  });
});

describe('OPS-04 anonymous analytics ingest is bounded (r1)', () => {
  const event = (properties: Record<string, unknown>) => ({ events: [{ name: 'page.view', properties }] });
  const many = (n: number, v: unknown = 'x') => Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, v]));

  it('rejects too many keys (top level and nested), oversized events and oversized bodies', async () => {
    expect((await call(t, null, 'POST', '/v1/analytics/events', event(many(50)))).status).toBe(202);
    expect((await call(t, null, 'POST', '/v1/analytics/events', event(many(51)))).status).toBe(400);
    expect((await call(t, null, 'POST', '/v1/analytics/events', event({ nested: many(51) }))).status).toBe(400);
    expect((await call(t, null, 'POST', '/v1/analytics/events', event(many(20, 'a'.repeat(500))))).status).toBe(400); // > 8 KB
    // the original 1.9 MB / 3,800-key attack body is refused before parsing
    const attack = event(many(3800, 'a'.repeat(500)));
    expect((await call(t, null, 'POST', '/v1/analytics/events', attack)).status).toBe(413);
    expect(analyticsEventSchema.safeParse(attack.events[0]).success).toBe(false);
  });

  it('PII stripping stays linear on adversarial strings', () => {
    const worst = ['a'.repeat(500), ('a'.repeat(60) + '@').repeat(8).slice(0, 500), 'a'.repeat(250) + '@' + 'a'.repeat(249), 'a@' + 'a.'.repeat(249)];
    for (const v of worst) {
      const props = many(15, v); // largest shape the schema admits (~8 KB)
      expect(analyticsEventSchema.safeParse({ name: 'page.view', properties: props }).success).toBe(true);
      const t0 = performance.now();
      for (let i = 0; i < 50; i++) stripPii(props); // a full 50-event batch
      expect(performance.now() - t0).toBeLessThan(400);
    }
    // detection itself is unchanged
    const r = stripPii({ a: 'mail me@x.io', b: 'a@b.c', c: 'x@y', d: '010-1234-5678', e: 'ok' });
    expect(r.clean).toEqual({ a: '[REDACTED]', b: 'a@b.c', c: 'x@y', d: '[REDACTED]', e: 'ok' });
  });
});

describe('OPS-03 public content listing (r1)', () => {
  it('lists the newest published entries first regardless of slug, with keyset pagination', async () => {
    const editor = await createUser(t, { roles: ['EDITOR'] });
    const publish = async (slug: string) => {
      const e = await call(t, editor, 'POST', '/v1/admin/cms/entries', { type: 'STORY', slug, title: slug });
      expect(e.status).toBe(201);
      expect((await call(t, editor, 'POST', `/v1/admin/cms/entries/${e.body.item.id}/publish`)).status).toBe(200);
      await sleep(5);
    };
    for (const slug of ['aaa-old-1', 'aaa-old-2', 'aaa-old-3', 'zoo-new-story', '제주-새소식']) await publish(slug);
    const p1 = await call(t, null, 'GET', '/v1/content/stories?limit=2');
    expect(p1.status).toBe(200);
    expect(p1.body.items.map((i: any) => i.slug)).toEqual(['제주-새소식', 'zoo-new-story']);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await call(t, null, 'GET', `/v1/content/stories?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((i: any) => i.slug)).toEqual(['aaa-old-3', 'aaa-old-2']);
    const p3 = await call(t, null, 'GET', `/v1/content/stories?limit=2&cursor=${p2.body.nextCursor}`);
    expect(p3.body.items.map((i: any) => i.slug)).toEqual(['aaa-old-1']);
    expect(p3.body.nextCursor).toBeNull();
  });
});

describe('PLAT tampered cursors (r1)', () => {
  it('out-of-range cursor timestamps never produce a 500', async () => {
    const bad = (ts: string) => Buffer.from(JSON.stringify([ts, '6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b'])).toString('base64url');
    for (const ts of ['2026-99-99 00:00:00', '2026-01-01 25:00:00', '2026-01-01T00:00:00+99']) {
      const c = bad(ts);
      expect((await call(t, guest, 'GET', `/v1/notifications?cursor=${c}`)).status).toBe(200);
      expect((await call(t, guest, 'GET', `/v1/conversations?cursor=${c}`)).status).toBe(200);
      expect((await call(t, null, 'GET', `/v1/content/stories?cursor=${c}`)).status).toBe(200);
      expect((await call(t, admin, 'GET', `/v1/admin/audit-logs?cursor=${c}`)).status).toBe(200);
      const r = await call(t, admin, 'GET', `/v1/admin/reservations?cursor=${c}`);
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('INVALID_CURSOR');
    }
  });
});

describe('PLAT config booleans (r1)', () => {
  it('OAUTH_MOCK="false"/"0"/"" mean false; production boots with the shipped OAUTH_MOCK="false"', () => {
    for (const v of ['false', '0', '', 'FALSE', 'off', undefined]) expect([v, loadConfig({ NODE_ENV: 'staging', OAUTH_MOCK: v }).OAUTH_MOCK]).toEqual([v, false]);
    for (const v of ['true', '1', true]) expect(loadConfig({ NODE_ENV: 'staging', OAUTH_MOCK: v }).OAUTH_MOCK).toBe(true);
    const prod = { NODE_ENV: 'production', JWT_SECRET: 'p'.repeat(48), DATA_ENCRYPTION_KEY: 'a'.repeat(64), PAYMENT_PROVIDER: 'TOSS' } as const;
    expect(loadConfig({ ...prod, OAUTH_MOCK: 'false' }).OAUTH_MOCK).toBe(false);
    expect(() => loadConfig({ ...prod, OAUTH_MOCK: 'true' })).toThrow('OAUTH_MOCK is forbidden in production');
    expect(() => loadConfig({ OAUTH_MOCK: 'maybe' })).toThrow();
  });
});

describe('PLAT outbox dispatch isolation (r1)', () => {
  it('commits each event before the next one is handled (locks and rollback scope are per event)', async () => {
    const order: string[] = [];
    let firstPublishedSeenByOthers: unknown = 'unset';
    let firstId = '';
    onEvent('test.ops.first', 'test.ops-first', async (_tx, _ev, _ctx, hooks) => {
      order.push('first');
      hooks.afterCommit(async () => void order.push('first.afterCommit'));
    });
    onEvent('test.ops.second', 'test.ops-second', async () => {
      // a different connection: sees the first event as published only if its dispatch already committed
      const r = await t.pool.query(`SELECT published_at FROM outbox_events WHERE id = $1`, [firstId]);
      firstPublishedSeenByOthers = r.rows[0].published_at;
      order.push('second');
    });
    await t.drain();
    firstId = await emit(t.pool, t.ctx(), { aggregateType: 'test', aggregateId: 'o1', eventType: 'test.ops.first', payload: {} });
    await emit(t.pool, t.ctx(), { aggregateType: 'test', aggregateId: 'o1', eventType: 'test.ops.second', payload: {} });
    expect(await dispatchOutbox(t.app.ctx)).toBeGreaterThanOrEqual(2);
    expect(order).toEqual(['first', 'first.afterCommit', 'second']);
    expect(firstPublishedSeenByOthers).toBeInstanceOf(Date);
  });
});
