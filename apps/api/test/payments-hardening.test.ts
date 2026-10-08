/**
 * QA hardening r1 — PAY-01/02 regressions (money group):
 *  - staff cannot refund a payment they paid or receive proceeds from;
 *  - a capture JETPOOL must not keep (duplicate / late / mismatch) is voided durably and retried until the PG confirms;
 *  - a new prepare supersedes a retryable FAILED payment (no second capture);
 *  - refund retries never cancel twice at the PG (stable key, no blind cancel when the verification read fails);
 *  - the refund executor calls the PG with no outbox-batch / payment / refund lock held;
 *  - a deadlock inside the subject handler is retried, not auto-refunded;
 *  - the unauthenticated webhook persists nothing for unknown payments and only whitelisted fields otherwise;
 *  - keyset pagination over payments created in one transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, idem, enableFlags, type TestApp, type TestUser } from './helpers.js';
import { MockProvider, ProviderError } from '../src/modules/payments/provider.js';
import { reconcileConfirming, retryRefunds, retryVoids } from '../src/modules/payments/service.js';
import { emit } from '../src/platform/outbox.js';

let t: TestApp;
let buyer: TestUser;
let accountant: TestUser;
let accountant2: TestUser;
let supplierOwner: TestUser;
let productId: string;
let mock: MockProvider;

async function newOrder(u: TestUser = buyer, price = 100_000, pid = productId) {
  const { rows } = await t.pool.query(
    `INSERT INTO travel_departures(product_id, starts_at, capacity, price_minor) VALUES ($1, now() + interval '20 days', 50, $2) RETURNING id`,
    [pid, price],
  );
  const o = await call(t, u, 'POST', '/v1/orders', { items: [{ departureId: rows[0].id, qty: 1 }] }, idem());
  expect(o.status).toBe(201);
  return o.body.item as { id: string; totalMinor: number };
}

async function prepare(orderId: string, u: TestUser = buyer) {
  const p = await call(t, u, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: orderId }, idem());
  expect(p.status, JSON.stringify(p.body)).toBe(201);
  return p.body as { paymentId: string; orderId: string; amount: number };
}

async function paidOrder(u: TestUser = buyer, price = 100_000, pid = productId) {
  const order = await newOrder(u, price, pid);
  const prep = await prepare(order.id, u);
  const c = await call(t, u, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${order.id}`, orderId: prep.orderId, amount: prep.amount }, idem());
  expect(c.status).toBe(200);
  return { order, payment: c.body.item as { id: string; paymentKey: string; amountMinor: number; orderId: string } };
}

/** Replace a MockProvider method for the next `times` calls (then the original behaviour is restored). */
function override<K extends 'confirm' | 'get' | 'cancel'>(name: K, times: number, impl: (orig: MockProvider[K], ...args: Parameters<MockProvider[K]>) => ReturnType<MockProvider[K]>) {
  const orig = (mock[name] as any).bind(mock);
  let left = times;
  (mock as any)[name] = (...args: any[]) => {
    if (left <= 0) return orig(...args);
    left--;
    if (left === 0) (mock as any)[name] = orig;
    return (impl as any)(orig, ...args);
  };
}

const pgCancels = (paymentKey: string) => mock.calls.filter((c) => c.op === 'cancel' && (c.args as any).paymentKey === paymentKey);

beforeAll(async () => {
  t = await createTestApp();
  mock = t.app.ctx.adapters.get('payments.provider') as MockProvider;
  buyer = await createUser(t);
  accountant = await createUser(t, { roles: ['ACCOUNTING'] });
  accountant2 = await createUser(t, { roles: ['ACCOUNTING'] });
  supplierOwner = await createUser(t, { roles: ['SUPPLIER'] });
  const s = await t.pool.query(
    `INSERT INTO suppliers(owner_user_id, name, supplier_type, status, merchant_of_record, commission_bps) VALUES ($1,'S','TOUR_OPERATOR','APPROVED','JETPOOL',1000) RETURNING id`,
    [supplierOwner.id],
  );
  productId = (await t.pool.query(`INSERT INTO travel_products(supplier_id, type, title, base_price_minor, status) VALUES ($1,'TOUR','Tour',100000,'PUBLISHED') RETURNING id`, [s.rows[0].id])).rows[0].id;
  await enableFlags(t, 'travel.commerce');
});
afterAll(async () => t.close());

