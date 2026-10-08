import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAuth } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { withTx } from '../../platform/db.js';
import { assertEnabled } from '../../platform/flags.js';
import { AppError } from '../../platform/errors.js';
import { runTravelAssistant } from './service.js';
import { getRecommendations } from './recommendations.js';

export const MAX_CONCURRENT_ASSISTANT_PER_USER = 3;

/** AI-01 Travel assistant + AI-02 Recommendations. */
export default async function aiModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;
  const inFlight = new Map<string, number>();

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
      // bounded per-user concurrency: each request waits on up to two LLM calls (this instance)
      const running = inFlight.get(actor.userId) ?? 0;
      if (running >= MAX_CONCURRENT_ASSISTANT_PER_USER) throw new AppError(429, 'ASSISTANT_BUSY', 'Please wait for your previous assistant requests to finish');
      inFlight.set(actor.userId, running + 1);
      try {
        // not wrapped in withTx: runTravelAssistant opens its own short transaction after the LLM calls
        return await runTravelAssistant(pool, ctx, { userId: actor.userId, message: req.body.message, sessionId: req.body.sessionId });
      } finally {
        const n = (inFlight.get(actor.userId) ?? 1) - 1;
        if (n > 0) inFlight.set(actor.userId, n);
        else inFlight.delete(actor.userId);
      }
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
