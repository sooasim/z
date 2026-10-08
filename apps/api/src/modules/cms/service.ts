import { z } from 'zod';
import type { Db } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { audit } from '../../platform/audit.js';
import { emit } from '../../platform/outbox.js';
import { StateMachine } from '../../platform/fsm.js';
import { badRequest, notFound } from '../../platform/errors.js';
import { cursorColumns, decodeCursor, page } from '../../platform/http.js';

/** OPS-03 content & SEO. Content publication is separated from transaction truth. */

export const ENTRY_TYPES = ['DESTINATION', 'STORY', 'FAQ', 'PROMOTION', 'BANNER', 'PAGE', 'LEGACY_CONTENT'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];
export type EntryStatus = 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
export const DEFAULT_LOCALE = 'ko-KR';

export const cmsFsm = new StateMachine<EntryStatus>('CmsEntry', {
  DRAFT: ['PUBLISHED', 'ARCHIVED'],
  PUBLISHED: ['DRAFT', 'ARCHIVED'],
  ARCHIVED: ['DRAFT'],
});

/** Public URL path for each entry type (apps/web route map). */
export const ENTRY_PATHS: Record<EntryType, ((slug: string) => string) | null> = {
  DESTINATION: (s) => `/discover/${s}`,
  STORY: (s) => `/stories/${s}`,
  LEGACY_CONTENT: (s) => `/stories/${s}`,
  FAQ: (s) => `/faq/${s}`,
  PAGE: (s) => `/p/${s}`,
  PROMOTION: (s) => `/promotions/${s}`,
  BANNER: null,
};

export function parseEntryType(raw: string): EntryType {
  const t = raw.toUpperCase().replace(/-/g, '_');
  const alias: Record<string, EntryType> = { DESTINATIONS: 'DESTINATION', STORIES: 'STORY', FAQS: 'FAQ', PROMOTIONS: 'PROMOTION', BANNERS: 'BANNER', PAGES: 'PAGE', LEGACY: 'LEGACY_CONTENT' };
  const v = (alias[t] ?? t) as EntryType;
  if (!(ENTRY_TYPES as readonly string[]).includes(v)) throw notFound('Content type');
  return v;
}

// ---------------------------------------------------------------- structured SEO + JSON-LD

const sitePathOrUrl = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => (v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') && !/[\r\n]/.test(v)) || /^https?:\/\/[^\s]+$/i.test(v), 'site-relative path or absolute http(s) URL');

/** cms_entries.seo: {title, description, canonical, noindex, keywords, og:{title, description, image, imageAlt, type}} */
export const seoSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(500).optional(),
  canonical: sitePathOrUrl(500).optional(),
  noindex: z.boolean().optional(),
  keywords: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
  og: z
    .object({
      title: z.string().max(200).optional(),
      description: z.string().max(500).optional(),
      image: sitePathOrUrl(1000).optional(),
      imageAlt: z.string().max(300).optional(),
      type: z.enum(['website', 'article', 'place']).optional(),
    })
    .strict()
    .optional(),
});
export type Seo = z.infer<typeof seoSchema>;

