import type { Db } from '../../platform/db.js';

export const SEARCH_ADAPTER = 'search';
export const PROPERTY_INDEX = 'properties';

/** Search projection document (PLAT-01). Coordinates are already privacy-fuzzed; no address, no PII. */
export interface PropertyDoc {
  id: string;
  slug: string;
  title: string;
  summary: string | null;
  city: string | null;
  region: string | null;
  country: string;
  areaLabel: string | null;
  propertyType: string;
  roomType: string;
  maxGuests: number;
  bedrooms: number;
  beds: number;
  bathrooms: number;
  priceMinor: number | null;
  currency: string;
  rentalEnabled: boolean;
  paidBookingEnabled: boolean;
  exchangeEnabled: boolean;
  instantBook: boolean;
  amenities: string[];
  amenityLabels: string[];
  coverUrl: string | null;
  photoUrls: string[];
  ratingAvg: number | null;
  reviewCount: number;
  lat: number | null;
  lng: number | null;
  minNights: number;
  maxNights: number;
  publishedAt: string | null;
  publishedAtTs: number;
  hostId: string;
  /** full-text body (title, summary, description excerpt, area, amenity labels) */
  searchText: string;
}

export type SearchSort = 'relevance' | 'price_asc' | 'price_desc' | 'rating' | 'distance' | 'newest';

export interface SearchQuery {
  q?: string;
  city?: string;
  region?: string;
  /** [minLng, minLat, maxLng, maxLat] */
  bbox?: [number, number, number, number];
  near?: { lat: number; lng: number; radiusM: number };
  guests?: number;
  nights?: number;
  priceMin?: number;
  priceMax?: number;
  amenities?: string[];
  propertyTypes?: string[];
  mode?: 'rental' | 'exchange' | 'any';
  /** property ids excluded by the authoritative date check (blocked / unavailable for the requested stay) */
  excludeIds?: string[];
  sort: SearchSort;
  page: number;
  limit: number;
}

export interface Facets {
  propertyType: Record<string, number>;
  amenities: Record<string, number>;
  city: Record<string, number>;
  mode: { rental: number; exchange: number };
}

export interface SearchResult {
  hits: (PropertyDoc & { distanceM?: number | null })[];
  total: number;
  facets: Facets;
}

export interface Suggestions {
  cities: { city: string; count: number }[];
  titles: { id: string; slug: string; title: string; city: string | null }[];
}

/** Replaceable search backend: Meilisearch when MEILI_HOST is set, PostgreSQL otherwise. */
export interface SearchAdapter {
  readonly name: 'meilisearch' | 'postgres';
  /**
   * true when upsert/remove write through the given PostgreSQL connection (the projection can then be applied inside
   * the outbox transaction). External engines (Meilisearch) are false: they are fed by flushPendingProjections,
   * outside any transaction, so a slow/hung engine can never hold outbox row locks or pooled connections.
   */
  readonly transactional?: boolean;
  ensureIndex(): Promise<void>;
  upsert(db: Db, docs: PropertyDoc[]): Promise<void>;
  remove(db: Db, ids: string[]): Promise<void>;
  reset(db: Db): Promise<void>;
  search(db: Db, query: SearchQuery): Promise<SearchResult>;
  suggest(db: Db, q: string, limit: number): Promise<Suggestions>;
}
