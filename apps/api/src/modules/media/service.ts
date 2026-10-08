import { randomUUID } from 'node:crypto';
import type { Ctx } from '../../platform/context.js';
import type { Actor } from '../../platform/auth.js';
import { hasRole } from '../../platform/auth.js';
import type { Db } from '../../platform/db.js';
import { maybeOne, q, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { emit } from '../../platform/outbox.js';
import { StateMachine } from '../../platform/fsm.js';
import { sha256 } from '../../platform/crypto.js';
import { STORAGE_ADAPTER, type StorageAdapter } from './storage.js';
import { imageDimensions, sniffMime } from './sniff.js';
import { MediaSanitizeError, stripMetadata } from './sanitize.js';

export const MEDIA_PURPOSES = ['PROPERTY', 'AVATAR', 'VERIFICATION', 'EVIDENCE', 'MESSAGE', 'CMS', 'TRAVEL_PRODUCT', 'GUIDE'] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];

export const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;
export const VIDEO_MIMES = ['video/mp4'] as const;
export const DOCUMENT_MIMES = ['application/pdf'] as const;
export const ALLOWED_MIMES = [...IMAGE_MIMES, ...VIDEO_MIMES, ...DOCUMENT_MIMES] as const;

export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;
const UPLOAD_URL_TTL_SEC = 15 * 60;

/** Purposes that are promoted to the public CDN bucket after processing. Everything else stays PRIVATE forever. */
export const PUBLIC_PURPOSES: ReadonlySet<MediaPurpose> = new Set(['PROPERTY', 'AVATAR', 'CMS', 'TRAVEL_PRODUCT', 'GUIDE']);
const VIDEO_PURPOSES: ReadonlySet<MediaPurpose> = new Set(['PROPERTY', 'MESSAGE', 'EVIDENCE', 'CMS', 'TRAVEL_PRODUCT', 'GUIDE']);
const DOCUMENT_PURPOSES: ReadonlySet<MediaPurpose> = new Set(['VERIFICATION', 'EVIDENCE']);

const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/avif': 'avif', 'video/mp4': 'mp4', 'application/pdf': 'pdf' };

export type MediaStatus = 'UPLOADING' | 'PROCESSING' | 'READY' | 'REJECTED' | 'DELETED';
export const mediaFsm = new StateMachine<MediaStatus>('MEDIA', {
  UPLOADING: ['PROCESSING', 'REJECTED', 'DELETED'],
  // PROCESSING → UPLOADING: a transient processing failure (storage / moderation outage, crash) releases the claim
  // so the owner can retry `complete` instead of the asset being stuck forever
  PROCESSING: ['READY', 'REJECTED', 'UPLOADING'],
  READY: ['DELETED'],
  REJECTED: ['DELETED'],
  DELETED: [],
});

/** Moderation hook (adapter 'media.moderator'). Default: rule-based approval. */
export interface MediaModerator {
  moderate(asset: { id: string; purpose: string; mimeType: string; byteSize: number }, bytes: Buffer): Promise<{ decision: 'APPROVED' | 'REJECTED'; reason?: string }>;
}
export const ruleBasedModerator: MediaModerator = {
  async moderate(asset, bytes) {
    if (bytes.length === 0) return { decision: 'REJECTED', reason: 'EMPTY_FILE' };
    if (asset.mimeType.startsWith('image/') && bytes.length < 32) return { decision: 'REJECTED', reason: 'TRUNCATED_IMAGE' };
    return { decision: 'APPROVED' };
  },
};

export function storageOf(ctx: Ctx): StorageAdapter {
  const s = ctx.app.adapters.get(STORAGE_ADAPTER) as StorageAdapter | undefined;
  if (!s) throw new Error(`adapter '${STORAGE_ADAPTER}' is not registered`);
  return s;
}

function maxBytesFor(mime: string) {
  if ((IMAGE_MIMES as readonly string[]).includes(mime)) return MAX_IMAGE_BYTES;
  if ((VIDEO_MIMES as readonly string[]).includes(mime)) return MAX_VIDEO_BYTES;
  return MAX_DOCUMENT_BYTES;
}

