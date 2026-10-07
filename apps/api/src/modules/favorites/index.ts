import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, getActor } from '../../platform/auth.js';
import { ctxFromRequest } from '../../platform/context.js';
import {
  TARGET_TYPES, addCollectionItem, addFavorite, createCollection, deleteCollection, getCollection, getSharedCollection, listCollections,
  listFavorites, removeCollectionItem, removeFavorite, updateCollection,
} from './service.js';

const target = z.object({ targetType: z.enum(TARGET_TYPES), targetId: z.uuid() });
const visibility = z.enum(['PRIVATE', 'LINK', 'PUBLIC']);
const idParams = z.object({ id: z.uuid() });

/** STAY-05 Favorites & Collections — idempotent saves and shareable collections with privacy controls. */
export default async function favoritesModule(app: FastifyInstance) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tags = ['STAY-05'];

  r.post('/v1/favorites', { schema: { tags, body: target }, preHandler: requireAuth }, async (req, reply) => {
    const res = await addFavorite(ctxFromRequest(req), getActor(req), req.body.targetType, req.body.targetId);
    return reply.status(res.created ? 201 : 200).send(res);
  });
  r.delete('/v1/favorites', { schema: { tags, querystring: target }, preHandler: requireAuth }, async (req) =>
    removeFavorite(ctxFromRequest(req), getActor(req), req.query.targetType, req.query.targetId),
  );
  r.delete('/v1/favorites/:targetType/:targetId', { schema: { tags, params: target }, preHandler: requireAuth }, async (req) =>
    removeFavorite(ctxFromRequest(req), getActor(req), req.params.targetType, req.params.targetId),
  );
  r.get('/v1/favorites', { schema: { tags, querystring: z.object({ targetType: z.enum(TARGET_TYPES).optional() }) }, preHandler: requireAuth }, async (req) => ({
    items: await listFavorites(app.ctx.pool, getActor(req), req.query.targetType),
  }));

  r.post('/v1/collections', {
    schema: { tags, body: z.object({ name: z.string().trim().min(1).max(100), visibility: visibility.default('PRIVATE') }) },
    preHandler: requireAuth,
  }, async (req, reply) => reply.status(201).send({ item: await createCollection(ctxFromRequest(req), getActor(req), req.body.name, req.body.visibility) }));
  r.get('/v1/collections', { schema: { tags }, preHandler: requireAuth }, async (req) => ({ items: await listCollections(app.ctx.pool, getActor(req)) }));
  r.get('/v1/collections/shared/:token', { schema: { tags, summary: 'Shared collection by link token (no auth)', params: z.object({ token: z.string().min(10).max(100) }) } }, async (req) => ({
    item: await getSharedCollection(app.ctx.pool, req.params.token),
  }));
  r.get('/v1/collections/:id', { schema: { tags, params: idParams } }, async (req) => ({ item: await getCollection(app.ctx.pool, req.actor ?? null, req.params.id) }));
  r.patch('/v1/collections/:id', {
    schema: { tags, params: idParams, body: z.object({ name: z.string().trim().min(1).max(100).optional(), visibility: visibility.optional(), rotateToken: z.boolean().optional() }) },
    preHandler: requireAuth,
  }, async (req) => ({ item: await updateCollection(ctxFromRequest(req), getActor(req), req.params.id, req.body) }));
  r.delete('/v1/collections/:id', { schema: { tags, params: idParams }, preHandler: requireAuth }, async (req) => deleteCollection(ctxFromRequest(req), getActor(req), req.params.id));

  r.post('/v1/collections/:id/items', {
    schema: { tags, params: idParams, body: target.extend({ note: z.string().max(500).nullish() }) },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const res = await addCollectionItem(ctxFromRequest(req), getActor(req), req.params.id, req.body);
    return reply.status(res.created ? 201 : 200).send(res);
  });
  r.delete('/v1/collections/:id/items/:targetType/:targetId', { schema: { tags, params: idParams.extend(target.shape) }, preHandler: requireAuth }, async (req) =>
    removeCollectionItem(ctxFromRequest(req), getActor(req), req.params.id, req.params.targetType, req.params.targetId),
  );
}