describe('PAY-02 staff refund self-dealing', () => {
  it('an ACCOUNTING user cannot refund their own purchase; a colleague can', async () => {
    const { payment } = await paidOrder(accountant, 80_000);
    const self = await call(t, accountant, 'POST', `/v1/payments/${payment.id}/refunds`, { amountMinor: 80_000, reason: 'goodwill' }, idem());
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_REFUND_FORBIDDEN');
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1`, [payment.id])).rows[0].n).toBe(0);
    const other = await call(t, accountant2, 'POST', `/v1/payments/${payment.id}/refunds`, { amountMinor: 1_000, reason: 'goodwill' }, idem());
    expect(other.status).toBe(201);
    await t.drain();
    expect((await t.pool.query(`SELECT status FROM refunds WHERE id = $1`, [other.body.item.id])).rows[0].status).toBe('PARTIAL');
  });

  it('a staff member who is a payee of the payment cannot refund it', async () => {
    const owner = await createUser(t, { roles: ['SUPPLIER', 'ACCOUNTING'] });
    const s = await t.pool.query(
      `INSERT INTO suppliers(owner_user_id, name, supplier_type, status, merchant_of_record, commission_bps) VALUES ($1,'S2','TOUR_OPERATOR','APPROVED','JETPOOL',1000) RETURNING id`,
      [owner.id],
    );
    const pid = (await t.pool.query(`INSERT INTO travel_products(supplier_id, type, title, base_price_minor, status) VALUES ($1,'TOUR','Own',10000,'PUBLISHED') RETURNING id`, [s.rows[0].id])).rows[0].id;
    const { payment } = await paidOrder(buyer, 10_000, pid);
    const r = await call(t, owner, 'POST', `/v1/payments/${payment.id}/refunds`, { amountMinor: 10_000, reason: 'goodwill' }, idem());
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('SELF_REFUND_FORBIDDEN');
  });
});

describe('PAY-01 captures JETPOOL must not keep are voided durably', () => {
  it('a new prepare supersedes a FAILED(CONFIRM_NOT_RECEIVED) payment: a late retry of it is refused without a PG capture', async () => {
    const order = await newOrder();
    const p1 = await prepare(order.id);
    override('confirm', 1, async () => {
      throw new ProviderError('NETWORK_ERROR', 'connection reset before the PG received it', true);
    });
    const c1 = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_p1_${order.id}`, orderId: p1.orderId, amount: p1.amount }, idem());
    expect(c1.status).toBe(202);
    await reconcileConfirming(t.app.ctx, t.ctx(), 0);
    expect((await t.pool.query(`SELECT status, failure_code FROM payments WHERE id = $1`, [p1.paymentId])).rows[0]).toEqual({ status: 'FAILED', failure_code: 'CONFIRM_NOT_RECEIVED' });

    const p2 = await prepare(order.id);
    expect((await t.pool.query(`SELECT status FROM payments WHERE id = $1`, [p1.paymentId])).rows[0].status).toBe('CANCELLED');
    expect((await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_p2_${order.id}`, orderId: p2.orderId, amount: p2.amount }, idem())).status).toBe(200);
    const confirmsBefore = mock.calls.filter((c) => c.op === 'confirm').length;
    const late = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_p1_${order.id}`, orderId: p1.orderId, amount: p1.amount }, idem());
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('PAYMENT_CANCELLED');
    expect(mock.calls.filter((c) => c.op === 'confirm').length).toBe(confirmsBefore); // never captured twice
  });

  it('duplicate capture (webhook) → durable void; a failing PG cancel is retried and CANCELED is recorded only when it lands', async () => {
    const order = await newOrder();
    const p1 = await prepare(order.id);
    const k1 = `mock_dup1_${order.id}`;
    // the PG captures P1 but answers with a definitive error: P1 is FAILED (non-retryable) on our side
    override('confirm', 1, async (orig, args) => {
      await orig(args);
      throw new ProviderError('PROVIDER_REJECTED', 'rejected after capture (simulated)', false, 400);
    });
    expect((await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: k1, orderId: p1.orderId, amount: p1.amount }, idem())).status).toBe(402);
    const p2 = await prepare(order.id);
    expect((await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_dup2_${order.id}`, orderId: p2.orderId, amount: p2.amount }, idem())).status).toBe(200);

    // the PG reports P1 DONE: the subject is already paid → duplicate. The first void attempt fails transiently.
    override('cancel', 1, async () => {
      throw new ProviderError('PROVIDER_ERROR', 'Toss 500 (simulated)', true, 500);
    });
    const wh = await call(t, null, 'POST', '/v1/webhooks/toss', { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: k1, orderId: p1.orderId, status: 'DONE' } });
    expect(wh.status).toBe(200);
    await t.drain();
    const dup = (await t.pool.query(`SELECT status, failure_code, provider_status FROM payments WHERE id = $1`, [p1.paymentId])).rows[0];
    expect(dup).toEqual({ status: 'CANCELLED', failure_code: 'DUPLICATE_PAYMENT', provider_status: 'DONE' }); // not claimed CANCELED
    const v1 = (await t.pool.query(`SELECT id, status, attempts, amount_minor FROM payment_voids WHERE payment_id = $1`, [p1.paymentId])).rows[0];
    expect(v1).toMatchObject({ status: 'FAILED', attempts: 1, amount_minor: p1.amount });
    expect(mock.payments.get(k1)!.balanceAmount).toBe(p1.amount); // still charged at the PG …
    const rep = await call(t, accountant, 'GET', '/v1/admin/payments/reconciliation?checkProvider=true');
    expect(rep.body.items.find((i: any) => i.paymentId === p1.paymentId)?.issues).toEqual(expect.arrayContaining(['VOID_PENDING', 'PROVIDER_CAPTURED_NOT_KEPT']));

    // … until the retry job runs (backoff elapsed)
    await t.pool.query(`UPDATE payment_voids SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [v1.id]);
    expect(await retryVoids(t.app.ctx, t.ctx())).toBe(1);
    expect((await t.pool.query(`SELECT status FROM payment_voids WHERE id = $1`, [v1.id])).rows[0].status).toBe('DONE');
    expect(mock.payments.get(k1)).toMatchObject({ status: 'CANCELED', balanceAmount: 0 });
    expect((await t.pool.query(`SELECT provider_status FROM payments WHERE id = $1`, [p1.paymentId])).rows[0].provider_status).toBe('CANCELED');
    // (the failed first attempt never reached the mock PG's call log) the retry used the same stable key
    expect(pgCancels(k1).map((c) => (c.args as any).idempotencyKey)).toEqual([`dup-${p1.paymentId}`]);
    const rep2 = await call(t, accountant, 'GET', '/v1/admin/payments/reconciliation?checkProvider=true');
    expect(rep2.body.items.find((i: any) => i.paymentId === p1.paymentId)?.ok).toBe(true);
    // the paid order is untouched
    expect((await call(t, buyer, 'GET', `/v1/orders/${order.id}`)).body.item.status).toBe('PAID');
  });

  it('a capture of a payment we consider cancelled (late capture) is voided', async () => {
    const order = await newOrder();
    const p1 = await prepare(order.id);
    const k1 = `mock_late_${order.id}`;
    await mock.confirm({ paymentKey: k1, orderId: p1.orderId, amount: p1.amount }); // the PG captured P1 anyway
    await prepare(order.id); // supersedes P1 (CANCELLED, no key on our side)
    const wh = await call(t, null, 'POST', '/v1/webhooks/toss', { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: k1, orderId: p1.orderId, status: 'DONE' } });
    expect(wh.status).toBe(200);
    expect(wh.body.action).toBe('VOID_REQUESTED');
    await t.drain();
    expect(mock.payments.get(k1)).toMatchObject({ status: 'CANCELED', balanceAmount: 0 });
    expect((await t.pool.query(`SELECT status FROM payment_voids WHERE payment_id = $1`, [p1.paymentId])).rows[0].status).toBe('DONE');
  });

  it('a provider amount mismatch at confirm records a durable void that is executed', async () => {
    const order = await newOrder();
    const p = await prepare(order.id);
    const key = `mock_mm_${order.id}`;
    override('confirm', 1, async (orig, args) => {
      const pp = await orig({ ...args, amount: args.amount + 1_000 }); // the PG captured a different amount
      return pp;
    });
    const r = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: key, orderId: p.orderId, amount: p.amount }, idem());
    expect(r.status).toBe(502);
    expect(r.body.code).toBe('PROVIDER_MISMATCH');
    expect((await t.pool.query(`SELECT status, reason FROM payment_voids WHERE payment_id = $1`, [p.paymentId])).rows[0]).toEqual({ status: 'PENDING', reason: 'AMOUNT_MISMATCH' });
    await t.drain();
    expect((await t.pool.query(`SELECT status FROM payment_voids WHERE payment_id = $1`, [p.paymentId])).rows[0].status).toBe('DONE');
    expect(mock.payments.get(key)).toMatchObject({ status: 'CANCELED', balanceAmount: 0 });
  });
});

