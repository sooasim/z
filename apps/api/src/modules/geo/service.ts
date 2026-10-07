import type { AppContext } from '../../platform/context.js';
import {
  CachedGeocoder,
  KakaoGeocoder,
  NominatimGeocoder,
  StaticGeocoder,
  fuzzCoordinates,
  type GeoResult,
  type Geocoder,
} from './geocoder.js';

export { fuzzCoordinates, haversineKm, type GeoResult, type Geocoder } from './geocoder.js';

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
export async function geocode(app: AppContext, query: string, opts: { limit?: number } = {}): Promise<GeoResult[]> {
  const q = query.trim();
  if (!q) return [];
  return geocoderOf(app).geocode(q.slice(0, 200), opts);
}

/** PLAT-02 contract: reverse geocoding (area-level; never returns a street address for privacy-sensitive use). */
export async function reverseGeocode(app: AppContext, lat: number, lng: number): Promise<GeoResult | null> {
  return geocoderOf(app).reverse(lat, lng);
}

/** Public coordinates for a listing: fuzzed unless the viewer is entitled to the exact location. */
export function publicCoordinates(id: string, lat: number | null | undefined, lng: number | null | undefined, exact = false) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return null;
  const la = Number(lat), ln = Number(lng);
  return exact ? { lat: la, lng: ln, approximate: false } : { ...fuzzCoordinates(id, la, ln), approximate: true };
}
