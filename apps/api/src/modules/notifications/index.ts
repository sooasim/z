import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAuth } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { withTx } from '../../platform/db.js';
import { onEvent } from '../../platform/outbox.js';
import { registerJob } from '../../platform/jobs.js';
import { CHANNELS, getRegistry } from './providers.js';
import {
  CATEGORIES,
  deliverPending,
  effectivePreferences,
  fanOutNotification,
  listNotifications,
  markAllRead,
  markNotificationRead,
  notifyMessageRecipients,
  updatePreferences,
} from './service.js';

const TAG = ['COMMS-02'];

/** COMMS-02 Notification orchestration. */
export default async function notificationsModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;
  getRegistry(app.ctx); // register default adapters (Novu when NOVU_API_KEY is set, else log provider)

  onEvent('notification.created', 'notifications.fanout', async (tx, ev, ctx) => {
    await fanOutNotification(tx, ctx, ctx.app, ev.payload.notificationId);
  });
  onEvent('message.created', 'notifications.message_received', async (tx, ev, ctx) => {
    await notifyMessageRecipients(tx, ctx, ev.payload);
  });
  registerJob('notifications.deliver', 10_000, (a) => deliverPending(a));

  r.get(
    '/v1/notifications',
    {
      schema: {
        tags: TAG,
        querystring: z.object({
          unread: z.enum(['true', 'false']).optional().transform((v) => v === 'true'),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          cursor: z.string().max(200).optional(),
        }),
      },
      preHandler: requireAuth,
    },
    async (req) => listNotifications(pool, getActor(req).userId, req.query),
  );

  r.post(
    '/v1/notifications/:id/read',
    { schema: { tags: TAG, params: z.object({ id: z.uuid() }) }, preHandler: requireAuth },
    async (req) => ({ item: await markNotificationRead(pool, getActor(req).userId, req.params.id) }),
  );

  r.post('/v1/notifications/read-all', { schema: { tags: TAG }, preHandler: requireAuth }, async (req) => markAllRead(pool, getActor(req).userId));

  r.get('/v1/notification-preferences', { schema: { tags: TAG }, preHandler: requireAuth }, async (req) => ({
    items: await effectivePreferences(pool, getActor(req).userId),
  }));

  r.patch(
    '/v1/notification-preferences',
    {
      schema: {
        tags: TAG,
        body: z.object({
          preferences: z.array(z.object({ category: z.enum(CATEGORIES), channel: z.enum(CHANNELS), enabled: z.boolean() })).min(1).max(50),
        }),
      },
      preHandler: requireAuth,
    },
    async (req) => {
      const actor = getActor(req);
      const ctx = ctxFromRequest(req);
      return { items: await withTx(pool, (tx) => updatePreferences(tx, ctx, actor.userId, req.body.preferences)) };
    },
  );
}
