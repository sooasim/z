import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, hasRole, requireRole } from '../../platform/auth.js';
import { ctxFromRequest, type Ctx } from '../../platform/context.js';
import { withTx, type Tx } from '../../platform/db.js';
import { AppError, badRequest } from '../../platform/errors.js';
import { recordAdminAction } from '../admin/actions.js';
import { EXTERNAL_SYSTEMS, LEGACY_SYSTEMS, ingestPayloadWebhook, linkLegacyRef, listExternalRefs, payloadWebhookBody, verifyPayloadSignature } from './external.js';
import {
  ENTRY_TYPES,
  adminListEntries,
  approveRedirects,
  createEntry,
  deleteRedirect,
  getPublished,
  pagePublished,
  listRedirects,
  parseEntryType,
  resolveRedirect,
  seoSchema,
  sitemap,
  toEntryDto,
  toPublicEntryDto,
  transitionEntry,
  updateEntry,
  upsertRedirects,
} from './service.js';

const TAG = ['OPS-03'];
const slug = z.string().regex(/^[a-z0-9가-힣]+(?:-[a-z0-9가-힣]+)*$/, 'kebab-case slug').max(120);
const locale = z.string().regex(/^[a-z]{2}-[A-Z]{2}$/);
const entryBody = z.object({
  type: z.enum(ENTRY_TYPES),
  slug,
  locale: locale.optional(),
  title: z.string().min(1).max(300),
  summary: z.string().max(2000).nullish(),
  bodyMd: z.string().max(200_000).nullish(),
  heroMediaId: z.uuid().nullish(),
  seo: seoSchema.optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
const redirectItem = z.object({
  legacyPath: z.string().min(1).max(2000),
  targetPath: z.string().min(1).max(2000),
  statusCode: z.union([z.literal(301), z.literal(302), z.literal(307), z.literal(308)]).optional(),
  approved: z.boolean().optional(),
});
const editor = requireRole('EDITOR', 'ADMIN');

/** OPS-03 CMS, Content & SEO. */
export default async function cmsModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pool = app.ctx.pool;
  const webUrl = app.ctx.config.PUBLIC_WEB_URL;

  /** Admin CMS mutation + `admin.action.performed` (OPS-02 contract) in one transaction. */
  const adminTx = <T>(req: FastifyRequest, action: string, fn: (tx: Tx, ctx: Ctx) => Promise<T>, resource: (out: T) => { type: string; id?: string | null; details?: Record<string, unknown> }) => {
    const ctx = ctxFromRequest(req);
    return withTx(pool, async (tx) => {
      const out = await fn(tx, ctx);
      const res = resource(out);
      await recordAdminAction(tx, ctx, { action, resourceType: res.type, resourceId: res.id ?? null, details: res.details });
      return out;
    });
  };
  const entryRes = (row: any) => ({ type: 'cms_entry', id: row.id as string, details: { entryType: row.entry_type, slug: row.slug, locale: row.locale, status: row.status } });

  // ---- admin CMS
  r.get(
    '/v1/admin/cms/entries',
    {
      schema: {
        tags: TAG,
        querystring: z.object({ type: z.enum(ENTRY_TYPES).optional(), status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(), locale: locale.optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
      },
      preHandler: editor,
    },
    async (req) => ({ items: (await adminListEntries(pool, req.query)).map(toEntryDto) }),
  );

  r.post('/v1/admin/cms/entries', { schema: { tags: TAG, body: entryBody }, preHandler: editor }, async (req, reply) => {
    return reply.status(201).send({ item: toEntryDto(await adminTx(req, 'cms.entry.created', (tx, ctx) => createEntry(tx, ctx, req.body), entryRes)) });
  });

  r.patch(
    '/v1/admin/cms/entries/:id',
    { schema: { tags: TAG, params: z.object({ id: z.uuid() }), body: entryBody.omit({ type: true }).partial() }, preHandler: editor },
    async (req) => ({ item: toEntryDto(await adminTx(req, 'cms.entry.updated', (tx, ctx) => updateEntry(tx, ctx, req.params.id, req.body), entryRes)) }),
  );

  for (const [action, to] of [['publish', 'PUBLISHED'], ['unpublish', 'DRAFT'], ['archive', 'ARCHIVED'], ['restore', 'DRAFT']] as const) {
    r.post(
      `/v1/admin/cms/entries/:id/${action}`,
      { schema: { tags: TAG, params: z.object({ id: z.uuid() }), body: z.object({ reason: z.string().max(500).optional() }).nullish() }, preHandler: editor },
      async (req) => ({
        item: toEntryDto(await adminTx(req, `cms.entry.${action}`, (tx, ctx) => transitionEntry(tx, ctx, req.params.id, to, req.body?.reason), entryRes)),
      }),
    );
  }

  // ---- public content (published only, locale fallback ko-KR)
  r.get(
    '/v1/content/:type',
    {
      schema: {
        tags: TAG,
        params: z.object({ type: z.string().max(40) }),
        querystring: z.object({ locale: locale.default('ko-KR'), limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(200).optional() }),
      },
    },
    async (req) => {
      const res = await pagePublished(pool, parseEntryType(req.params.type), req.query.locale, req.query.limit, req.query.cursor);
      return { items: res.items.map((e) => toPublicEntryDto(e, webUrl)), nextCursor: res.nextCursor };
    },
  );
  r.get(
    '/v1/content/:type/:slug',
    { schema: { tags: TAG, params: z.object({ type: z.string().max(40), slug: z.string().max(120) }), querystring: z.object({ locale: locale.default('ko-KR') }) } },
    async (req) => ({ item: toPublicEntryDto(await getPublished(pool, parseEntryType(req.params.type), req.params.slug, req.query.locale), webUrl) }),
  );

  // ---- SEO redirects
  r.get('/v1/seo/redirects', { schema: { tags: TAG, querystring: z.object({ path: z.string().min(1).max(2000) }) } }, async (req) => ({
    item: await resolveRedirect(pool, req.query.path),
  }));

  r.get(
    '/v1/admin/seo/redirects',
    {
      schema: {
        tags: TAG,
        querystring: z.object({
          approved: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
          prefix: z.string().max(500).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
      preHandler: editor,
    },
    async (req) => ({ items: await listRedirects(pool, req.query) }),
  );

  const redirectsRes = (source: string) => (out: { inserted: number; updated: number; errors: unknown[] }) => ({
    type: 'seo_redirect',
    details: { source, inserted: out.inserted, updated: out.updated, errors: out.errors.length },
  });

  r.put('/v1/admin/seo/redirects', { schema: { tags: TAG, body: redirectItem }, preHandler: editor }, async (req) => {
    const canApprove = hasRole(getActor(req), 'ADMIN');
    return adminTx(req, 'seo.redirects.upserted', (tx, ctx) => upsertRedirects(tx, ctx, [req.body], { source: 'admin', canApprove }), redirectsRes('admin'));
  });

  r.post(
    '/v1/admin/seo/redirects/bulk',
    { schema: { tags: TAG, body: z.object({ items: z.array(redirectItem).min(1).max(5000), source: z.string().max(50).optional() }) }, preHandler: editor },
    async (req) => {
      const canApprove = hasRole(getActor(req), 'ADMIN');
      const source = req.body.source ?? 'bulk';
      return adminTx(req, 'seo.redirects.upserted', (tx, ctx) => upsertRedirects(tx, ctx, req.body.items, { source, canApprove }), redirectsRes(source));
    },
  );

  r.post(
    '/v1/admin/seo/redirects/approve',
    { schema: { tags: TAG, body: z.object({ paths: z.array(z.string().max(2000)).min(1).max(5000), approved: z.boolean().default(true) }) }, preHandler: requireRole('ADMIN') },
    async (req) =>
      adminTx(
        req,
        req.body.approved ? 'seo.redirects.approved' : 'seo.redirects.unapproved',
        (tx, ctx) => approveRedirects(tx, ctx, req.body.paths, req.body.approved),
        (out) => ({ type: 'seo_redirect', details: { updated: out.updated } }),
      ),
  );

  r.delete('/v1/admin/seo/redirects', { schema: { tags: TAG, querystring: z.object({ path: z.string().min(1).max(2000) }) }, preHandler: editor }, async (req) => ({
    item: await adminTx(req, 'seo.redirect.deleted', (tx, ctx) => deleteRedirect(tx, ctx, req.query.path), (row) => ({ type: 'seo_redirect', id: row.legacy_path })),
  }));

  // ---- external refs (cms_external_refs)
  r.get(
    '/v1/admin/cms/external-refs',
    {
      schema: {
        tags: TAG,
        querystring: z.object({
          system: z.enum(EXTERNAL_SYSTEMS).optional(),
          entryId: z.uuid().optional(),
          externalId: z.string().min(1).max(300).optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      },
      preHandler: editor,
    },
    async (req) => ({ items: await listExternalRefs(pool, req.query) }),
  );

  r.get('/v1/admin/cms/entries/:id/refs', { schema: { tags: TAG, params: z.object({ id: z.uuid() }) }, preHandler: editor }, async (req) => ({
    items: await listExternalRefs(pool, { entryId: req.params.id, limit: 50, offset: 0 }),
  }));

  r.put(
    '/v1/admin/cms/entries/:id/refs',
    {
      schema: {
        tags: TAG,
        summary: 'Map legacy (WONT / SixShop) content to an entry; Payload refs are created by the signed webhook only',
        params: z.object({ id: z.uuid() }),
        body: z.object({ system: z.enum(LEGACY_SYSTEMS), externalId: z.string().trim().min(1).max(300), externalUrl: z.string().max(2000).regex(/^https?:\/\/\S+$/i).nullish() }),
      },
      preHandler: editor,
    },
    async (req, reply) => {
      const res = await adminTx(
        req,
        'cms.external_ref.linked',
        (tx, ctx) => linkLegacyRef(tx, ctx, req.params.id, req.body),
        () => ({ type: 'cms_entry', id: req.params.id, details: { system: req.body.system, externalId: req.body.externalId } }),
      );
      return reply.status(res.created ? 201 : 200).send({ item: res.item });
    },
  );

  // ---- Payload CMS webhook (invariant 4: HMAC over the exact raw body; replay-safe and idempotent per revision)
  await app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 2 * 1024 * 1024 }, (req, body, done) => {
      (req as any).rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(badRequest('INVALID_JSON', 'Malformed JSON body'), undefined);
      }
    });
    sub.withTypeProvider<ZodTypeProvider>().post(
      '/v1/cms/webhooks/payload',
      {
        schema: { tags: TAG, summary: 'Payload CMS document webhook (x-payload-signature: sha256=<hex HMAC-SHA256 of the raw body>)', body: payloadWebhookBody },
        // verify the signature BEFORE body validation so unsigned callers learn nothing about the schema
        preValidation: async (req) => {
          const secret = process.env.PAYLOAD_WEBHOOK_SECRET;
          if (!secret) throw new AppError(503, 'WEBHOOK_NOT_CONFIGURED', 'Payload webhook is not configured');
          if (!verifyPayloadSignature(secret, (req as any).rawBody ?? '', req.headers['x-payload-signature'])) {
            throw new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature verification failed');
          }
        },
      },
      async (req) => ingestPayloadWebhook(pool, ctxFromRequest(req), (req as any).rawBody ?? '', req.body),
    );
  });

  r.get('/v1/seo/sitemap', { schema: { tags: TAG } }, async () => sitemap(pool, app.ctx.config.PUBLIC_WEB_URL));
}