const absUrl = (baseUrl: string, pathOrUrl: string | undefined | null) =>
  !pathOrUrl ? undefined : /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${baseUrl.replace(/\/$/, '')}${pathOrUrl}`;

const str = (v: unknown, max = 5000) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);

/** FAQ items from data.faqs | data.questions | data.items ([{question|q, answer|a}]); falls back to title/summary. */
function faqItems(r: any): Array<{ question: string; answer: string }> {
  const d = r.data ?? {};
  const raw = [d.faqs, d.questions, d.items].find((x) => Array.isArray(x)) as any[] | undefined;
  const items = (raw ?? [])
    .map((x) => ({ question: str(x?.question ?? x?.q, 500), answer: str(x?.answer ?? x?.a) }))
    .filter((x): x is { question: string; answer: string } => !!x.question && !!x.answer)
    .slice(0, 100);
  if (items.length) return items;
  const answer = str(r.summary) ?? str(r.body_md);
  return answer ? [{ question: String(r.title).slice(0, 500), answer }] : [];
}

/**
 * schema.org JSON-LD hints for the web app (`data.jsonLd`): TouristDestination for DESTINATION, FAQPage for FAQ.
 * Always computed from the entry (never echoed from editor input) so the <script type="application/ld+json"> stays well-formed.
 */
export function jsonLdFor(r: any, baseUrl: string): Record<string, unknown> | null {
  const type = r.entry_type as EntryType;
  if (type !== 'DESTINATION' && type !== 'FAQ') return null;
  const seo = r.seo ?? {};
  const d = r.data ?? {};
  const url = absUrl(baseUrl, str(seo.canonical, 500) ?? ENTRY_PATHS[type]?.(r.slug));
  if (type === 'DESTINATION') {
    const lat = num(d.lat ?? d.latitude);
    const lng = num(d.lng ?? d.longitude);
    const touristType = Array.isArray(d.touristType) ? d.touristType.map((x: unknown) => str(x, 100)).filter(Boolean).slice(0, 20) : undefined;
    return {
      '@context': 'https://schema.org',
      '@type': 'TouristDestination',
      name: r.title,
      description: str(seo.description, 500) ?? str(r.summary, 500),
      url,
      inLanguage: r.locale,
      image: absUrl(baseUrl, str(seo.og?.image, 1000)),
      ...(lat !== undefined && lng !== undefined && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { geo: { '@type': 'GeoCoordinates', latitude: lat, longitude: lng } } : {}),
      ...(touristType?.length ? { touristType } : {}),
      ...(str(d.region, 200) ? { containedInPlace: { '@type': 'Place', name: str(d.region, 200) } } : {}),
    };
  }
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    name: r.title,
    url,
    inLanguage: r.locale,
    mainEntity: faqItems(r).map((x) => ({ '@type': 'Question', name: x.question, acceptedAnswer: { '@type': 'Answer', text: x.answer } })),
  };
}

/** Public content DTO: entry + computed `data.jsonLd` (DESTINATION/FAQ); editor-supplied `data.jsonLd` is never echoed. */
export function toPublicEntryDto(r: any, baseUrl: string) {
  const dto = toEntryDto(r);
  const { jsonLd: _editorJsonLd, ...data } = (r.data ?? {}) as Record<string, unknown>;
  const jsonLd = jsonLdFor(r, baseUrl);
  return { ...dto, data: jsonLd ? { ...data, jsonLd } : data };
}

export const toEntryDto = (r: any) => ({
  id: r.id,
  type: r.entry_type,
  slug: r.slug,
  locale: r.locale,
  title: r.title,
  summary: r.summary,
  bodyMd: r.body_md,
  heroMediaId: r.hero_media_id,
  seo: r.seo,
  data: r.data,
  status: r.status,
  publishedAt: r.published_at,
  updatedAt: r.updated_at,
  path: ENTRY_PATHS[r.entry_type as EntryType]?.(r.slug) ?? null,
});

export interface EntryInput {
  type: EntryType;
  slug: string;
  locale?: string;
  title: string;
  summary?: string | null;
  bodyMd?: string | null;
  heroMediaId?: string | null;
  seo?: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export async function createEntry(db: Db, ctx: Ctx, input: EntryInput) {
  const row = await one(
    db,
    `INSERT INTO cms_entries(entry_type, slug, locale, title, summary, body_md, hero_media_id, seo, data, author_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [input.type, input.slug, input.locale ?? DEFAULT_LOCALE, input.title, input.summary ?? null, input.bodyMd ?? null, input.heroMediaId ?? null, JSON.stringify(input.seo ?? {}), JSON.stringify(input.data ?? {}), ctx.actor?.userId ?? null],
  );
  await audit(db, ctx, { action: 'cms.entry.created', resourceType: 'cms_entry', resourceId: row.id, after: { type: row.entry_type, slug: row.slug, locale: row.locale }, category: 'CONTENT' });
  return row;
}