export function toMediaDto(m: any) {
  return {
    id: m.id,
    ownerId: m.owner_id,
    purpose: m.purpose,
    visibility: m.visibility,
    mimeType: m.mime_type,
    byteSize: m.byte_size,
    status: m.status,
    moderationStatus: m.moderation_status,
    width: m.width,
    height: m.height,
    // only PUBLIC media ever exposes a URL; private objects are reachable solely via short-lived signed access
    publicUrl: m.visibility === 'PUBLIC' ? m.public_url : null,
    createdAt: m.created_at,
    readyAt: m.ready_at,
  };
}

export async function createUploadUrl(
  ctx: Ctx,
  actor: Actor,
  input: { purpose: MediaPurpose; mimeType: string; byteSize: number; sha256?: string },
) {
  const mime = input.mimeType.toLowerCase();
  if (!(ALLOWED_MIMES as readonly string[]).includes(mime)) {
    throw unprocessable('MEDIA_TYPE_NOT_ALLOWED', `MIME type ${input.mimeType} is not allowed`, { allowed: ALLOWED_MIMES });
  }
  if ((VIDEO_MIMES as readonly string[]).includes(mime) && !VIDEO_PURPOSES.has(input.purpose)) {
    throw unprocessable('MEDIA_TYPE_NOT_ALLOWED', `Video is not allowed for purpose ${input.purpose}`);
  }
  if ((DOCUMENT_MIMES as readonly string[]).includes(mime) && !DOCUMENT_PURPOSES.has(input.purpose)) {
    throw unprocessable('MEDIA_TYPE_NOT_ALLOWED', `Documents are only allowed for verification/evidence uploads`);
  }
  const limit = maxBytesFor(mime);
  if (input.byteSize > limit) throw unprocessable('MEDIA_TOO_LARGE', `File exceeds the ${Math.round(limit / 1024 / 1024)}MB limit`, { maxBytes: limit });
  if (input.purpose === 'CMS' && !hasRole(actor, 'EDITOR', 'ADMIN')) throw forbidden('ROLE_REQUIRED', 'CMS media requires EDITOR or ADMIN');

  const id = randomUUID();
  const key = `private/${input.purpose.toLowerCase()}/${actor.userId}/${id}`;
  const storage = storageOf(ctx);
  const presigned = await storage.presignPut({ mediaId: id, key, mimeType: mime, byteSize: input.byteSize, expiresSec: UPLOAD_URL_TTL_SEC });
  const row = await withTx(ctx.app.pool, async (tx) => {
    const m = await maybeOne(
      tx,
      `INSERT INTO media_assets(id, owner_id, storage_key, purpose, visibility, mime_type, byte_size, sha256, status)
       VALUES ($1,$2,$3,$4,'PRIVATE',$5,$6,$7,'UPLOADING') RETURNING *`,
      [id, actor.userId, key, input.purpose, mime, input.byteSize, input.sha256?.toLowerCase() ?? null],
    );
    return m;
  });
  return { media: toMediaDto(row), upload: presigned };
}

