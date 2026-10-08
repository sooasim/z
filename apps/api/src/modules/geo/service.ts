import { createHmac } from 'node:crypto';
import type { AppContext } from '../../platform/context.js';
import type { Config } from '../../platform/config.js';
import {
  CachedGeocoder,
  KakaoGeocoder,
  NominatimGeocoder,
  StaticGeocoder,
  fuzzCoordinates,
  type GeoResult,
  type GeocodeOptions,
  type Geocoder,
} from './geocoder.js';

export { haversineKm, type GeoResult, type Geocoder } from './geocoder.js';

export const GEOCODER_ADAPTER = 'geocoder';

/** Build the configured provider (GEOCODER=STATIC|KAKAO|NOMINATIM) wrapped in the LRU cache + STATIC fallback. */
export function createGeocoder(app: Pick<AppContext, 'config' | 'log'>): CachedGeocoder {
  const cfg = app.config;
  let inner: Geocoder = new StaticGeocoder();
  if (cfg.GEOCODER === 'KAKAO') {
    if (cfg.KAKAO_REST_API_KEY) inner = new KakaoGeocoder(cfg.KAKAO_REST_API_KEY);
    else app.log.warn('GEOCODER=KAKAO but KAKAO_REST_API_KEY is unset; using STATIC geocoder');
  } else if (cfg.GEOCODER === 'NOMINATIM') {
    inner = new NominatimGeocoder();
  }
  return new CachedGeocoder(inner, (err) => app.log.warn({ err: String(err), provider: inner.name }, 'geocoder provider failed; static fallback'));
}

function geocoderOf(app: AppContext): Geocoder {
  let g = app.adapters.get(GEOCODER_ADAPTER) as Geocoder | undefined;
  if (!g) {
    g = createGeocoder(app);
    app.adapters.set(GEOCODER_ADAPTER, g);
  }
  return g;
}

/** PLAT-02 contract: forward geocoding for other modules (properties, search, guide, ...). */
export async function geocode(app: AppContext, query: string, opts: GeocodeOptions = {}): Promise<GeoResult[]> {
  const q = query.trim();
  if (!q) return [];
  return geocoderOf(app).geocode(q.slice(0, 200), opts);
}

/** PLAT-02 contract: reverse geocoding (area-level; never returns a street address for privacy-sensitive use). */
export async function reverseGeocode(app: AppContext, lat: number, lng: number, opts: Pick<GeocodeOptions, 'maxWaitMs'> = {}): Promise<GeoResult | null> {
  return geocoderOf(app).reverse(lat, lng, opts);
}

/** Name of the configured geocoding provider ('STATIC' | 'KAKAO' | 'NOMINATIM'). */
export function geocoderProvider(app: AppContext): Geocoder['name'] {
  return geocoderOf(app).name;
}

/**
 * Resolve `p` but give up after `ms` (the provider call keeps running in the background; its result is cached).
 * `ok: false` on timeout or error.
 */
export async function withDeadline<T>(p: Promise<T>, ms: number): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.then((value) => ({ ok: true as const, value }), () => ({ ok: false as const })),
      new Promise<{ ok: false }>((resolve) => (timer = setTimeout(() => resolve({ ok: false }), ms))),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// --- public-coordinate privacy fuzz ------------------------------------------------------------------

let fuzzKey: Buffer | null = null;
const FUZZ_KEY_LABEL = 'jetpool/geo-fuzz-key/v2';

/**
 * Configure the server secret for the coordinate fuzz (called when the geo module registers). GEO_FUZZ_SECRET is
 * preferred; otherwise a key is derived from DATA_ENCRYPTION_KEY (which production config refuses to leave at
 * its default), so the offset can never be recomputed from source code + the public property id.
 */
export function configureGeoPrivacy(cfg: Pick<Config, 'GEO_FUZZ_SECRET' | 'DATA_ENCRYPTION_KEY'>) {
  fuzzKey = createHmac('sha256', cfg.GEO_FUZZ_SECRET ?? cfg.DATA_ENCRYPTION_KEY).update(FUZZ_KEY_LABEL).digest();
}

function currentFuzzKey(): Buffer {
  if (fuzzKey) return fuzzKey;
  if (process.env.NODE_ENV === 'production') throw new Error('geo privacy key is not configured');
  // dev/test only (no app registered yet): same derivation as the config default
  configureGeoPrivacy({ GEO_FUZZ_SECRET: process.env.GEO_FUZZ_SECRET, DATA_ENCRYPTION_KEY: process.env.DATA_ENCRYPTION_KEY ?? '0'.repeat(64) });
  return fuzzKey!;
}

/** Secret-keyed public fuzz of a listing point (search projection, public views). */
export function fuzzPublic(id: string, lat: number, lng: number): { lat: number; lng: number } {
  return fuzzCoordinates(id, lat, lng, currentFuzzKey());
}

/** Public coordinates for a listing: fuzzed unless the viewer is entitled to the exact location. */
export function publicCoordinates(id: string, lat: number | null | undefined, lng: number | null | undefined, exact = false) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
  const la = Number(lat), ln = Number(lng);
  return exact ? { lat: la, lng: ln, approximate: false } : { ...fuzzPublic(id, la, ln), approximate: true };
}
