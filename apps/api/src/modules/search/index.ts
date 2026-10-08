import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireRole } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import { onEvent, emit } from '../../platform/outbox.js';
import { registerJob } from '../../platform/jobs.js';
import { audit } from '../../platform/audit.js';
import { SEARCH_ADAPTER } from './adapter.js';
import { createSearchAdapter, flushPendingProjections, projectProperty, propertyIdsForEvent, rebuildIndex, reconcileIndex, searchAdapterOf, searchProperties, suggest } from './service.js';

/** Events that change what a property's search document looks like. */
const PROJECTION_EVENTS = ['property.*', 'listing.blocked', 'media.ready', 'availability.changed', 'review.*', 'reputation.*', 'compliance.*'];

/** STAY-04 Stay Search & Discovery + PLAT-01 Search Projection. */
export default async function searchModule(app: FastifyInstance) {
  if (!app.ctx.adapters.has(SEARCH_ADAPTER)) app.ctx.adapters.set(SEARCH_ADAPTER, createSearchAdapter(app.ctx));
  const adapter = searchAdapterOf(app.ctx);
  if (adapter.name === 'meilisearch') {
    // configure index settings in the background; the projection retries via the outbox if Meilisearch is down
    adapter.ensureIndex().catch((err) => app.ctx.log.warn({ err: String(err) }, 'meilisearch ensureIndex failed'));
  }

  for (const pattern of new Set(PROJECTION_EVENTS)) {
    // inside the outbox dispatch transaction: PostgreSQL projections are applied here; external engines (Meilisearch)
    // are only marked PENDING and pushed by search.flush outside any transaction
    onEvent(pattern, `search.projection:${pattern}`, async (tx, ev, ctx) => {
      for (const id of await propertyIdsForEvent(tx, ev)) await projectProperty(tx, ctx.app, id, ev.created_at);
    });
  }

  registerJob('search.flush', 5 * 1000, (appCtx) => flushPendingProjections(appCtx));
  registerJob('search.reconcile', 10 * 60 * 1000, (appCtx) => reconcileIndex(appCtx));

  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/v1/search/properties', {
    schema: {
      tags: ['STAY-04', 'PLAT-01'],
      summary: 'Search stays (candidates only — checkout revalidates availability)',
      querystring: z.object({
        q: z.string().max(200).optional(),
        city: z.string().max(100).optional(),
        region: z.string().max(20).optional(),
        bbox: z.string().max(100).optional().describe('minLng,minLat,maxLng,maxLat'),
        lat: z.coerce.number().min(-90).max(90).optional(),
        lng: z.coerce.number().min(-180).max(180).optional(),
        radius: z.coerce.number().int().min(100).max(100_000).optional().describe('metres'),
        checkIn: z.string().optional(),
        checkOut: z.string().optional(),
        guests: z.coerce.number().int().min(1).max(50).optional(),
        priceMin: z.coerce.number().int().min(0).optional(),
        priceMax: z.coerce.number().int().min(0).optional(),
        amenities: z.string().max(1000).optional().describe('comma-separated amenity codes (all required)'),
        propertyType: z.string().max(200).optional().describe('comma-separated property types'),
        mode: z.enum(['rental', 'exchange', 'any']).optional(),
        sort: z.enum(['relevance', 'price_asc', 'price_desc', 'rating', 'distance', 'newest']).optional(),
        page: z.coerce.number().int().min(1).max(250).default(1),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
    },
  }, async (req) => searchProperties(app.ctx, req.query));

  r.get('/v1/search/suggest', {
    schema: { tags: ['STAY-04'], summary: 'Autocomplete (places, cities, listing titles)', querystring: z.object({ q: z.string().max(100), limit: z.coerce.number().int().min(1).max(10).default(5) }) },
  }, async (req) => suggest(app.ctx, req.query.q, req.query.limit));

  r.post('/v1/admin/search/reindex', {
    schema: { tags: ['PLAT-01'], summary: 'Rebuild the search projection from PostgreSQL', body: z.object({ reset: z.boolean().default(true) }).default({ reset: true }) },
    preHandler: requireRole('ADMIN'),
  }, async (req) => {
    const ctx = ctxFromRequest(req);
    await emit(app.ctx.pool, ctx, { aggregateType: 'search_index', aggregateId: 'properties', eventType: 'search.reindex.requested', payload: { reset: req.body?.reset ?? true, requestedBy: ctx.actor?.userId } });
    await audit(app.ctx.pool, ctx, { action: 'search.reindex', resourceType: 'search_index', resourceId: null, after: { reset: req.body?.reset ?? true } });
    return { item: await rebuildIndex(ctx, { reset: req.body?.reset ?? true }) };
  });
}
