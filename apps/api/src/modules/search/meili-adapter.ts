import { Meilisearch } from 'meilisearch';
import type { Db } from '../../platform/db.js';
import { PROPERTY_INDEX, type PropertyDoc, type SearchAdapter, type SearchQuery, type SearchResult, type Suggestions } from './adapter.js';
import { haversineKm } from '../geo/service.js';

const str = (v: string) => JSON.stringify(v); // Meilisearch filter string literal

/** Meilisearch projection (PLAT-01). Never authoritative: date availability is re-applied from PostgreSQL. */
export class MeiliSearchAdapter implements SearchAdapter {
  readonly name = 'meilisearch' as const;
  private client: Meilisearch;
  constructor(host: string, apiKey?: string, private uid = PROPERTY_INDEX) {
    this.client = new Meilisearch({ host, apiKey });
  }
  private get index() {
    return this.client.index<Record<string, any>>(this.uid);
  }

  async ensureIndex() {
    await this.client.createIndex(this.uid, { primaryKey: 'id' }).waitTask().catch(() => undefined); // exists → ignore
    await this.index
      .updateSettings({
        searchableAttributes: ['title', 'city', 'areaLabel', 'region', 'summary', 'amenityLabels', 'searchText'],
        filterableAttributes: [
          'id', 'city', 'region', 'country', 'propertyType', 'roomType', 'amenities', 'maxGuests', 'priceMinor', 'rentalEnabled',
          'paidBookingEnabled', 'exchangeEnabled', 'minNights', 'maxNights', '_geo',
        ],
        sortableAttributes: ['priceMinor', 'ratingAvg', 'reviewCount', 'publishedAtTs', '_geo'],
        faceting: { maxValuesPerFacet: 100 },
        pagination: { maxTotalHits: 5000 },
      })
      .waitTask();
  }

  async upsert(_db: Db, docs: PropertyDoc[]) {
    if (!docs.length) return;
    await this.index.addDocuments(
      docs.map((d) => ({ ...d, _geo: d.lat !== null && d.lng !== null ? { lat: d.lat, lng: d.lng } : null })),
      { primaryKey: 'id' },
    );
  }

  async remove(_db: Db, ids: string[]) {
    if (ids.length) await this.index.deleteDocuments(ids);
  }

  async reset() {
    await this.index.deleteAllDocuments().waitTask();
  }

  async search(_db: Db, query: SearchQuery): Promise<SearchResult> {
    const f: string[] = [];
    if (query.city) f.push(`city = ${str(query.city)}`);
    if (query.region) f.push(`region = ${str(query.region.toUpperCase())}`);
    if (query.bbox) {
      const [minLng, minLat, maxLng, maxLat] = query.bbox;
      f.push(`_geoBoundingBox([${maxLat}, ${maxLng}], [${minLat}, ${minLng}])`);
    }
    if (query.near) f.push(`_geoRadius(${query.near.lat}, ${query.near.lng}, ${Math.round(query.near.radiusM)})`);
    if (query.guests) f.push(`maxGuests >= ${query.guests}`);
    if (query.nights) f.push(`minNights <= ${query.nights} AND maxNights >= ${query.nights}`);
    if (query.priceMin !== undefined) f.push(`priceMinor >= ${query.priceMin}`);
    if (query.priceMax !== undefined) f.push(`priceMinor <= ${query.priceMax}`);
    for (const a of query.amenities ?? []) f.push(`amenities = ${str(a)}`);
    if (query.propertyTypes?.length) f.push(`propertyType IN [${query.propertyTypes.map(str).join(', ')}]`);
    if (query.mode === 'rental') f.push('paidBookingEnabled = true');
    if (query.mode === 'exchange') f.push('exchangeEnabled = true');
    if (query.excludeIds?.length) f.push(`id NOT IN [${query.excludeIds.map(str).join(', ')}]`);

    const origin = query.near ?? (query.bbox ? { lat: (query.bbox[1] + query.bbox[3]) / 2, lng: (query.bbox[0] + query.bbox[2]) / 2 } : null);
    const sort: string[] = [];
    switch (query.sort) {
      case 'price_asc': sort.push('priceMinor:asc'); break;
      case 'price_desc': sort.push('priceMinor:desc'); break;
      case 'rating': sort.push('ratingAvg:desc', 'reviewCount:desc'); break;
      case 'newest': sort.push('publishedAtTs:desc'); break;
      case 'distance': if (origin) sort.push(`_geoPoint(${origin.lat}, ${origin.lng}):asc`); break;
      default: if (!query.q) sort.push('ratingAvg:desc', 'publishedAtTs:desc');
    }
    const res = await this.index.search(query.q ?? '', {
      filter: f.length ? f.join(' AND ') : undefined,
      sort: sort.length ? sort : undefined,
      facets: ['propertyType', 'amenities', 'city', 'paidBookingEnabled', 'exchangeEnabled'],
      page: query.page,
      hitsPerPage: query.limit,
    });
    const fd = (res.facetDistribution ?? {}) as Record<string, Record<string, number>>;
    return {
      hits: res.hits.map((h: any) => {
        const { _geo, _geoDistance, ...doc } = h;
        void _geo;
        const distanceM = _geoDistance ?? (origin && doc.lat !== null ? Math.round(haversineKm(origin.lat, origin.lng, doc.lat, doc.lng) * 1000) : null);
        return { ...(doc as PropertyDoc), distanceM };
      }),
      total: (res as any).totalHits ?? (res as any).estimatedTotalHits ?? res.hits.length,
      facets: {
        propertyType: fd.propertyType ?? {},
        amenities: fd.amenities ?? {},
        city: fd.city ?? {},
        mode: { rental: fd.paidBookingEnabled?.['true'] ?? 0, exchange: fd.exchangeEnabled?.['true'] ?? 0 },
      },
    };
  }

  async suggest(_db: Db, text: string, limit: number): Promise<Suggestions> {
    const res = await this.index.search(text, { limit, attributesToRetrieve: ['id', 'slug', 'title', 'city'], facets: ['city'] });
    const cities = Object.entries((res.facetDistribution?.city ?? {}) as Record<string, number>)
      .filter(([c]) => c.toLowerCase().startsWith(text.toLowerCase()))
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([city, count]) => ({ city, count }));
    return { cities, titles: res.hits.map((h: any) => ({ id: h.id, slug: h.slug, title: h.title, city: h.city ?? null })) };
  }
}
