import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, getActor } from '../../platform/auth.js';
import { ctxFromRequest, type Ctx } from '../../platform/context.js';
import { withTx, maybeOne, type Tx } from '../../platform/db.js';
import { notFound } from '../../platform/errors.js';
import { idempotencyKeyFrom, withIdempotency } from '../../platform/idempotency.js';
import { registerPaymentSubject } from '../../platform/payment-subjects.js';
import { registerJob } from '../../platform/jobs.js';
import { addHostBlock, hostCalendar, publicCalendar, removeHostBlock, setAvailability } from './availability.js';
import { createQuote, quoteDto, type QuoteRow } from './pricing.js';
import {
  autoCompleteStays, checkIn, completeStay, createHold, expireHolds, getReservation, listGuestReservations, listHostReservations, markNoShow,
  releaseHold, reservationDto, reservationPaymentSubject,
} from './reservations.js';
import { cancelReservation, cancellationPreview } from './cancellation.js';
import { RESERVATION_TRANSITIONS, type ReservationStatus } from './fsm.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const idParams = z.object({ id: z.uuid() });
const rangeQuery = z.object({ from: date, to: date });
const STATUSES = Object.keys(RESERVATION_TRANSITIONS) as [ReservationStatus, ...ReservationStatus[]];

/** STAY-06..10 Availability, Pricing/Quote, Hold, Reservation FSM, Cancellation — routes, event handlers and adapters are registered here. */
export default async function bookingModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = () => app.ctx.pool;

  registerPaymentSubject('RESERVATION', reservationPaymentSubject);
  registerJob('booking.hold-expiry', 30_000, expireHolds);
  registerJob('booking.auto-complete', 15 * 60_000, autoCompleteStays);

  // ------------------------------------------------------------ STAY-06 availability & calendar
  r.put('/v1/properties/:id/availability', {
    schema: {
      tags: ['STAY-06'],
      params: idParams,
      body: z.object({
        ranges: z.array(z.object({
          start: date,
          end: date,
          status: z.enum(['AVAILABLE', 'UNAVAILABLE']).optional(),
          priceMinor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
          minNights: z.number().int().min(1).max(365).nullable().optional(),
          note: z.string().max(500).nullable().optional(),
        })).min(1).max(100),
      }),
    },
    preHandler: requireAuth,
  }, async (req) => {
    const ctx = ctxFromRequest(req);
    const res = await withTx(pool(), (tx) => setAvailability(tx, ctx, req.params.id, req.body.ranges));
    return { item: { propertyId: req.params.id, daysUpdated: res.days } };
  });

  r.post('/v1/properties/:id/blocks', {
    schema: { tags: ['STAY-06'], params: idParams, body: z.object({ start: date, end: date, note: z.string().max(500).optional() }) },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const b = await withTx(pool(), (tx) => addHostBlock(tx, ctx, req.params.id, req.body));
    return reply.status(201).send({ item: { id: b.id, propertyId: b.property_id, type: b.block_type, start: req.body.start, end: req.body.end, state: b.state } });
  });

  r.delete('/v1/properties/:id/blocks/:blockId', {
    schema: { tags: ['STAY-06'], params: z.object({ id: z.uuid(), blockId: z.uuid() }) },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    await withTx(pool(), (tx) => removeHostBlock(tx, ctx, req.params.id, req.params.blockId));
    return reply.status(204).send();
  });

  r.get('/v1/properties/:id/calendar', {
    schema: { tags: ['STAY-06'], params: idParams, querystring: rangeQuery },
  }, async (req) => ({ item: await publicCalendar(pool(), req.actor ?? null, req.params.id, req.query.from, req.query.to) }));

  r.get('/v1/host/calendar', {
    schema: { tags: ['STAY-06'], querystring: rangeQuery.extend({ propertyId: z.uuid() }) },
    preHandler: requireAuth,
  }, async (req) => ({ item: await hostCalendar(pool(), getActor(req), req.query.propertyId, req.query.from, req.query.to) }));

  // ------------------------------------------------------------ STAY-07 quote
  r.post('/v1/booking/quotes', {
    schema: {
      tags: ['STAY-07'],
      body: z.object({ propertyId: z.uuid(), checkIn: date, checkOut: date, guests: z.number().int().min(1).max(50) }),
    },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const actor = getActor(req);
    const q = await withTx(pool(), (tx) => createQuote(tx, ctx, { ...req.body, guestId: actor.userId }));
    return reply.status(201).send({ item: quoteDto(q) });
  });

  r.get('/v1/booking/quotes/:id', {
    schema: { tags: ['STAY-07'], params: idParams },
    preHandler: requireAuth,
  }, async (req) => {
    const actor = getActor(req);
    const q = await maybeOne<QuoteRow>(
      pool(),
      `SELECT id, property_id, guest_id, check_in::text, check_out::text, guests, subtotal_minor, cleaning_fee_minor, platform_fee_minor,
              tax_minor, discount_minor, total_minor, currency, breakdown, rules_version, expires_at, created_at
         FROM booking_quotes WHERE id = $1 AND guest_id = $2`,
      [req.params.id, actor.userId],
    );
    if (!q) throw notFound('Quote');
    return { item: quoteDto(q) };
  });

  // ------------------------------------------------------------ STAY-08 hold
  r.post('/v1/booking/holds', {
    schema: { tags: ['STAY-08'], body: z.object({ quoteId: z.uuid() }) },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const actor = getActor(req);
    const key = idempotencyKeyFrom(req);
    const res = await withIdempotency(pool(), `booking.hold:${actor.userId}`, key, req.body, async (tx) => ({
      status: 201,
      body: { item: await createHold(tx, ctx, req.body.quoteId) },
    }));
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.status(res.status).send(res.body);
  });

  r.delete('/v1/booking/holds/:id', {
    schema: { tags: ['STAY-08'], params: idParams },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    await withTx(pool(), (tx) => releaseHold(tx, ctx, req.params.id));
    return reply.status(204).send();
  });

  // ------------------------------------------------------------ STAY-09 reservations
  r.get('/v1/reservations', {
    schema: { tags: ['STAY-09'], querystring: z.object({ status: z.enum(STATUSES).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) },
    preHandler: requireAuth,
  }, async (req) => ({ items: await listGuestReservations(pool(), getActor(req), req.query), nextCursor: null }));

  r.get('/v1/host/reservations', {
    schema: {
      tags: ['STAY-09'],
      querystring: z.object({
        filter: z.enum(['upcoming', 'current', 'completed', 'cancelled']).optional(),
        propertyId: z.uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      }),
    },
    preHandler: requireAuth,
  }, async (req) => ({ items: await listHostReservations(pool(), getActor(req), req.query), nextCursor: null }));

  r.get('/v1/reservations/:id', {
    schema: { tags: ['STAY-09'], params: idParams },
    preHandler: requireAuth,
  }, async (req) => ({ item: await getReservation(pool(), getActor(req), req.params.id) }));

  const lifecycle = (path: string, tag: string, fn: (tx: Tx, ctx: Ctx, id: string, reason?: string) => Promise<any>) =>
    r.post(path, {
      schema: { tags: [tag], params: idParams, body: z.object({ reason: z.string().min(1).max(500).optional() }).optional() },
      preHandler: requireAuth,
    }, async (req) => {
      const ctx = ctxFromRequest(req);
      const row = await withTx(pool(), (tx) => fn(tx, ctx, req.params.id, req.body?.reason));
      return { item: reservationDto(row) };
    });
  lifecycle('/v1/reservations/:id/check-in', 'STAY-10', (tx, ctx, id) => checkIn(tx, ctx, id));
  lifecycle('/v1/reservations/:id/complete', 'STAY-09', (tx, ctx, id, reason) => completeStay(tx, ctx, id, reason ?? 'stay completed'));
  lifecycle('/v1/reservations/:id/no-show', 'STAY-10', (tx, ctx, id, reason) => markNoShow(tx, ctx, id, reason));

  // ------------------------------------------------------------ STAY-10 cancellation
  r.get('/v1/reservations/:id/cancellation-preview', {
    schema: { tags: ['STAY-10'], params: idParams },
    preHandler: requireAuth,
  }, async (req) => ({ item: await cancellationPreview(pool(), getActor(req), req.params.id) }));

  r.post('/v1/reservations/:id/cancel', {
    schema: { tags: ['STAY-10'], params: idParams, body: z.object({ reason: z.string().min(1).max(500) }) },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    const actor = getActor(req);
    const key = idempotencyKeyFrom(req);
    const res = await withIdempotency(pool(), `booking.cancel:${actor.userId}`, key, { id: req.params.id, ...req.body }, async (tx) => {
      const out = await cancelReservation(tx, ctx, req.params.id, req.body.reason);
      return { status: 200, body: { item: reservationDto(out.reservation, { cancellation: out.evaluation }) } };
    });
    if (res.replayed) reply.header('idempotent-replayed', 'true');
    return reply.status(res.status).send(res.body);
  });
}