async function loadOwned(db: Db, actor: Actor, mediaId: string, lock = false) {
  const m = await maybeOne(db, `SELECT * FROM media_assets WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [mediaId]);
  if (!m) throw notFound('Media');
  if (m.owner_id !== actor.userId) throw forbidden('NOT_MEDIA_OWNER', 'You do not own this media');
  return m;
}

export async function getMedia(ctx: Ctx, actor: Actor, mediaId: string) {
  return toMediaDto(await loadOwned(ctx.app.pool, actor, mediaId));
}

/** Persist a rejection (its own committed tx) and then raise the 422 to the caller. */
async function reject(ctx: Ctx, mediaId: string, code: string, msg: string): Promise<never> {
  await withTx(ctx.app.pool, async (tx) => {
    const cur = await maybeOne<{ status: MediaStatus }>(tx, `SELECT status FROM media_assets WHERE id = $1 FOR UPDATE`, [mediaId]);
    if (cur && mediaFsm.can(cur.status, 'REJECTED')) {
      await mediaFsm.transition(tx, ctx, { table: 'media_assets', id: mediaId, to: 'REJECTED', reason: code, set: { moderation_status: 'REJECTED' } });
    }
  });
  throw unprocessable(code, msg);
}

/** Largest accepted image edge (px). Also keeps the value inside the int4 width/height columns. */
export const MAX_IMAGE_EDGE = 65_535;
/** A PROCESSING claim older than this is considered abandoned (crashed worker) and released by the sweeper. */
export const PROCESSING_LEASE_SEC = 10 * 60;

/**
 * The processing claim is identified by its lease timestamp (processing_started_at): a request only finishes,
 * renews or releases the claim it took — never one taken over after its lease expired.
 */
async function holdsClaim(db: Db, mediaId: string, claim: Date, lock = false) {
  const cur = await maybeOne(db, `SELECT status, processing_started_at FROM media_assets WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [mediaId]);
  return cur?.status === 'PROCESSING' && cur.processing_started_at instanceof Date && cur.processing_started_at.getTime() === claim.getTime();
}

/** Renew the lease of a claim we still hold (before slow steps such as the CDN upload). Returns the new token. */
async function renewClaim(ctx: Ctx, mediaId: string, claim: Date): Promise<Date> {
  const next = new Date(Math.max(Date.now(), claim.getTime() + 1));
  const r = await ctx.app.pool.query(
    `UPDATE media_assets SET processing_started_at = $3 WHERE id = $1 AND status = 'PROCESSING' AND processing_started_at = $2`,
    [mediaId, claim, next],
  );
  if (r.rowCount !== 1) throw conflict('MEDIA_CLAIM_LOST', 'Processing of this media was taken over; retry completing the upload');
  return next;
}

/** Release a processing claim after a transient failure (only if it is still ours). */
async function releaseClaim(ctx: Ctx, mediaId: string, claim: Date, why: string) {
  await withTx(ctx.app.pool, async (tx) => {
    if (!(await holdsClaim(tx, mediaId, claim, true))) return;
    await mediaFsm.transition(tx, ctx, { table: 'media_assets', id: mediaId, from: 'PROCESSING', to: 'UPLOADING', reason: why.slice(0, 200), set: { processing_started_at: null } });
  });
}

/**
 * POST /v1/media/:id/complete — verify ownership, object presence, size, checksum and magic bytes, then
 * UPLOADING → PROCESSING → (moderation) → READY; public purposes are promoted to the public bucket.
 *
 *  - The UPLOADING → PROCESSING compare-and-set happens BEFORE the object is read: concurrent completes of the same
 *    asset get 409 instead of each buffering the (up to 200 MB) object.
 *  - What is published is exactly the in-memory buffer that was verified and moderated (metadata stripped), never a
 *    fresh copy of the private object (the presigned PUT URL stays valid and could swap the bytes).
 *  - Any unexpected failure after the claim releases it (PROCESSING → UPLOADING, retryable) and removes a public
 *    copy written for it; abandoned claims are released by the media.processing-sweeper job.
 */
