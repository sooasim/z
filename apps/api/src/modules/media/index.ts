import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireAuth, getActor } from '../../platform/auth.js';
import { ctxFromRequest, systemCtx } from '../../platform/context.js';
import { registerJob } from '../../platform/jobs.js';
import { notFound } from '../../platform/errors.js';
import { LocalStorageAdapter, STORAGE_ADAPTER, createStorage, type StorageAdapter } from './storage.js';
import { ALLOWED_MIMES, MAX_VIDEO_BYTES, MEDIA_PURPOSES, acceptDevUpload, completeUpload, createUploadUrl, getMedia, releaseStaleProcessing, setPropertyMedia } from './service.js';

const MIME_BY_EXT: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', avif: 'image/avif', mp4: 'video/mp4' };

/** STAY-02 Media Pipeline — presigned private uploads, verification, moderation hook and CDN promotion. */
export default async function mediaModule(app: FastifyInstance) {
  if (!app.ctx.adapters.has(STORAGE_ADAPTER)) app.ctx.adapters.set(STORAGE_ADAPTER, createStorage(app.ctx.config));
  const storage = app.ctx.adapters.get(STORAGE_ADAPTER) as StorageAdapter;
  const r = app.withTypeProvider<ZodTypeProvider>();

  // abandoned PROCESSING claims (crashed worker) become retryable again
  registerJob('media.processing-sweeper', 5 * 60 * 1000, (appCtx) => releaseStaleProcessing(systemCtx(appCtx, `job-media-sweeper-${Date.now()}`)));

  r.post('/v1/media/upload-url', {
    schema: {
      tags: ['STAY-02'],
      summary: 'Request a presigned PUT URL into the private bucket',
      body: z.object({
        purpose: z.enum(MEDIA_PURPOSES),
        mimeType: z.string().min(3).max(100),
        byteSize: z.number().int().positive(),
        sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).optional(),
      }),
    },
    preHandler: requireAuth,
  }, async (req, reply) => {
    const res = await createUploadUrl(ctxFromRequest(req), getActor(req), req.body);
    return reply.status(201).send(res);
  });

  r.post('/v1/media/:id/complete', {
    schema: { tags: ['STAY-02'], summary: 'Verify the uploaded object and process it', params: z.object({ id: z.uuid() }) },
    preHandler: requireAuth,
  }, async (req) => ({ item: await completeUpload(ctxFromRequest(req), getActor(req), req.params.id) }));

  r.get('/v1/media/:id', {
    schema: { tags: ['STAY-02'], params: z.object({ id: z.uuid() }) },
    preHandler: requireAuth,
  }, async (req) => ({ item: await getMedia(ctxFromRequest(req), getActor(req), req.params.id) }));

  r.put('/v1/properties/:id/media', {
    schema: {
      tags: ['STAY-02', 'STAY-01'],
      summary: 'Attach / reorder / remove listing media (full ordered replacement)',
      params: z.object({ id: z.uuid() }),
      body: z.object({ items: z.array(z.object({ mediaId: z.uuid(), caption: z.string().max(300).nullish() })).max(60) }),
    },
    preHandler: requireAuth,
  }, async (req) => ({ items: await setPropertyMedia(ctxFromRequest(req), getActor(req), req.params.id, req.body.items) }));

  if (storage instanceof LocalStorageAdapter) {
    // Dev/test stand-in for the S3 presigned PUT. Raw bytes; auth is the HMAC token in the URL.
    app.addContentTypeParser(
      [...ALLOWED_MIMES, 'application/octet-stream'],
      { parseAs: 'buffer', bodyLimit: MAX_VIDEO_BYTES },
      (_req, body, done) => done(null, body),
    );
    r.put('/v1/media/dev-upload/:id', {
      schema: { tags: ['STAY-02'], hide: true, params: z.object({ id: z.uuid() }), querystring: z.object({ token: z.string().min(10) }) },
      bodyLimit: MAX_VIDEO_BYTES,
    }, async (req, reply) => {
      const body = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.alloc(0);
      await acceptDevUpload(ctxFromRequest(req), req.params.id, req.headers['content-type'], body, (mime) =>
        storage.verifyToken(req.params.id, mime, req.query.token),
      );
      return reply.status(200).send({ ok: true });
    });

    // Dev stand-in for the CDN (CDN_BASE_URL defaults to {api}/media-dev). Serves PUBLIC objects only.
    app.get('/media-dev/public/:file', { schema: { hide: true } }, async (req, reply) => {
      const file = (req.params as any).file as string;
      const m = /^([0-9a-f-]{36})\.(jpg|png|webp|avif|mp4)$/.exec(file);
      if (!m) throw notFound('Media');
      try {
        const bytes = await storage.readPublic(`public/${file}`);
        return reply.type(MIME_BY_EXT[m[2]]).header('cache-control', 'public, max-age=31536000, immutable').send(bytes);
      } catch {
        throw notFound('Media');
      }
    });
  }
}
