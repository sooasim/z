import { createHash } from 'node:crypto';

/** PLAT-02: provider-neutral geocoding result. `precision` tells consumers how exact the point is. */
export interface GeoResult {
  label: string;
  labelEn?: string;
  lat: number;
  lng: number;
  country: string;
  /** ISO 3166-2 subdivision, e.g. 'KR-11' (Seoul) */
  region?: string;
  city?: string;
  district?: string;
  precision: 'CITY' | 'DISTRICT' | 'ADDRESS' | 'POI';
  provider: 'STATIC' | 'KAKAO' | 'NOMINATIM';
}

export interface Geocoder {
  readonly name: 'STATIC' | 'KAKAO' | 'NOMINATIM';
  geocode(query: string, opts?: { limit?: number }): Promise<GeoResult[]>;
  reverse(lat: number, lng: number): Promise<GeoResult | null>;
}

// ---------------------------------------------------------------------------------------------
// STATIC: built-in table of major Korean cities + Seoul districts (approximate centroids).
// ---------------------------------------------------------------------------------------------
interface Place {
  ko: string;
  en: string;
  aliases: string[];
  kind: 'CITY' | 'DISTRICT';
  lat: number;
  lng: number;
  region: string;
  city: string;
  /** reverse-geocode capture radius in km */
  radiusKm: number;
}

const city = (ko: string, en: string, region: string, lat: number, lng: number, aliases: string[] = [], radiusKm = 20): Place => ({
  ko, en, aliases: [ko, en.toLowerCase(), ...aliases], kind: 'CITY', lat, lng, region, city: en, radiusKm,
});
const seoulGu = (ko: string, en: string, lat: number, lng: number): Place => ({
  ko: `서울 ${ko}`,
  en: `${en}, Seoul`,
  aliases: [ko, en.toLowerCase(), en.toLowerCase().replace(/-gu$/, ''), `${en.toLowerCase().replace(/-gu$/, '')} gu`],
  kind: 'DISTRICT', lat, lng, region: 'KR-11', city: 'Seoul', radiusKm: 4,
});

export const STATIC_PLACES: readonly Place[] = [
  city('서울', 'Seoul', 'KR-11', 37.5665, 126.978, ['서울특별시', '서울시'], 25),
  city('부산', 'Busan', 'KR-26', 35.1796, 129.0756, ['부산광역시', '부산시', 'pusan'], 25),
  city('제주', 'Jeju', 'KR-49', 33.4996, 126.5312, ['제주시', '제주도', '제주특별자치도', 'jeju-si', 'jeju island'], 40),
  city('서귀포', 'Seogwipo', 'KR-49', 33.2541, 126.5601, ['서귀포시'], 15),
  city('인천', 'Incheon', 'KR-28', 37.4563, 126.7052, ['인천광역시', '인천시'], 20),
  city('강릉', 'Gangneung', 'KR-42', 37.7519, 128.8761, ['강릉시'], 15),
  city('경주', 'Gyeongju', 'KR-47', 35.8562, 129.2247, ['경주시'], 15),
  city('전주', 'Jeonju', 'KR-45', 35.8242, 127.148, ['전주시'], 12),
  city('속초', 'Sokcho', 'KR-42', 38.207, 128.5918, ['속초시'], 10),
  city('여수', 'Yeosu', 'KR-46', 34.7604, 127.6622, ['여수시'], 15),
  city('대구', 'Daegu', 'KR-27', 35.8714, 128.6014, ['대구광역시', '대구시'], 20),
  city('대전', 'Daejeon', 'KR-30', 36.3504, 127.3845, ['대전광역시', '대전시'], 20),
  city('광주', 'Gwangju', 'KR-29', 35.1595, 126.8526, ['광주광역시', '광주시'], 18),
  seoulGu('종로구', 'Jongno-gu', 37.5735, 126.979),
  seoulGu('중구', 'Jung-gu', 37.5641, 126.9979),
  seoulGu('용산구', 'Yongsan-gu', 37.5326, 126.9905),
  seoulGu('성동구', 'Seongdong-gu', 37.5634, 127.0369),
  seoulGu('광진구', 'Gwangjin-gu', 37.5385, 127.0823),
  seoulGu('동대문구', 'Dongdaemun-gu', 37.5744, 127.0396),
  seoulGu('중랑구', 'Jungnang-gu', 37.6063, 127.0925),
  seoulGu('성북구', 'Seongbuk-gu', 37.5894, 127.0167),
  seoulGu('강북구', 'Gangbuk-gu', 37.6396, 127.0257),
  seoulGu('도봉구', 'Dobong-gu', 37.6688, 127.0471),
  seoulGu('노원구', 'Nowon-gu', 37.6542, 127.0568),
  seoulGu('은평구', 'Eunpyeong-gu', 37.6027, 126.9291),
  seoulGu('서대문구', 'Seodaemun-gu', 37.5791, 126.9368),
  seoulGu('마포구', 'Mapo-gu', 37.5663, 126.9019),
  seoulGu('양천구', 'Yangcheon-gu', 37.517, 126.8665),
  seoulGu('강서구', 'Gangseo-gu', 37.5509, 126.8495),
  seoulGu('구로구', 'Guro-gu', 37.4954, 126.8874),
  seoulGu('금천구', 'Geumcheon-gu', 37.4569, 126.8955),
  seoulGu('영등포구', 'Yeongdeungpo-gu', 37.5264, 126.8962),
  seoulGu('동작구', 'Dongjak-gu', 37.5124, 126.9393),
  seoulGu('관악구', 'Gwanak-gu', 37.4784, 126.9516),
  seoulGu('서초구', 'Seocho-gu', 37.4837, 127.0324),
  seoulGu('강남구', 'Gangnam-gu', 37.5172, 127.0473),
  seoulGu('송파구', 'Songpa-gu', 37.5145, 127.1059),
  seoulGu('강동구', 'Gangdong-gu', 37.5301, 127.1238),
];

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

