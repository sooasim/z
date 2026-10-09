import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, idem, enableFlags, type TestApp, type TestUser } from './helpers.js';
import { MockProvider, MOCK_FAIL_AMOUNT, ProviderError, TossProvider } from '../src/modules/payments/provider.js';
import { expirePayments, reconcileConfirming, retryRefunds } from '../src/modules/payments/service.js';
import { emit } from '../src/platform/outbox.js';

let t: TestApp;
let buyer: TestUser;
let accountant: TestUser;
let supplierOwner: TestUser;
let productId: string;
let mock: MockProvider;

async function newOrder(u: TestUser = buyer, opts: { price?: number; qty?: number } = {}) {
  const { rows } = await t.pool.query(
    `INSERT INTO travel_departures(product_id, starts_at, capacity, price_minor) VALUES ($1, now() + interval '20 days', 50, $2) RETURNING id`,
    [productId, opts.price ?? null],
  );
  const o = await call(t, u, 'POST', '/v1/orders', { items: [{ departureId: rows[0].id, qty: opts.qty ?? 1 }] }, idem());
  expect(o.status).toBe(201);
  return o.body.item;
}

async function prepare(orderId: string, u: TestUser = buyer) {
  const p = await call(t, u, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: orderId }, idem());
  expect(p.status).toBe(201);
  return p.body;
}