describe('PAY-02 refund retries never cancel twice', () => {
  it('cancel applied but timed out; the verification read then fails → no blind second cancel', async () => {
    const { payment } = await paidOrder(buyer, 100_000);
    override('cancel', 1, async (orig, args) => {
      await orig(args); // applied at the PG …
      throw new ProviderError('NETWORK_ERROR', 'Simulated timeout after apply', true); // … but we never saw the answer
    });
    const r = await call(t, accountant, 'POST', `/v1/payments/${payment.id}/refunds`, { amountMinor: 30_000, reason: 'partial goodwill' }, idem());
    expect(r.status).toBe(201);
    await t.drain();
    expect((await t.pool.query(`SELECT status, attempts FROM refunds WHERE id = $1`, [r.body.item.id])).rows[0]).toEqual({ status: 'FAILED', attempts: 1 });
    expect(mock.payments.get(payment.paymentKey)!.balanceAmount).toBe(70_000);

    // attempt 2: the PG lookup fails too → nothing is sent
    override('get', 1, async () => {
      throw new ProviderError('NETWORK_ERROR', 'Toss request failed: TimeoutError', true);
    });
    await t.pool.query(`UPDATE refunds SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [r.body.item.id]);
    await retryRefunds(t.app.ctx, t.ctx());
    expect((await t.pool.query(`SELECT status, attempts FROM refunds WHERE id = $1`, [r.body.item.id])).rows[0]).toEqual({ status: 'FAILED', attempts: 2 });
    expect(pgCancels(payment.paymentKey)).toHaveLength(1);
    expect(mock.payments.get(payment.paymentKey)!.balanceAmount).toBe(70_000);

    // attempt 3: the lookup finds the landed cancel → completed exactly once
    await t.pool.query(`UPDATE refunds SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [r.body.item.id]);
    await retryRefunds(t.app.ctx, t.ctx());
    expect((await t.pool.query(`SELECT status FROM refunds WHERE id = $1`, [r.body.item.id])).rows[0].status).toBe('PARTIAL');
    expect((await t.pool.query(`SELECT refunded_minor FROM payments WHERE id = $1`, [payment.id])).rows[0].refunded_minor).toBe(30_000);
    expect(mock.payments.get(payment.paymentKey)!.balanceAmount).toBe(70_000);
    expect(pgCancels(payment.paymentKey)).toHaveLength(1);
  });

  it('every attempt uses one stable PG idempotency key, so a resent cancel is deduplicated by the PG', async () => {
    const { payment } = await paidOrder(buyer, 10_000);
    override('cancel', 1, async (orig, args) => {
      await orig(args);
      throw new ProviderError('NETWORK_ERROR', 'timeout after apply', true);
    });
    const r = await call(t, accountant, 'POST', `/v1/payments/${payment.id}/refunds`, { amountMinor: 5_000, reason: '50% goodwill' }, idem());
    await t.drain();
    // the PG has not published the cancel yet: the verification read does not show it
    override('get', 1, async (orig, key) => {
      const cur = await orig(key);
      return { ...cur, balanceAmount: cur.totalAmount, status: 'DONE' as const, cancels: [] };
    });
    await t.pool.query(`UPDATE refunds SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [r.body.item.id]);
    await retryRefunds(t.app.ctx, t.ctx());
    expect((await t.pool.query(`SELECT status FROM refunds WHERE id = $1`, [r.body.item.id])).rows[0].status).toBe('PARTIAL');
    const keys = pgCancels(payment.paymentKey).map((c) => (c.args as any).idempotencyKey);
    expect(keys).toEqual([`refund-${r.body.item.id}`, `refund-${r.body.item.id}`]);
    expect(mock.payments.get(payment.paymentKey)!.balanceAmount).toBe(5_000); // cancelled once, not twice
    expect((await t.pool.query(`SELECT refunded_minor FROM payments WHERE id = $1`, [payment.id])).rows[0].refunded_minor).toBe(5_000);
  });
});

describe('PAY-02 refund executor holds no lock while the PG is called', () => {
  it('payment, refund and outbox rows are free during the provider cancel; the batch has committed', async () => {
    const { order, payment } = await paidOrder(buyer, 50_000);
    await t.drain();
    const unrelated = await emit(t.pool, t.ctx(), { aggregateType: 'test', aggregateId: order.id, eventType: 'verify.unrelated', payload: {} });
    const r = await call(t, accountant, 'POST', `/v1/payments/${payment.id}/refunds`, { amountMinor: 10_000, reason: 'slow PG' }, idem());
    expect(r.status).toBe(201);
    const probes: Record<string, string> = {};
    const probe = async (name: string, sql: string, params: unknown[]) => {
      try {
        await t.pool.query(sql, params);
        probes[name] = 'free';
      } catch (e: any) {
        probes[name] = e.code;
      }
    };
    override('cancel', 1, async (orig, args) => {
      await probe('payment', `SELECT 1 FROM payments WHERE id = $1 FOR UPDATE NOWAIT`, [payment.id]);
      await probe('refund', `SELECT 1 FROM refunds WHERE id = $1 FOR UPDATE NOWAIT`, [r.body.item.id]);
      await probe('outbox', `SELECT 1 FROM outbox_events WHERE id = $1 FOR UPDATE NOWAIT`, [unrelated]);
      probes.unrelatedPublished = String((await t.pool.query(`SELECT published_at IS NOT NULL AS p FROM outbox_events WHERE id = $1`, [unrelated])).rows[0].p);
      return orig(args);
    });
    await t.drain();
    expect(probes).toEqual({ payment: 'free', refund: 'free', outbox: 'free', unrelatedPublished: 'true' });
    expect((await t.pool.query(`SELECT status FROM refunds WHERE id = $1`, [r.body.item.id])).rows[0].status).toBe('PARTIAL');
  });
});

describe('PAY-01 approval vs transient database errors', () => {
  it('a deadlock inside the subject handler is retried; the purchase is not auto-refunded', async () => {
    const order = await newOrder(buyer, 50_000);
    const p = await prepare(order.id);
    const c = await t.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`, [order.id]); // e.g. a concurrent prepare holding the order
      const confirm = call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_dl_${order.id}`, orderId: p.orderId, amount: p.amount }, idem());
      // wait until the approval is blocked on the order lock (it already holds the payment lock)
      for (let i = 0; i < 100; i++) {
        const w = await t.pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
        if (w.rows[0].n > 0) break;
        await new Promise((res) => setTimeout(res, 20));
      }
      await new Promise((res) => setTimeout(res, 100));
      // … and now take the payment lock: a lock-order deadlock; the approval has waited longer and is the victim
      await c.query(`SELECT 1 FROM payments WHERE id = $1 FOR UPDATE`, [p.paymentId]);
      await c.query('COMMIT');
      const res = await confirm;
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.body.item.status).toBe('APPROVED');
    } finally {
      c.release();
    }
    expect((await call(t, buyer, 'GET', `/v1/orders/${order.id}`)).body.item.status).toBe('PAID');
    const refunds = await t.pool.query(`SELECT reason FROM refunds r JOIN payments p ON p.id = r.payment_id WHERE p.subject_id = $1`, [order.id]);
    expect(refunds.rows).toEqual([]); // no AUTO_REFUND:40P01
  });
});

describe('PAY-01 webhook intake', () => {
  it('persists nothing for unknown payments and only whitelisted fields for known ones', async () => {
    const count = async () => (await t.pool.query(`SELECT count(*)::int AS n FROM webhook_events`)).rows[0].n as number;
    const before = await count();
    const unknown = await call(t, null, 'POST', '/v1/webhooks/toss', { eventId: 'evil-1', eventType: 'PAYMENT_STATUS_CHANGED', data: { orderId: 'JPdoesnotexist000000000000', status: 'DONE' } });
    expect(unknown.status).toBe(200);
    expect(unknown.body.ignored).toBe('UNKNOWN_ORDER');
    const junk = await call(t, null, 'POST', '/v1/webhooks/toss', { eventId: 'evil-2', data: { orderId: { junk: 'x'.repeat(100_000) } } });
    expect(junk.status).toBe(200);
    expect(junk.body.ignored).toBe('UNKNOWN_ORDER');
    expect(await count()).toBe(before);

    const { payment } = await paidOrder(buyer, 20_000);
    const ok = await call(t, null, 'POST', '/v1/webhooks/toss', {
      eventType: 'PAYMENT_STATUS_CHANGED',
      createdAt: '2026-10-08T00:00:00+09:00',
      secret: 'per-payment-secret',
      junk: 'y'.repeat(50_000),
      data: { paymentKey: payment.paymentKey, orderId: payment.orderId, status: 'DONE', blob: 'z'.repeat(50_000), secret: 'deposit-secret' },
    });
    expect(ok.status).toBe(200);
    const row = (await t.pool.query(`SELECT payload FROM webhook_events WHERE payload->'data'->>'orderId' = $1`, [payment.orderId])).rows[0];
    expect(row.payload).toEqual({ eventType: 'PAYMENT_STATUS_CHANGED', createdAt: '2026-10-08T00:00:00+09:00', data: { paymentKey: payment.paymentKey, orderId: payment.orderId, status: 'DONE' } });
  });
});

describe('keyset pagination with rows created in one transaction', () => {
  it('walks every payment of a payer and in the admin list exactly once', async () => {
    const payer = await createUser(t);
    const subject = (await newOrder(payer, 1_000)).id;
    const ins = await t.pool.query(
      `INSERT INTO payments(provider, provider_order_id, payer_id, subject_type, subject_id, status, amount_minor, currency, expires_at)
       SELECT 'MOCK', 'JPbatch' || g || substr(md5(random()::text), 1, 12), $1, 'ORDER', $2, 'CANCELLED', 1000, 'KRW', now() FROM generate_series(1,3) g RETURNING id`,
      [payer.id, subject],
    );
    const walk = async (u: TestUser, url: string) => {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 10; i++) {
        const r: any = await call(t, u, 'GET', `${url}&limit=1${cursor ? `&cursor=${cursor}` : ''}`);
        expect(r.status).toBe(200);
        seen.push(...r.body.items.map((x: any) => x.id));
        cursor = r.body.nextCursor;
        if (!cursor) break;
      }
      return seen;
    };
    const ids = ins.rows.map((r) => r.id).sort();
    expect((await walk(payer, '/v1/payments?status=CANCELLED')).sort()).toEqual(ids);
    expect((await walk(accountant, `/v1/admin/payments?status=CANCELLED&subjectId=${subject}`)).sort()).toEqual(ids);
  });
});
