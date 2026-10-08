import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, requireAuth } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { withTx } from '../../platform/db.js';
import { assertEnabled, isEnabled } from '../../platform/flags.js';
import { registerJob } from '../../platform/jobs.js';
import { badRequest, notFound } from '../../platform/errors.js';
import { isoDate } from '../../platform/http.js';
import {
  PROVIDERS,
  createAccount,
  exportIcs,
  getOwnedAccount,
  handleInboundWebhook,
  issueExportToken,
  listAccounts,
  listIntegrationEvents,
  syncDueAccounts,
  syncIcalAccount,
  updateAccount,
} from './service.js';

const TAG = ['INT-01'];
const FLAG = 'integrations.pms';
// real calendar days only: 2026-02-30 is a 400, not a 22008 from the `::date` cast in acquireBlock
const isoDay = isoDate;

/** INT-01 PMS / supplier integrations (iCal import/export, generic HMAC webhook). */
export default async function integrationsModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;
  const flagged = async (req: FastifyRequest) => {
    const actor = getActor(req);
    await assertEnabled(pool, FLAG, { userId: actor.userId, roles: actor.roles });
  };

  registerJob('integrations.ical_sync', 15 * 60_000, async (a) => {
    if (!(await isEnabled(a.pool, FLAG))) return [];
    return syncDueAccounts(a);
  });

  r.get('/v1/integrations/accounts', { schema: { tags: TAG }, preHandler: [requireAuth, flagged] }, async (req) => ({ items: await listAccounts(pool, getActor(req).userId) }));

  r.post(
    '/v1/integrations/accounts',
    { schema: { tags: TAG, body: z.object({ provider: z.enum(PROVIDERS), propertyId: z.uuid(), icalUrl: z.string().max(2000).optional() }) }, preHandler: [requireAuth, flagged] },
    async (req, reply) => {
      const ctx = ctxFromRequest(req);
      const res = await withTx(pool, (tx) => createAccount(tx, ctx, getActor(req).userId, req.body));
      // webhookSecret is shown exactly once
      return reply.status(201).send({ item: res.account, webhookSecret: res.webhookSecret });
    },
  );

  r.patch(
    '/v1/integrations/accounts/:id',
    { schema: { tags: TAG, params: z.object({ id: z.uuid() }), body: z.object({ status: z.enum(['ACTIVE', 'PAUSED']).optional(), icalUrl: z.string().max(2000).optional() }) }, preHandler: [requireAuth, flagged] },
    async (req) => {
      const ctx = ctxFromRequest(req);
      return { item: await withTx(pool, (tx) => updateAccount(tx, ctx, getActor(req).userId, req.params.id, req.body)) };
    },
  );

  r.post('/v1/integrations/accounts/:id/sync', { schema: { tags: TAG, params: z.object({ id: z.uuid() }) }, preHandler: [requireAuth, flagged] }, async (req) => {
    await getOwnedAccount(pool, req.params.id, getActor(req).userId);
    return syncIcalAccount(app.ctx, req.params.id, ctxFromRequest(req));
  });

  r.get(
    '/v1/integrations/accounts/:id/events',
    { schema: { tags: TAG, params: z.object({ id: z.uuid() }), querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }) }, preHandler: [requireAuth, flagged] },
    async (req) => {
      await getOwnedAccount(pool, req.params.id, getActor(req).userId);
      return { items: await listIntegrationEvents(pool, req.params.id, req.query.limit) };
    },
  );

  r.post(
    '/v1/integrations/properties/:propertyId/ical-export-token',
    { schema: { tags: TAG, params: z.object({ propertyId: z.uuid() }) }, preHandler: [requireAuth, flagged] },
    async (req, reply) => {
      const ctx = ctxFromRequest(req);
      return reply.status(201).send({ item: await withTx(pool, (tx) => issueExportToken(tx, ctx, getActor(req).userId, req.params.propertyId)) });
    },
  );

  // Public, token-authenticated busy-dates feed (no guest PII).
  r.get(
    '/v1/integrations/ical/:file',
    { schema: { tags: TAG, params: z.object({ file: z.string().max(60) }), querystring: z.object({ token: z.string().min(20).max(200) }) } },
    async (req, reply) => {
      const m = /^([0-9a-f-]{36})\.ics$/i.exec(req.params.file);
      if (!m) throw notFound('Calendar');
      if (!(await isEnabled(pool, FLAG))) throw notFound('Calendar');
      const ics = await exportIcs(pool, m[1], req.query.token);
      return reply.type('text/calendar; charset=utf-8').header('cache-control', 'private, max-age=300').send(ics);
    },
  );

  // Generic inbound webhook — HMAC over the raw body; needs its own JSON parser to keep the exact bytes.
  await app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 256 * 1024 }, (req, body, done) => {
      (req as any).rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(badRequest('INVALID_JSON', 'Malformed JSON body'), undefined);
      }
    });
    sub.withTypeProvider<ZodTypeProvider>().post(
      '/v1/integrations/webhooks/:accountId',
      {
        schema: {
          tags: TAG,
          params: z.object({ accountId: z.uuid() }),
          body: z.object({ eventId: z.string().min(1).max(200), type: z.enum(['BLOCK_UPSERT', 'BLOCK_DELETE']), externalId: z.string().min(1).max(255), start: isoDay.optional(), end: isoDay.optional() }),
        },
      },
      async (req) => {
        if (!(await isEnabled(pool, FLAG))) throw notFound('Integration account');
        return handleInboundWebhook(app.ctx, ctxFromRequest(req), req.params.accountId, (req as any).rawBody ?? '', req.headers['x-jetpool-signature'] as string | undefined, req.body);
      },
    );
  });
}
