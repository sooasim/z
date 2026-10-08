import type { AppContext, Ctx } from '../../platform/context.js';
import type { Db } from '../../platform/db.js';
import { maybeOne, q, withTx } from '../../platform/db.js';
import { badRequest } from '../../platform/errors.js';
import { isCalendarDate } from '../../platform/http.js';
import { emit, type DomainEvent } from '../../platform/outbox.js';
import { fuzzPublic } from '../geo/service.js';
import { StaticGeocoder } from '../geo/geocoder.js';
import { PROPERTY_INDEX, SEARCH_ADAPTER, type PropertyDoc, type SearchAdapter, type SearchQuery } from './adapter.js';
import { PgSearchAdapter } from './pg-adapter.js';
import { MeiliSearchAdapter } from './meili-adapter.js';

export function createSearchAdapter(app: Pick<AppContext, 'config'>): SearchAdapter {
  return app.config.MEILI_HOST ? new MeiliSearchAdapter(app.config.MEILI_HOST, app.config.MEILI_API_KEY) : new PgSearchAdapter();
}

export function searchAdapterOf(app: AppContext): SearchAdapter {
  let a = app.adapters.get(SEARCH_ADAPTER) as SearchAdapter | undefined;
  if (!a) {
    a = createSearchAdapter(app);
    app.adapters.set(SEARCH_ADAPTER, a);
  }
  return a;
}

/** Build the projection document from source tables; null when the property must not be searchable. */
export async function buildPropertyDocument(db: Db, propertyId: string): Promise<PropertyDoc | null> {
  const p = await maybeOne(db, `SELECT * FROM properties WHERE id = $1`, [propertyId]);
  if (!p || p.status !== 'PUBLISHED') return null;
  const addr = await maybeOne(db, `SELECT public_area_label FROM property_addresses WHERE property_id = $1`, [propertyId]);
  const amenities = await q(db, `SELECT a.code, a.label_ko, a.label_en FROM property_amenities pa JOIN amenities a ON a.code = pa.amenity_code WHERE pa.property_id = $1 ORDER BY a.code`, [propertyId]);
  const media = await q(
    db,
    `SELECT m.public_url FROM property_media pm JOIN media_assets m ON m.id = pm.media_id
      WHERE pm.property_id = $1 AND m.status = 'READY' AND m.visibility = 'PUBLIC' AND m.public_url IS NOT NULL ORDER BY pm.sort_order LIMIT 8`,
    [propertyId],
  );
  const rep = await maybeOne(db, `SELECT review_count, rating_avg FROM reputation_scores WHERE target_type = 'PROPERTY' AND target_id = $1`, [propertyId]);
  const coords = p.lat !== null && p.lng !== null ? fuzzPublic(p.id, Number(p.lat), Number(p.lng)) : null;
  const amenityLabels = amenities.flatMap((a) => [a.label_ko, a.label_en]);
  const areaLabel = addr?.public_area_label ?? null;
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    summary: p.summary,
    city: p.city,
    region: p.region,
    country: p.country,
    areaLabel,
    propertyType: p.property_type,
    roomType: p.room_type,
    maxGuests: p.max_guests,
    bedrooms: p.bedrooms,
    beds: p.beds,
    bathrooms: Number(p.bathrooms),
    priceMinor: p.rental_enabled ? p.base_price_minor : null,
    currency: p.currency,
    rentalEnabled: p.rental_enabled,
    paidBookingEnabled: p.paid_booking_enabled,
    exchangeEnabled: p.exchange_enabled,
    instantBook: p.instant_book,
    amenities: amenities.map((a) => a.code),
    amenityLabels,
    coverUrl: media[0]?.public_url ?? null,
    photoUrls: media.map((m) => m.public_url),
    ratingAvg: rep?.rating_avg ?? null,
    reviewCount: rep?.review_count ?? 0,
    lat: coords?.lat ?? null,
    lng: coords?.lng ?? null,
    minNights: p.min_nights,
    maxNights: p.max_nights,
    publishedAt: p.published_at ? new Date(p.published_at).toISOString() : null,
    publishedAtTs: p.published_at ? new Date(p.published_at).getTime() : 0,
    hostId: p.host_id,
    searchText: [p.title, p.summary, (p.description ?? '').slice(0, 2000), p.city, p.region, areaLabel, p.property_type, ...amenityLabels].filter(Boolean).join(' '),
  };
}