async function paidOrder(price = 80_000) {
  const order = await newOrder(buyer, { price });
  const prep = await prepare(order.id);
  const c = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${order.id}`, orderId: prep.orderId, amount: prep.amount }, idem());
  expect(c.status).toBe(200);
  return { order, prep, payment: c.body.item };
}

async function ledgerBalanced() {
  const r = await call(t, accountant, 'GET', '/v1/admin/ledger/trial-balance');
  expect(r.status).toBe(200);
  return r.body;
}

beforeAll(async () => {
  t = await createTestApp();
  mock = t.app.ctx.adapters.get('payments.provider') as MockProvider;
  buyer = await createUser(t);
  accountant = await createUser(t, { roles: ['ACCOUNTING'] });
  supplierOwner = await createUser(t, { roles: ['SUPPLIER'] });
  const s = await t.pool.query(
    `INSERT INTO suppliers(owner_user_id, name, supplier_type, status, merchant_of_record, commission_bps) VALUES ($1,'S','TOUR_OPERATOR','APPROVED','JETPOOL',1000) RETURNING id`,
    [supplierOwner.id],
  );
  const p = await t.pool.query(`INSERT INTO travel_products(supplier_id, type, title, base_price_minor, status) VALUES ($1,'TOUR','Tour',100000,'PUBLISHED') RETURNING id`, [s.rows[0].id]);
  productId = p.rows[0].id;
  await enableFlags(t, 'travel.commerce');
});
afterAll(async () => t.close());

describe('PAY-01 prepare / confirm', () => {
  it('prepare uses the server-side amount and requires Idempotency-Key; only the buyer may prepare', async () => {
    const order = await newOrder(buyer, { price: 33_000, qty: 2 });
    expect((await call(t, buyer, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: order.id })).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const other = await createUser(t);
    const forbidden = await call(t, other, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: order.id, amount: 1 } as any, idem());
    expect(forbidden.status).toBe(403);
    const p = await prepare(order.id);
    expect(p.amount).toBe(66_000);
    expect(p.currency).toBe('KRW');
    expect(p.orderId).toMatch(/^[A-Za-z0-9_-]{6,64}$/);
    expect(p.customerKey).toBeTruthy();
    const o = await call(t, buyer, 'GET', `/v1/orders/${order.id}`);
    expect(o.body.item.status).toBe('PAYMENT_PENDING');
    const row = await t.pool.query(`SELECT * FROM payments WHERE provider_order_id = $1`, [p.orderId]);
    expect(row.rows[0].status).toBe('CREATED');
    // invariant 9: no PAN / CVC columns
    const cols = await t.pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('payments','refunds','payout_accounts')`);
    expect(cols.rows.map((c) => c.column_name).some((c) => /card|pan|cvc|cvv/i.test(c))).toBe(false);
  });

  it('confirm with a mismatched amount is rejected without calling the provider', async () => {
    const order = await newOrder();
    const p = await prepare(order.id);
    const before = mock.calls.length;
    const r = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${order.id}`, orderId: p.orderId, amount: p.amount - 1 }, idem());
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('AMOUNT_MISMATCH');
    expect(mock.calls.length).toBe(before);
    const row = await t.pool.query(`SELECT status FROM payments WHERE provider_order_id = $1`, [p.orderId]);
    expect(row.rows[0].status).toBe('CREATED');
    const aud = await t.pool.query(`SELECT 1 FROM audit_logs WHERE action = 'payment.confirm.amount_mismatch' AND category = 'MONEY'`);
    expect(aud.rowCount).toBeGreaterThan(0);
  });

  it('confirm approves, posts a balanced ledger, issues a receipt; replay with the same key is idempotent', async () => {
    const order = await newOrder(buyer, { price: 80_000 });
    const p = await prepare(order.id);
    const other = await createUser(t);
    expect((await call(t, other, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${order.id}`, orderId: p.orderId, amount: p.amount }, idem())).status).toBe(403);
    const h = idem();
    const body = { paymentKey: `mock_${order.id}`, orderId: p.orderId, amount: p.amount };
    const c1 = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', body, h);
    expect(c1.status).toBe(200);
    expect(c1.body.item.status).toBe('APPROVED');
    const confirmCalls = mock.calls.filter((c) => c.op === 'confirm').length;
    const c2 = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', body, h);
    expect(c2.status).toBe(200);
    expect(c2.headers['idempotent-replayed']).toBe('true');
    expect(c2.body.item.id).toBe(c1.body.item.id);
    // a fresh key after approval also returns the approved payment without another PG call
    const c3 = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', body, idem());
    expect(c3.status).toBe(200);
    expect(mock.calls.filter((c) => c.op === 'confirm').length).toBe(confirmCalls);
    // same key, different payload → 422
    expect((await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { ...body, paymentKey: 'mock_other' }, h)).status).toBe(422);

    const ledger = await t.pool.query(
      `SELECT a.code, e.debit_minor, e.credit_minor FROM ledger_transactions x JOIN ledger_entries e ON e.transaction_id = x.id JOIN ledger_accounts a ON a.id = e.account_id
        WHERE x.source_type = 'PAYMENT' AND x.source_id = $1`,
      [c1.body.item.id],
    );
    const by = Object.fromEntries(ledger.rows.map((r) => [r.code, r.debit_minor || r.credit_minor]));
    expect(by['PLATFORM:PG_CLEARING:KRW']).toBe(80_000);
    expect(by[`PAYEE:${supplierOwner.id}:PAYABLE:KRW`]).toBe(72_000); // 10% commission
    expect(by['PLATFORM:FEE_REVENUE:KRW']).toBe(8_000);
    expect((await ledgerBalanced()).balanced).toBe(true);
    const receipts = await call(t, buyer, 'GET', '/v1/receipts');
    expect(receipts.body.items.some((r: any) => r.paymentId === c1.body.item.id && r.receiptType === 'PAYMENT')).toBe(true);
    const mine = await call(t, buyer, 'GET', '/v1/payments');
    expect(mine.body.items.some((x: any) => x.id === c1.body.item.id)).toBe(true);
    expect((await call(t, other, 'GET', `/v1/payments/${c1.body.item.id}`)).status).toBe(404);
    // a second prepare for a paid subject is refused
    expect((await call(t, buyer, 'POST', '/v1/payments/toss/prepare', { subjectType: 'ORDER', subjectId: order.id }, idem())).status).toBe(409);
  });

  it('MOCK provider failure → payment FAILED and the order PAYMENT_FAILED', async () => {
    const order = await newOrder();
    const p = await prepare(order.id);
    const r = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_fail_${order.id}`, orderId: p.orderId, amount: p.amount }, idem());
    expect(r.status).toBe(402);
    expect(r.body.providerCode).toBe('REJECT_CARD_PAYMENT');
    expect(r.body.item.status).toBe('FAILED');
    expect((await call(t, buyer, 'GET', `/v1/orders/${order.id}`)).body.item.status).toBe('PAYMENT_FAILED');
    // the failed payment cannot be confirmed again; a new prepare is allowed
    expect((await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${order.id}`, orderId: p.orderId, amount: p.amount }, idem())).body.code).toBe('PAYMENT_FAILED');
    const p2 = await prepare(order.id);
    expect((await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${order.id}`, orderId: p2.orderId, amount: p2.amount }, idem())).status).toBe(200);
  });

  it('fails by amount too (MOCK_FAIL_AMOUNT)', async () => {
    const order = await newOrder(buyer, { price: MOCK_FAIL_AMOUNT });
    const p = await prepare(order.id);
    const r = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${order.id}`, orderId: p.orderId, amount: p.amount }, idem());
    expect(r.status).toBe(402);
  });

  it('unknown outcome stays CONFIRMING and the reconciliation job approves via provider.get', async () => {
    const order = await newOrder();
    const p = await prepare(order.id);
    const r = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_timeout_${order.id}`, orderId: p.orderId, amount: p.amount }, idem());
    expect(r.status).toBe(202);
    expect(r.body.item.status).toBe('CONFIRMING');
    expect(await reconcileConfirming(t.app.ctx, t.ctx(), 0)).toBeGreaterThanOrEqual(1);
    const row = await t.pool.query(`SELECT status FROM payments WHERE provider_order_id = $1`, [p.orderId]);
    expect(row.rows[0].status).toBe('APPROVED');
    expect((await call(t, buyer, 'GET', `/v1/orders/${order.id}`)).body.item.status).toBe('PAID');
  });

  it('crash between phases (CONFIRMING, PG never received it) → FAILED retryable → confirm again', async () => {
    const order = await newOrder();
    const p = await prepare(order.id);
    await t.pool.query(`UPDATE payments SET status = 'CONFIRMING', payment_key = $2 WHERE provider_order_id = $1`, [p.orderId, `mock_lost_${order.id}`]);
    await reconcileConfirming(t.app.ctx, t.ctx(), 0);
    const row = await t.pool.query(`SELECT status, failure_code FROM payments WHERE provider_order_id = $1`, [p.orderId]);
    expect(row.rows[0]).toEqual({ status: 'FAILED', failure_code: 'CONFIRM_NOT_RECEIVED' });
    const r = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${order.id}`, orderId: p.orderId, amount: p.amount }, idem());
    expect(r.status).toBe(200);
  });

  it('expiry job fails CREATED payments past expires_at', async () => {
    const order = await newOrder();
    const p = await prepare(order.id);
    await t.pool.query(`UPDATE payments SET expires_at = now() - interval '1 second' WHERE provider_order_id = $1`, [p.orderId]);
    expect(await expirePayments(t.app.ctx, t.ctx())).toBeGreaterThanOrEqual(1);
    const row = await t.pool.query(`SELECT status, failure_code FROM payments WHERE provider_order_id = $1`, [p.orderId]);
    expect(row.rows[0]).toEqual({ status: 'FAILED', failure_code: 'EXPIRED' });
    const c = await call(t, buyer, 'POST', '/v1/payments/toss/confirm', { paymentKey: `mock_${order.id}`, orderId: p.orderId, amount: p.amount }, idem());
    expect(c.status).toBe(409);
  });
});