function toResult(p: Place): GeoResult {
  return {
    label: p.ko,
    labelEn: p.en,
    lat: p.lat,
    lng: p.lng,
    country: 'KR',
    region: p.region,
    city: p.city,
    district: p.kind === 'DISTRICT' ? p.en.split(',')[0] : undefined,
    precision: p.kind,
    provider: 'STATIC',
  };
}

export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export class StaticGeocoder implements Geocoder {
  readonly name = 'STATIC' as const;

  async geocode(query: string, opts: { limit?: number } = {}): Promise<GeoResult[]> {
    const qn = norm(query);
    if (qn.length < 1) return [];
    const scored: { p: Place; score: number }[] = [];
    for (const p of STATIC_PLACES) {
      let best = 0;
      for (const a of p.aliases) {
        const an = norm(a);
        // Exact alias, alias contained in the query ("서울 마포구 ..."), or query is a prefix of an alias (autocomplete).
        if (qn === an) best = Math.max(best, 100 + an.length);
        else if (an.length >= 2 && qn.includes(an)) best = Math.max(best, 50 + an.length);
        else if (qn.length >= 2 && an.startsWith(qn)) best = Math.max(best, 20 + qn.length);
      }
      if (best > 0) {
        // Districts beat cities when the query names both ("서울 강남구"); a Seoul district name alone ("중구") is ambiguous
        // across cities, so it only wins when the query also mentions Seoul or matches exactly.
        if (p.kind === 'DISTRICT' && (qn.includes('서울') || qn.includes('seoul'))) best += 30;
        scored.push({ p, score: best });
      }
    }
    scored.sort((a, b) => b.score - a.score || (a.p.kind === 'DISTRICT' ? -1 : 1));
    return scored.slice(0, opts.limit ?? 5).map((s) => toResult(s.p));
  }

  async reverse(lat: number, lng: number): Promise<GeoResult | null> {
    let best: { p: Place; d: number } | null = null;
    for (const p of STATIC_PLACES) {
      const d = haversineKm(lat, lng, p.lat, p.lng);
      if (d > p.radiusKm) continue;
      // prefer the finest-grained place that captures the point
      const rank = d / p.radiusKm + (p.kind === 'DISTRICT' ? 0 : 1);
      if (!best || rank < best.d) best = { p, d: rank };
    }
    return best ? toResult(best.p) : null;
  }
}