export async function completeUpload(ctx: Ctx, actor: Actor, mediaId: string) {
  const m = await loadOwned(ctx.app.pool, actor, mediaId);
  if (m.status === 'READY') return toMediaDto(m); // idempotent replay
  if (m.status === 'PROCESSING') throw conflict('MEDIA_PROCESSING', 'Media is being processed; retry shortly', { status: m.status });
  if (m.status !== 'UPLOADING') throw conflict('INVALID_STATE_TRANSITION', `Media is ${m.status}`, { status: m.status });

  const storage = storageOf(ctx);
  const head = await storage.head(m.storage_key);
  if (!head) throw conflict('UPLOAD_NOT_FOUND', 'No uploaded object found for this media; upload it first');
  if (head.size !== Number(m.byte_size)) await reject(ctx, mediaId, 'MEDIA_SIZE_MISMATCH', 'Uploaded size does not match the declared size');
  if (head.size > maxBytesFor(m.mime_type)) await reject(ctx, mediaId, 'MEDIA_TOO_LARGE', 'Uploaded object exceeds the size limit');

  // claim (single winner) BEFORE reading the object
  let claim = new Date();
  const done = await withTx(ctx.app.pool, async (tx) => {
    const cur = await maybeOne(tx, `SELECT * FROM media_assets WHERE id = $1 FOR UPDATE`, [mediaId]);
    if (cur?.status === 'READY') return cur; // a concurrent complete already finished
    if (cur?.status === 'PROCESSING') throw conflict('MEDIA_PROCESSING', 'Media is being processed; retry shortly', { status: cur.status });
    await mediaFsm.transition(tx, ctx, { table: 'media_assets', id: mediaId, from: 'UPLOADING', to: 'PROCESSING', reason: 'upload received', set: { processing_started_at: claim } });
    await emit(tx, ctx, { aggregateType: 'media', aggregateId: mediaId, eventType: 'media.uploaded', payload: { mediaId, ownerId: m.owner_id, purpose: m.purpose, mimeType: m.mime_type, byteSize: head.size } });
    return null;
  });
  if (done) return toMediaDto(done);

  const promote = PUBLIC_PURPOSES.has(m.purpose);
  const publicKey = `public/${mediaId}.${EXT[m.mime_type] ?? 'bin'}`;
  let published = false;
  try {
    const bytes = await storage.read(m.storage_key);
    if (bytes.length !== Number(m.byte_size)) await reject(ctx, mediaId, 'MEDIA_SIZE_MISMATCH', 'Uploaded size does not match the declared size');
    const digest = sha256(bytes);
    if (m.sha256 && m.sha256 !== digest) await reject(ctx, mediaId, 'MEDIA_CHECKSUM_MISMATCH', 'Uploaded object checksum does not match');
    const sniffed = sniffMime(bytes);
    if (sniffed !== m.mime_type) await reject(ctx, mediaId, 'MEDIA_TYPE_MISMATCH', `File content (${sniffed ?? 'unknown'}) does not match declared type ${m.mime_type}`);
    const rawDims = m.mime_type.startsWith('image/') ? imageDimensions(bytes, m.mime_type) : null;
    if (rawDims && (rawDims.width > MAX_IMAGE_EDGE || rawDims.height > MAX_IMAGE_EDGE)) {
      // a crafted header (e.g. PNG width 0x80000000) must be refused, not overflow the int4 column after the claim
      await reject(ctx, mediaId, 'MEDIA_DIMENSIONS_INVALID', `Image dimensions must not exceed ${MAX_IMAGE_EDGE}px`);
    }
    const dims = rawDims && rawDims.width >= 1 && rawDims.height >= 1 ? rawDims : null; // 0 = unknown

    const moderator = (ctx.app.adapters.get('media.moderator') as MediaModerator | undefined) ?? ruleBasedModerator;
    const verdict = await moderator.moderate({ id: mediaId, purpose: m.purpose, mimeType: m.mime_type, byteSize: head.size }, bytes);
    if (verdict.decision !== 'APPROVED') await reject(ctx, mediaId, 'MEDIA_MODERATION_REJECTED', `Media rejected by moderation${verdict.reason ? `: ${verdict.reason}` : ''}`);

    let publicUrl: string | null = null;
    if (promote) {
      let publicBytes: Buffer;
      try {
        publicBytes = stripMetadata(bytes, m.mime_type); // EXIF/GPS, XMP, IPTC, MP4 location atoms
      } catch (err) {
        if (!(err instanceof MediaSanitizeError)) throw err;
        await reject(ctx, mediaId, 'MEDIA_METADATA_UNSUPPORTED', `Media metadata could not be removed safely: ${err.message}`);
        throw err; // unreachable (reject throws)
      }
      claim = await renewClaim(ctx, mediaId, claim); // still ours, and the lease covers the upload
      published = true;
      await storage.promote(m.storage_key, publicKey, m.mime_type, publicBytes); // exactly the verified bytes
      publicUrl = storage.publicUrl(publicKey);
    }
    const row = await withTx(ctx.app.pool, async (tx) => {
      if (!(await holdsClaim(tx, mediaId, claim, true))) throw conflict('MEDIA_CLAIM_LOST', 'Processing of this media was taken over; retry completing the upload');
      const { row } = await mediaFsm.transition(tx, ctx, {
        table: 'media_assets', id: mediaId, from: 'PROCESSING', to: 'READY', reason: 'processed',
        set: {
          sha256: digest,
          moderation_status: 'APPROVED',
          visibility: promote ? 'PUBLIC' : 'PRIVATE',
          public_url: publicUrl,
          width: dims?.width ?? null,
          height: dims?.height ?? null,
          ready_at: new Date(),
          processing_started_at: null,
        },
      });
      await emit(tx, ctx, { aggregateType: 'media', aggregateId: mediaId, eventType: 'media.ready', payload: { mediaId, ownerId: m.owner_id, purpose: m.purpose, visibility: row.visibility } });
      return row;
    });
    return toMediaDto(row);
  } catch (err) {
    if (published) {
      // roll back our CDN copy unless the asset is READY (then the copy belongs to the committed result)
      const st = await maybeOne(ctx.app.pool, `SELECT status FROM media_assets WHERE id = $1`, [mediaId]).catch(() => null);
      if (st?.status !== 'READY') await storage.removePublic?.(publicKey).catch(() => {});
    }
    if (err instanceof AppError) throw err; // deliberate rejection (already persisted) or conflict
    ctx.app.log.warn({ err: String(err), mediaId }, 'media processing failed; claim released for retry');
    await releaseClaim(ctx, mediaId, claim, `processing failed: ${String((err as any)?.message ?? err)}`).catch(() => {});
    throw new AppError(503, 'MEDIA_PROCESSING_FAILED', 'Media processing failed temporarily; retry completing the upload');
  }
}