/**
 * Mark a document for projection. search_sync_state.source_version only moves forward and is computed IN SQL at
 * full (microsecond) precision as greatest(stored, event version, properties.updated_at): JS Dates truncate to
 * milliseconds, which made `source_version < updated_at` true forever (reconcile never converged). The row lock
 * taken here also serialises concurrent projections of the same document.
 */
async function claimProjection(db: Db, propertyId: string, sourceVersion?: Date | string | null) {
  await db.query(
    `INSERT INTO search_sync_state(index_name, document_id, source_version, status)
     VALUES ($1, $2, greatest(coalesce($3::timestamptz, now()), coalesce((SELECT updated_at FROM properties WHERE id = $4::uuid), now())), 'PENDING')
     ON CONFLICT (index_name, document_id) DO UPDATE SET source_version = greatest(search_sync_state.source_version, EXCLUDED.source_version),
       status = 'PENDING', error = NULL`,
    [PROPERTY_INDEX, propertyId, sourceVersion ?? null, propertyId],
  );
}

/**
 * Project one property from the CURRENT source rows (never from event payloads), so applying events late or out of
 * order is harmless: a late event re-projects the latest state instead of being skipped (an event emitted by a long
 * transaction carries an OLDER timestamp than ones committed meanwhile — skipping it left stale documents).
 * Transactional adapters (PostgreSQL) are written in `db`'s transaction; external engines only get the document
 * marked PENDING here and are fed by flushPendingProjections outside any transaction.
 * Returns 'SYNCED' | 'DELETED' (applied) or 'PENDING' (deferred to the flush).
 */
export async function projectProperty(db: Db, app: AppContext, propertyId: string, sourceVersion?: Date | string | null) {
  await claimProjection(db, propertyId, sourceVersion);
  const adapter = searchAdapterOf(app);
  if (!adapter.transactional) return 'PENDING' as const;
  const doc = await buildPropertyDocument(db, propertyId);
  if (doc) await adapter.upsert(db, [doc]);
  else await adapter.remove(db, [propertyId]);
  const status = doc ? 'SYNCED' : 'DELETED';
  await db.query(`UPDATE search_sync_state SET status = $3, synced_at = now() WHERE index_name = $1 AND document_id = $2`, [PROPERTY_INDEX, propertyId, status]);
  return status as 'SYNCED' | 'DELETED';
}

const FLUSH_LOCK = 'jetpool:search.flush';

/**
 * Push PENDING documents to the search engine OUTSIDE any transaction (one flusher at a time across replicas, so
 * pushes stay ordered). Each document is built from the current rows and the row is marked SYNCED/DELETED only if
 * its version did not move meanwhile (otherwise it stays PENDING for the next run). Engine errors mark it FAILED
 * (picked up again by flush / reconcile) — they never block the outbox.
 */