describe('PAY-01 webhook (invariant 3: the success URL never confirms — server confirm / webhook does)', () => {
  it('reconciles from the provider, dedupes replays and is processed once', async () => {
    const order = await newOrder();
    const p = await prepare(order.id);
    // the browser landed on successUrl but never called confirm; PG has approved it
    await mock.confirm({ paymentKey: `mock_wh_${order.id}`, orderId: p.orderId, amount: p.amount });
    const payload = { eventType: 'PAYMENT_STATUS_CHANGED', createdAt: new Date().toISOString(), data: { paymentKey: `mock_wh_${order.id}`, orderId: p.orderId, status: 'DONE' } };
    const w1 = await call(t, null, 'POST', '/v1/webhooks/toss', payload);
    expect(w1.status).toBe(200);
    expect(w1.body.action).toBe('APPROVED');
    const w2 = await call(t, null, 'POST', '/v1/webhooks/toss', payload);
    expect(w2.status).toBe(200);
    expect(w2.body.duplicate).toBe(true);
    const pay = await t.pool.query(`SELECT id, status FROM payments WHERE provider_order_id = $1`, [p.orderId]);
    expect(pay.rows[0].status).toBe('APPROVED');
    const tx = await t.pool.query(`SELECT count(*)::int AS n FROM ledger_transactions WHERE source_type = 'PAYMENT' AND source_id = $1`, [pay.rows[0].id]);
    expect(tx.rows[0].n).toBe(1);
    const ev = await t.pool.query(`SELECT count(*)::int AS n FROM webhook_events WHERE provider = 'TOSS' AND processed_at IS NOT NULL AND payload->'data'->>'orderId' = $1`, [p.orderId]);
    expect(ev.rows[0].n).toBe(1);
    expect((await call(t, buyer, 'GET', `/v1/orders/${order.id}`)).body.item.status).toBe('PAID');
  });

  it('a forged webhook (provider has no such payment) is rejected and changes nothing', async () => {
    const order = await newOrder();
    const p = await prepare(order.id);
    const r = await call(t, null, 'POST', '/v1/webhooks/toss', { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: 'mock_forged', orderId: p.orderId, status: 'DONE' } });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe('WEBHOOK_UNVERIFIED');
    expect((await t.pool.query(`SELECT status FROM payments WHERE provider_order_id = $1`, [p.orderId])).rows[0].status).toBe('CREATED');
  });

  it('with TOSS_WEBHOOK_SECRET configured, invalid signatures are rejected (401) and valid ones accepted', async () => {
    const cfg = t.app.ctx.config as any;
    cfg.TOSS_WEBHOOK_SECRET = 'whsec_test_123';
    try {
      const order = await newOrder();
      const p = await prepare(order.id);
      await mock.confirm({ paymentKey: `mock_sig_${order.id}`, orderId: p.orderId, amount: p.amount });
      const raw = JSON.stringify({ eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: `mock_sig_${order.id}`, orderId: p.orderId, status: 'DONE' } });
      const bad = await t.app.inject({ method: 'POST', url: '/v1/webhooks/toss', payload: raw, headers: { 'content-type': 'application/json', 'x-toss-signature': 'deadbeef' } });
      expect(bad.statusCode).toBe(401);
      const none = await t.app.inject({ method: 'POST', url: '/v1/webhooks/toss', payload: raw, headers: { 'content-type': 'application/json' } });
      expect(none.statusCode).toBe(401);
      expect((await t.pool.query(`SELECT status FROM payments WHERE provider_order_id = $1`, [p.orderId])).rows[0].status).toBe('CREATED');
      const time = String(Date.now());
      const sig = createHmac('sha256', 'whsec_test_123').update(`${raw}:${time}`).digest('base64');
      const good = await t.app.inject({
        method: 'POST',
        url: '/v1/webhooks/toss',
        payload: raw,
        headers: { 'content-type': 'application/json', 'tosspayments-webhook-signature': `v1:${sig}`, 'tosspayments-webhook-transmission-time': time },
      });
      expect(good.statusCode).toBe(200);
      expect((await t.pool.query(`SELECT status FROM payments WHERE provider_order_id = $1`, [p.orderId])).rows[0].status).toBe('APPROVED');
    } finally {
      cfg.TOSS_WEBHOOK_SECRET = undefined;
    }
  });

  it('syncs a cancellation made at the provider console into a completed refund', async () => {
    const { payment } = await paidOrder(40_000);
    await mock.cancel({ paymentKey: payment.paymentKey, cancelAmount: 10_000, cancelReason: 'console', idempotencyKey: `console-${payment.id}` });
    const r = await call(t, null, 'POST', '/v1/webhooks/toss', { eventType: 'PAYMENT_STATUS_CHANGED', data: { paymentKey: payment.paymentKey, orderId: payment.orderId, status: 'PARTIAL_CANCELED' } });
    expect(r.status).toBe(200);
    const row = await t.pool.query(`SELECT status, refunded_minor FROM payments WHERE id = $1`, [payment.id]);
    expect(row.rows[0]).toEqual({ status: 'PARTIALLY_REFUNDED', refunded_minor: 10_000 });
    expect((await ledgerBalanced()).balanced).toBe(true);
  });
});

