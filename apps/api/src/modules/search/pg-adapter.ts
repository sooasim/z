import type { Db } from '../../platform/db.js';
import { q } from '../../platform/db.js';
import { PROPERTY_INDEX, type Facets, type PropertyDoc, type SearchAdapter, type SearchQuery, type SearchResult, type Suggestions } from './adapter.js';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

const distanceSql = (latP: string, lngP: string) =>
  `(6371000 * 2 * asin(least(1.0, sqrt(power(sin(radians(lat - ${latP}) / 2), 2) + cos(radians(${latP})) * cos(radians(lat)) * power(sin(radians(lng - ${lngP}) / 2), 2)))))`;

/** PostgreSQL fallback: projection rows in search_documents, to_tsvector('simple') + ILIKE, SQL geo filters. */
export class PgSearchAdapter implements SearchAdapter {
  readonly name = 'postgres' as const;

  async ensureIndex() {}

  async upsert(db: Db, docs: PropertyDoc[]) {
    for (const d of docs) {
      const { searchText, ...doc } = d;
      await db.query(
        `INSERT INTO search_documents(index_name, document_id, property_id, doc, search_text, city, region, country, property_type, room_type,
            amenities, max_guests, price_minor, currency, rental_enabled, paid_booking_enabled, exchange_enabled, min_nights, max_nights,
            lat, lng, rating_avg, review_count, published_at, updated_at)
         VALUES ($1,$2,$24::uuid,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23, now())
         ON CONFLICT (index_name, document_id) DO UPDATE SET
            doc = EXCLUDED.doc, search_text = EXCLUDED.search_text, city = EXCLUDED.city, region = EXCLUDED.region, country = EXCLUDED.country,
            property_type = EXCLUDED.property_type, room_type = EXCLUDED.room_type, amenities = EXCLUDED.amenities, max_guests = EXCLUDED.max_guests,
            price_minor = EXCLUDED.price_minor, currency = EXCLUDED.currency, rental_enabled = EXCLUDED.rental_enabled,
            paid_booking_enabled = EXCLUDED.paid_booking_enabled, exchange_enabled = EXCLUDED.exchange_enabled, min_nights = EXCLUDED.min_nights,
            max_nights = EXCLUDED.max_nights, lat = EXCLUDED.lat, lng = EXCLUDED.lng, rating_avg = EXCLUDED.rating_avg,
            review_count = EXCLUDED.review_count, published_at = EXCLUDED.published_at, updated_at = now()`,
        [
          PROPERTY_INDEX, d.id, JSON.stringify(doc), searchText, d.city, d.region, d.country, d.propertyType, d.roomType, d.amenities, d.maxGuests,
          d.priceMinor, d.currency, d.rentalEnabled, d.paidBookingEnabled, d.exchangeEnabled, d.minNights, d.maxNights, d.lat, d.lng, d.ratingAvg,
          d.reviewCount, d.publishedAt, d.id,
        ],
      );
    }
  }

  async remove(db: Db, ids: string[]) {
    if (ids.length) await db.query(`DELETE FROM search_documents WHERE index_name = $1 AND document_id = ANY($2::text[])`, [PROPERTY_INDEX, ids]);
  }

  async reset(db: Db) {
    await db.query(`DELETE FROM search_documents WHERE index_name = $1`, [PROPERTY_INDEX]);
  }

  private where(query: SearchQuery) {
    const params: unknown[] = [PROPERTY_INDEX];
    const p = (v: unknown) => {
      params.push(v);
      return `$${params.length}`;
    };
    const w: string[] = ['index_name = $1'];
    let rankExpr: string | null = null;
    if (query.q) {
      const tq = p(query.q);
      w.push(`(tsv @@ plainto_tsquery('simple', ${tq}) OR search_text ILIKE ${p(`%${escapeLike(query.q)}%`)})`);
      rankExpr = `ts_rank(tsv, plainto_tsquery('simple', ${tq}))`;
    }
    if (query.city) w.push(`lower(city) = lower(${p(query.city)})`);
    if (query.region) w.push(`region = ${p(query.region.toUpperCase())}`);
    if (query.bbox) {
      const [minLng, minLat, maxLng, maxLat] = query.bbox;
      w.push(`lat BETWEEN ${p(minLat)} AND ${p(maxLat)}`);
      // viewport crossing the antimeridian wraps around
      w.push(minLng <= maxLng ? `lng BETWEEN ${p(minLng)} AND ${p(maxLng)}` : `(lng >= ${p(minLng)} OR lng <= ${p(maxLng)})`);
    }
    let distExpr: string | null = null;
    if (query.near) {
      const la = p(query.near.lat), ln = p(query.near.lng);
      distExpr = distanceSql(`${la}::float8`, `${ln}::float8`);
      const dLat = query.near.radiusM / 111_320;
      const dLng = query.near.radiusM / (111_320 * Math.max(Math.cos((query.near.lat * Math.PI) / 180), 0.01));
      w.push(`lat BETWEEN ${p(query.near.lat - dLat)} AND ${p(query.near.lat + dLat)}`);
      w.push(`lng BETWEEN ${p(query.near.lng - dLng)} AND ${p(query.near.lng + dLng)}`);
      w.push(`${distExpr} <= ${p(query.near.radiusM)}`);
    }
    if (query.guests) w.push(`max_guests >= ${p(query.guests)}`);
    if (query.nights) w.push(`min_nights <= ${p(query.nights)} AND max_nights >= ${p(query.nights)}`);
    if (query.priceMin !== undefined) w.push(`price_minor >= ${p(query.priceMin)}`);
    if (query.priceMax !== undefined) w.push(`price_minor <= ${p(query.priceMax)}`);
    if (query.amenities?.length) w.push(`amenities @> ${p(query.amenities)}::text[]`);
    if (query.propertyTypes?.length) w.push(`property_type = ANY(${p(query.propertyTypes)}::text[])`);
    if (query.mode === 'rental') w.push('paid_booking_enabled');
    if (query.mode === 'exchange') w.push('exchange_enabled');
    if (query.excludeIds?.length) w.push(`NOT (document_id = ANY(${p(query.excludeIds)}::text[]))`);
    return { where: w.join(' AND '), params, rankExpr, distExpr, p };
  }

