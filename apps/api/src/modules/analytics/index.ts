import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { analyticsBatchSchema, auditQuerySchema, funnel, ingestEvents, kpis, parseRange, readAuditLogs } from './service.js';

const TAG = ['OPS-04'];
const rangeQuery = z.object({ from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional() });

/** OPS-04 Analytics & Audit. */
export default async function analyticsModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  // Anonymous or authenticated; PII is stripped server-side before persistence.
  r.post('/v1/analytics/events', { schema: { tags: TAG, body: analyticsBatchSchema } }, async (req, reply) => {
    const res = await ingestEvents(pool, { userId: req.actor?.userId ?? null, batch: req.body });
    return reply.status(202).send(res);
  });

  r.get('/v1/admin/analytics/funnel', { schema: { tags: TAG, querystring: rangeQuery }, preHandler: requireRole('ADMIN', 'ACCOUNTING') }, async (req) =>
    funnel(pool, parseRange(req.query.from, req.query.to)),
  );

  r.get('/v1/admin/analytics/kpis', { schema: { tags: TAG, querystring: rangeQuery }, preHandler: requireRole('ADMIN', 'ACCOUNTING') }, async (req) =>
    kpis(pool, parseRange(req.query.from, req.query.to)),
  );

  r.get('/v1/admin/audit-logs', { schema: { tags: TAG, querystring: auditQuerySchema }, preHandler: requireRole('ADMIN', 'ACCOUNTING') }, async (req) =>
    readAuditLogs(pool, ctxFromRequest(req), req.query),
  );
}
