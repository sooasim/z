import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { GEOCODER_ADAPTER, configureGeoPrivacy, createGeocoder, geocode, reverseGeocode } from './service.js';

/**
 * Queue budget for the anonymous endpoints: a public lookup is refused (STATIC fallback) rather than queued behind
 * more than ~2.5 s of provider work, so public traffic can never build an unbounded backlog for internal callers.
 */
const PUBLIC_MAX_WAIT_MS = 2500;

/** PLAT-02 Map / Geo Adapter — geocoding behind a replaceable provider interface (STATIC | KAKAO | NOMINATIM). */
export default async function geoModule(app: FastifyInstance) {
  configureGeoPrivacy(app.ctx.config);
  if (!app.ctx.adapters.has(GEOCODER_ADAPTER)) app.ctx.adapters.set(GEOCODER_ADAPTER, createGeocoder(app.ctx));
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get('/v1/geo/geocode', {
    schema: {
      tags: ['PLAT-02'],
      summary: 'Forward geocode (area/address → coordinates)',
      querystring: z.object({ q: z.string().trim().min(1).max(200), limit: z.coerce.number().int().min(1).max(10).default(5) }),
    },
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req) => {
    const items = await geocode(app.ctx, req.query.q, { limit: req.query.limit, maxWaitMs: PUBLIC_MAX_WAIT_MS });
    return { items };
  });

  r.get('/v1/geo/reverse', {
    schema: {
      tags: ['PLAT-02'],
      summary: 'Reverse geocode (coordinates → area label)',
      querystring: z.object({ lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180) }),
    },
    config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
  }, async (req) => {
    const item = await reverseGeocode(app.ctx, req.query.lat, req.query.lng, { maxWaitMs: PUBLIC_MAX_WAIT_MS });
    return { item };
  });
}
