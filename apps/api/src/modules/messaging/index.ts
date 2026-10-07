import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import pg from 'pg';
import { z } from 'zod';
import { getActor, requireAuth, requireRole, resolveActor } from '../../platform/auth.js';
import { ctxFromRequest, type AppContext } from '../../platform/context.js';
import { withTx } from '../../platform/db.js';
import { unauthorized } from '../../platform/errors.js';
import {
  MAX_BODY_LENGTH,
  NOTIFY_CHANNEL,
  createInquiry,
  deliverRealtime,
  listMessagesAsMember,
  listMyConversations,
  markRead,
  readAsStaff,
  reportMessage,
  sendMessage,
  toMessageDto,
} from './service.js';

const TAG = ['COMMS-01'];
const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(200).optional() });

/**
 * Postgres LISTEN/NOTIFY bridge for multi-instance realtime: every instance LISTENs on `jetpool_messages`
 * and fans committed messages out to its locally connected SSE subscribers. Returns a stop function.
 */
export async function startMessageBridge(app: AppContext): Promise<() => Promise<void>> {
  let client: pg.Client | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;
  const connect = async () => {
    const c = new pg.Client({ connectionString: app.config.DATABASE_URL, application_name: 'jetpool-realtime' });
    c.on('notification', (n) => {
      if (n.channel !== NOTIFY_CHANNEL || !n.payload) return;
      try {
        const { messageId } = JSON.parse(n.payload);
        deliverRealtime(app, messageId).catch((err) => app.log.warn({ err }, 'realtime delivery failed'));
      } catch {
        /* ignore malformed payloads */
      }
    });
    c.on('error', (err) => {
      app.log.warn({ err }, 'realtime LISTEN connection lost');
      c.end().catch(() => {});
      if (!stopped) retry = setTimeout(() => connect().catch(() => {}), 2000);
    });
    await c.connect();
    await c.query(`LISTEN ${NOTIFY_CHANNEL}`);
    client = c;
  };
  await connect();
  app.adapters.set('messaging.bridge', true);
  return async () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    app.adapters.delete('messaging.bridge');
    await client?.end().catch(() => {});
  };
}

/** After COMMIT: publish locally only when no LISTEN bridge runs (otherwise the bridge delivers, avoiding duplicates). */
function publishAfterCommit(app: AppContext, messageId: string) {
  if (app.adapters.has('messaging.bridge')) return;
  deliverRealtime(app, messageId).catch((err) => app.log.warn({ err }, 'realtime delivery failed'));
}

