import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { withTx } from '../../platform/db.js';
import { approveConfig, listConfig, listDeadLetters, listFlags, overview, proposeConfig, publicConfig, retryDeadLetter, updateFlag } from './service.js';

const OPS = ['OPS-02'];
const PLAT = ['PLAT-06'];
const reason = z.string().min(5).max(500);

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
          rules: z.object({ allow_user_ids: z.array(z.uuid()).max(1000).optional(), allow_roles: z.array(z.string().max(20)).max(20).optional() }).strict().optional(),
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
}