export async function updateEntry(db: Db, ctx: Ctx, id: string, patch: Partial<Omit<EntryInput, 'type'>>) {
  const before = await maybeOne(db, `SELECT * FROM cms_entries WHERE id = $1 FOR UPDATE`, [id]);
  if (!before) throw notFound('Content entry');
  const row = await one(
    db,
    `UPDATE cms_entries SET slug = coalesce($2, slug), locale = coalesce($3, locale), title = coalesce($4, title),
        summary = CASE WHEN $5::boolean THEN $6 ELSE summary END, body_md = CASE WHEN $7::boolean THEN $8 ELSE body_md END,
        hero_media_id = CASE WHEN $9::boolean THEN $10::uuid ELSE hero_media_id END,
        seo = coalesce($11, seo), data = coalesce($12, data), updated_at = now()
      WHERE id = $1 RETURNING *`,
    [
      id,
      patch.slug ?? null,
      patch.locale ?? null,
      patch.title ?? null,
      patch.summary !== undefined,
      patch.summary ?? null,
      patch.bodyMd !== undefined,
      patch.bodyMd ?? null,
      patch.heroMediaId !== undefined,
      patch.heroMediaId ?? null,
      patch.seo ? JSON.stringify(patch.seo) : null,
      patch.data ? JSON.stringify(patch.data) : null,
    ],
  );
  await audit(db, ctx, { action: 'cms.entry.updated', resourceType: 'cms_entry', resourceId: id, before: { title: before.title, slug: before.slug }, after: { title: row.title, slug: row.slug }, category: 'CONTENT' });
  return row;
}

export async function transitionEntry(db: Db, ctx: Ctx, id: string, to: EntryStatus, reason?: string) {
  const res = await cmsFsm.transition(db, ctx, {
    table: 'cms_entries',
    id,
    to,
    reason,
    set: to === 'PUBLISHED' ? { published_at: new Date(), updated_at: new Date() } : { updated_at: new Date() },
  });
  await audit(db, ctx, { action: `cms.entry.${to.toLowerCase()}`, resourceType: 'cms_entry', resourceId: id, before: { status: res.from }, after: { status: to }, reason, category: 'CONTENT' });
  if (to === 'PUBLISHED') {
    await emit(db, ctx, {
      aggregateType: 'cms_entry',
      aggregateId: id,
      eventType: 'content.published',
      payload: { entryId: id, type: res.row.entry_type, slug: res.row.slug, locale: res.row.locale, path: ENTRY_PATHS[res.row.entry_type as EntryType]?.(res.row.slug) ?? null },
    });
  }
  return res.row;
}

export async function adminListEntries(db: Db, f: { type?: EntryType; status?: EntryStatus; locale?: string; limit: number }) {
  return q(
    db,
    `SELECT * FROM cms_entries WHERE ($1::text IS NULL OR entry_type = $1) AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR locale = $3)
      ORDER BY updated_at DESC LIMIT $4`,
    [f.type ?? null, f.status ?? null, f.locale ?? null, f.limit],
  );
}

/**
 * Published entries in `locale` (falling back per slug to ko-KR), newest first, keyset-paginated on
 * (coalesce(published_at, created_at), id). The locale fallback (DISTINCT ON slug) runs first and the ORDER/LIMIT
 * applies to its result: limiting inside the DISTINCT ON returned the alphabetically first N slugs, so newer
 * entries with late slugs ('zoo-…', Hangul) never appeared.
 */
export async function pagePublished(db: Db, type: EntryType, locale: string, limit: number, cursor?: string) {
  const c = decodeCursor(cursor);
  const rows = await q(
    db,
    `SELECT x.*, ${cursorColumns('x', 'sort_at')} FROM (
        SELECT DISTINCT ON (slug) *, coalesce(published_at, created_at) AS sort_at FROM cms_entries
         WHERE entry_type = $1 AND status = 'PUBLISHED' AND locale = ANY($2::text[])
         ORDER BY slug, (locale = $3) DESC
      ) x
      WHERE ($5::timestamptz IS NULL OR (x.sort_at, x.id) < ($5::timestamptz, $6::uuid))
      ORDER BY x.sort_at DESC, x.id DESC LIMIT $4`,
    [type, [locale, DEFAULT_LOCALE], locale, limit + 1, c?.createdAt ?? null, c?.id ?? null],
  );
  const res = page(rows, limit);
  return { items: res.items.map(({ sort_at: _s, ...rest }: any) => rest), nextCursor: res.nextCursor };
}