// ---------------------------------------------------------------------------------------------
// KAKAO Local API
// ---------------------------------------------------------------------------------------------
const KR_REGION_BY_NAME: Record<string, string> = {
  서울: 'KR-11', 부산: 'KR-26', 대구: 'KR-27', 인천: 'KR-28', 광주: 'KR-29', 대전: 'KR-30', 울산: 'KR-31', 세종: 'KR-50',
  경기: 'KR-41', 강원: 'KR-42', 충북: 'KR-43', 충남: 'KR-44', 전북: 'KR-45', 전남: 'KR-46', 경북: 'KR-47', 경남: 'KR-48', 제주: 'KR-49',
};
export const regionFromKoreanName = (name?: string | null) => {
  if (!name) return undefined;
  const key = Object.keys(KR_REGION_BY_NAME).find((k) => name.startsWith(k));
  return key ? KR_REGION_BY_NAME[key] : undefined;
};

type FetchLike = typeof fetch;

export class KakaoGeocoder implements Geocoder {
  readonly name = 'KAKAO' as const;
  constructor(private apiKey: string, private fetchImpl: FetchLike = fetch, private base = 'https://dapi.kakao.com') {}

  private async get(path: string, params: Record<string, string>) {
    const url = `${this.base}${path}?${new URLSearchParams(params)}`;
    const res = await this.fetchImpl(url, { headers: { authorization: `KakaoAK ${this.apiKey}` }, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`kakao ${path} failed: ${res.status}`);
    return (await res.json()) as any;
  }

  async geocode(query: string, opts: { limit?: number } = {}): Promise<GeoResult[]> {
    const size = String(Math.min(opts.limit ?? 5, 15));
    const addr = await this.get('/v2/local/search/address.json', { query, size });
    let docs: any[] = addr.documents ?? [];
    let kind: GeoResult['precision'] = 'ADDRESS';
    if (docs.length === 0) {
      const kw = await this.get('/v2/local/search/keyword.json', { query, size });
      docs = kw.documents ?? [];
      kind = 'POI';
    }
    return docs.map((d) => {
      const a = d.address ?? d.road_address ?? {};
      return {
        label: d.place_name ?? d.address_name,
        lat: Number(d.y),
        lng: Number(d.x),
        country: 'KR',
        region: regionFromKoreanName(a.region_1depth_name ?? d.address_name),
        city: a.region_1depth_name,
        district: a.region_2depth_name,
        precision: kind,
        provider: 'KAKAO' as const,
      };
    });
  }

  async reverse(lat: number, lng: number): Promise<GeoResult | null> {
    const r = await this.get('/v2/local/geo/coord2regioncode.json', { x: String(lng), y: String(lat) });
    const d = (r.documents ?? []).find((x: any) => x.region_type === 'H') ?? r.documents?.[0];
    if (!d) return null;
    return {
      label: d.address_name,
      lat, lng,
      country: 'KR',
      region: regionFromKoreanName(d.region_1depth_name),
      city: d.region_1depth_name,
      district: d.region_2depth_name,
      precision: 'DISTRICT',
      provider: 'KAKAO',
    };
  }
}

// ---------------------------------------------------------------------------------------------
// NOMINATIM (OpenStreetMap) — usage policy: identifying User-Agent and max 1 request/second.
// ---------------------------------------------------------------------------------------------
export class NominatimGeocoder implements Geocoder {
  readonly name = 'NOMINATIM' as const;
  private last = 0;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private userAgent = 'JETPOOL/2.0 (+https://jetpool.kr; ops@jetpool.kr)',
    private fetchImpl: FetchLike = fetch,
    private base = 'https://nominatim.openstreetmap.org',
    private minIntervalMs = 1100,
  ) {}

