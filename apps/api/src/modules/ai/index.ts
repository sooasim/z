import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAuth } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { withTx } from '../../platform/db.js';
import { assertEnabled } from '../../platform/flags.js';
import { runTravelAssistant } from './service.js';
import { getRecommendations } from './recommendations.js';

/** AI-01 Travel assistant + AI-02 Recommendations. */
export default async function aiModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  r.post(
    '/v1/ai/travel-assistant',
    {
      schema: { tags: ['AI-01'], body: z.object({ message: z.string().trim().min(1).max(2000), sessionId: z.uuid().optional() }) },
      preHandler: requireAuth,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req) => {
      const actor = getActor(req);
      await assertEnabled(pool, 'ai.assistant', { userId: actor.userId, roles: actor.roles });
      const ctx = ctxFromRequest(req);
      return withTx(pool, (tx) => runTravelAssistant(tx, ctx, { userId: actor.userId, message: req.body.message, sessionId: req.body.sessionId }));
    },
  );

  r.get(
    '/v1/recommendations',
    {
      schema: {
        tags: ['AI-02'],
        querystring: z.object({ surface: z.enum(['home', 'stay', 'exchange', 'guide', 'travel']).default('home'), limit: z.coerce.number().int().min(1).max(50).default(12) }),
      },
    },
    async (req) => {
      const ctx = ctxFromRequest(req);
      return withTx(pool, (tx) => getRecommendations(tx, ctx, { userId: req.actor?.userId ?? null, surface: req.query.surface, limit: req.query.limit }));
    },
  );
}
