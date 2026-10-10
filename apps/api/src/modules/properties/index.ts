import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, requireRole, getActor } from '../../platform/auth.js';
import { ctxFromRequest, systemCtx } from '../../platform/context.js';
import { onEvent } from '../../platform/outbox.js';
import { registerJob } from '../../platform/jobs.js';
import { contentLocale, contentTranslation, localize } from '../../platform/content-locale.js';
import {
  PROPERTY_TYPES, ROOM_TYPES, archiveProperty, assertValidNights, backfillGeoJurisdictions, blockProperty, createProperty, enforceHostStanding, getProperty, getPublicBySlug,
  listAmenities, listCancellationPolicies, listHostProperties, listPublicProperties, publishProperty, setAmenities, unblockProperty,
  unlistProperty, updateProperty, withdrawProperty,
} from './service.js';

/**
 * Events after which a host may no longer be in good standing. The consumer re-checks the host's standing (it is
 * idempotent and only acts on adverse state) and takes live listings down: a sanctioned / suspended / deleted
 * host's listings must not stay searchable and bookable.
 */
const HOST_STANDING_EVENTS = ['sanction.applied', 'user.suspended', 'role.revoked', 'privacy.requested', 'privacy.completed'] as const;

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
const address = z.object({
  line1: z.string().trim().min(1).max(300),
  line2: z.string().trim().max(300).nullish(),
  postalCode: z.string().trim().max(20).nullish(),
  city: z.string().trim().max(100).nullish(),
  region: z.string().trim().max(100).nullish(),
  country: z.string().length(2).nullish(),
  publicAreaLabel: z.string().trim().max(120).nullish(),
});
const houseRules = z.object({
  smokingAllowed: z.boolean().optional(),
  petsAllowed: z.boolean().optional(),
  eventsAllowed: z.boolean().optional(),
  quietHours: z.string().max(100).nullish(),
  extraRules: z.string().max(4000).nullish(),
});
const fields = {
  title: z.string().trim().min(2).max(120),
  summary: z.string().trim().max(500).nullish(),
  description: z.string().trim().max(10000).nullish(),
  propertyType: z.enum(PROPERTY_TYPES),
  roomType: z.enum(ROOM_TYPES).optional(),
  maxGuests: z.number().int().min(1).max(50).optional(),
  bedrooms: z.number().int().min(0).max(100).optional(),
  beds: z.number().int().min(0).max(200).optional(),
  bathrooms: z.number().min(0).max(100).multipleOf(0.5).optional(),
  lat: z.number().min(-90).max(90).nullish(),
  lng: z.number().min(-180).max(180).nullish(),
  country: z.string().length(2).optional(),
  region: z.string().trim().max(20).nullish(),
  city: z.string().trim().max(100).nullish(),
  timezone: z.string().max(64).optional(),
  rentalEnabled: z.boolean().optional(),
  exchangeEnabled: z.boolean().optional(),
  instantBook: z.boolean().optional(),
  basePriceMinor: z.number().int().min(0).max(1e12).nullish(),
  cleaningFeeMinor: z.number().int().min(0).max(1e12).optional(),
  currency: z.string().length(3).optional(),
  minNights: z.number().int().min(1).max(365).optional(),
  maxNights: z.number().int().min(1).max(1000).optional(),
  checkInTime: time.optional(),
  checkOutTime: time.optional(),
  cancellationPolicyCode: z.string().max(40).nullish(),
  address: address.nullish(),
  houseRules: houseRules.nullish(),
  amenities: z.array(z.string().max(60)).max(100).optional(),
};
const createBody = z.object(fields);
const patchBody = z.object(fields).partial().refine((b) => Object.keys(b).length > 0, 'At least one field is required');
const idParams = z.object({ id: z.uuid() });
const reasonBody = z.object({ reason: z.string().trim().min(3).max(1000) });
const STATUSES = ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'UNLISTED', 'BLOCKED', 'ARCHIVED'] as const;

/** Host-written text in the public DTOs. Everything else (city, amenity codes, policy names) is enum/reference data the UI already translates. */
const LISTING_TEXT = ['items[].title', 'items[].summary', 'items[].description'] as const;
const DETAIL_TEXT = ['title', 'summary', 'description', 'houseRules.extraRules', 'host.about'] as const;