export async function flushPendingProjections(app: AppContext, limit = 200): Promise<{ synced: number; deleted: number; failed: number; skipped?: boolean }> {
  const adapter = searchAdapterOf(app);
  const out = { synced: 0, deleted: 0, failed: 0 };
  const conn = await app.pool.connect();
  let locked = false;
  try {
    locked = (await conn.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [FLUSH_LOCK])).rows[0].ok === true;
    if (!locked) return { ...out, skipped: true };
    const rows = await q<{ id: string; v: string }>(
      app.pool,
      `SELECT document_id AS id, source_version::text AS v FROM search_sync_state
        WHERE index_name = $1 AND status IN ('PENDING','FAILED') ORDER BY source_version, document_id LIMIT $2`,
      [PROPERTY_INDEX, limit],
    );
    let consecutiveFailures = 0;
    for (const r of rows) {
      if (consecutiveFailures >= 3) break; // engine looks down: leave the rest for the next run (no hammering)
      try {
        if (adapter.transactional) {
          const st = await withTx(app.pool, (tx) => projectProperty(tx, app, r.id, r.v));
          if (st === 'SYNCED') out.synced++;
          else if (st === 'DELETED') out.deleted++;
          continue;
        }
        const doc = await buildPropertyDocument(app.pool, r.id);
        if (doc) await adapter.upsert(app.pool, [doc]);
        else await adapter.remove(app.pool, [r.id]);
        const st = doc ? 'SYNCED' : 'DELETED';
        await app.pool.query(
          `UPDATE search_sync_state SET status = $3, synced_at = now(), error = NULL
            WHERE index_name = $1 AND document_id = $2 AND status IN ('PENDING','FAILED') AND source_version = $4::timestamptz`,
          [PROPERTY_INDEX, r.id, st, r.v],
        );
        if (doc) out.synced++;
        else out.deleted++;
        consecutiveFailures = 0;
      } catch (err) {
        out.failed++;
        consecutiveFailures++;
        await app.pool
          .query(`UPDATE search_sync_state SET status = 'FAILED', error = $3 WHERE index_name = $1 AND document_id = $2 AND source_version = $4::timestamptz`, [
            PROPERTY_INDEX, r.id, String(err).slice(0, 500), r.v,
          ])
          .catch(() => {});
      }
    }
    return out;
  } finally {
    if (locked) await conn.query(`SELECT pg_advisory_unlock(hashtext($1))`, [FLUSH_LOCK]).catch(() => {});
    conn.release();
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Which properties does an event affect? */
export async function propertyIdsForEvent(db: Db, ev: DomainEvent): Promise<string[]> {
  const pl = (ev.payload ?? {}) as any;
  if (ev.event_type === 'media.ready') {
    return (await q(db, `SELECT DISTINCT property_id FROM property_media WHERE media_id = $1`, [pl.mediaId ?? ev.aggregate_id])).map((r) => r.property_id);
  }
  if (ev.event_type.startsWith('review.') || ev.event_type.startsWith('reputation.')) {
    const tt = pl.targetType ?? pl.target_type;
    const tid = pl.targetId ?? pl.target_id;
    if (tt === 'PROPERTY' && tid) return UUID_RE.test(tid) ? [tid] : [];
    if (pl.propertyId) return UUID_RE.test(pl.propertyId) ? [pl.propertyId] : [];
    if (tt === 'HOST' && tid && UUID_RE.test(tid)) return (await q(db, `SELECT id FROM properties WHERE host_id = $1 AND status = 'PUBLISHED'`, [tid])).map((r) => r.id);
    return [];
  }
  const id = pl.propertyId ?? pl.property_id ?? (ev.aggregate_type === 'property' ? ev.aggregate_id : null);
  return typeof id === 'string' && UUID_RE.test(id) ? [id] : [];
}

/** Rebuild the index from PostgreSQL (admin reindex / disaster recovery). */
export async function rebuildIndex(ctx: Ctx, opts: { reset?: boolean } = {}) {
  const app = ctx.app;
  const adapter = searchAdapterOf(app);
  if (opts.reset ?? true) {
    await adapter.reset(app.pool);
    await app.pool.query(`DELETE FROM search_sync_state WHERE index_name = $1`, [PROPERTY_INDEX]);
  }
  const ids = await q<{ id: string }>(app.pool, `SELECT id FROM properties WHERE status = 'PUBLISHED' ORDER BY id`);
  let indexed = 0;
  for (const r of ids) {
    if ((await withTx(app.pool, (tx) => projectProperty(tx, app, r.id, null))) === 'SYNCED') indexed++;
  }
  if (!adapter.transactional) {
    for (let round = 0; round < 1000; round++) {
      const f = await flushPendingProjections(app, 500);
      indexed += f.synced;
      if (f.skipped || f.synced + f.deleted + f.failed === 0) break;
      if (f.synced + f.deleted === 0) break; // only failures left: reconcile / flush retry later
    }
  }
  await emit(app.pool, ctx, { aggregateType: 'search_index', aggregateId: PROPERTY_INDEX, eventType: 'search.projection.updated', payload: { index: PROPERTY_INDEX, indexed, rebuilt: true, adapter: adapter.name } });
  return { index: PROPERTY_INDEX, adapter: adapter.name, indexed };
}

/**
 * Reconcile job: re-project published properties whose source changed after their last sync (missed events)
 * and drop documents of properties that are no longer published. Oldest drift first, so every run makes progress
 * on catalogs larger than `limit`.
 */
export async function reconcileIndex(app: AppContext, limit = 500) {
  const stale = await q(
    app.pool,
    `SELECT p.id FROM properties p
       LEFT JOIN search_sync_state s ON s.index_name = $1 AND s.document_id = p.id::text
      WHERE p.status = 'PUBLISHED' AND (s.document_id IS NULL OR s.status IN ('PENDING','FAILED') OR s.source_version < p.updated_at)
      ORDER BY p.updated_at, p.id
      LIMIT $2`,
    [PROPERTY_INDEX, limit],
  );
  const gone = await q(
    app.pool,
    `SELECT s.document_id AS id FROM search_sync_state s
       LEFT JOIN properties p ON p.id::text = s.document_id
      WHERE s.index_name = $1 AND s.status = 'SYNCED' AND (p.id IS NULL OR p.status <> 'PUBLISHED')
      ORDER BY s.source_version, s.document_id LIMIT $2`,
    [PROPERTY_INDEX, limit],
  );
  for (const r of [...stale, ...gone]) {
    try {
      await withTx(app.pool, (tx) => projectProperty(tx, app, r.id, null));
    } catch (err) {
      await app.pool.query(`UPDATE search_sync_state SET status = 'FAILED', error = $3 WHERE index_name = $1 AND document_id = $2`, [PROPERTY_INDEX, r.id, String(err).slice(0, 500)]);
    }
  }
  if (!searchAdapterOf(app).transactional) await flushPendingProjections(app, limit);
  return { reprojected: stale.length, removed: gone.length };
}

// --- query --------------------------------------------------------------------------------------

export interface SearchRequest {
  q?: string; city?: string; region?: string; bbox?: string; lat?: number; lng?: number; radius?: number;
  checkIn?: string; checkOut?: string; guests?: number; priceMin?: number; priceMax?: number;
  amenities?: string; propertyType?: string; mode?: 'rental' | 'exchange' | 'any';
  sort?: SearchQuery['sort']; page?: number; limit?: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const nightsBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * Properties NOT bookable for [checkIn, checkOut): ACTIVE non-expired inventory blocks overlapping the stay, or
 * UNAVAILABLE calendar days inside it. Read from PostgreSQL (authoritative) at query time.
 */
export async function unavailablePropertyIds(db: Db, checkIn: string, checkOut: string): Promise<string[]> {
  const rows = await q(
    db,
    `SELECT property_id::text AS id FROM inventory_blocks
      WHERE state = 'ACTIVE' AND (expires_at IS NULL OR expires_at > now()) AND stay_range && daterange($1::date, $2::date, '[)')
     UNION
     SELECT property_id::text FROM availability_days WHERE status = 'UNAVAILABLE' AND day >= $1::date AND day < $2::date`,
    [checkIn, checkOut],
  );
  return rows.map((r) => r.id);
}

export function parseSearch(r: SearchRequest): SearchQuery & { checkIn?: string; checkOut?: string } {
  const out: SearchQuery & { checkIn?: string; checkOut?: string } = { sort: r.sort ?? 'relevance', page: r.page ?? 1, limit: r.limit ?? 20, mode: r.mode ?? 'any' };
  if (r.q?.trim()) out.q = r.q.trim().slice(0, 200);
  if (r.city) out.city = r.city;
  if (r.region) out.region = r.region;
  if (r.bbox) {
    const parts = r.bbox.split(',').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) throw badRequest('INVALID_BBOX', 'bbox must be minLng,minLat,maxLng,maxLat');
    const [minLng, minLat, maxLng, maxLat] = parts;
    if (minLat > maxLat || minLat < -90 || maxLat > 90 || Math.abs(minLng) > 180 || Math.abs(maxLng) > 180) throw badRequest('INVALID_BBOX', 'bbox is out of range');
    out.bbox = [minLng, minLat, maxLng, maxLat];
  }
  if (r.lat !== undefined || r.lng !== undefined) {
    if (r.lat === undefined || r.lng === undefined) throw badRequest('INVALID_GEO', 'lat and lng must be given together');
    out.near = { lat: r.lat, lng: r.lng, radiusM: Math.min(r.radius ?? 5000, 100_000) };
  }
  if (r.checkIn || r.checkOut) {
    if (!r.checkIn || !r.checkOut || !DATE_RE.test(r.checkIn) || !DATE_RE.test(r.checkOut)) throw badRequest('INVALID_DATE', 'checkIn and checkOut must both be YYYY-MM-DD');
    // real calendar days only (2026-02-30 / 2026-13-01 would otherwise reach `$1::date` and fail with a 500)
    if (!isCalendarDate(r.checkIn) || !isCalendarDate(r.checkOut)) throw badRequest('INVALID_DATE', 'checkIn and checkOut must be valid calendar dates');
    const n = nightsBetween(r.checkIn, r.checkOut);
    if (n <= 0) throw badRequest('INVALID_DATE_RANGE', 'checkOut must be after checkIn');
    if (n > 365) throw badRequest('INVALID_DATE_RANGE', 'Stay is too long');
    out.checkIn = r.checkIn;
    out.checkOut = r.checkOut;
    out.nights = n;
  }
  if (r.guests) out.guests = r.guests;
  if (r.priceMin !== undefined) out.priceMin = r.priceMin;
  if (r.priceMax !== undefined) out.priceMax = r.priceMax;
  if (out.priceMin !== undefined && out.priceMax !== undefined && out.priceMin > out.priceMax) throw badRequest('INVALID_PRICE_RANGE', 'priceMin must be ≤ priceMax');
  if (r.amenities) out.amenities = r.amenities.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 30);
  if (r.propertyType) out.propertyTypes = r.propertyType.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean).slice(0, 10);
  if (out.sort === 'distance' && !out.near && !out.bbox) throw badRequest('ORIGIN_REQUIRED', 'Distance sort needs lat/lng or bbox');
  if (out.sort === 'distance' && !out.near && out.bbox) {
    // sort by distance from the viewport centre
    const [a, b, c, d] = out.bbox;
    out.near = { lat: (b + d) / 2, lng: (a + c) / 2, radiusM: 20_000_000 }; // origin only; the bbox does the filtering
  }
  return out;
}