describe('PAY-02 refunds', () => {
  it('staff partial refund executes via outbox, posts compensating ledger entries; over-refund rejected', async () => {
    const { payment } = await paidOrder(80_000);
    const body = { amountMinor: 30_000, reason: 'partial goodwill' };
    expect((await call(t, buyer, 'POST', `/v1/payments/${payment.id}/refunds`, body, idem())).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['ACCOUNTING'], aal: 'aal1' });
    expect((await call(t, aal1, 'POST', `/v1/payments/${payment.id}/refunds`, body, idem())).body.code).toBe('AAL2_REQUIRED');
    expect((await call(t, accountant, 'POST', `/v1/payments/${payment.id}/refunds`, body)).body.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const h = idem();
    const r1 = await call(t, accountant, 'POST', `/v1/payments/${payment.id}/refunds`, body, h);
    expect(r1.status).toBe(201);
    expect(r1.body.item.status).toBe('REQUESTED');
    const r1b = await call(t, accountant, 'POST', `/v1/payments/${payment.id}/refunds`, body, h);
    expect(r1b.body.item.id).toBe(r1.body.item.id);
    // pending refunds count against the refundable balance
    const over = await call(t, accountant, 'POST', `/v1/payments/${payment.id}/refunds`, { amountMinor: 50_001, reason: 'too much' }, idem());
    expect(over.status).toBe(422);
    expect(over.body.code).toBe('REFUND_EXCEEDS_REFUNDABLE');
    await t.drain();
    const p = await call(t, buyer, 'GET', `/v1/payments/${payment.id}`);
    expect(p.body.item.status).toBe('PARTIALLY_REFUNDED');
    expect(p.body.item.refundedMinor).toBe(30_000);
    expect(p.body.item.refunds[0].status).toBe('PARTIAL');
    expect(p.body.item.refundableMinor).toBe(50_000);
    const rev = await t.pool.query(
      `SELECT a.code, e.debit_minor, e.credit_minor FROM ledger_transactions x JOIN ledger_entries e ON e.transaction_id = x.id JOIN ledger_accounts a ON a.id = e.account_id
        WHERE x.source_type = 'REFUND' AND x.source_id = $1`,
      [r1.body.item.id],
    );
    const by = Object.fromEntries(rev.rows.map((r) => [r.code, r.debit_minor || r.credit_minor]));
    expect(by['PLATFORM:PG_CLEARING:KRW']).toBe(30_000);
    expect(by[`PAYEE:${supplierOwner.id}:PAYABLE:KRW`]).toBe(27_000);
    expect(by['PLATFORM:FEE_REVENUE:KRW']).toBe(3_000);
    const tb = await ledgerBalanced();
    expect(tb.balanced).toBe(true);
    for (const c of tb.currencies) expect(c.differenceMinor).toBe(0);
    // refund the rest → REFUNDED; nothing remains
    await call(t, accountant, 'POST', `/v1/payments/${payment.id}/refunds`, { amountMinor: 50_000, reason: 'rest' }, idem());
    await t.drain();
    const done = await call(t, buyer, 'GET', `/v1/payments/${payment.id}`);
    expect(done.body.item.status).toBe('REFUNDED');
    expect((await call(t, accountant, 'POST', `/v1/payments/${payment.id}/refunds`, { amountMinor: 1, reason: 'more' }, idem())).status).toBe(422);
    const bal = await t.pool.query(`SELECT balance_minor FROM ledger_balances WHERE code = 'PLATFORM:FEE_REVENUE:KRW'`);
    expect(bal.rows[0].balance_minor).toBeGreaterThanOrEqual(0);
    const receipts = await call(t, buyer, 'GET', '/v1/receipts');
    expect(receipts.body.items.filter((r: any) => r.paymentId === payment.id && r.receiptType === 'REFUND')).toHaveLength(2);
  });

  it('provider cancel failure → FAILED, retried by the job, completes exactly once', async () => {
    const { payment } = await paidOrder(20_000);
    await call(t, accountant, 'POST', `/v1/payments/${payment.id}/refunds`, { amountMinor: 5_000, reason: 'MOCK_FAIL once' }, idem());
    await t.drain();
    const f = await t.pool.query(`SELECT id, status, attempts FROM refunds WHERE payment_id = $1`, [payment.id]);
    expect(f.rows[0].status).toBe('FAILED');
    // fix the reason so the mock accepts it, make it due, retry
    await t.pool.query(`UPDATE refunds SET reason = 'retry ok', next_attempt_at = now() - interval '1 second' WHERE id = $1`, [f.rows[0].id]);
    await retryRefunds(t.app.ctx, t.ctx());
    await retryRefunds(t.app.ctx, t.ctx());
    const ok = await t.pool.query(`SELECT status FROM refunds WHERE id = $1`, [f.rows[0].id]);
    expect(ok.rows[0].status).toBe('PARTIAL');
    const pay = await t.pool.query(`SELECT refunded_minor FROM payments WHERE id = $1`, [payment.id]);
    expect(pay.rows[0].refunded_minor).toBe(5_000);
    const cancels = mock.payments.get(payment.paymentKey)!.cancels;
    expect(cancels.reduce((a, c) => a + c.cancelAmount, 0)).toBe(5_000);
  });

  it('consumes refund.requested intents emitted by other modules (no refundId)', async () => {
    const { order, payment } = await paidOrder(30_000);
    const ctx = t.ctx();
    await emit(t.pool, ctx, { aggregateType: 'order', aggregateId: order.id, eventType: 'refund.requested', payload: { subjectType: 'ORDER', subjectId: order.id, amountMinor: 12_000, reason: 'domain cancel' } });
    await t.drain();
    const pay = await t.pool.query(`SELECT status, refunded_minor FROM payments WHERE id = $1`, [payment.id]);
    expect(pay.rows[0]).toEqual({ status: 'PARTIALLY_REFUNDED', refunded_minor: 12_000 });
    const refunds = await t.pool.query(`SELECT count(*)::int AS n FROM refunds WHERE payment_id = $1`, [payment.id]);
    expect(refunds.rows[0].n).toBe(1);
  });

  it('admin payments list and reconciliation report (payments vs ledger vs provider)', async () => {
    await paidOrder(15_000);
    expect((await call(t, buyer, 'GET', '/v1/admin/payments')).status).toBe(403);
    const list = await call(t, accountant, 'GET', '/v1/admin/payments?status=APPROVED');
    expect(list.status).toBe(200);
    expect(list.body.items.length).toBeGreaterThan(0);
    const rep = await call(t, accountant, 'GET', '/v1/admin/payments/reconciliation?checkProvider=true');
    expect(rep.status).toBe(200);
    expect(rep.body.checked).toBeGreaterThan(0);
    expect(rep.body.discrepancies).toBe(0);
  });
});