  async search(db: Db, query: SearchQuery): Promise<SearchResult> {
    const { where, params, rankExpr, distExpr, p } = this.where(query);
    let order: string;
    switch (query.sort) {
      case 'price_asc': order = 'price_minor ASC NULLS LAST'; break;
      case 'price_desc': order = 'price_minor DESC NULLS LAST'; break;
      case 'rating': order = 'rating_avg DESC NULLS LAST, review_count DESC'; break;
      case 'newest': order = 'published_at DESC NULLS LAST'; break;
      case 'distance': order = distExpr ? `${distExpr} ASC` : 'published_at DESC NULLS LAST'; break;
      default: order = `${rankExpr ? `${rankExpr} DESC, ` : ''}rating_avg DESC NULLS LAST, review_count DESC, published_at DESC NULLS LAST`;
    }
    const baseParams = [...params];
    const limitP = p(query.limit), offsetP = p((query.page - 1) * query.limit);
    const rows = await q(
      db,
      `SELECT doc, ${distExpr ?? 'NULL::float8'} AS distance_m FROM search_documents WHERE ${where}
        ORDER BY ${order}, document_id LIMIT ${limitP} OFFSET ${offsetP}`,
      params,
    );
    const [count] = await q<{ n: number; rental: number; exchange: number }>(
      db,
      `SELECT count(*)::int AS n, count(*) FILTER (WHERE paid_booking_enabled)::int AS rental, count(*) FILTER (WHERE exchange_enabled)::int AS exchange
         FROM search_documents WHERE ${where}`,
      baseParams,
    );
    const toMap = (rs: { k: string; n: number }[]) => Object.fromEntries(rs.filter((r) => r.k !== null).map((r) => [r.k, r.n]));
    const facets: Facets = {
      propertyType: toMap(await q(db, `SELECT property_type AS k, count(*)::int AS n FROM search_documents WHERE ${where} GROUP BY 1 ORDER BY 2 DESC`, baseParams)),
      amenities: toMap(await q(db, `SELECT a AS k, count(*)::int AS n FROM search_documents, unnest(amenities) a WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 50`, baseParams)),
      city: toMap(await q(db, `SELECT city AS k, count(*)::int AS n FROM search_documents WHERE ${where} GROUP BY 1 ORDER BY 2 DESC LIMIT 30`, baseParams)),
      mode: { rental: count.rental, exchange: count.exchange },
    };
    return {
      hits: rows.map((r) => ({ ...r.doc, distanceM: r.distance_m === null ? null : Math.round(r.distance_m) })),
      total: count.n,
      facets,
    };
  }

  async suggest(db: Db, text: string, limit: number): Promise<Suggestions> {
    const like = `${escapeLike(text)}%`;
    const cities = await q(
      db,
      `SELECT city, count(*)::int AS count FROM search_documents WHERE index_name = $1 AND city ILIKE $2 AND city IS NOT NULL
        GROUP BY city ORDER BY count DESC, city LIMIT $3`,
      [PROPERTY_INDEX, like, limit],
    );
    const titles = await q(
      db,
      `SELECT document_id AS id, doc->>'slug' AS slug, doc->>'title' AS title, city FROM search_documents
        WHERE index_name = $1 AND (doc->>'title') ILIKE $2 ORDER BY rating_avg DESC NULLS LAST, published_at DESC NULLS LAST LIMIT $3`,
      [PROPERTY_INDEX, `%${escapeLike(text)}%`, limit],
    );
    return { cities, titles };
  }
}
