import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Writable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createTestApp, createUser, call, type TestApp } from './helpers.js';
import { buildApp } from '../src/app.js';
import { q } from '../src/platform/db.js';
import { cursorColumns, decodeCursor, encodeCursor, page, redactSecretsInText, redactUrl, serializeRequest } from '../src/platform/http.js';
import { evaluateFlag, isEnabled, rolloutBucket, setFlag } from '../src/platform/flags.js';
import { createMetricsServer, recordPaymentOutcome, registry, workerMetricsPort } from '../src/platform/metrics.js';
import { dispatchOutbox, emit, onEvent } from '../src/platform/outbox.js';

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

async function counterValue(name: string, labels: Record<string, string> = {}): Promise<number> {
  const m = registry.getSingleMetric(name);
  if (!m) return 0;
  const { values } = await m.get();
  return values
    .filter((v: any) => Object.entries(labels).every(([k, val]) => v.labels?.[k] === val))
    .reduce((n: number, v: any) => n + v.value, 0);
}

// ------------------------------------------------------------------------------------------------ keyset cursors
describe('keyset pagination is exact at microsecond precision', () => {
  // 3 rows in the same millisecond (distinct microseconds) + 2 rows sharing one exact timestamp (tie on id)
  const SAME_MS = ['2026-03-01T10:00:00.123100Z', '2026-03-01T10:00:00.123200Z', '2026-03-01T10:00:00.123300Z'];
  const TIE = '2026-03-01T10:00:00.122000Z';
  let expectedDesc: string[];

  beforeAll(async () => {
    await t.pool.query(`CREATE TABLE tmp_cursor_rows (id uuid PRIMARY KEY, created_at timestamptz NOT NULL)`);
    for (const ts of [...SAME_MS, TIE, TIE]) await t.pool.query(`INSERT INTO tmp_cursor_rows VALUES ($1,$2)`, [randomUUID(), ts]);
    expectedDesc = (await q(t.pool, `SELECT id FROM tmp_cursor_rows ORDER BY created_at DESC, id DESC`)).map((r) => r.id);
    // sanity: the three same-millisecond rows really are indistinguishable as JS Dates
    const dates = await q(t.pool, `SELECT created_at FROM tmp_cursor_rows WHERE created_at >= '2026-03-01T10:00:00.123Z'`);
    expect(new Set(dates.map((d) => (d.created_at as Date).getTime())).size).toBe(1);
  });

  async function walk(order: 'DESC' | 'ASC', exact: boolean): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 20; i++) {
      const c = decodeCursor(cursor);
      const cmp = order === 'DESC' ? '<' : '>';
      const rows = await q(
        t.pool,
        `SELECT r.* ${exact ? `, ${cursorColumns('r')}` : ''} FROM tmp_cursor_rows r
          WHERE ($1::timestamptz IS NULL OR (r.created_at, r.id) ${cmp} ($1::timestamptz, $2::uuid))
          ORDER BY r.created_at ${order}, r.id ${order} LIMIT $3`,
        [c?.createdAt ?? null, c?.id ?? null, 2],
      );
      const p = page(rows, 1);
      seen.push(...p.items.map((x) => x.id));
      if (exact) for (const it of p.items) expect(it).not.toHaveProperty('created_at_cursor');
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    return seen;
  }

  it('limit 1 walks every row once, newest first, with cursorColumns()', async () => {
    expect(await walk('DESC', true)).toEqual(expectedDesc);
  });

  it('ascending walk is exact too (no repeats)', async () => {
    expect(await walk('ASC', true)).toEqual([...expectedDesc].reverse());
  });

  it('the legacy millisecond Date cursor demonstrably skips same-millisecond rows (regression guard)', async () => {
    const legacy = await walk('DESC', false);
    expect(legacy.length).toBeLessThan(expectedDesc.length);
  });

  it('encodes string timestamps verbatim and decodes back to the exact text', () => {
    const id = randomUUID();
    const c = encodeCursor({ created_at: '2026-03-01 10:00:00.123456+00', id });
    expect(decodeCursor(c)).toEqual({ createdAt: '2026-03-01 10:00:00.123456+00', id });
    const preferred = encodeCursor({ created_at: new Date('2026-03-01T10:00:00.123Z'), created_at_cursor: '2026-03-01T10:00:00.123456Z', id });
    expect(decodeCursor(preferred)?.createdAt).toBe('2026-03-01T10:00:00.123456Z');
    // legacy Date cursors (other modules) still round-trip
    expect(decodeCursor(encodeCursor({ created_at: new Date('2026-03-01T10:00:00.123Z'), id }))?.createdAt).toBe('2026-03-01T10:00:00.123Z');
  });

  it('rejects malformed / tampered cursors and unsafe identifiers', () => {
    const bad = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    expect(decodeCursor('not-base64-json')).toBeNull();
    expect(decodeCursor(bad(['2026-03-01; DROP TABLE x', randomUUID()]))).toBeNull();
    expect(decodeCursor(bad([123, randomUUID()]))).toBeNull();
    expect(decodeCursor(bad(['2026-03-01T10:00:00Z', 'nope']))).toBeNull();
    expect(() => cursorColumns('r; DROP')).toThrow();
    expect(cursorColumns()).toContain('AS created_at_cursor');
    expect(cursorColumns('i', 'opened_at')).toContain('i.opened_at');
  });
});

