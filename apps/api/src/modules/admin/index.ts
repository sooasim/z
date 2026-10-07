import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { STAFF_ROLES, getActor, requireRole } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { withTx } from '../../platform/db.js';
import { idParams, isoDate, pagination } from '../../platform/http.js';
import { approveConfig, flagRulesSchema, listConfig, listDeadLetters, listFlags, overview, proposeConfig, publicConfig, retryDeadLetter, updateFlag } from './service.js';
import { SAVED_VIEW_TYPES, createSavedView, deleteSavedView, getSavedView, listSavedViews, savedViewCreate, savedViewPatch, updateSavedView } from './saved-views.js';
import { adminListExchanges, adminListGuideBookings, adminListListings, adminListReservations } from './console.js';

const OPS = ['OPS-02'];
const PLAT = ['PLAT-06'];
const reason = z.string().min(5).max(500);
const boolQuery = z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true'));
/** YYYY-MM-DD that is a real calendar day (2026-02-30 is rejected before it reaches SQL). */
const calendarDay = isoDate.refine((v) => {
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}, 'invalid calendar date');
/** Shared console list query: comma-separated statuses, any-party user filter, inclusive business-day range. */
const consoleQuery = pagination.extend({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z.string().regex(/^[A-Za-z_]+(,[A-Za-z_]+)*$/, 'comma-separated statuses').max(400).optional(),
  userId: z.uuid().optional(),
  from: calendarDay.optional(),
  to: calendarDay.optional(),
});
const staffAny = requireRole(...STAFF_ROLES);

