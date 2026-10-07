import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAuth } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { idParams } from '../../platform/http.js';
import { notFound } from '../../platform/errors.js';
import { SUPPORTED_CURRENCIES } from '../../platform/money.js';
import * as svc from './service.js';

const TAG = ['CORE-02'];
const tag = z.string().trim().min(1).max(40);

/** CORE-02 Profile, Locale & Preferences. */
export default async function profileModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  r.get('/v1/me/profile', { schema: { tags: TAG }, preHandler: requireAuth }, async (req) => ({ item: await svc.getProfile(pool, getActor(req).userId) }));

  r.patch('/v1/me/profile', {
    schema: {
      tags: TAG,
      summary: 'Update my profile (audited; PII values are never written to the audit log)',
      body: z
        .object({
          displayName: z.string().trim().min(1).max(80),
          phone: z.string().regex(/^\+?[0-9]{8,15}$/).nullable(),
          locale: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/),
          legalName: z.string().trim().min(1).max(120).nullable(),
          preferredName: z.string().trim().min(1).max(80).nullable(),
          bio: z.string().max(2000).nullable(),
          avatarMediaId: z.uuid().nullable(),
          birthYear: z.number().int().nullable(),
          country: z.string().regex(/^[A-Z]{2}$/).nullable(),
          timezone: z.string().min(1).max(64),
          languages: z.array(z.string().regex(/^[a-z]{2,3}$/)).max(20),
          accessibility: z.record(z.string(), z.union([z.boolean(), z.string().max(200)])),
        })
        .partial()
        .strict(),
    },
    preHandler: requireAuth,
  }, async (req) => ({ item: await svc.updateProfile(pool, ctxFromRequest(req), req.body) }));

  r.get('/v1/me/preferences', { schema: { tags: TAG }, preHandler: requireAuth }, async (req) => ({ item: await svc.getPreferences(pool, getActor(req).userId) }));

  r.patch('/v1/me/preferences', {
    schema: {
      tags: TAG,
      body: z
        .object({
          currency: z.enum(SUPPORTED_CURRENCIES),
          travelStyles: z.array(tag).max(20),
          interests: z.array(tag).max(50),
          personalizationOptOut: z.boolean(),
          marketingOptIn: z.boolean(),
          extra: z.record(z.string(), z.unknown()),
        })
        .partial()
        .strict(),
    },
    preHandler: requireAuth,
  }, async (req) => ({ item: await svc.updatePreferences(pool, ctxFromRequest(req), req.body) }));

  r.get('/v1/users/:id/profile', { schema: { tags: TAG, summary: 'Public profile (no contact data)', params: idParams } }, async (req) => {
    const item = await svc.getPublicProfile(pool, req.params.id);
    if (!item) throw notFound('User');
    return { item };
  });
}
