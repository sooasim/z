import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, hasRole, requireAuth, requireRole } from '../../platform/auth.js';
import { ctxFromRequest, systemCtx } from '../../platform/context.js';
import { maybeOne, q, withTx } from '../../platform/db.js';
import { forbidden, notFound } from '../../platform/errors.js';
import { idempotencyKeyFrom, withIdempotency } from '../../platform/idempotency.js';
import { onEvent } from '../../platform/outbox.js';
import { registerJob } from '../../platform/jobs.js';
import { audit } from '../../platform/audit.js';
import { decodeCursor, idParams, page, pagination } from '../../platform/http.js';
import { MockProvider, TossProvider } from './provider.js';
import {
  confirmPayment,
  executeRefund,
  expirePayments,
  paymentDto,
  preparePayment,
  providerOf,
  reconcileConfirming,
  reconcileFromProvider,
  reconciliationReport,
  refundDto,
  refundableRemaining,
  requestRefund,
  retryRefunds,
  type PaymentRow,
  type RefundRow,
} from './service.js';
import { handleTossWebhook } from './webhook.js';

const TAG_PAY = 'PAY-01';
const TAG_REFUND = 'PAY-02';
const subjectType = z.enum(['RESERVATION', 'GUIDE_BOOKING', 'ORDER']);
const STAFF_VIEW = ['ADMIN', 'ACCOUNTING', 'SUPPORT'] as const;