describe('PAY-01 TossProvider (stubbed fetch)', () => {
  it('sends Basic auth, Idempotency-Key and the confirm body; maps statuses and errors', async () => {
    const seen: Array<{ url: string; init: any }> = [];
    const fetchStub = (async (url: string, init: any) => {
      seen.push({ url, init });
      if (url.endsWith('/v1/payments/confirm')) {
        return new Response(
          JSON.stringify({ paymentKey: 'pk_1', orderId: 'JPorder123', status: 'DONE', totalAmount: 15000, balanceAmount: 15000, currency: 'KRW', method: '카드', receipt: { url: 'https://r' }, approvedAt: '2026-01-01T00:00:00+09:00' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.endsWith('/cancel')) {
        return new Response(JSON.stringify({ code: 'NOT_CANCELABLE_AMOUNT', message: 'nope' }), { status: 400 });
      }
      return new Response(JSON.stringify({ code: 'FAILED_INTERNAL_SYSTEM_PROCESSING', message: 'x' }), { status: 500 });
    }) as unknown as typeof fetch;
    const toss = new TossProvider({ secretKey: 'test_sk_abc', apiBase: 'https://api.tosspayments.test/', fetchImpl: fetchStub });
    const res = await toss.confirm({ paymentKey: 'pk_1', orderId: 'JPorder123', amount: 15000, idempotencyKey: 'idem-1' });
    expect(seen[0].url).toBe('https://api.tosspayments.test/v1/payments/confirm');
    expect(seen[0].init.method).toBe('POST');
    expect(seen[0].init.headers.Authorization).toBe(`Basic ${Buffer.from('test_sk_abc:').toString('base64')}`);
    expect(seen[0].init.headers['Idempotency-Key']).toBe('idem-1');
    expect(JSON.parse(seen[0].init.body)).toEqual({ paymentKey: 'pk_1', orderId: 'JPorder123', amount: 15000 });
    expect(res).toMatchObject({ status: 'DONE', totalAmount: 15000, receiptUrl: 'https://r', method: '카드' });

    const cancelErr = await toss.cancel({ paymentKey: 'pk_1', cancelAmount: 1, cancelReason: 'r', idempotencyKey: 'c-1' }).catch((e) => e);
    expect(cancelErr).toBeInstanceOf(ProviderError);
    expect(cancelErr.code).toBe('NOT_CANCELABLE_AMOUNT');
    expect(cancelErr.retryable).toBe(false);
    expect(seen[1].url).toBe('https://api.tosspayments.test/v1/payments/pk_1/cancel');
    expect(JSON.parse(seen[1].init.body)).toEqual({ cancelReason: 'r', cancelAmount: 1 });
    expect(seen[1].init.headers['Idempotency-Key']).toBe('c-1');

    const getErr = await toss.get('pk_1').catch((e) => e);
    expect(getErr.retryable).toBe(true);
    expect(seen[2].init.method).toBe('GET');
    expect(seen[2].url).toBe('https://api.tosspayments.test/v1/payments/pk_1');

    const net = new TossProvider({ secretKey: 'k', apiBase: 'https://x', fetchImpl: (async () => { throw new TypeError('fetch failed'); }) as any });
    const e = await net.get('pk').catch((x) => x);
    expect(e.code).toBe('NETWORK_ERROR');
    expect(e.retryable).toBe(true);
  });
});