/** Job: release PROCESSING claims abandoned by a crashed worker (lease expired) so the owner can retry. */
export async function releaseStaleProcessing(ctx: Ctx, leaseSec = PROCESSING_LEASE_SEC): Promise<number> {
  const stale = await q<{ id: string }>(
    ctx.app.pool,
    `SELECT id FROM media_assets WHERE status = 'PROCESSING'
        AND coalesce(processing_started_at, created_at) < now() - make_interval(secs => $1) ORDER BY id LIMIT 200`,
    [leaseSec],
  );
  let n = 0;
  for (const { id } of stale) {
    await withTx(ctx.app.pool, async (tx) => {
      const cur = await maybeOne(tx, `SELECT status, coalesce(processing_started_at, created_at) < now() - make_interval(secs => $2) AS expired FROM media_assets WHERE id = $1 FOR UPDATE SKIP LOCKED`, [id, leaseSec]);
      if (cur?.status !== 'PROCESSING' || !cur.expired) return;
      await mediaFsm.transition(tx, ctx, { table: 'media_assets', id, from: 'PROCESSING', to: 'UPLOADING', reason: 'processing lease expired', actorType: 'SYSTEM', set: { processing_started_at: null } });
      n++;
    });
  }
  return n;
}

/** Dev storage only: accept the bytes for a pending upload (the "presigned PUT"). */
export async function acceptDevUpload(ctx: Ctx, mediaId: string, contentType: string | undefined, body: Buffer, verify: (mime: string) => boolean) {
  const m = await maybeOne(ctx.app.pool, `SELECT * FROM media_assets WHERE id = $1`, [mediaId]);
  if (!m || !verify(m.mime_type)) throw forbidden('INVALID_UPLOAD_TOKEN', 'Upload URL is invalid or expired');
  if (m.status !== 'UPLOADING') throw conflict('INVALID_STATE_TRANSITION', `Media is ${m.status}`);
  if ((contentType ?? '').split(';')[0].trim().toLowerCase() !== m.mime_type) throw badRequest('CONTENT_TYPE_MISMATCH', 'Content-Type must match the declared MIME type');
  if (body.length > Number(m.byte_size) || body.length > maxBytesFor(m.mime_type)) throw unprocessable('MEDIA_TOO_LARGE', 'Upload exceeds the declared size');
  const storage = storageOf(ctx) as any;
  await storage.writePrivate(m.storage_key, body);
}