/** PAY-01/02 Payment & Refund Orchestrator — routes, event handlers and adapters are registered here. */
export default async function paymentsModule(app: FastifyInstance) {
  const cfg = app.ctx.config;
  if (!app.ctx.adapters.has('payments.provider')) {
    if (cfg.PAYMENT_PROVIDER === 'TOSS') {
      app.ctx.adapters.set('payments.provider', new TossProvider({ secretKey: cfg.TOSS_SECRET_KEY ?? '', apiBase: cfg.TOSS_API_BASE }));
    } else {
      if (cfg.NODE_ENV === 'production') throw new Error('MOCK payment provider is forbidden in production');
      app.ctx.adapters.set('payments.provider', new MockProvider());
    }
  }

  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/v1/payments/toss/prepare',
    {
      schema: {
        tags: [TAG_PAY],
        summary: 'Create a payment intent for a subject; the amount is computed server-side',
        body: z.object({ subjectType, subjectId: z.uuid() }),
      },
      preHandler: requireAuth,
    },
    async (req, reply) => {
      const actor = getActor(req);
      const ctx = ctxFromRequest(req);
      const key = idempotencyKeyFrom(req);
      const res = await withIdempotency(app.ctx.pool, `payments.prepare:${actor.userId}`, key, req.body, async (tx) => ({
        status: 201,
        body: await preparePayment(tx, ctx, req.body),
      }));
      return reply.status(res.status).header('idempotent-replayed', String(res.replayed)).send(res.body);
    },
  );

  r.post(
    '/v1/payments/toss/confirm',
    {
      schema: {
        tags: [TAG_PAY],
        summary: 'Server-side confirmation with the PG (the browser success redirect alone never confirms)',
        body: z.object({
          paymentKey: z.string().min(1).max(200).regex(/^[A-Za-z0-9_\-.]+$/),
          orderId: z.string().min(6).max(64).regex(/^[A-Za-z0-9_\-]+$/),
          amount: z.number().int().positive(),
        }),
      },
      preHandler: requireAuth,
    },
    async (req, reply) => {
      const ctx = ctxFromRequest(req);
      const key = idempotencyKeyFrom(req)!;
      const res = await confirmPayment(ctx, req.body, key);
      return reply.status(res.status).header('idempotent-replayed', String(res.replayed)).send(res.body);
    },
  );

  // ---- webhook (raw body needed for HMAC): encapsulated so the custom parser only applies here
  await app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 256 * 1024 }, (req, body, done) => {
      (req as any).rawBody = body as string;
      try {
        done(null, (body as string).length ? JSON.parse(body as string) : {});
      } catch {
        const err: any = new Error('Malformed JSON');
        err.statusCode = 400;
        done(err, undefined);
      }
    });
    sub.post('/v1/webhooks/toss', { schema: { tags: [TAG_PAY], summary: 'TossPayments status-change webhook (verified via provider re-fetch)' } }, async (req, reply) => {
      const ctx = ctxFromRequest(req);
      const raw = (req as any).rawBody ?? JSON.stringify(req.body ?? {});
      const out = await handleTossWebhook(ctx, raw, req.body, req.headers as any);
      return reply.status(out.status).send(out.body);
    });
  });

  r.get(
    '/v1/payments',
    { schema: { tags: [TAG_PAY], querystring: pagination.extend({ status: z.string().optional() }) }, preHandler: requireAuth },
    async (req) => {
      const actor = getActor(req);
      const c = decodeCursor(req.query.cursor);
      const rows = await q<PaymentRow>(
        app.ctx.pool,
        `SELECT * FROM payments WHERE payer_id = $1 AND ($2::text IS NULL OR status = $2)
           AND ($3::timestamptz IS NULL OR (created_at, id) < ($3::timestamptz, $4::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $5`,
        [actor.userId, req.query.status ?? null, c?.createdAt ?? null, c?.id ?? null, req.query.limit + 1],
      );
      const p = page(rows, req.query.limit);
      return { items: p.items.map(paymentDto), nextCursor: p.nextCursor };
    },
  );

  r.get('/v1/payments/:id', { schema: { tags: [TAG_PAY], params: idParams }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req);
    const p = await maybeOne<PaymentRow>(app.ctx.pool, `SELECT * FROM payments WHERE id = $1`, [req.params.id]);
    if (!p) throw notFound('Payment');
    const staff = hasRole(actor, ...STAFF_VIEW) && actor.aal === 'aal2';
    if (p.payer_id !== actor.userId && !staff) throw notFound('Payment');
    const refunds = await q<RefundRow>(app.ctx.pool, `SELECT * FROM refunds WHERE payment_id = $1 ORDER BY created_at`, [p.id]);
    return { item: { ...paymentDto(p), refunds: refunds.map(refundDto), refundableMinor: await refundableRemaining(app.ctx.pool, p) } };
  });

  r.get('/v1/payments/:id/refunds', { schema: { tags: [TAG_REFUND], params: idParams }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req);
    const p = await maybeOne<PaymentRow>(app.ctx.pool, `SELECT * FROM payments WHERE id = $1`, [req.params.id]);
    if (!p) throw notFound('Payment');
    if (p.payer_id !== actor.userId && !(hasRole(actor, ...STAFF_VIEW) && actor.aal === 'aal2')) throw notFound('Payment');
    const refunds = await q<RefundRow>(app.ctx.pool, `SELECT * FROM refunds WHERE payment_id = $1 ORDER BY created_at`, [p.id]);
    return { items: refunds.map(refundDto) };
  });

  r.post(
    '/v1/payments/:id/refunds',
    {
      schema: {
        tags: [TAG_REFUND],
        summary: 'Staff-initiated full/partial refund (ACCOUNTING/ADMIN, AAL2)',
        params: idParams,
        body: z.object({ amountMinor: z.number().int().positive(), reason: z.string().trim().min(3).max(500) }),
      },
      preHandler: requireRole('ACCOUNTING', 'ADMIN'),
    },
    async (req, reply) => {
      const actor = getActor(req);
      const ctx = ctxFromRequest(req);
      const key = idempotencyKeyFrom(req)!;
      const res = await withIdempotency(app.ctx.pool, `payments.refund:${req.params.id}`, key, req.body, async (tx) => {
        const p = await maybeOne<PaymentRow>(tx, `SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [req.params.id]);
        if (!p) throw notFound('Payment');
        const out = await requestRefund(tx, ctx, {
          subjectType: p.subject_type,
          subjectId: p.subject_id,
          amountMinor: req.body.amountMinor,
          reason: req.body.reason,
          idempotencyKey: `staff:${p.id}:${key}`,
          requestedBy: actor.userId,
        });
        if (!out.refundId) throw forbidden('NOT_REFUNDABLE', `Payment is not refundable (${out.status})`);
        await audit(tx, ctx, {
          action: 'payment.refund.staff_requested',
          resourceType: 'payment',
          resourceId: p.id,
          category: 'MONEY',
          reason: req.body.reason,
          after: { refundId: out.refundId, amountMinor: req.body.amountMinor },
        });
        const refund = await maybeOne<RefundRow>(tx, `SELECT * FROM refunds WHERE id = $1`, [out.refundId]);
        return { status: 201, body: { item: refundDto(refund!) } };
      });
      return reply.status(res.status).send(res.body);
    },
  );

  r.get(
    '/v1/admin/payments',
    {
      schema: { tags: [TAG_PAY], querystring: pagination.extend({ status: z.string().optional(), subjectType: subjectType.optional(), subjectId: z.uuid().optional() }) },
      preHandler: requireRole('ACCOUNTING', 'ADMIN', 'SUPPORT'),
    },
    async (req) => {
      const c = decodeCursor(req.query.cursor);
      const rows = await q<PaymentRow>(
        app.ctx.pool,
        `SELECT * FROM payments WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR subject_type = $2) AND ($3::uuid IS NULL OR subject_id = $3)
           AND ($4::timestamptz IS NULL OR (created_at, id) < ($4::timestamptz, $5::uuid))
         ORDER BY created_at DESC, id DESC LIMIT $6`,
        [req.query.status ?? null, req.query.subjectType ?? null, req.query.subjectId ?? null, c?.createdAt ?? null, c?.id ?? null, req.query.limit + 1],
      );
      const p = page(rows, req.query.limit);
      return { items: p.items.map(paymentDto), nextCursor: p.nextCursor };
    },
  );

  r.get(
    '/v1/admin/payments/reconciliation',
    {
      schema: {
        tags: [TAG_PAY],
        summary: 'Payments vs ledger vs provider status report',
        querystring: z.object({ checkProvider: z.enum(['true', 'false']).default('false'), limit: z.coerce.number().int().min(1).max(500).default(100) }),
      },
      preHandler: requireRole('ACCOUNTING', 'ADMIN'),
    },
    async (req) => reconciliationReport(app.ctx, { checkProvider: req.query.checkProvider === 'true', limit: req.query.limit }),
  );

  r.post(
    '/v1/admin/payments/:id/reconcile',
    { schema: { tags: [TAG_PAY], params: idParams }, preHandler: requireRole('ACCOUNTING', 'ADMIN') },
    async (req) => {
      const ctx = ctxFromRequest(req);
      const p0 = await maybeOne<PaymentRow>(app.ctx.pool, `SELECT * FROM payments WHERE id = $1`, [req.params.id]);
      if (!p0) throw notFound('Payment');
      if (!p0.payment_key) return { item: paymentDto(p0), action: 'NO_PAYMENT_KEY' };
      const pp = await providerOf(app.ctx).get(p0.payment_key);
      return withTx(app.ctx.pool, async (tx) => {
        const p = await maybeOne<PaymentRow>(tx, `SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [p0.id]);
        const action = await reconcileFromProvider(tx, ctx, p!, pp, 'ADMIN');
        await audit(tx, ctx, { action: 'payment.reconcile', resourceType: 'payment', resourceId: p0.id, category: 'MONEY', after: { action, providerStatus: pp.status } });
        const now = await maybeOne<PaymentRow>(tx, `SELECT * FROM payments WHERE id = $1`, [p0.id]);
        return { item: paymentDto(now!), action };
      });
    },
  );

  // ---- events: execute refunds; accept refund intents emitted by other modules
  onEvent('refund.requested', 'payments.refund-executor', async (tx, ev, ctx) => {
    const p = ev.payload ?? {};
    if (p.refundId) {
      // our own intent (emitted by requestRefund): run the provider cancel
      await executeRefund(tx, ctx, p.refundId);
      return;
    }
    // a domain emitted an intent instead of calling requestRefund: record it (idempotent per event)
    if (!p.subjectType || !p.subjectId || !Number.isInteger(p.amountMinor)) {
      ctx.app.log.warn({ eventId: ev.id }, 'refund.requested without subject/amount ignored');
      return;
    }
    await tx.query('SAVEPOINT ext_refund');
    try {
      await requestRefund(tx, ctx, {
        subjectType: p.subjectType,
        subjectId: p.subjectId,
        amountMinor: p.amountMinor,
        reason: String(p.reason ?? 'REFUND_REQUESTED').slice(0, 500),
        idempotencyKey: String(p.idempotencyKey ?? `event:${ev.id}`),
        requestedBy: p.requestedBy ?? null,
      });
      await tx.query('RELEASE SAVEPOINT ext_refund');
    } catch (err: any) {
      // business rejection (e.g. exceeds refundable): do not retry forever; record for operators
      await tx.query('ROLLBACK TO SAVEPOINT ext_refund');
      await audit(tx, ctx, {
        action: 'refund.request.rejected',
        resourceType: String(p.subjectType),
        resourceId: String(p.subjectId),
        category: 'MONEY',
        reason: String(err?.code ?? err?.message ?? 'ERROR').slice(0, 200),
        after: { eventId: ev.id, amountMinor: p.amountMinor },
      });
    }
  });

  registerJob('payments.expire', 60_000, (appCtx) => expirePayments(appCtx, systemCtx(appCtx, `job-payments-expire-${Date.now()}`)));
  registerJob('payments.reconcile-confirming', 60_000, (appCtx) => reconcileConfirming(appCtx, systemCtx(appCtx, `job-payments-reconcile-${Date.now()}`)));
  registerJob('payments.refund-retry', 60_000, (appCtx) => retryRefunds(appCtx, systemCtx(appCtx, `job-refund-retry-${Date.now()}`)));
}