/** First page of published entries (newest first). */
export async function listPublished(db: Db, type: EntryType, locale: string, limit: number) {
  return (await pagePublished(db, type, locale, limit)).items;
}

export async function getPublished(db: Db, type: EntryType, slug: string, locale: string) {
  const row = await maybeOne(
    db,
    `SELECT * FROM cms_entries WHERE entry_type = $1 AND slug = $2 AND status = 'PUBLISHED' AND locale = ANY($3::text[])
      ORDER BY (locale = $4) DESC LIMIT 1`,
    [type, slug, [locale, DEFAULT_LOCALE], locale],
  );
  if (!row) throw notFound('Content');
  return row;
}

// ---------------------------------------------------------------- redirects

/** Canonical legacy path: leading slash, no trailing slash (except root), no fragment; query preserved. */
export function normalizePath(input: string): string {
  let s = input.trim();
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      s = u.pathname + u.search;
    }
  } catch {
    /* keep raw */
  }
  s = s.split('#')[0];
  let [p, qs] = s.split('?', 2) as [string, string | undefined];
  try {
    p = decodeURI(p);
  } catch {
    /* leave encoded */
  }
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return qs ? `${p}?${qs}` : p;
}

/** Only same-site relative targets are accepted (no open redirects). */
export function assertSafeTarget(target: string) {
  if (!target.startsWith('/') || target.startsWith('//') || /[\r\n]/.test(target) || /^\/\\/.test(target)) {
    throw badRequest('UNSAFE_REDIRECT_TARGET', 'Redirect targets must be site-relative paths starting with a single /');
  }
}

/** Resolve an approved redirect, counting hits. Tries exact path+query first, then path without query. */
export async function resolveRedirect(db: Db, rawPath: string) {
  const path = normalizePath(rawPath);
  const candidates = path.includes('?') ? [path, path.split('?')[0]] : [path];
  const row = await maybeOne<{ legacy_path: string; target_path: string; status_code: number }>(
    db,
    `UPDATE seo_redirects SET hits = hits + 1
      WHERE legacy_path = (SELECT legacy_path FROM seo_redirects WHERE legacy_path = ANY($1::text[]) AND approved
                            ORDER BY array_position($1::text[], legacy_path) LIMIT 1)
      RETURNING legacy_path, target_path, status_code`,
    [candidates],
  );
  if (!row) throw notFound('Redirect');
  return { legacyPath: row.legacy_path, targetPath: row.target_path, statusCode: row.status_code };
}

export interface RedirectInput { legacyPath: string; targetPath: string; statusCode?: 301 | 302 | 307 | 308; approved?: boolean }

export async function upsertRedirects(db: Db, ctx: Ctx, items: RedirectInput[], opts: { source?: string; canApprove: boolean }) {
  const results = { inserted: 0, updated: 0, unchanged: 0, errors: [] as Array<{ index: number; legacyPath: string; error: string }> };
  const seen = new Set<string>();
  for (const [i, it] of items.entries()) {
    const legacy = normalizePath(it.legacyPath);
    try {
      assertSafeTarget(it.targetPath);
      if (seen.has(legacy)) throw badRequest('DUPLICATE_IN_BATCH', 'Duplicate legacy path in batch');
      if (normalizePath(it.targetPath) === legacy) throw badRequest('REDIRECT_LOOP', 'Target equals legacy path');
      seen.add(legacy);
    } catch (e: any) {
      results.errors.push({ index: i, legacyPath: legacy, error: e.code ?? String(e) });
      continue;
    }
    const approved = opts.canApprove ? !!it.approved : false;
    const r = await maybeOne<{ inserted: boolean; changed: boolean }>(
      db,
      `WITH prev AS (SELECT target_path, status_code, approved FROM seo_redirects WHERE legacy_path = $1)
       INSERT INTO seo_redirects(legacy_path, target_path, status_code, approved, source) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (legacy_path) DO UPDATE SET target_path = EXCLUDED.target_path, status_code = EXCLUDED.status_code,
         approved = CASE WHEN seo_redirects.target_path = EXCLUDED.target_path THEN (seo_redirects.approved OR EXCLUDED.approved) ELSE EXCLUDED.approved END,
         source = coalesce(EXCLUDED.source, seo_redirects.source), updated_at = now()
       RETURNING (xmax = 0) AS inserted,
         ((SELECT target_path FROM prev) IS DISTINCT FROM target_path OR (SELECT status_code FROM prev) IS DISTINCT FROM status_code
          OR (SELECT approved FROM prev) IS DISTINCT FROM approved) AS changed`,
      [legacy, it.targetPath, it.statusCode ?? 301, approved, opts.source ?? null],
    );
    if (r?.inserted) results.inserted++;
    else if (r?.changed) results.updated++;
    else results.unchanged++;
  }
  await audit(db, ctx, {
    action: 'seo.redirects.upserted',
    resourceType: 'seo_redirect',
    after: { count: items.length, inserted: results.inserted, updated: results.updated, errors: results.errors.length, source: opts.source ?? null },
    category: 'CONTENT',
  });
  return results;
}