  /** Serialize requests and keep ≥ minIntervalMs between them (provider cost/abuse control). */
  private throttle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return fn();
    });
    this.chain = run.catch(() => {});
    return run;
  }

  private async get(path: string, params: Record<string, string>) {
    return this.throttle(async () => {
      const url = `${this.base}${path}?${new URLSearchParams({ format: 'jsonv2', 'accept-language': 'ko,en', ...params })}`;
      const res = await this.fetchImpl(url, { headers: { 'user-agent': this.userAgent }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error(`nominatim ${path} failed: ${res.status}`);
      return (await res.json()) as any;
    });
  }

  private map(d: any, precision: GeoResult['precision']): GeoResult {
    const a = d.address ?? {};
    const iso = a['ISO3166-2-lvl4'] ?? a['ISO3166-2-lvl6'];
    return {
      label: d.display_name,
      lat: Number(d.lat),
      lng: Number(d.lon),
      country: String(a.country_code ?? 'kr').toUpperCase(),
      region: typeof iso === 'string' ? iso : undefined,
      city: a.city ?? a.town ?? a.province ?? a.state,
      district: a.borough ?? a.city_district ?? a.suburb,
      precision,
      provider: 'NOMINATIM',
    };
  }

  async geocode(query: string, opts: { limit?: number } = {}): Promise<GeoResult[]> {
    const rows = await this.get('/search', { q: query, limit: String(Math.min(opts.limit ?? 5, 10)), addressdetails: '1', countrycodes: 'kr' });
    return (rows as any[]).map((d) => this.map(d, d.addresstype === 'city' ? 'CITY' : d.addresstype === 'borough' ? 'DISTRICT' : 'ADDRESS'));
  }

  async reverse(lat: number, lng: number): Promise<GeoResult | null> {
    const d = await this.get('/reverse', { lat: String(lat), lon: String(lng), zoom: '14', addressdetails: '1' });
    if (!d || d.error) return null;
    return this.map(d, 'DISTRICT');
  }
}

// ---------------------------------------------------------------------------------------------
// Cache + fallback wrapper
// ---------------------------------------------------------------------------------------------
export class LruCache<V> {
  private map = new Map<string, { v: V; exp: number }>();
  constructor(private max = 1000, private ttlMs = 24 * 3600 * 1000) {}
  get(k: string): V | undefined {
    const e = this.map.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.map.delete(k);
      return undefined;
    }
    this.map.delete(k);
    this.map.set(k, e); // refresh recency
    return e.v;
  }
  set(k: string, v: V) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, { v, exp: Date.now() + this.ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size() {
    return this.map.size;
  }
}

/**
 * Caching geocoder: in-memory LRU in front of the provider; on provider failure falls back to the
 * STATIC table so map/search keep working (provider is replaceable — PLAT-02 acceptance).
 */
export class CachedGeocoder implements Geocoder {
  readonly cache = new LruCache<GeoResult[] | GeoResult | null>(2000);
  private fallback = new StaticGeocoder();
  constructor(private inner: Geocoder, private onError?: (err: unknown) => void) {}
  get name() {
    return this.inner.name;
  }

  async geocode(query: string, opts: { limit?: number } = {}): Promise<GeoResult[]> {
    const key = `g:${opts.limit ?? 5}:${norm(query)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit as GeoResult[];
    let res: GeoResult[];
    try {
      res = await this.inner.geocode(query, opts);
    } catch (err) {
      this.onError?.(err);
      return this.fallback.geocode(query, opts); // not cached: retry provider next time
    }
    this.cache.set(key, res);
    return res;
  }

  async reverse(lat: number, lng: number): Promise<GeoResult | null> {
    const key = `r:${lat.toFixed(4)}:${lng.toFixed(4)}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit as GeoResult | null;
    let res: GeoResult | null;
    try {
      res = await this.inner.reverse(lat, lng);
    } catch (err) {
      this.onError?.(err);
      return this.fallback.reverse(lat, lng);
    }
    this.cache.set(key, res);
    return res;
  }
}

/**
 * Deterministic privacy fuzz for public listing coordinates (~200–300 m, stable per property id so
 * repeated requests cannot be averaged out). Exact coordinates are revealed only after booking.
 */
export function fuzzCoordinates(id: string, lat: number, lng: number): { lat: number; lng: number } {
  const h = createHash('sha256').update(`jetpool-geo-fuzz:${id}`).digest();
  const angle = (h.readUInt32BE(0) / 0xffffffff) * 2 * Math.PI;
  const dist = 200 + (h.readUInt32BE(4) / 0xffffffff) * 100; // metres
  const dLat = (dist * Math.cos(angle)) / 111_320;
  const dLng = (dist * Math.sin(angle)) / (111_320 * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
  return { lat: Math.round((lat + dLat) * 1e5) / 1e5, lng: Math.round((lng + dLng) * 1e5) / 1e5 };
}
