import { z } from 'zod';
import type pg from 'pg';
import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { audit } from '../../platform/audit.js';
import { emit } from '../../platform/outbox.js';
import { hmacSha256, safeEqual, sha256 } from '../../platform/crypto.js';
import { conflict, notFound, unprocessable } from '../../platform/errors.js';
import { DEFAULT_LOCALE, ENTRY_PATHS, ENTRY_TYPES, createEntry, seoSchema, transitionEntry, updateEntry, type EntryType, type Seo } from './service.js';

/**
 * OPS-03 external content sources (cms_external_refs).
 * - PAYLOAD: Payload CMS pushes documents via a signed webhook (afterChange/afterDelete hooks).
 * - LEGACY_WONT / SIXSHOP: legacy content mapped manually by editors during migration (MIG-01).
 * JETPOOL's cms_entries remain the published copy served to the web app; publication never touches transaction data.
 */

export const EXTERNAL_SYSTEMS = ['PAYLOAD', 'LEGACY_WONT', 'SIXSHOP'] as const;
export type ExternalSystem = (typeof EXTERNAL_SYSTEMS)[number];
export const LEGACY_SYSTEMS = ['LEGACY_WONT', 'SIXSHOP'] as const;

export const SLUG_RE = /^[a-z0-9가-힣]+(?:-[a-z0-9가-힣]+)*$/;
const LOCALE_RE = /^[a-z]{2}-[A-Z]{2}$/;

// ---------------------------------------------------------------- signature (invariant 4)

/** `x-payload-signature: [sha256=]<hex HMAC-SHA256(PAYLOAD_WEBHOOK_SECRET, rawBody)>` */
export function signPayloadWebhook(secret: string, rawBody: string) {
  return `sha256=${hmacSha256(secret, rawBody)}`;
}

export function verifyPayloadSignature(secret: string, rawBody: string, header: string | string[] | undefined): boolean {
  const h = Array.isArray(header) ? header[0] : header;
  if (!h) return false;
  const sig = h.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  return safeEqual(sig, hmacSha256(secret, rawBody));
}

// ---------------------------------------------------------------- webhook body

/** Payload collection slug -> entry type (an explicit `doc.type` wins). */
export const PAYLOAD_COLLECTIONS: Record<string, EntryType> = {
  destinations: 'DESTINATION',
  stories: 'STORY',
  faqs: 'FAQ',
  promotions: 'PROMOTION',
  banners: 'BANNER',
  pages: 'PAGE',
  'legacy-content': 'LEGACY_CONTENT',
};

const metaImage = z.union([z.string().max(1000), z.object({ url: z.string().max(1000).nullish() })]);

export const payloadWebhookBody = z.object({
  event: z.string().max(50).optional(),
  operation: z.enum(['create', 'update', 'delete']).default('update'),
  collection: z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/),
  locale: z.string().regex(LOCALE_RE).optional(),
  doc: z.object({
    id: z.union([z.string().min(1).max(100), z.number().int()]),
    updatedAt: z.iso.datetime({ offset: true }),
    slug: z.string().max(120).optional(),
    title: z.string().max(300).optional(),
    type: z.enum(ENTRY_TYPES).optional(),
    _status: z.enum(['draft', 'published']).optional(),
    status: z.enum(['draft', 'published']).optional(),
    locale: z.string().regex(LOCALE_RE).optional(),
    summary: z.string().max(2000).nullish(),
    bodyMd: z.string().max(200_000).nullish(),
    /** markdown export of the rich-text field */
    content: z.string().max(200_000).nullish(),
    heroMediaId: z.uuid().nullish(),
    seo: seoSchema.optional(),
    /** @payloadcms/plugin-seo field group */
    meta: z.object({ title: z.string().max(200).nullish(), description: z.string().max(500).nullish(), image: metaImage.nullish() }).nullish(),
    data: z.record(z.string(), z.unknown()).optional(),
    url: z.string().max(2000).regex(/^https?:\/\/\S+$/i).optional(),
  }),
});
export type PayloadWebhookBody = z.infer<typeof payloadWebhookBody>;