/** STAY-01 Property / Listing Management — draft CRUD, content, lifecycle FSM and public detail. */
export default async function propertiesModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['STAY-01'];

  for (const eventType of HOST_STANDING_EVENTS) {
    onEvent(eventType, `properties.host-standing:${eventType}`, async (tx, ev, ctx) => {
      const pl = (ev.payload ?? {}) as Record<string, any>;
      const userId = typeof pl.userId === 'string' ? pl.userId : ev.aggregate_type === 'user' ? ev.aggregate_id : null;
      if (!userId) return;
      if (eventType === 'role.revoked' && pl.role !== 'HOST') return;
      if (eventType.startsWith('privacy.') && pl.type !== 'DELETE') return;
      await enforceHostStanding(tx, ctx, userId, eventType);
    });
  }
  registerJob('properties.geo-jurisdiction-backfill', 60 * 60 * 1000, (appCtx) => backfillGeoJurisdictions(systemCtx(appCtx, `job-geo-backfill-${Date.now()}`)));

  r.get('/v1/amenities', { schema: { tags, summary: 'Amenity catalog' } }, async () => ({ items: await listAmenities(app.ctx.pool) }));
  r.get('/v1/properties/cancellation-policies', { schema: { tags, summary: 'Selectable cancellation policies' } }, async () => ({
    items: await listCancellationPolicies(app.ctx.pool),
  }));

  r.post('/v1/properties', { schema: { summary: 'Create a property draft', tags, body: createBody }, preHandler: requireAuth }, async (req, reply) => {
    assertValidNights(req.body.minNights, req.body.maxNights);
    return reply.status(201).send({ item: await createProperty(ctxFromRequest(req), getActor(req), req.body as any) });
  });

  r.patch('/v1/properties/:id', { schema: { summary: 'Update a property', tags, params: idParams, body: patchBody }, preHandler: requireAuth }, async (req) => {
    assertValidNights(req.body.minNights, req.body.maxNights);
    return { item: await updateProperty(ctxFromRequest(req), getActor(req), req.params.id, req.body as any) };
  });

  r.get('/v1/properties', {
    schema: {
      tags, summary: 'Published listings (public)',
      querystring: z.object({ hostId: z.uuid().optional(), city: z.string().max(100).optional(), limit: z.coerce.number().int().min(1).max(100).default(20), offset: z.coerce.number().int().min(0).max(10000).default(0) }),
    },
  }, async (req) => {
    // Listing copy is written by hosts, so it is translated for a reader in another language (STAY-01 +
    // content.auto_translate). Anything not cached yet stays in the source language — see
    // platform/translate.ts.
    const body = { items: await listPublicProperties(app.ctx.pool, req.query) };
    const locale = contentLocale(req);
    return localize(await contentTranslation(ctxFromRequest(req), locale), body, LISTING_TEXT, locale);
  });

  r.get('/v1/properties/by-slug/:slug', { schema: { tags, summary: 'Public listing detail', params: z.object({ slug: z.string().min(1).max(200) }) } }, async (req) => {
    const item = await getPublicBySlug(app.ctx.pool, req.params.slug);
    const locale = contentLocale(req);
    return { item: await localize(await contentTranslation(ctxFromRequest(req), locale), item, DETAIL_TEXT, locale) };
  });

  r.get('/v1/properties/:id', { schema: { summary: 'Get a property', tags, params: idParams } }, async (req) => ({
    item: await getProperty(ctxFromRequest(req), req.actor ?? null, req.params.id),
  }));

  r.get('/v1/host/properties', {
    schema: { tags, summary: "Host's own listings", querystring: z.object({ status: z.enum(STATUSES).optional() }) },
    preHandler: requireAuth,
  }, async (req) => ({ items: await listHostProperties(app.ctx.pool, getActor(req), req.query.status) }));

  r.put('/v1/properties/:id/amenities', {
    schema: { summary: 'Replace the amenities of a property', tags, params: idParams, body: z.object({ codes: z.array(z.string().max(60)).max(100) }) },
    preHandler: requireAuth,
  }, async (req) => ({ items: await setAmenities(ctxFromRequest(req), getActor(req), req.params.id, req.body.codes) }));

  r.post('/v1/properties/:id/publish', { schema: { summary: 'Publish a property', tags, params: idParams }, preHandler: requireAuth }, async (req, reply) => {
    const res = await publishProperty(ctxFromRequest(req), getActor(req), req.params.id);
    return reply.status(res.outcome === 'PUBLISHED' ? 200 : 202).send(res);
  });
  r.post('/v1/properties/:id/unlist', { schema: { summary: 'Unlist a published property', tags, params: idParams }, preHandler: requireAuth }, async (req) => ({
    item: await unlistProperty(ctxFromRequest(req), getActor(req), req.params.id),
  }));
  r.post('/v1/properties/:id/withdraw', { schema: { tags, params: idParams, summary: 'Withdraw an IN_REVIEW listing back to DRAFT' }, preHandler: requireAuth }, async (req) => ({
    item: await withdrawProperty(ctxFromRequest(req), getActor(req), req.params.id),
  }));
  r.post('/v1/properties/:id/archive', { schema: { summary: 'Archive a property', tags, params: idParams }, preHandler: requireAuth }, async (req) => ({
    item: await archiveProperty(ctxFromRequest(req), getActor(req), req.params.id),
  }));

  const staff = requireRole('ADMIN', 'COMPLIANCE'); // staff-only → AAL2
  r.post('/v1/admin/properties/:id/block', { schema: { summary: 'Block a property from public visibility', tags: ['STAY-01', 'STAY-03'], params: idParams, body: reasonBody }, preHandler: staff }, async (req) => ({
    item: await blockProperty(ctxFromRequest(req), req.params.id, req.body.reason),
  }));
  r.post('/v1/admin/properties/:id/unblock', { schema: { summary: 'Unblock a property', tags: ['STAY-01', 'STAY-03'], params: idParams, body: reasonBody }, preHandler: staff }, async (req) => ({
    item: await unblockProperty(ctxFromRequest(req), req.params.id, req.body.reason),
  }));
}