/** COMMS-01 P2P Messaging. */
export default async function messagingModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;

  if (app.ctx.config.NODE_ENV !== 'test') {
    let stop: (() => Promise<void>) | null = null;
    app.addHook('onReady', async () => {
      try {
        stop = await startMessageBridge(app.ctx);
      } catch (err) {
        app.log.warn({ err }, 'realtime bridge unavailable; falling back to in-process delivery');
      }
    });
    app.addHook('onClose', async () => {
      await stop?.();
    });
  }

  r.get('/v1/conversations', { schema: { tags: TAG, querystring: pageQuery }, preHandler: requireAuth }, async (req) => {
    return listMyConversations(pool, getActor(req).userId, req.query);
  });

  r.post(
    '/v1/conversations',
    {
      schema: {
        tags: TAG,
        body: z.object({
          contextType: z.literal('INQUIRY').default('INQUIRY'),
          targetType: z.enum(['PROPERTY', 'GUIDE']),
          targetId: z.uuid(),
          message: z.string().max(MAX_BODY_LENGTH).optional(),
          clientMessageId: z.string().min(1).max(100).optional(),
        }),
      },
      preHandler: requireAuth,
    },
    async (req, reply) => {
      const actor = getActor(req);
      const ctx = ctxFromRequest(req);
      const res = await withTx(pool, (tx) =>
        createInquiry(tx, ctx, { requesterId: actor.userId, targetType: req.body.targetType, targetId: req.body.targetId, message: req.body.message, clientMessageId: req.body.clientMessageId }),
      );
      if (res.message) publishAfterCommit(app.ctx, res.message.id);
      return reply.status(201).send({ item: { id: res.conversationId }, message: res.message ? toMessageDto(res.message) : null });
    },
  );

  r.get(
    '/v1/conversations/:id/messages',
    { schema: { tags: TAG, params: z.object({ id: z.uuid() }), querystring: pageQuery }, preHandler: requireAuth },
    async (req) => listMessagesAsMember(pool, req.params.id, getActor(req).userId, req.query),
  );

  r.post(
    '/v1/conversations/:id/messages',
    {
      schema: {
        tags: TAG,
        params: z.object({ id: z.uuid() }),
        body: z.object({
          body: z.string().max(MAX_BODY_LENGTH, `at most ${MAX_BODY_LENGTH} characters`).default(''),
          clientMessageId: z.string().min(1).max(100).optional(),
          mediaId: z.uuid().optional(),
        }),
      },
      preHandler: requireAuth,
    },
    async (req, reply) => {
      const actor = getActor(req);
      const ctx = ctxFromRequest(req);
      const res = await withTx(pool, (tx) =>
        sendMessage(tx, ctx, { conversationId: req.params.id, senderId: actor.userId, body: req.body.body, clientMessageId: req.body.clientMessageId, mediaId: req.body.mediaId }),
      );
      if (res.created) publishAfterCommit(app.ctx, res.message.id);
      return reply.status(res.created ? 201 : 200).send({ item: toMessageDto(res.message), replayed: !res.created });
    },
  );

  r.post(
    '/v1/conversations/:id/read',
    { schema: { tags: TAG, params: z.object({ id: z.uuid() }) }, preHandler: requireAuth },
    async (req) => ({ item: await markRead(pool, req.params.id, getActor(req).userId) }),
  );

  r.post(
    '/v1/messages/:id/report',
    { schema: { tags: TAG, params: z.object({ id: z.uuid() }), body: z.object({ reason: z.string().min(3).max(1000) }) }, preHandler: requireAuth },
    async (req, reply) => {
      const actor = getActor(req);
      const ctx = ctxFromRequest(req);
      const res = await withTx(pool, (tx) => reportMessage(tx, ctx, { messageId: req.params.id, reporterId: actor.userId, reason: req.body.reason }));
      return reply.status(res.created ? 201 : 200).send({ item: res.report });
    },
  );

  // Staff read: invariant 10 — case-scoped, time-limited, audited elevation only.
  r.get(
    '/v1/admin/conversations/:id/messages',
    { schema: { tags: TAG, params: z.object({ id: z.uuid() }), querystring: pageQuery }, preHandler: requireRole('ADMIN', 'SUPPORT', 'COMPLIANCE') },
    async (req) => readAsStaff(pool, ctxFromRequest(req), req.params.id, req.query),
  );

  // SSE realtime stream: `Authorization: Bearer` or `?token=` (EventSource cannot set headers).
  r.get(
    '/v1/realtime/stream',
    { schema: { tags: TAG, querystring: z.object({ token: z.string().max(4000).optional() }) } },
    async (req, reply) => {
      let actor = req.actor;
      if (!actor && req.query.token) actor = await resolveActor(app.ctx.config, pool, `Bearer ${req.query.token}`);
      if (!actor) throw unauthorized();
      const userId = actor.userId;
      reply.hijack();
      const raw = reply.raw;
      raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'x-correlation-id': req.correlationId,
      });
      raw.write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ userId })}\n\n`);
      const unsubscribe = app.ctx.realtime.subscribe(`user:${userId}`, (evt) => {
        raw.write(`event: ${evt.type ?? 'message'}\nid: ${evt.message?.id ?? ''}\ndata: ${JSON.stringify(evt)}\n\n`);
      });
      const heartbeat = setInterval(() => raw.write(`: ping\n\n`), 25_000);
      const close = () => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      req.raw.on('close', close);
      raw.on('close', close);
    },
  );
}