function seoFrom(doc: PayloadWebhookBody['doc']): Seo | undefined {
  if (doc.seo) return doc.seo;
  if (!doc.meta) return undefined;
  const image = typeof doc.meta.image === 'string' ? doc.meta.image : doc.meta.image?.url ?? undefined;
  const seo = {
    title: doc.meta.title ?? undefined,
    description: doc.meta.description ?? undefined,
    og: image ? { image } : undefined,
  };
  const parsed = seoSchema.safeParse(seo);
  return parsed.success ? parsed.data : { title: seo.title, description: seo.description };
}

export interface PayloadIngestResult {
  received: true;
  duplicate?: boolean;
  ignored?: string;
  entryId?: string;
  action?: 'CREATED' | 'UPDATED' | 'LINKED' | 'ARCHIVED';
  status?: string;
}

/**
 * Upsert a Payload document as a cms entry. Idempotent per (external id, updatedAt) via webhook_events;
 * out-of-order deliveries older than the last applied revision are ignored. Errors roll back the whole
 * delivery (including its dedupe row) so Payload can retry.
 */
export async function ingestPayloadWebhook(pool: pg.Pool, ctx: Ctx, rawBody: string, body: PayloadWebhookBody): Promise<PayloadIngestResult> {
  const doc = body.doc;
  const locale = body.locale ?? doc.locale ?? DEFAULT_LOCALE;
  const externalId = `${body.collection}:${doc.id}:${locale}`;
  const updatedAt = new Date(doc.updatedAt);
  const deleted = body.operation === 'delete';
  const eventKey = `${externalId}@${updatedAt.toISOString()}${deleted ? '#delete' : ''}`;
  const status: 'PUBLISHED' | 'DRAFT' = (doc._status ?? doc.status) === 'published' ? 'PUBLISHED' : 'DRAFT';

  return withTx(pool, async (tx) => {
    // serialize deliveries of the same document
    await tx.query(`SELECT pg_advisory_xact_lock(hashtext('cms.payload:' || $1))`, [externalId]);
    const ins = await maybeOne<{ id: string }>(
      tx,
      `INSERT INTO webhook_events(provider, external_event_id, event_type, payload_hash, payload, signature_valid)
       VALUES ('PAYLOAD',$1,$2,$3,$4,true) ON CONFLICT (provider, external_event_id) DO NOTHING RETURNING id`,
      [
        eventKey.slice(0, 500),
        `${body.collection}.${body.operation}`.slice(0, 100),
        sha256(rawBody),
        // compact summary only (bodies can be large; content lives in cms_entries)
        JSON.stringify({ collection: body.collection, operation: body.operation, docId: doc.id, locale, slug: doc.slug ?? null, status, updatedAt: updatedAt.toISOString() }),
      ],
    );
    if (!ins) return { received: true, duplicate: true };
    const done = (error: string | null) => tx.query(`UPDATE webhook_events SET processed_at = now(), process_error = $2 WHERE id = $1`, [ins.id, error]);

    const type = doc.type ?? PAYLOAD_COLLECTIONS[body.collection];
    if (!type) {
      await done('UNKNOWN_COLLECTION');
      return { received: true, ignored: 'UNKNOWN_COLLECTION' };
    }
    const ref = await maybeOne(
      tx,
      `SELECT r.*, e.entry_type, e.status AS entry_status FROM cms_external_refs r JOIN cms_entries e ON e.id = r.entry_id
        WHERE r.system = 'PAYLOAD' AND r.external_id = $1 FOR UPDATE OF r`,
      [externalId],
    );
    if (ref?.source_updated_at && new Date(ref.source_updated_at) > updatedAt) {
      await done('STALE_REVISION');
      return { received: true, ignored: 'STALE_REVISION', entryId: ref.entry_id };
    }

    const saveRef = async (entryId: string) => {
      await tx.query(
        `INSERT INTO cms_external_refs(entry_id, system, external_id, external_url, source_updated_at, synced_at) VALUES ($1,'PAYLOAD',$2,$3,$4,now())
         ON CONFLICT (system, external_id) DO UPDATE SET entry_id = EXCLUDED.entry_id, external_url = coalesce(EXCLUDED.external_url, cms_external_refs.external_url),
           source_updated_at = EXCLUDED.source_updated_at, synced_at = now()`,
        [entryId, externalId, doc.url ?? null, updatedAt],
      );
    };

    if (deleted) {
      if (!ref) {
        await done('UNKNOWN_DOCUMENT');
        return { received: true, ignored: 'UNKNOWN_DOCUMENT' };
      }
      if (ref.entry_status !== 'ARCHIVED') await transitionEntry(tx, ctx, ref.entry_id, 'ARCHIVED', 'deleted in Payload');
      await saveRef(ref.entry_id);
      await audit(tx, ctx, { action: 'cms.external_ref.synced', resourceType: 'cms_entry', resourceId: ref.entry_id, after: { system: 'PAYLOAD', externalId, action: 'ARCHIVED', updatedAt }, category: 'CONTENT' });
      await done(null);
      return { received: true, entryId: ref.entry_id, action: 'ARCHIVED', status: 'ARCHIVED' };
    }

    if (!doc.slug || !SLUG_RE.test(doc.slug)) throw unprocessable('INVALID_SLUG', 'Payload document needs a kebab-case slug');
    if (!doc.title?.trim()) throw unprocessable('TITLE_REQUIRED', 'Payload document needs a title');
    const input = {
      slug: doc.slug,
      locale,
      title: doc.title.trim(),
      // absent keys keep the current value; explicit null clears it
      summary: doc.summary,
      bodyMd: doc.bodyMd !== undefined ? doc.bodyMd : doc.content,
      heroMediaId: doc.heroMediaId,
      seo: seoFrom(doc),
      data: doc.data,
    };

    let entryId: string;
    let action: 'CREATED' | 'UPDATED' | 'LINKED';
    if (ref) {
      if (ref.entry_type !== type) throw conflict('ENTRY_TYPE_CHANGED', 'The Payload document changed its content type; archive it and create a new one');
      await updateEntry(tx, ctx, ref.entry_id, input);
      entryId = ref.entry_id;
      action = 'UPDATED';
    } else {
      const existing = await maybeOne(
        tx,
        `SELECT e.id, e.status, r.external_id AS payload_ref FROM cms_entries e
           LEFT JOIN cms_external_refs r ON r.entry_id = e.id AND r.system = 'PAYLOAD'
          WHERE e.entry_type = $1 AND e.slug = $2 AND e.locale = $3 FOR UPDATE OF e`,
        [type, input.slug, locale],
      );
      if (existing) {
        // adopt an editor-created entry (or one whose Payload document was deleted); never steal a live mapping
        if (existing.payload_ref && existing.status !== 'ARCHIVED') throw conflict('SLUG_CONFLICT', 'Another Payload document already owns this slug');
        if (existing.payload_ref) await tx.query(`DELETE FROM cms_external_refs WHERE system = 'PAYLOAD' AND external_id = $1`, [existing.payload_ref]);
        await updateEntry(tx, ctx, existing.id, input);
        entryId = existing.id;
        action = 'LINKED';
      } else {
        entryId = (await createEntry(tx, ctx, { type, ...input })).id;
        action = 'CREATED';
      }
    }

    const cur = (await one<{ status: string }>(tx, `SELECT status FROM cms_entries WHERE id = $1`, [entryId])).status;
    if (cur !== status) {
      if (cur === 'ARCHIVED' && status === 'PUBLISHED') await transitionEntry(tx, ctx, entryId, 'DRAFT', 'restored from Payload');
      await transitionEntry(tx, ctx, entryId, status, `Payload ${body.operation}`);
    } else if (status === 'PUBLISHED') {
      // live content changed: re-announce so caches / ISR pages revalidate
      await emit(tx, ctx, {
        aggregateType: 'cms_entry',
        aggregateId: entryId,
        eventType: 'content.published',
        payload: { entryId, type, slug: input.slug, locale, path: ENTRY_PATHS[type]?.(input.slug) ?? null, republished: true },
      });
    }
    await saveRef(entryId);
    await audit(tx, ctx, { action: 'cms.external_ref.synced', resourceType: 'cms_entry', resourceId: entryId, after: { system: 'PAYLOAD', externalId, action, status, updatedAt }, category: 'CONTENT' });
    await done(null);
    return { received: true, entryId, action, status };
  });
}

