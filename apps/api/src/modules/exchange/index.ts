import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requireAuth, getActor } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { withTx } from '../../platform/db.js';
import { idParams } from '../../platform/http.js';
import { idempotencyKeyFrom, withIdempotency } from '../../platform/idempotency.js';
import { assertEnabled } from '../../platform/flags.js';
import { onEvent } from '../../platform/outbox.js';
import { registerJob } from '../../platform/jobs.js';
import * as s from './schemas.js';
import {
  EXCHANGE_FLAG,
  acceptExchange,
  acknowledgeSafety,
  advanceLifecycle,
  cancelExchange,
  completeExchange,
  confirmExchange,
  counterExchange,
  createExchange,
  declineExchange,
  discoverHomes,
  disputeExchange,
  evaluateEligibility,
  expireStaleRequests,
  getAgreement,
  getExchange,
  listMyExchanges,
  markExchangeReviewed,
  runVerification,
  signAgreement,
  upsertProfile,
  withdrawExchange,
} from './service.js';

/**
 * EXCH-01..06 Home Exchange — independent FSM 'EXCHANGE' (never a reservation).
 * Feature flag `exchange.enabled` gates entering/advancing the funnel (discover, request, counter, accept,
 * verify, sign, confirm). Exits (decline, withdraw, cancel, dispute, complete) and reads stay available
 * so a flag rollback never strands users mid-exchange.
 */
export default async function exchangeModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  // ---- EXCH-01 eligibility / profile / discovery
  r.get('/v1/exchange/eligibility', { schema: { tags: ['EXCH-01'] }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req);
    return { item: await evaluateEligibility(pool, actor.userId) };
  });

  r.put('/v1/exchange/profile', { schema: { tags: ['EXCH-01'], body: s.profileBody }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    return { item: await withTx(pool, (tx) => upsertProfile(tx, ctx, req.body)) };
  });

  r.get('/v1/exchange/homes', { schema: { tags: ['EXCH-01'], querystring: s.homesQuery }, preHandler: requireAuth }, async (req) => {
    const actor = getActor(req);
    await assertEnabled(pool, EXCHANGE_FLAG, { userId: actor.userId, roles: actor.roles });
    return discoverHomes(pool, ctxFromRequest(req), req.query);
  });

  // ---- EXCH-02 request & counter
  r.post('/v1/exchanges', { schema: { tags: ['EXCH-02'], body: s.createBody }, preHandler: requireAuth }, async (req, reply) => {
    const actor = getActor(req);
    const ctx = ctxFromRequest(req);
    const res = await withIdempotency(pool, `exchange.create:${actor.userId}`, idempotencyKeyFrom(req, false), req.body, async (tx) => ({
      status: 201,
      body: await createExchange(tx, ctx, req.body),
    }));
    return reply.status(res.status).send(res.body);
  });

  r.get('/v1/exchanges', { schema: { tags: ['EXCH-02'], querystring: s.listQuery }, preHandler: requireAuth }, async (req) =>
    listMyExchanges(pool, ctxFromRequest(req), req.query),
  );

  r.get('/v1/exchanges/:id', { schema: { tags: ['EXCH-02'], params: idParams }, preHandler: requireAuth }, async (req) =>
    getExchange(pool, ctxFromRequest(req), req.params.id),
  );

  r.post('/v1/exchanges/:id/counter', { schema: { tags: ['EXCH-02'], params: idParams, body: s.counterBody }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    return withTx(pool, (tx) => counterExchange(tx, ctx, req.params.id, req.body));
  });

  r.post('/v1/exchanges/:id/accept', { schema: { tags: ['EXCH-02'], params: idParams, body: s.acceptBody }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    return withTx(pool, (tx) => acceptExchange(tx, ctx, req.params.id, req.body));
  });

  r.post('/v1/exchanges/:id/decline', { schema: { tags: ['EXCH-02'], params: idParams, body: s.reasonBody.optional() }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    return withTx(pool, (tx) => declineExchange(tx, ctx, req.params.id, { reason: req.body?.reason ?? null }));
  });

  r.post('/v1/exchanges/:id/withdraw', { schema: { tags: ['EXCH-02'], params: idParams, body: s.reasonBody.optional() }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    return withTx(pool, (tx) => withdrawExchange(tx, ctx, req.params.id, { reason: req.body?.reason ?? null }));
  });

  // ---- EXCH-03 verification gate
  r.post('/v1/exchanges/:id/verify', { schema: { tags: ['EXCH-03'], params: idParams }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    return withTx(pool, (tx) => runVerification(tx, ctx, req.params.id));
  });

  r.post('/v1/exchanges/:id/safety-ack', { schema: { tags: ['EXCH-03'], params: idParams, body: s.safetyAckBody }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    const actor = getActor(req);
    await assertEnabled(pool, EXCHANGE_FLAG, { userId: actor.userId, roles: actor.roles });
    return withTx(pool, (tx) => acknowledgeSafety(tx, ctx, req.params.id));
  });

  // ---- EXCH-04 agreement & e-consent
  r.get('/v1/exchanges/:id/agreement', { schema: { tags: ['EXCH-04'], params: idParams }, preHandler: requireAuth }, async (req) =>
    getAgreement(pool, ctxFromRequest(req), req.params.id),
  );

  r.post('/v1/exchanges/:id/agreement/sign', { schema: { tags: ['EXCH-04'], params: idParams, body: s.signBody }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    return withTx(pool, (tx) => signAgreement(tx, ctx, req.params.id, req.body));
  });

  // ---- EXCH-05 calendar lock (Idempotency-Key REQUIRED)
  r.post('/v1/exchanges/:id/confirm', { schema: { tags: ['EXCH-05'], params: idParams }, preHandler: requireAuth }, async (req, reply) => {
    const actor = getActor(req);
    const ctx = ctxFromRequest(req);
    const key = idempotencyKeyFrom(req, true);
    await assertEnabled(pool, EXCHANGE_FLAG, { userId: actor.userId, roles: actor.roles });
    const res = await withIdempotency(pool, `exchange.confirm:${actor.userId}`, key, { exchangeId: req.params.id }, async (tx) => ({
      status: 200,
      body: await confirmExchange(tx, ctx, req.params.id),
    }));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.status(res.status).send(res.body);
  });

  r.post('/v1/exchanges/:id/cancel', { schema: { tags: ['EXCH-05'], params: idParams, body: s.cancelBody }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    return withTx(pool, (tx) => cancelExchange(tx, ctx, req.params.id, req.body));
  });

  // ---- EXCH-06 completion / dispute / review
  r.post('/v1/exchanges/:id/complete', { schema: { tags: ['EXCH-06'], params: idParams }, preHandler: requireAuth }, async (req) => {
    const ctx = ctxFromRequest(req);
    return withTx(pool, (tx) => completeExchange(tx, ctx, req.params.id));
  });

  r.post('/v1/exchanges/:id/dispute', { schema: { tags: ['EXCH-06'], params: idParams, body: s.disputeBody }, preHandler: requireAuth }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const body = await withTx(pool, (tx) => disputeExchange(tx, ctx, req.params.id, req.body));
    return reply.status(201).send(body);
  });

  onEvent('exchange.reviews.completed', 'exchange.mark-reviewed', async (tx, ev, ctx) => {
    const exchangeId = (ev.payload as { exchangeId?: string })?.exchangeId;
    if (exchangeId) await markExchangeReviewed(tx, ctx, exchangeId);
  });

  registerJob('exchange.expire-requests', 5 * 60_000, (a) => expireStaleRequests(a));
  registerJob('exchange.lifecycle', 5 * 60_000, (a) => advanceLifecycle(a));
}