export async function approveRedirects(db: Db, ctx: Ctx, paths: string[], approved: boolean) {
  const norm = paths.map(normalizePath);
  const rows = await q(db, `UPDATE seo_redirects SET approved = $2, updated_at = now() WHERE legacy_path = ANY($1::text[]) RETURNING legacy_path`, [norm, approved]);
  await audit(db, ctx, { action: approved ? 'seo.redirects.approved' : 'seo.redirects.unapproved', resourceType: 'seo_redirect', after: { paths: rows.map((r) => r.legacy_path) }, category: 'CONTENT' });
  return { updated: rows.length };
}

export async function deleteRedirect(db: Db, ctx: Ctx, path: string) {
  const row = await maybeOne(db, `DELETE FROM seo_redirects WHERE legacy_path = $1 RETURNING *`, [normalizePath(path)]);
  if (!row) throw notFound('Redirect');
  await audit(db, ctx, { action: 'seo.redirect.deleted', resourceType: 'seo_redirect', resourceId: row.legacy_path, before: row, category: 'CONTENT' });
  return row;
}

export async function listRedirects(db: Db, f: { approved?: boolean; prefix?: string; limit: number; offset: number }) {
  return q(
    db,
    `SELECT * FROM seo_redirects WHERE ($1::boolean IS NULL OR approved = $1) AND ($2::text IS NULL OR starts_with(legacy_path, $2))
      ORDER BY legacy_path LIMIT $3 OFFSET $4`,
    [f.approved ?? null, f.prefix ?? null, f.limit, f.offset],
  );
}

// ---------------------------------------------------------------- sitemap

export async function sitemap(db: Db, baseUrl: string) {
  const items: Array<{ loc: string; lastmod: string | null; type: string }> = [];
  const add = (path: string, lastmod: any, type: string) =>
    items.push({ loc: `${baseUrl.replace(/\/$/, '')}${path}`, lastmod: lastmod ? new Date(lastmod).toISOString() : null, type });
  for (const p of await q(db, `SELECT id, slug, updated_at FROM properties WHERE status = 'PUBLISHED' ORDER BY published_at DESC NULLS LAST LIMIT 45000`)) add(`/stay/${p.slug ?? p.id}`, p.updated_at, 'property');
  for (const g of await q(db, `SELECT user_id, updated_at FROM guide_profiles WHERE status = 'PUBLISHED' ORDER BY updated_at DESC LIMIT 20000`)) add(`/guide-friends/${g.user_id}`, g.updated_at, 'guide');
  for (const t of await q(db, `SELECT id, slug, updated_at FROM travel_products WHERE status = 'PUBLISHED' ORDER BY updated_at DESC LIMIT 20000`)) add(`/travel/${t.slug ?? t.id}`, t.updated_at, 'travel_product');
  for (const e of await q(db, `SELECT DISTINCT ON (entry_type, slug) entry_type, slug, updated_at FROM cms_entries WHERE status = 'PUBLISHED' ORDER BY entry_type, slug, updated_at DESC`)) {
    const path = ENTRY_PATHS[e.entry_type as EntryType]?.(e.slug);
    if (path) add(path, e.updated_at, 'content');
  }
  return { items, count: items.length };
}