// --- property media (STAY-01/02) ---------------------------------------------------------------

export async function listPropertyMedia(db: Db, propertyId: string, publicOnly = false) {
  return q(
    db,
    `SELECT m.*, pm.sort_order, pm.caption FROM property_media pm JOIN media_assets m ON m.id = pm.media_id
      WHERE pm.property_id = $1 ${publicOnly ? `AND m.status = 'READY' AND m.visibility = 'PUBLIC'` : ''}
      ORDER BY pm.sort_order, m.created_at`,
    [propertyId],
  );
}

export const toPropertyMediaDto = (m: any) => ({ ...toMediaDto(m), sortOrder: m.sort_order, caption: m.caption });

/** PUT /v1/properties/:id/media — replace the ordered media set (attach / reorder / remove). */
export async function setPropertyMedia(ctx: Ctx, actor: Actor, propertyId: string, items: { mediaId: string; caption?: string | null }[]) {
  const ids = items.map((i) => i.mediaId);
  if (new Set(ids).size !== ids.length) throw badRequest('DUPLICATE_MEDIA', 'Each media may appear only once');
  return withTx(ctx.app.pool, async (tx) => {
    const p = await maybeOne(tx, `SELECT id, host_id, status FROM properties WHERE id = $1 FOR UPDATE`, [propertyId]);
    if (!p) throw notFound('Property');
    if (p.host_id !== actor.userId) throw forbidden('NOT_PROPERTY_OWNER', 'You do not own this property');
    if (p.status === 'ARCHIVED') throw conflict('PROPERTY_ARCHIVED', 'Archived properties cannot be edited');
    const media = ids.length ? await q(tx, `SELECT * FROM media_assets WHERE id = ANY($1::uuid[])`, [ids]) : [];
    const byId = new Map(media.map((m: any) => [m.id, m]));
    for (const id of ids) {
      const m: any = byId.get(id);
      if (!m) throw unprocessable('MEDIA_NOT_FOUND', `Media ${id} not found`);
      if (m.owner_id !== actor.userId) throw forbidden('NOT_MEDIA_OWNER', 'You do not own this media');
      if (m.purpose !== 'PROPERTY') throw unprocessable('MEDIA_PURPOSE_MISMATCH', 'Only PROPERTY media can be attached to a listing');
      if (m.status !== 'READY' || m.visibility !== 'PUBLIC') throw unprocessable('MEDIA_NOT_READY', `Media ${id} is not ready`);
    }
    if (['PUBLISHED'].includes(p.status) && ids.length < 3) {
      throw unprocessable('PUBLISH_VALIDATION_FAILED', 'Published listings need at least 3 ready photos', { errors: ['MEDIA_MIN_3'] });
    }
    await tx.query(`DELETE FROM property_media WHERE property_id = $1 AND NOT (media_id = ANY($2::uuid[]))`, [propertyId, ids]);
    for (const [i, it] of items.entries()) {
      await tx.query(
        `INSERT INTO property_media(property_id, media_id, sort_order, caption) VALUES ($1,$2,$3,$4)
         ON CONFLICT (property_id, media_id) DO UPDATE SET sort_order = EXCLUDED.sort_order, caption = EXCLUDED.caption`,
        [propertyId, it.mediaId, i, it.caption ?? null],
      );
    }
    await tx.query(`UPDATE properties SET updated_at = now() WHERE id = $1`, [propertyId]);
    await emit(tx, ctx, { aggregateType: 'property', aggregateId: propertyId, eventType: 'property.updated', payload: { propertyId, fields: ['media'] } });
    return (await listPropertyMedia(tx, propertyId)).map(toPropertyMediaDto);
  });
}
