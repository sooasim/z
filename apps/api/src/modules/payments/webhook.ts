/**
 * PAY-01 Toss webhook intake (invariant 4).
 * Authenticity: (1) optional HMAC-SHA256 header check when TOSS_WEBHOOK_SECRET is configured, and
 * (2) — authoritative — the payment is re-fetched from the provider API with our secret key; the
 * webhook body itself is never trusted for state. Replays are deduped in webhook_events.
 */
import { createHmac } from 'node:crypto';
import type { Ctx } from '../../platform/context.js';
import { maybeOne, withTx } from '../../platform/db.js';
import { AppError, badRequest } from '../../platform/errors.js';
import { safeEqual, sha256 } from '../../platform/crypto.js';
import { ProviderError, type ProviderPayment } from './provider.js';
import { providerOf, reconcileFromProvider, type PaymentRow } from './service.js';

export function verifyWebhookSignature(secret: string, rawBody: string, headers: Record<string, string | string[] | undefined>): boolean {
  const h = (k: string) => {
    const v = headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  const sig = h('tosspayments-webhook-signature');
  const time = h('tosspayments-webhook-transmission-time');
  if (sig && time) {
    // Toss style: v1:<base64(HMAC_SHA256(secret, `${payload}:${transmissionTime}`))>[,<more>]
    const expected = createHmac('sha256', secret).update(`${rawBody}:${time}`).digest('base64');
    return sig
      .replace(/^v1:/, '')
      .split(',')
      .map((s) => s.trim().replace(/^v1:/, ''))
      .some((s) => s.length > 0 && safeEqual(s, expected));
  }
  const simple = h('x-toss-signature');
  if (simple) {
    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    return safeEqual(simple.replace(/^sha256=/, '').trim().toLowerCase(), expected);
  }
  return false;
}

/** Strip per-payment secrets before persisting the payload. */
function redact(body: any): any {
  if (!body || typeof body !== 'object') return body;
  const clone = JSON.parse(JSON.stringify(body));
  if ('secret' in clone) clone.secret = '[REDACTED]';
  if (clone.data && typeof clone.data === 'object' && 'secret' in clone.data) clone.data.secret = '[REDACTED]';
  return clone;
}

export interface WebhookOutcome { status: number; body: Record<string, unknown> }

export async function handleTossWebhook(ctx: Ctx, rawBody: string, body: any, headers: Record<string, string | string[] | undefined>): Promise<WebhookOutcome> {
  const app = ctx.app;
  const secret = app.config.TOSS_WEBHOOK_SECRET;
  if (secret && !verifyWebhookSignature(secret, rawBody, headers)) {
    throw new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
  }
  if (!body || typeof body !== 'object') throw badRequest('INVALID_WEBHOOK', 'Malformed webhook body');
  const data = body.data && typeof body.data === 'object' ? body.data : body;
  const eventType: string = String(body.eventType ?? (body.secret ? 'DEPOSIT_CALLBACK' : 'UNKNOWN')).slice(0, 100);
  const orderId: string | undefined = typeof data.orderId === 'string' ? data.orderId : undefined;
  const paymentKeyHint: string | undefined = typeof data.paymentKey === 'string' ? data.paymentKey : undefined;
  const payloadHash = sha256(rawBody);
  const externalId = String(body.eventId ?? body.id ?? payloadHash).slice(0, 200);

  const inserted = await withTx(app.pool, async (tx) => {
    const ins = await tx.query(
      `INSERT INTO webhook_events(provider, external_event_id, event_type, payload_hash, payload, signature_valid)
       VALUES ('TOSS',$1,$2,$3,$4,$5) ON CONFLICT (provider, external_event_id) DO NOTHING RETURNING id`,
      [externalId, eventType, payloadHash, JSON.stringify(redact(body)), !!secret],
    );
    if (ins.rows[0]) return { id: ins.rows[0].id as string, processed: false };
    const prev = await maybeOne<{ id: string; processed_at: Date | null }>(
      tx,
      `SELECT id, processed_at FROM webhook_events WHERE provider = 'TOSS' AND external_event_id = $1`,
      [externalId],
    );
    return { id: prev!.id, processed: !!prev!.processed_at };
  });
  if (inserted.processed) return { status: 200, body: { received: true, duplicate: true } };

  const markProcessed = (error: string | null, valid: boolean) =>
    app.pool.query(`UPDATE webhook_events SET processed_at = now(), process_error = $2, signature_valid = $3 WHERE id = $1 AND processed_at IS NULL`, [
      inserted.id,
      error,
      valid,
    ]);

  const payment = orderId
    ? await maybeOne<PaymentRow>(app.pool, `SELECT * FROM payments WHERE provider_order_id = $1`, [orderId])
    : paymentKeyHint
      ? await maybeOne<PaymentRow>(app.pool, `SELECT * FROM payments WHERE payment_key = $1`, [paymentKeyHint])
      : null;
  if (!payment) {
    await markProcessed('UNKNOWN_ORDER', false);
    return { status: 200, body: { received: true, ignored: 'UNKNOWN_ORDER' } };
  }
  const paymentKey = payment.payment_key ?? paymentKeyHint;
  if (!paymentKey) {
    await markProcessed('NO_PAYMENT_KEY', false);
    return { status: 200, body: { received: true, ignored: 'NO_PAYMENT_KEY' } };
  }

  // authoritative check: re-fetch from the provider with our secret key
  let pp: ProviderPayment;
  try {
    pp = await providerOf(app).get(paymentKey);
  } catch (err) {
    if (err instanceof ProviderError && !err.retryable) {
      await markProcessed(`UNVERIFIED:${err.code}`, false);
      throw new AppError(400, 'WEBHOOK_UNVERIFIED', 'Webhook could not be verified with the provider');
    }
    // transient: let the provider retry (do not mark processed)
    throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'Provider verification temporarily unavailable');
  }
  if (pp.orderId !== payment.provider_order_id || (payment.payment_key && pp.paymentKey !== payment.payment_key)) {
    await markProcessed('PROVIDER_MISMATCH', false);
    throw new AppError(400, 'WEBHOOK_UNVERIFIED', 'Webhook does not match the provider record');
  }

  const result = await withTx(app.pool, async (tx) => {
    const ev = await maybeOne<{ processed_at: Date | null }>(tx, `SELECT processed_at FROM webhook_events WHERE id = $1 FOR UPDATE`, [inserted.id]);
    if (ev?.processed_at) return { duplicate: true, action: 'NOOP' };
    const locked = await maybeOne<PaymentRow>(tx, `SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [payment.id]);
    const action = await reconcileFromProvider(tx, ctx, locked!, pp, `WEBHOOK:${eventType}`);
    await tx.query(`UPDATE webhook_events SET processed_at = now(), process_error = NULL, signature_valid = true WHERE id = $1`, [inserted.id]);
    return { duplicate: false, action };
  });
  return { status: 200, body: { received: true, ...result } };
}
