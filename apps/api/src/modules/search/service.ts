import type { AppContext, Ctx } from '../../platform/context.js';
import type { Db } from '../../platform/db.js';
import { maybeOne, q } from '../../platform/db.js';
import { badRequest } from '../../platform/errors.js';
import { emit, type DomainEvent } from '../../platform/outbox.js';
import { fuzzCoordinates } from '../geo/service.js';
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
  const coords = p.lat !== null && p.lng !== null ? fuzzCoordinates(p.id, Number(p.lat), Number(p.lng)) : null;
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
 * Project one property. Out-of-order safety: search_sync_state.source_version only moves forward; an older
 * event than the last applied one is skipped. Returns 'SYNCED' | 'DELETED' | 'STALE'.
 */
export async function projectProperty(db: Db, app: AppContext, propertyId: string, sourceVersion: Date | string) {
  const claimed = await q(
    db,
    `INSERT INTO search_sync_state(index_name, document_id, source_version, status) VALUES ($1,$2,$3,'PENDING')
     ON CONFLICT (index_name, document_id) DO UPDATE SET source_version = EXCLUDED.source_version, status = 'PENDING', error = NULL
       WHERE search_sync_state.source_version <= EXCLUDED.source_version
     RETURNING document_id`,
    [PROPERTY_INDEX, propertyId, sourceVersion],
  );
  if (!claimed.length) return 'STALE' as const;
  const adapter = searchAdapterOf(app);
  const doc = await buildPropertyDocument(db, propertyId);
  if (doc) await adapter.upsert(db, [doc]);
  else await adapter.remove(db, [propertyId]);
  const status = doc ? 'SYNCED' : 'DELETED';
  await db.query(`UPDATE search_sync_state SET status = $3, synced_at = now() WHERE index_name = $1 AND document_id = $2`, [PROPERTY_INDEX, propertyId, status]);
  return status as 'SYNCED' | 'DELETED';
}

/** Which properties does an event affect? */
export async function propertyIdsForEvent(db: Db, ev: DomainEvent): Promise<string[]> {
  const pl = (ev.payload ?? {}) as any;
  if (ev.event_type === 'media.ready') {
    return (await q(db, `SELECT DISTINCT property_id FROM property_media WHERE media_id = $1`, [pl.mediaId ?? ev.aggregate_id])).map((r) => r.property_id);
  }
  if (ev.event_type.startsWith('review.') || ev.event_type.startsWith('reputation.')) {
    const tt = pl.targetType ?? pl.target_type;
    const tid = pl.targetId ?? pl.target_id;
    if (tt === 'PROPERTY' && tid) return [tid];
    if (pl.propertyId) return [pl.propertyId];
    if (tt === 'HOST' && tid) return (await q(db, `SELECT id FROM properties WHERE host_id = $1 AND status = 'PUBLISHED'`, [tid])).map((r) => r.id);
    return [];
  }
  const id = pl.propertyId ?? pl.property_id ?? (ev.aggregate_type === 'property' ? ev.aggregate_id : null);
  return id && /^[0-9a-f-]{36}$/i.test(id) ? [id] : [];
}

/** Rebuild the index from PostgreSQL (admin reindex / disaster recovery). */
export async function rebuildIndex(ctx: Ctx, opts: { reset?: boolean } = {}) {
  const app = ctx.app;
  const adapter = searchAdapterOf(app);
  if (opts.reset ?? true) {
    await adapter.reset(app.pool);
    await app.pool.query(`DELETE FROM search_sync_state WHERE index_name = $1`, [PROPERTY_INDEX]);
  }
  const ids = (await q(app.pool, `SELECT id, updated_at FROM properties WHERE status = 'PUBLISHED' ORDER BY id`)).map((r) => r);
  let indexed = 0;
  for (const r of ids) {
    if ((await projectProperty(app.pool, app, r.id, r.updated_at)) === 'SYNCED') indexed++;
  }
  await emit(app.pool, ctx, { aggregateType: 'search_index', aggregateId: PROPERTY_INDEX, eventType: 'search.projection.updated', payload: { index: PROPERTY_INDEX, indexed, rebuilt: true, adapter: adapter.name } });
  return { index: PROPERTY_INDEX, adapter: adapter.name, indexed };
}

/**
 * Reconcile job: re-project published properties whose source changed after their last sync (missed events)
 * and drop documents of properties that are no longer published.
 */
export async function reconcileIndex(app: AppContext, limit = 500) {
  const stale = await q(
    app.pool,
    `SELECT p.id, p.updated_at FROM properties p
       LEFT JOIN search_sync_state s ON s.index_name = $1 AND s.document_id = p.id::text
      WHERE p.status = 'PUBLISHED' AND (s.document_id IS NULL OR s.status IN ('PENDING','FAILED') OR s.source_version < p.updated_at)
      LIMIT $2`,
    [PROPERTY_INDEX, limit],
  );
  const gone = await q(
    app.pool,
    `SELECT s.document_id AS id, greatest(s.source_version, coalesce(p.updated_at, s.source_version)) AS updated_at FROM search_sync_state s
       LEFT JOIN properties p ON p.id::text = s.document_id
      WHERE s.index_name = $1 AND s.status = 'SYNCED' AND (p.id IS NULL OR p.status <> 'PUBLISHED') LIMIT $2`,
    [PROPERTY_INDEX, limit],
  );
  for (const r of [...stale, ...gone]) {
    try {
      await projectProperty(app.pool, app, r.id, r.updated_at);
    } catch (err) {
      await app.pool.query(`UPDATE search_sync_state SET status = 'FAILED', error = $3 WHERE index_name = $1 AND document_id = $2`, [PROPERTY_INDEX, r.id, String(err).slice(0, 500)]);
    }
  }
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