// ---------------------------------------------------------------- admin: refs

export const toRefDto = (r: any) => ({
  entryId: r.entry_id,
  system: r.system,
  externalId: r.external_id,
  externalUrl: r.external_url,
  sourceUpdatedAt: r.source_updated_at,
  syncedAt: r.synced_at,
  createdAt: r.created_at,
  entry: r.entry_type ? { type: r.entry_type, slug: r.slug, locale: r.locale, title: r.title, status: r.status } : undefined,
});

export async function listExternalRefs(db: Db, f: { system?: ExternalSystem; entryId?: string; externalId?: string; limit: number; offset: number }) {
  const rows = await q(
    db,
    `SELECT r.*, e.entry_type, e.slug, e.locale, e.title, e.status FROM cms_external_refs r JOIN cms_entries e ON e.id = r.entry_id
      WHERE ($1::text IS NULL OR r.system = $1) AND ($2::uuid IS NULL OR r.entry_id = $2) AND ($3::text IS NULL OR r.external_id = $3)
      ORDER BY r.synced_at DESC, r.system, r.external_id LIMIT $4 OFFSET $5`,
    [f.system ?? null, f.entryId ?? null, f.externalId ?? null, f.limit, f.offset],
  );
  return rows.map(toRefDto);
}

/** Editors map legacy (WONT / SixShop) content to an entry. Payload refs are only created by the signed webhook. */
export async function linkLegacyRef(tx: Tx, ctx: Ctx, entryId: string, input: { system: (typeof LEGACY_SYSTEMS)[number]; externalId: string; externalUrl?: string | null }) {
  const entry = await maybeOne(tx, `SELECT id FROM cms_entries WHERE id = $1 FOR UPDATE`, [entryId]);
  if (!entry) throw notFound('Content entry');
  const taken = await maybeOne(tx, `SELECT entry_id FROM cms_external_refs WHERE system = $1 AND external_id = $2`, [input.system, input.externalId]);
  if (taken && taken.entry_id !== entryId) throw conflict('EXTERNAL_REF_TAKEN', 'This external id is already mapped to another entry');
  const other = await maybeOne(tx, `SELECT external_id FROM cms_external_refs WHERE entry_id = $1 AND system = $2`, [entryId, input.system]);
  if (other && other.external_id !== input.externalId) throw conflict('ENTRY_ALREADY_MAPPED', `The entry is already mapped to another ${input.system} id`);
  const row = await one(
    tx,
    `INSERT INTO cms_external_refs(entry_id, system, external_id, external_url) VALUES ($1,$2,$3,$4)
     ON CONFLICT (system, external_id) DO UPDATE SET external_url = coalesce(EXCLUDED.external_url, cms_external_refs.external_url), synced_at = now()
     RETURNING *, (xmax = 0) AS inserted`,
    [entryId, input.system, input.externalId, input.externalUrl ?? null],
  );
  await audit(tx, ctx, { action: 'cms.external_ref.linked', resourceType: 'cms_entry', resourceId: entryId, after: { system: input.system, externalId: input.externalId }, category: 'CONTENT' });
  return { created: !!row.inserted, item: toRefDto(row) };
}
