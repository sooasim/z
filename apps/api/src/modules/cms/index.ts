import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getActor, hasRole, requireRole } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { withTx } from '../../platform/db.js';
import {
  ENTRY_TYPES,
  adminListEntries,
  approveRedirects,
  createEntry,
  deleteRedirect,
  getPublished,
  listPublished,
  listRedirects,
  parseEntryType,
  resolveRedirect,
  sitemap,
  toEntryDto,
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
  seo: z.object({ title: z.string().max(200).optional(), description: z.string().max(500).optional(), canonical: z.string().max(500).optional(), noindex: z.boolean().optional() }).optional(),
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
    const ctx = ctxFromRequest(req);
    return reply.status(201).send({ item: toEntryDto(await withTx(pool, (tx) => createEntry(tx, ctx, req.body))) });
  });

  r.patch(
    '/v1/admin/cms/entries/:id',
    { schema: { tags: TAG, params: z.object({ id: z.uuid() }), body: entryBody.omit({ type: true }).partial() }, preHandler: editor },
    async (req) => {
      const ctx = ctxFromRequest(req);
      return { item: toEntryDto(await withTx(pool, (tx) => updateEntry(tx, ctx, req.params.id, req.body))) };
    },
  );

  for (const [action, to] of [['publish', 'PUBLISHED'], ['unpublish', 'DRAFT'], ['archive', 'ARCHIVED'], ['restore', 'DRAFT']] as const) {
    r.post(
      `/v1/admin/cms/entries/:id/${action}`,
      { schema: { tags: TAG, params: z.object({ id: z.uuid() }), body: z.object({ reason: z.string().max(500).optional() }).nullish() }, preHandler: editor },
      async (req) => {
        const ctx = ctxFromRequest(req);
        return { item: toEntryDto(await withTx(pool, (tx) => transitionEntry(tx, ctx, req.params.id, to, req.body?.reason))) };
      },
    );
  }

  // ---- public content (published only, locale fallback ko-KR)
  r.get(
    '/v1/content/:type',
    { schema: { tags: TAG, params: z.object({ type: z.string().max(40) }), querystring: z.object({ locale: locale.default('ko-KR'), limit: z.coerce.number().int().min(1).max(100).default(50) }) } },
    async (req) => ({ items: (await listPublished(pool, parseEntryType(req.params.type), req.query.locale, req.query.limit)).map(toEntryDto) }),
  );
  r.get(
    '/v1/content/:type/:slug',
    { schema: { tags: TAG, params: z.object({ type: z.string().max(40), slug: z.string().max(120) }), querystring: z.object({ locale: locale.default('ko-KR') }) } },
    async (req) => ({ item: toEntryDto(await getPublished(pool, parseEntryType(req.params.type), req.params.slug, req.query.locale)) }),
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

  r.put('/v1/admin/seo/redirects', { schema: { tags: TAG, body: redirectItem }, preHandler: editor }, async (req) => {
    const ctx = ctxFromRequest(req);
    const canApprove = hasRole(getActor(req), 'ADMIN');
    return withTx(pool, (tx) => upsertRedirects(tx, ctx, [req.body], { source: 'admin', canApprove }));
  });

  r.post(
    '/v1/admin/seo/redirects/bulk',
    { schema: { tags: TAG, body: z.object({ items: z.array(redirectItem).min(1).max(5000), source: z.string().max(50).optional() }) }, preHandler: editor },
    async (req) => {
      const ctx = ctxFromRequest(req);
      const canApprove = hasRole(getActor(req), 'ADMIN');
      return withTx(pool, (tx) => upsertRedirects(tx, ctx, req.body.items, { source: req.body.source ?? 'bulk', canApprove }));
    },
  );

  r.post(
    '/v1/admin/seo/redirects/approve',
    { schema: { tags: TAG, body: z.object({ paths: z.array(z.string().max(2000)).min(1).max(5000), approved: z.boolean().default(true) }) }, preHandler: requireRole('ADMIN') },
    async (req) => {
      const ctx = ctxFromRequest(req);
      return withTx(pool, (tx) => approveRedirects(tx, ctx, req.body.paths, req.body.approved));
    },
  );

  r.delete('/v1/admin/seo/redirects', { schema: { tags: TAG, querystring: z.object({ path: z.string().min(1).max(2000) }) }, preHandler: editor }, async (req) => {
    const ctx = ctxFromRequest(req);
    return { item: await withTx(pool, (tx) => deleteRedirect(tx, ctx, req.query.path)) };
  });

  r.get('/v1/seo/sitemap', { schema: { tags: TAG } }, async () => sitemap(pool, app.ctx.config.PUBLIC_WEB_URL));
}