const toCard = (d: PropertyDoc & { distanceM?: number | null }) => ({
  id: d.id,
  slug: d.slug,
  title: d.title,
  summary: d.summary,
  city: d.city,
  region: d.region,
  areaLabel: d.areaLabel,
  propertyType: d.propertyType,
  roomType: d.roomType,
  maxGuests: d.maxGuests,
  bedrooms: d.bedrooms,
  beds: d.beds,
  bathrooms: d.bathrooms,
  priceMinor: d.priceMinor,
  currency: d.currency,
  rentalEnabled: d.rentalEnabled,
  paidBookingEnabled: d.paidBookingEnabled,
  exchangeEnabled: d.exchangeEnabled,
  instantBook: d.instantBook,
  amenities: d.amenities,
  coverUrl: d.coverUrl,
  photoUrls: d.photoUrls,
  ratingAvg: d.ratingAvg,
  reviewCount: d.reviewCount,
  location: d.lat !== null ? { lat: d.lat, lng: d.lng, approximate: true } : null,
  distanceM: d.distanceM ?? null,
});

/** GET /v1/search/properties — returns CANDIDATES only; checkout must revalidate availability (STAY-04 acceptance). */
export async function searchProperties(app: AppContext, req: SearchRequest) {
  const query = parseSearch(req);
  if (query.checkIn && query.checkOut) query.excludeIds = await unavailablePropertyIds(app.pool, query.checkIn, query.checkOut);
  const res = await searchAdapterOf(app).search(app.pool, query);
  return {
    items: res.hits.map(toCard),
    total: res.total,
    page: query.page,
    limit: query.limit,
    facets: res.facets,
    candidatesOnly: true as const,
    dateFiltered: !!query.checkIn,
  };
}

const staticPlaces = new StaticGeocoder();

/** GET /v1/search/suggest — city/title autocomplete; places come from the static table (no paid provider calls per keystroke). */
export async function suggest(app: AppContext, text: string, limit = 5) {
  const t = text.trim().slice(0, 100);
  if (!t) return { places: [], cities: [], titles: [] };
  const [places, s] = [await staticPlaces.geocode(t, { limit }), await searchAdapterOf(app).suggest(app.pool, t, limit)];
  return { places: places.map((p) => ({ label: p.label, labelEn: p.labelEn, lat: p.lat, lng: p.lng, region: p.region, precision: p.precision })), ...s };
}