/** OPS-02 Admin / Backoffice + PLAT-06 Feature Flags & Config. Staff roles are AAL2-gated by requireRole. */
export default async function adminModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  r.get('/v1/admin/overview', { schema: { tags: OPS }, preHandler: requireRole('ADMIN', 'SUPPORT', 'ACCOUNTING') }, async () => overview(pool));

  r.get('/v1/admin/feature-flags', { schema: { tags: PLAT }, preHandler: requireRole('ADMIN') }, async () => ({ items: await listFlags(pool) }));

  r.patch(
    '/v1/admin/feature-flags',
    {
      schema: {
        tags: PLAT,
        body: z.object({
          flagKey: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/),
          enabled: z.boolean().optional(),
          rules: flagRulesSchema.optional(),
          description: z.string().max(500).optional(),
          create: z.boolean().optional(),
          reason,
        }),
      },
      preHandler: requireRole('ADMIN'),
    },
    async (req) => {
      const ctx = ctxFromRequest(req);
      return { item: await withTx(pool, (tx) => updateFlag(tx, ctx, req.body)) };
    },
  );

  r.get('/v1/admin/config', { schema: { tags: PLAT, querystring: z.object({ key: z.string().max(100).optional() }) }, preHandler: requireRole('ADMIN', 'ACCOUNTING') }, async (req) => ({
    items: await listConfig(pool, req.query.key),
  }));

  r.post(
    '/v1/admin/config',
    {
      schema: {
        tags: PLAT,
        body: z.object({
          key: z.string().max(100),
          value: z.json(),
          effectiveFrom: z.iso.datetime({ offset: true }).optional(),
          effectiveUntil: z.iso.datetime({ offset: true }).optional(),
          note: z.string().max(1000).optional(),
        }),
      },
      preHandler: requireRole('ADMIN', 'ACCOUNTING'),
    },
    async (req, reply) => {
      const ctx = ctxFromRequest(req);
      return reply.status(201).send({ item: await withTx(pool, (tx) => proposeConfig(tx, ctx, req.body)) });
    },
  );

  r.post(
    '/v1/admin/config/approve',
    { schema: { tags: PLAT, body: z.object({ key: z.string().max(100), effectiveFrom: z.iso.datetime({ offset: true }), reason }) }, preHandler: requireRole('ADMIN') },
    async (req) => {
      const ctx = ctxFromRequest(req);
      return { item: await withTx(pool, (tx) => approveConfig(tx, ctx, req.body)) };
    },
  );

  r.get('/v1/config/public', { schema: { tags: PLAT } }, async (req) =>
    publicConfig(pool, req.actor ? { userId: req.actor.userId, roles: req.actor.roles } : undefined),
  );

  r.get(
    '/v1/admin/outbox/dead-letters',
    { schema: { tags: OPS, querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) }, preHandler: requireRole('ADMIN') },
    async (req) => ({ items: await listDeadLetters(pool, req.query.limit) }),
  );

  r.post(
    '/v1/admin/outbox/dead-letters/:id/retry',
    { schema: { tags: OPS, params: z.object({ id: z.uuid() }), body: z.object({ reason }) }, preHandler: requireRole('ADMIN') },
    async (req) => {
      const ctx = ctxFromRequest(req);
      return { item: await withTx(pool, (tx) => retryDeadLetter(tx, ctx, req.params.id, req.body.reason)) };
    },
  );

  // ---- OPS-02 saved console views (any staff role, AAL2) ---------------------------------------------------------
  r.get(
    '/v1/admin/saved-views',
    { schema: { tags: OPS, querystring: z.object({ viewType: z.enum(SAVED_VIEW_TYPES).optional(), mine: boolQuery }) }, preHandler: staffAny },
    async (req) => ({ items: await listSavedViews(pool, getActor(req).userId, req.query) }),
  );

  r.post('/v1/admin/saved-views', { schema: { tags: OPS, body: savedViewCreate }, preHandler: staffAny }, async (req, reply) => {
    const ctx = ctxFromRequest(req);
    return reply.status(201).send({ item: await withTx(pool, (tx) => createSavedView(tx, ctx, req.body)) });
  });

  r.get('/v1/admin/saved-views/:id', { schema: { tags: OPS, params: idParams }, preHandler: staffAny }, async (req) => ({
    item: await getSavedView(pool, getActor(req).userId, req.params.id),
  }));

  r.patch('/v1/admin/saved-views/:id', { schema: { tags: OPS, params: idParams, body: savedViewPatch }, preHandler: staffAny }, async (req) => {
    const ctx = ctxFromRequest(req);
    return { item: await withTx(pool, (tx) => updateSavedView(tx, ctx, req.params.id, req.body)) };
  });

  r.delete('/v1/admin/saved-views/:id', { schema: { tags: OPS, params: idParams }, preHandler: staffAny }, async (req) => {
    const ctx = ctxFromRequest(req);
    return { item: await withTx(pool, (tx) => deleteSavedView(tx, ctx, req.params.id)) };
  });

  // ---- OPS-02 read-only console lists (other domains' state changes stay in their own modules) ------------------
  r.get(
    '/v1/admin/reservations',
    {
      schema: {
        tags: [...OPS, 'STAY-09'],
        summary: 'Console list of paid-stay reservations (read-only)',
        querystring: consoleQuery.extend({ dateField: z.enum(['CREATED', 'CHECK_IN', 'CHECK_OUT']).optional(), propertyId: z.uuid().optional(), code: z.string().max(20).optional() }),
      },
      preHandler: requireRole('ADMIN', 'SUPPORT', 'ACCOUNTING'),
    },
    async (req) => adminListReservations(pool, req.query),
  );

  r.get(
    '/v1/admin/exchanges',
    {
      schema: {
        tags: [...OPS, 'EXCH-06'],
        summary: 'Console list of home exchanges (read-only)',
        querystring: consoleQuery.extend({ dateField: z.enum(['CREATED', 'START']).optional(), propertyId: z.uuid().optional() }),
      },
      preHandler: requireRole('ADMIN', 'SUPPORT'),
    },
    async (req) => adminListExchanges(pool, req.query),
  );

  r.get(
    '/v1/admin/guide-bookings',
    {
      schema: {
        tags: [...OPS, 'GUIDE-05'],
        summary: 'Console list of guide bookings (read-only)',
        querystring: consoleQuery.extend({ dateField: z.enum(['CREATED', 'START']).optional(), paid: boolQuery }),
      },
      preHandler: requireRole('ADMIN', 'SUPPORT', 'ACCOUNTING'),
    },
    async (req) => adminListGuideBookings(pool, req.query),
  );

  r.get(
    '/v1/admin/listings',
    {
      schema: {
        tags: [...OPS, 'STAY-01'],
        summary: 'Console list of stay listings (read-only; exact location omitted)',
        querystring: consoleQuery.extend({
          dateField: z.enum(['CREATED', 'UPDATED', 'PUBLISHED']).optional(),
          city: z.string().max(100).optional(),
          q: z.string().trim().min(1).max(200).optional(),
          rentalEnabled: boolQuery,
          exchangeEnabled: boolQuery,
        }),
      },
      preHandler: requireRole('ADMIN', 'SUPPORT', 'COMPLIANCE'),
    },
    async (req) => adminListListings(pool, req.query),
  );
}
