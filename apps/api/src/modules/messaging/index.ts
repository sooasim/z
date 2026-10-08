import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import pg from 'pg';
import { z } from 'zod';
import { getActor, requireAuth, requireRole, resolveActor } from '../../platform/auth.js';
import { ctxFromRequest, type AppContext } from '../../platform/context.js';
import { decodeJwt } from 'jose';
import { withTx } from '../../platform/db.js';
import { AppError, unauthorized } from '../../platform/errors.js';
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
const HEARTBEAT_MS = 25_000;
export const MAX_STREAMS_PER_USER = 5;
const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30), cursor: z.string().max(200).optional() });

export interface MessageBridgeOptions {
  /** first reconnect delay (doubles per failed attempt) */
  retryMs?: number;
  /** reconnect delay cap */
  maxRetryMs?: number;
}

/**
 * Postgres LISTEN/NOTIFY bridge for multi-instance realtime: every instance LISTENs on `jetpool_messages`
 * and fans committed messages out to its locally connected SSE subscribers. Returns a stop function.
 *
 * The `messaging.bridge` adapter flag is set ONLY while LISTEN is live: while the connection is down (DB restart,
 * failover) publishAfterCommit falls back to in-process delivery, and the bridge keeps reconnecting with backoff
 * until it is stopped (a single failed reconnect used to end realtime delivery for the whole instance).
 */
export async function startMessageBridge(app: AppContext, opts: MessageBridgeOptions = {}): Promise<() => Promise<void>> {
  const baseDelay = opts.retryMs ?? 1000;
  const maxDelay = opts.maxRetryMs ?? 30_000;
  let client: pg.Client | null = null;
  let stopped = false;
  let retry: NodeJS.Timeout | null = null;
  let attempt = 0;

  const scheduleReconnect = () => {
    if (stopped || retry) return;
    const delay = Math.min(maxDelay, baseDelay * 2 ** Math.min(attempt, 16));
    attempt++;
    retry = setTimeout(() => {
      retry = null;
      connect().catch((err) => {
        app.log.warn({ err: err?.message ?? err, attempt }, 'realtime LISTEN reconnect failed');
        scheduleReconnect();
      });
    }, delay);
  };

  const connect = async () => {
    const c = new pg.Client({ connectionString: app.config.DATABASE_URL, application_name: 'jetpool-realtime' });
    let lost = false;
    const onLost = (err?: unknown) => {
      if (lost) return; // 'error' and 'end' both fire for one loss: reconnect once
      lost = true;
      if (client === c) {
        client = null;
        app.adapters.delete('messaging.bridge');
        app.log.warn({ err }, 'realtime LISTEN connection lost; delivering in-process until reconnected');
      }
      c.end().catch(() => {});
      scheduleReconnect();
    };
    c.on('notification', (n) => {
      if (n.channel !== NOTIFY_CHANNEL || !n.payload) return;
      try {
        const { messageId } = JSON.parse(n.payload);
        deliverRealtime(app, messageId).catch((err) => app.log.warn({ err }, 'realtime delivery failed'));
      } catch {
        /* ignore malformed payloads */
      }
    });
    c.on('error', (err) => onLost(err));
    c.on('end', () => onLost());
    try {
      await c.connect();
      await c.query(`LISTEN ${NOTIFY_CHANNEL}`);
    } catch (err) {
      lost = true; // the caller schedules the next attempt
      c.end().catch(() => {});
      throw err;
    }
    if (stopped) {
      lost = true;
      await c.end().catch(() => {});
      return;
    }
    client = c;
    attempt = 0;
    app.adapters.set('messaging.bridge', true);
  };

  try {
    await connect();
  } catch (err) {
    app.log.warn({ err }, 'realtime bridge unavailable; delivering in-process and retrying');
    scheduleReconnect();
  }
  return async () => {
    stopped = true;
    if (retry) clearTimeout(retry);
    retry = null;
    app.adapters.delete('messaging.bridge');
    const c = client;
    client = null;
    await c?.end().catch(() => {});
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
  /** open SSE streams per user on this instance */
  const streams = new Map<string, number>();

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
  // The stream lives no longer than its credentials: it is re-validated (resolveActor: token expiry, session
  // revocation, account suspension/deletion) before every pushed event and on every heartbeat, and it is closed
  // when the access token expires — clients reconnect with a fresh token (CORE-03: revocation is immediate).
  r.get(
    '/v1/realtime/stream',
    { schema: { tags: TAG, querystring: z.object({ token: z.string().max(4000).optional() }) } },
    async (req, reply) => {
      let actor = req.actor;
      let bearer = actor ? req.headers.authorization : undefined;
      if (!actor && req.query.token) {
        bearer = `Bearer ${req.query.token}`;
        actor = await resolveActor(app.ctx.config, pool, bearer);
      }
      if (!actor || !bearer) throw unauthorized();
      const { userId, sessionId } = actor;
      let expMs = Number.POSITIVE_INFINITY;
      try {
        const exp = decodeJwt(bearer.slice(7)).exp;
        if (typeof exp === 'number') expMs = exp * 1000;
      } catch {
        /* verified by resolveActor already */
      }
      const open = streams.get(userId) ?? 0;
      if (open >= MAX_STREAMS_PER_USER) throw new AppError(429, 'TOO_MANY_STREAMS', `At most ${MAX_STREAMS_PER_USER} realtime streams per user`);
      streams.set(userId, open + 1);

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

      let closed = false;
      let chain: Promise<void> = Promise.resolve();
      const stillValid = () =>
        Date.now() < expMs
          ? resolveActor(app.ctx.config, pool, bearer).then(
              (a) => !!a && a.userId === userId && a.sessionId === sessionId,
              () => false,
            )
          : Promise.resolve(false);
      // events are written strictly in order, each only after the session was re-checked
      const guarded = (write: () => void) => {
        chain = chain
          .then(async () => {
            if (closed) return;
            if (!(await stillValid())) return end(Date.now() >= expMs ? 'expired' : 'revoked');
            if (!closed) write();
          })
          .catch((err) => app.log.warn({ err }, 'realtime stream write failed'));
      };
      const unsubscribe = app.ctx.realtime.subscribe(`user:${userId}`, (evt) => {
        guarded(() => raw.write(`event: ${evt.type ?? 'message'}\nid: ${evt.message?.id ?? ''}\ndata: ${JSON.stringify(evt)}\n\n`));
      });
      const recheckMs = Number(app.ctx.adapters.get('messaging.sseRecheckMs') ?? HEARTBEAT_MS);
      const heartbeat = setInterval(() => guarded(() => raw.write(`: ping\n\n`)), recheckMs);
      const expiry = setTimeout(() => end('expired'), Math.max(0, Math.min(2 ** 31 - 1, expMs - Date.now())));
      function end(reason?: 'revoked' | 'expired') {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(expiry);
        unsubscribe();
        const n = (streams.get(userId) ?? 1) - 1;
        if (n > 0) streams.set(userId, n);
        else streams.delete(userId);
        if (reason && !raw.writableEnded && !raw.destroyed) raw.write(`event: ${reason}\ndata: ${JSON.stringify({ reason })}\n\n`);
        if (!raw.writableEnded) raw.end();
      }
      req.raw.on('close', () => end());
      raw.on('close', () => end());
    },
  );
}