// ------------------------------------------------------------------------------------------------ log redaction
describe('request log redaction', () => {
  it('redactUrl strips secret query parameters only', () => {
    expect(redactUrl('/v1/realtime/stream?token=abc.def&channel=x')).toBe('/v1/realtime/stream?token=[REDACTED]&channel=x');
    expect(redactUrl('/v1/hosts/ical/feed.ics?TOKEN=zzz')).toBe('/v1/hosts/ical/feed.ics?TOKEN=[REDACTED]');
    expect(redactUrl('/cb?code=c1&state=s1&scope=email')).toBe('/cb?code=[REDACTED]&state=[REDACTED]&scope=email');
    expect(redactUrl('/x?access_token=a&refresh_token=b&paymentKey=pk_1&orderId=o1')).toBe(
      '/x?access_token=[REDACTED]&refresh_token=[REDACTED]&paymentKey=[REDACTED]&orderId=o1',
    );
    expect(redactUrl('/x?to%6Ben=enc&a=1#frag')).toBe('/x?to%6Ben=[REDACTED]&a=1#frag');
    expect(redactUrl('/x?token')).toBe('/x?token=[REDACTED]');
    expect(redactUrl('/plain/path')).toBe('/plain/path');
    expect(redactUrl('/x?tokens=keep&mytoken=keep')).toBe('/x?tokens=keep&mytoken=keep');
  });

  it('serializeRequest keeps the Fastify shape and redacts the url', () => {
    const out = serializeRequest({
      method: 'GET',
      url: '/v1/payments/toss/success?paymentKey=tgen_123&orderId=o1&amount=1000',
      headers: { host: 'api.jetpool.kr', authorization: 'Bearer secret' },
      host: 'api.jetpool.kr',
      ip: '10.0.0.1',
      socket: { remotePort: 4321 },
    });
    expect(out).toEqual({
      method: 'GET',
      url: '/v1/payments/toss/success?paymentKey=[REDACTED]&orderId=o1&amount=1000',
      version: undefined,
      host: 'api.jetpool.kr',
      remoteAddress: '10.0.0.1',
      remotePort: 4321,
    });
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('redactSecretsInText scrubs URLs inside messages', () => {
    expect(redactSecretsInText('Route GET:/v1/nope?token=abc&x=1 not found')).toBe('Route GET:/v1/nope?token=[REDACTED]&x=1 not found');
  });

  it('end-to-end: secrets in query strings never reach the log sink', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const app = await buildApp({
      logStream: sink as any,
      config: { ...t.app.ctx.config, LOG_LEVEL: 'info' } as any,
    });
    await app.ready();
    try {
      await app.inject({ method: 'GET', url: '/health?token=SECRET_TOKEN_1&keep=1' });
      await app.inject({ method: 'GET', url: '/v1/does-not-exist?access_token=SECRET_TOKEN_2&code=SECRET_CODE_3' });
    } finally {
      await app.close();
    }
    const all = lines.join('');
    expect(all).toContain('incoming request');
    expect(all).toContain('[REDACTED]');
    expect(all).toContain('keep=1');
    for (const s of ['SECRET_TOKEN_1', 'SECRET_TOKEN_2', 'SECRET_CODE_3']) expect(all).not.toContain(s);
  });
});

// ------------------------------------------------------------------------------------------------ PLAT-04
describe('PLAT-04 observability', () => {
  it('health/ready are in the OpenAPI contract tagged PLAT-04; metrics stays hidden', async () => {
    const spec = t.app.swagger() as any;
    expect(spec.paths['/health'].get.tags).toContain('PLAT-04');
    expect(spec.paths['/ready'].get.tags).toContain('PLAT-04');
    expect(spec.paths['/metrics']).toBeUndefined();
    expect((await call(t, null, 'GET', '/health')).body).toEqual({ status: 'ok' });
    const ready = await call(t, null, 'GET', '/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.status).toBe('ready');
    expect(typeof ready.body.outboxPending).toBe('number');
  });

  it('outbox dispatch/failure/dead-letter counters and the dead_letters view', async () => {
    onEvent('test.metrics.ok', 'test.metrics-ok', async () => {});
    onEvent('test.metrics.fail', 'test.metrics-failing', async () => {
      throw new Error('boom');
    });
    const before = {
      ok: await counterValue('jetpool_outbox_dispatched_total', { event_type: 'test.metrics.ok' }),
      failed: await counterValue('jetpool_outbox_failed_total', { consumer: 'test.metrics-failing' }),
      dead: await counterValue('jetpool_outbox_dead_lettered_total'),
    };
    const ctx = t.ctx();
    await emit(t.pool, ctx, { aggregateType: 'test', aggregateId: 'a1', eventType: 'test.metrics.ok', payload: {} });
    const failId = await emit(t.pool, ctx, { aggregateType: 'test', aggregateId: 'a2', eventType: 'test.metrics.fail', payload: { x: 1 } });
    await t.drain();
    expect(await counterValue('jetpool_outbox_dispatched_total', { event_type: 'test.metrics.ok' })).toBe(before.ok + 1);
    expect(await counterValue('jetpool_outbox_failed_total', { consumer: 'test.metrics-failing' })).toBe(before.failed + 1);

    // last retry → dead letter
    await t.pool.query(`UPDATE outbox_events SET attempts = 7, available_at = now() WHERE id = $1`, [failId]);
    for (let i = 0; i < 5 && (await dispatchOutbox(t.app.ctx)) > 0; i++) {}
    expect(await counterValue('jetpool_outbox_dead_lettered_total')).toBe(before.dead + 1);
    const dl = await q(t.pool, `SELECT * FROM dead_letters WHERE id = $1`, [failId]);
    expect(dl).toHaveLength(1);
    expect(dl[0]).toMatchObject({ event_type: 'test.metrics.fail', attempts: 8, payload: { x: 1 } });
    expect(dl[0].last_error).toContain('test.metrics-failing: boom');
    expect(Object.keys(dl[0]).sort()).toEqual(
      ['aggregate_id', 'aggregate_type', 'attempts', 'correlation_id', 'dead_lettered_at', 'event_type', 'id', 'last_error', 'payload'].sort(),
    );

    const text = (await call(t, null, 'GET', '/metrics')).body as string;
    for (const name of ['jetpool_outbox_dispatched_total', 'jetpool_outbox_failed_total', 'jetpool_outbox_dead_lettered_total', 'jetpool_payment_outcomes_total']) {
      expect(text).toContain(`# TYPE ${name} counter`);
    }
  });

  it('recordPaymentOutcome counts bounded outcome labels', async () => {
    const a = await counterValue('jetpool_payment_outcomes_total', { outcome: 'approved' });
    const o = await counterValue('jetpool_payment_outcomes_total', { outcome: 'other' });
    recordPaymentOutcome('approved');
    recordPaymentOutcome('APPROVED');
    recordPaymentOutcome('<script>');
    expect(await counterValue('jetpool_payment_outcomes_total', { outcome: 'approved' })).toBe(a + 2);
    expect(await counterValue('jetpool_payment_outcomes_total', { outcome: 'other' })).toBe(o + 1);
  });

  it('worker metrics server serves /metrics and /health', async () => {
    let scrapes = 0;
    const server = createMetricsServer({ beforeScrape: async () => void scrapes++ });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const m = await fetch(`http://127.0.0.1:${port}/metrics`);
      expect(m.status).toBe(200);
      expect(m.headers.get('content-type')).toContain('text/plain');
      expect(await m.text()).toContain('jetpool_outbox_dispatched_total');
      expect(scrapes).toBe(1);
      expect(await (await fetch(`http://127.0.0.1:${port}/health`)).json()).toEqual({ status: 'ok' });
      expect((await fetch(`http://127.0.0.1:${port}/nope`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' })).status).toBe(405);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(workerMetricsPort(undefined)).toBe(9464);
    expect(workerMetricsPort('9100')).toBe(9100);
    expect(workerMetricsPort('off')).toBeNull();
    expect(workerMetricsPort('abc')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ PLAT-06
describe('PLAT-06 flag rules and config version history', () => {
  const users = Array.from({ length: 2000 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);

  it('rollout buckets are deterministic, uniform and monotonic in pct', () => {
    expect(rolloutBucket('x.flag', users[0])).toBe(rolloutBucket('x.flag', users[0]));
    for (const u of users.slice(0, 50)) {
      const b = rolloutBucket('x.flag', u);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThan(100);
    }
    const row = (pct: number) => ({ enabled: false, rules: { rollout_pct: pct } });
    const on30 = users.filter((u) => evaluateFlag('x.flag', row(30), { userId: u }));
    expect(on30.length / users.length).toBeGreaterThan(0.25);
    expect(on30.length / users.length).toBeLessThan(0.35);
    // same answer every time, and raising the percentage only adds users
    expect(users.filter((u) => evaluateFlag('x.flag', row(30), { userId: u }))).toEqual(on30);
    const on50 = new Set(users.filter((u) => evaluateFlag('x.flag', row(50), { userId: u })));
    for (const u of on30) expect(on50.has(u)).toBe(true);
    // the bucket matches the documented formula: first 4 bytes of sha256(key:user) mod 100
    for (const u of users.slice(0, 20)) expect(evaluateFlag('x.flag', row(30), { userId: u })).toBe(rolloutBucket('x.flag', u) < 30);
    // a different flag key reshuffles users
    const otherKey = users.filter((u) => evaluateFlag('y.flag', row(30), { userId: u }));
    expect(otherKey).not.toEqual(on30);
    // edges
    expect(evaluateFlag('x.flag', row(0), { userId: users[0] })).toBe(false);
    expect(evaluateFlag('x.flag', row(100), {})).toBe(true);
    expect(evaluateFlag('x.flag', row(99), {})).toBe(false);
    expect(evaluateFlag('x.flag', { enabled: false, rules: { rollout_pct: 'lots' } }, { userId: users[0] })).toBe(false);
    expect(evaluateFlag('x.flag', null, { userId: users[0] })).toBe(false);
  });

  it('isEnabled applies rollout_pct from the DB deterministically', async () => {
    const key = 'test.rollout';
    await t.pool.query(`INSERT INTO feature_flags(flag_key, enabled, rules) VALUES ($1, false, '{"rollout_pct": 40}')`, [key]);
    const inside = users.find((u) => rolloutBucket(key, u) < 40)!;
    const outside = users.find((u) => rolloutBucket(key, u) >= 40)!;
    expect(await isEnabled(t.pool, key, { userId: inside })).toBe(true);
    expect(await isEnabled(t.pool, key, { userId: inside })).toBe(true);
    expect(await isEnabled(t.pool, key, { userId: outside })).toBe(false);
    expect(await isEnabled(t.pool, key)).toBe(false);
    expect(await isEnabled(t.pool, 'test.missing.flag', { userId: inside })).toBe(false);
  });

  it('kill switch beats enabled, allow lists and rollout', async () => {
    const key = 'test.killed';
    const u = users[7];
    await t.pool.query(
      `INSERT INTO feature_flags(flag_key, enabled, rules) VALUES ($1, true, $2)`,
      [key, JSON.stringify({ kill_switch: true, allow_user_ids: [u], allow_roles: ['ADMIN'], rollout_pct: 100 })],
    );
    expect(await isEnabled(t.pool, key)).toBe(false);
    expect(await isEnabled(t.pool, key, { userId: u, roles: ['ADMIN'] })).toBe(false);
    await t.pool.query(`UPDATE feature_flags SET rules = rules - 'kill_switch' WHERE flag_key = $1`, [key]);
    expect(await isEnabled(t.pool, key)).toBe(true);
    await t.pool.query(`UPDATE feature_flags SET enabled = false, rules = jsonb_build_object('allow_roles', '["ADMIN"]'::jsonb) WHERE flag_key = $1`, [key]);
    expect(await isEnabled(t.pool, key, { roles: ['ADMIN'] })).toBe(true);
    expect(await isEnabled(t.pool, key, { roles: ['USER'] })).toBe(false);
  });

  it('every flag change is versioned automatically (changed_by, reason); no-op upserts are not', async () => {
    const admin = await createUser(t, { roles: ['ADMIN'] });
    const key = 'test.versioned';
    const versions = () => q(t.pool, `SELECT * FROM config_versions WHERE config_type = 'FLAG' AND config_key = $1 ORDER BY id`, [key]);
    await setFlag(t.pool, key, false);
    await setFlag(t.pool, key, true, admin.id, 'launch to everyone');
    await setFlag(t.pool, key, true, admin.id); // no effective change
    await t.pool.query(`UPDATE feature_flags SET rules = '{"kill_switch": true}', updated_by = $2 WHERE flag_key = $1`, [key, admin.id]);
    const v = await versions();
    expect(v).toHaveLength(3);
    expect(v[0]).toMatchObject({ before: null, after: { enabled: false, rules: {} }, changed_by: null, reason: null });
    expect(v[1]).toMatchObject({ before: { enabled: false }, after: { enabled: true }, changed_by: admin.id, reason: 'launch to everyone' });
    expect(v[2]).toMatchObject({ before: { rules: {} }, after: { rules: { kill_switch: true } }, changed_by: admin.id });
    expect(v[2].after).not.toHaveProperty('updated_at');
    expect(new Date(v[2].created_at).getTime()).toBeGreaterThanOrEqual(new Date(v[1].created_at).getTime());
  });

  it('config_values changes are versioned and the history is append-only', async () => {
    const proposer = await createUser(t, { roles: ['ADMIN'] });
    const approver = await createUser(t, { roles: ['ADMIN'] });
    await t.pool.query(`INSERT INTO config_values(config_key, value, note, proposed_by) VALUES ('test.cfg.limit', '5', 'initial', $1)`, [proposer.id]);
    await t.pool.query(`UPDATE config_values SET approved_by = $1, approved_at = now() WHERE config_key = 'test.cfg.limit'`, [approver.id]);
    const v = await q(t.pool, `SELECT * FROM config_versions WHERE config_type = 'CONFIG' AND config_key = 'test.cfg.limit' ORDER BY id`);
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ before: null, changed_by: proposer.id, reason: 'initial' });
    expect(v[0].after.value).toBe(5);
    expect(v[1]).toMatchObject({ changed_by: approver.id });
    expect(v[1].before.approved_by).toBeNull();
    expect(v[1].after.approved_by).toBe(approver.id);

    await expect(t.pool.query(`UPDATE config_versions SET reason = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(t.pool.query(`DELETE FROM config_versions`)).rejects.toThrow(/append-only/);
  });

  it('history starts with a baseline of the seeded flags', async () => {
    const base = await q(t.pool, `SELECT * FROM config_versions WHERE config_type = 'FLAG' AND config_key = 'stay.paid_booking' ORDER BY id LIMIT 1`);
    expect(base[0]).toMatchObject({ before: null, reason: 'baseline (migration 0800)' });
    expect(base[0].after.enabled).toBe(false);
  });
});
