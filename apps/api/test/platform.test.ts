import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, day, type TestApp } from './helpers.js';
import { withTx } from '../src/platform/db.js';
import { acquireBlock } from '../src/platform/inventory.js';
import { postLedger, PlatformAccount, accountBalance } from '../src/platform/ledger.js';
import { withIdempotency } from '../src/platform/idempotency.js';
import { StateMachine } from '../src/platform/fsm.js';
import { emit, onEvent } from '../src/platform/outbox.js';
import { applyBps, allocate } from '../src/platform/money.js';

let t: TestApp;
let hostId: string;
let propertyId: string;

beforeAll(async () => {
  t = await createTestApp();
  const host = await createUser(t, { roles: ['HOST'] });
  hostId = host.id;
  const { rows } = await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'P','HOUSE') RETURNING id`, [hostId]);
  propertyId = rows[0].id;
});
afterAll(async () => t.close());

describe('platform', () => {
  it('serves health/ready/metrics', async () => {
    expect((await call(t, null, 'GET', '/health')).status).toBe(200);
    expect((await call(t, null, 'GET', '/ready')).body.status).toBe('ready');
    expect((await call(t, null, 'GET', '/metrics')).status).toBe(200);
  });

  it('exclusion constraint prevents overlapping blocks under concurrency', async () => {
    const attempts = Array.from({ length: 10 }, () =>
      withTx(t.pool, (tx) => acquireBlock(tx, { propertyId, start: day(30), end: day(33), blockType: 'HOLD', sourceType: 'RESERVATION_HOLD' })).then(
        () => 'ok',
        (e) => e.code,
      ),
    );
    const results = await Promise.all(attempts);
    expect(results.filter((r) => r === 'ok')).toHaveLength(1);
    expect(results.filter((r) => r === 'INVENTORY_UNAVAILABLE')).toHaveLength(9);
  });

  it('expired holds do not block new acquisitions', async () => {
    await withTx(t.pool, (tx) =>
      acquireBlock(tx, { propertyId, start: day(40), end: day(42), blockType: 'HOLD', sourceType: 'RESERVATION_HOLD', expiresAt: new Date(Date.now() - 1000) }),
    );
    const b = await withTx(t.pool, (tx) => acquireBlock(tx, { propertyId, start: day(41), end: day(43), blockType: 'HOST_BLOCK', sourceType: 'HOST' }));
    expect(b.state).toBe('ACTIVE');
  });

  it('ledger rejects unbalanced postings and is append-only', async () => {
    const ctx = t.ctx();
    await expect(
      withTx(t.pool, (tx) => postLedger(tx, ctx, { type: 'X', sourceType: 'TEST', idempotencyKey: 'bad', lines: [{ account: PlatformAccount.bank('KRW'), debit: 10 }, { account: PlatformAccount.feeRevenue('KRW'), credit: 9 }] })),
    ).rejects.toThrow(/unbalanced/);
    const r = await withTx(t.pool, (tx) =>
      postLedger(tx, ctx, { type: 'X', sourceType: 'TEST', idempotencyKey: 'good', lines: [{ account: PlatformAccount.bank('KRW'), debit: 100 }, { account: PlatformAccount.feeRevenue('KRW'), credit: 100 }] }),
    );
    const again = await withTx(t.pool, (tx) =>
      postLedger(tx, ctx, { type: 'X', sourceType: 'TEST', idempotencyKey: 'good', lines: [{ account: PlatformAccount.bank('KRW'), debit: 100 }, { account: PlatformAccount.feeRevenue('KRW'), credit: 100 }] }),
    );
    expect(again).toEqual({ transactionId: r.transactionId, created: false });
    expect(await accountBalance(t.pool, 'PLATFORM:BANK:KRW')).toBe(100);
    await expect(t.pool.query(`UPDATE ledger_entries SET debit_minor = 1`)).rejects.toThrow(/append-only/);
    // DB-level deferred trigger also rejects raw unbalanced inserts
    await expect(
      withTx(t.pool, async (tx) => {
        const { rows } = await tx.query(`INSERT INTO ledger_transactions(transaction_type, source_type, idempotency_key) VALUES ('RAW','TEST','raw') RETURNING id`);
        const acc = (await tx.query(`SELECT id FROM ledger_accounts LIMIT 1`)).rows[0].id;
        await tx.query(`INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, currency) VALUES ($1,$2,5,'KRW')`, [rows[0].id, acc]);
      }),
    ).rejects.toThrow(/unbalanced/);
  });

  it('idempotency replays the stored response and rejects key reuse with a different body', async () => {
    let calls = 0;
    const fn = async () => ({ status: 201, body: { n: ++calls } });
    const a = await withIdempotency(t.pool, 'test', 'key-12345678', { x: 1 }, fn);
    const b = await withIdempotency(t.pool, 'test', 'key-12345678', { x: 1 }, fn);
    expect(a.body).toEqual({ n: 1 });
    expect(b).toEqual({ status: 201, body: { n: 1 }, replayed: true });
    await expect(withIdempotency(t.pool, 'test', 'key-12345678', { x: 2 }, fn)).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => withIdempotency(t.pool, 'test', 'key-concurrent', { y: 1 }, fn)));
    expect(new Set(concurrent.map((c) => (c.body as any).n)).size).toBe(1);
  });

  it('state machine only accepts enumerated transitions and records history', async () => {
    const m = new StateMachine<'A' | 'B' | 'C'>('TEST_AGG', { A: ['B'], B: ['C'], C: [] });
    const { rows } = await t.pool.query(
      `INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, total_minor, currency, quote_snapshot)
       VALUES ($1,$2,$2,'HELD',$3,$4,100,'KRW','{}') RETURNING id`,
      [propertyId, hostId, day(100), day(101)],
    );
    const fsm = new StateMachine<any>('RESERVATION', { HELD: ['PAYMENT_PENDING'], PAYMENT_PENDING: ['CONFIRMED'] });
    await withTx(t.pool, (tx) => fsm.transition(tx, t.ctx(), { table: 'reservations', id: rows[0].id, to: 'PAYMENT_PENDING', reason: 'test', versioned: true }));
    await expect(withTx(t.pool, (tx) => fsm.transition(tx, t.ctx(), { table: 'reservations', id: rows[0].id, to: 'HELD' }))).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    expect(m.can('A', 'C')).toBe(false);
    const hist = await t.pool.query(`SELECT * FROM state_transitions WHERE aggregate_id = $1`, [rows[0].id]);
    expect(hist.rows).toHaveLength(1);
    expect(hist.rows[0].correlation_id).toMatch(/^test-/);
  });

  it('outbox delivers each event once per consumer', async () => {
    const seen: string[] = [];
    onEvent('test.thing.*', 'test-consumer', async (_tx, ev) => {
      seen.push(ev.id);
    });
    const id = await withTx(t.pool, (tx) => emit(tx, t.ctx(), { aggregateType: 'thing', aggregateId: 'x', eventType: 'test.thing.happened', payload: {} }));
    await t.drain();
    await t.drain();
    expect(seen.filter((s) => s === id)).toHaveLength(1);
  });

  it('money helpers are exact', () => {
    expect(applyBps(10001, 1000)).toBe(1000);
    expect(applyBps(10005, 1000)).toBe(1001);
    expect(allocate(100, [1, 1, 1]).reduce((a, b) => a + b)).toBe(100);
  });
});
