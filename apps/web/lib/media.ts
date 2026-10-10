import { useSyncExternalStore, type CSSProperties } from 'react';
import { post } from './api';
import { item, str, f } from './shape';

export const ALLOWED_IMAGE = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** API media purposes (STAY-02). Documents (PDF) are only accepted for VERIFICATION / EVIDENCE. */
export type MediaPurpose = 'PROPERTY' | 'AVATAR' | 'VERIFICATION' | 'EVIDENCE' | 'MESSAGE' | 'CMS' | 'TRAVEL_PRODUCT' | 'GUIDE';

export function validateUpload(file: { type: string; size: number }, allowed = ALLOWED_IMAGE, max = MAX_IMAGE_BYTES): string | null {
  if (!allowed.includes(file.type)) return 'UNSUPPORTED_TYPE';
  if (file.size > max) return 'FILE_TOO_LARGE';
  if (file.size === 0) return 'EMPTY_FILE';
  return null;
}

export async function sha256Hex(file: Blob): Promise<string | undefined> {
  try {
    if (typeof crypto === 'undefined' || !crypto.subtle || file.size > 50 * 1024 * 1024) return undefined;
    const buf = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

/** Parse POST /v1/media/upload-url → { media: {id}, upload: {url, method, headers} } (tolerates flat shapes). */
export function parseUploadTicket(res: unknown) {
  const r = item(res) ?? {};
  return {
    id: str(r, 'media.id', 'mediaId', 'id'),
    url: str(r, 'upload.url', 'uploadUrl', 'url'),
    method: (str(r, 'upload.method', 'method') || 'PUT').toUpperCase(),
    headers: (f<Record<string, string>>(r, 'upload.headers', 'headers') ?? {}) as Record<string, string>,
  };
}

/**
 * Presigned upload: 1) POST /v1/media/upload-url 2) PUT bytes straight to object storage (never through the web
 * server) 3) POST /v1/media/:id/complete so the API sniffs/validates and processes it. Returns the media id.
 */
export async function presignedUpload(file: File, purpose: MediaPurpose, onProgress?: (pct: number) => void): Promise<string> {
  const sha256 = await sha256Hex(file);
  const t = parseUploadTicket(await post('/v1/media/upload-url', { purpose, mimeType: file.type || 'application/octet-stream', byteSize: file.size, sha256 }));
  if (!t.url || !t.id) throw new Error('Upload ticket missing');
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(t.method, t.url);
    const headers = { 'content-type': file.type, ...t.headers };
    Object.entries(headers).forEach(([k, v]) => k.toLowerCase() !== 'host' && xhr.setRequestHeader(k, v));
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(Math.round((e.loaded / e.total) * 100));
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Upload network error'));
    xhr.send(file);
  });
  await post(`/v1/media/${t.id}/complete`, {});
  return t.id;
}

// =====================================================================================================================
// Media map — real photos & migrated wontc.co.kr assets (apps/web/public/media-map.json, written by the data pipeline)
// =====================================================================================================================
//
// Every URL in the map is root-relative WITHOUT the deploy basePath ('/photos/<sha12>/960.webp',
// '/legacy/<sha12>/960.webp'). The web adds the Next basePath ('' on localhost:3000, '/z' on GitHub Pages), never
// twice: API data in the static demo already carries it. Lookups are by asset id ('photos/<sha12>'), so any variant
// URL of an asset (480/700/960.webp, original.jpg) resolves to the same entry.

/** Attribution for an openly-licensed photo (CC BY / BY-SA / CC0 / PDM) — shown on /credits. */
export interface MediaCredit {
  title?: string;
  creator?: string;
  creatorUrl?: string;
  license?: string;
  licenseUrl?: string;
  landingUrl?: string;
  provider?: string;
  attribution?: string;
}
export interface MediaEntry {
  srcset?: string;
  placeholder?: string;
  width?: number;
  height?: number;
  colorAvg?: string;
  alt?: string;
  credit?: MediaCredit;
  groups?: string[];
}
export interface ArchiveItem {
  url: string;
  alt?: string;
  captionKo?: string;
  /** Platform route where the image is used now ('/about/about-ceo', '/stories/heart-letter-01'). */
  page?: string;
  /** Title of that page. */
  pageTitle?: string;
  /** Original wontc.co.kr path ('/about_ceo'). */
  legacyPath?: string | null;
  category?: string;
  width?: number;
  height?: number;
}
export interface EmbedItem {
  provider: string;
  id: string;
  title?: string;
  date?: string;
  /** Human date as written on the legacy page ('1998년 5월 27일'). */
  dateText?: string;
  thumb?: string;
  description?: string;
  page?: string;
}
/**
 * Profile photos: openly-licensed real portraits standing in for the demo people. `byId` / `byName` are the seeded
 * hosts, guides and travellers; `pool` is every published portrait, used for anyone else (review authors, staff).
 */
export interface PeopleMap {
  byId: Record<string, string>;
  byName: Record<string, string>;
  pool: string[];
}
export interface MediaMap {
  photos: Record<string, MediaEntry>;
  legacy: Record<string, MediaEntry>;
  cities: Record<string, string>;
  guides: Record<string, string>;
  people: PeopleMap;
  hero: string[];
  charter: string[];
  archive: ArchiveItem[];
  embeds: EmbedItem[];
  /** Optional extras tolerated if the pipeline adds them. */
  products?: Record<string, string | string[]>;
  pools?: Record<string, string[]>;
  /** Property slug → photos (listing photos normally come from the API). */
  stays?: Record<string, string[]>;
  /** Platform route → migrated CMS entry summary. */
  pages?: Record<string, { type?: string; slug?: string; title?: string; heroUrl?: string }>;
}

/** Next basePath, inlined at build time by Next ('' in dev, '/z' on GitHub Pages). */
export const BASE_PATH: string = ((process.env.__NEXT_ROUTER_BASEPATH as string | undefined) || '').replace(/\/+$/, '');

const EXTERNAL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Root-relative path without the basePath (and without a same-asset origin). */
export function stripBase(url: string): string {
  let u = String(url || '');
  const abs = /^https?:\/\/[^/]+(\/.*)$/i.exec(u);
  if (abs && ASSET_RE.test(stripBasePath(abs[1]))) u = abs[1];
  return stripBasePath(u);
}
function stripBasePath(u: string): string {
  return BASE_PATH && (u === BASE_PATH || u.startsWith(BASE_PATH + '/')) ? u.slice(BASE_PATH.length) || '/' : u;
}

/** Adds the basePath to a root-relative public URL exactly once; absolute / data: / blob: URLs pass through. */
export function withBase(url: string | null | undefined): string {
  const u = String(url || '');
  if (!u || EXTERNAL.test(u) || !u.startsWith('/')) return u;
  if (BASE_PATH && (u === BASE_PATH || u.startsWith(BASE_PATH + '/'))) return u;
  return BASE_PATH + u;
}

/**
 * Scheme allow-list for a URL that is about to become an `<img src>`: an uploaded avatar or listing photo arrives
 * as API data or as a `blob:` preview of the file the user just picked, so only `http(s):`, `blob:` and
 * root-relative paths are rendered. Anything else (`javascript:`, `vbscript:`, `data:`, a protocol-relative host)
 * is dropped and the caller falls back to its placeholder.
 */
export function safeImageSrc(url: string | null | undefined): string | undefined {
  const u = String(url ?? '').trim();
  if (!u || u.startsWith('//')) return undefined;
  if (u.startsWith('/')) return u;
  return /^(https?|blob):/i.test(u) && !/^\s*(javascript|vbscript|data):/i.test(u) ? u : undefined;
}

const ASSET_RE = /^\/(photos|legacy)\/([0-9a-f]{12})(?:\/|$)/;
/** 'photos/<sha12>' | 'legacy/<sha12>' for a migrated / licensed asset URL (any variant, with or without basePath). */
export function assetId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = ASSET_RE.exec(stripBase(String(url).split(/[?#]/)[0]));
  return m ? `${m[1]}/${m[2]}` : null;
}
export const isLicensedPhoto = (url: string | null | undefined) => assetId(url)?.startsWith('photos/') ?? false;
export const isLegacyAsset = (url: string | null | undefined) => assetId(url)?.startsWith('legacy/') ?? false;

const EMPTY: MediaMap = { photos: {}, legacy: {}, cities: {}, guides: {}, people: { byId: {}, byName: {}, pool: [] }, hero: [], charter: [], archive: [], embeds: [] };

interface Indexed {
  map: MediaMap;
  byId: Map<string, { url: string; entry: MediaEntry }>;
  cityKeys: Map<string, string>;
  archiveById: Map<string, ArchiveItem>;
}

function asRecord<T>(v: unknown): Record<string, T> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, T>) : {};
}
function asList<T>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
const cityKey = (s: string) =>
  String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9가-힣]+/g, '');

/** Strips tags and decodes the common entities of provider metadata. */
export function plainText(v: string | undefined): string | undefined {
  if (v == null) return v;
  return String(v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Normalises a raw media-map document (tolerant of missing sections) and builds the id index. */
export function indexMediaMap(raw: unknown): Indexed {
  const r = asRecord<unknown>(raw);
  const map: MediaMap = {
    photos: asRecord<MediaEntry>(r.photos),
    legacy: asRecord<MediaEntry>(r.legacy),
    cities: asRecord<string>(r.cities),
    guides: asRecord<string>(r.guides),
    people: {
      byId: asRecord<string>(asRecord<unknown>(r.people).byId),
      byName: asRecord<string>(asRecord<unknown>(r.people).byName),
      pool: asList<string>(asRecord<unknown>(r.people).pool).filter((x) => typeof x === 'string'),
    },
    hero: asList<string>(r.hero).filter((x) => typeof x === 'string'),
    charter: asList<string>(r.charter).filter((x) => typeof x === 'string'),
    archive: asList<ArchiveItem>(r.archive).filter((x) => x && typeof x.url === 'string'),
    embeds: asList<EmbedItem>(r.embeds).filter((x) => x && typeof x.id === 'string'),
    products: r.products ? asRecord<string | string[]>(r.products) : undefined,
    pools: r.pools ? asRecord<string[]>(r.pools) : undefined,
    stays: r.stays ? asRecord<string[]>(r.stays) : undefined,
    pages: r.pages ? asRecord<{ type?: string; slug?: string; title?: string; heroUrl?: string }>(r.pages) : undefined,
  };
  // Provider metadata can carry markup (Wikimedia "<div class='fn'>…</div>"): credits are plain text.
  for (const e of Object.values(map.photos))
    if (e?.credit) e.credit = { ...e.credit, title: plainText(e.credit.title), creator: plainText(e.credit.creator) };
  const byId = new Map<string, { url: string; entry: MediaEntry }>();
  for (const section of [map.photos, map.legacy])
    for (const [url, entry] of Object.entries(section)) {
      const id = assetId(url);
      if (id && !byId.has(id)) byId.set(id, { url, entry: entry ?? {} });
    }
  const cityKeys = new Map<string, string>();
  for (const [name, url] of Object.entries(map.cities)) if (typeof url === 'string') cityKeys.set(cityKey(name), url);
  const archiveById = new Map<string, ArchiveItem>();
  for (const a of map.archive) {
    const id = assetId(a.url);
    if (id && !archiveById.has(id)) archiveById.set(id, a);
  }
  return { map, byId, cityKeys, archiveById };
}

let current: Indexed | null = null;
let loading: Promise<Indexed> | null = null;
const listeners = new Set<() => void>();
/**
 * What the component being rendered may see. `useMediaMap()` sets it from the store snapshot, so during hydration
 * (server snapshot = null) helpers behave exactly like on the server even if the map has already arrived — no
 * hydration mismatches; React re-renders subscribers with the loaded map right after. Outside React it is unset.
 */
let view: Indexed | null | undefined = undefined;
const active = (): Indexed | null => (view === undefined ? current : view);

/** Test / SSR hook: install a map synchronously (also used by the loader). */
export function setMediaMap(raw: unknown | null) {
  current = raw === null ? null : indexMediaMap(raw);
  view = undefined;
  listeners.forEach((l) => l());
}

/** Fetches /media-map.json once per page load (cached); a missing/broken map degrades to an empty one. */
export function loadMediaMap(): Promise<Indexed> {
  if (current) return Promise.resolve(current);
  if (loading) return loading;
  if (typeof window === 'undefined' || typeof fetch === 'undefined') return Promise.resolve(indexMediaMap(EMPTY));
  loading = fetch(withBase('/media-map.json'), { headers: { accept: 'application/json' } })
    .then((r) => (r.ok ? r.json() : EMPTY))
    .catch(() => EMPTY)
    .then((raw) => {
      setMediaMap(raw);
      return current!;
    });
  return loading;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  void loadMediaMap();
  return () => listeners.delete(cb);
}
const snapshot = () => current;
const serverSnapshot = () => null;

/**
 * Re-renders the caller once the media map has loaded. Returns the map (or null while loading). All helpers below
 * read the loaded map synchronously, so `useMediaMap(); const p = imgProps(url)` always reflects the latest state.
 */
export function useMediaMap(): MediaMap | null {
  const ix = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  view = ix;
  return ix?.map ?? null;
}
/** True once the map has loaded (or failed to load — then helpers fall back gracefully). */
export const mediaReady = () => active() !== null;

/** Start loading as early as possible (no-op on the server). */
export function prefetchMediaMap() {
  if (typeof window !== 'undefined') void loadMediaMap();
}

export function entryFor(url: string | null | undefined): MediaEntry | undefined {
  const id = assetId(url);
  return id ? active()?.byId.get(id)?.entry : undefined;
}
/** Canonical map URL (no basePath) of an asset, e.g. a '700.webp' variant → its map key. */
export function canonicalUrl(url: string | null | undefined): string | undefined {
  const id = assetId(url);
  return id ? active()?.byId.get(id)?.url : undefined;
}

export const DEFAULT_SIZES = '(max-width: 640px) 100vw, (max-width: 1100px) 50vw, 33vw';

export interface ImgProps {
  src: string;
  srcSet?: string;
  sizes?: string;
  width?: number;
  height?: number;
  alt?: string;
  loading?: 'lazy' | 'eager';
  decoding?: 'async' | 'auto' | 'sync';
  style: CSSProperties;
}

function srcsetWithBase(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;
  return srcset
    .split(',')
    .map((part) => {
      const [u, ...d] = part.trim().split(/\s+/);
      return [withBase(u), ...d].join(' ');
    })
    .filter(Boolean)
    .join(', ');
}

/**
 * <img> props for any public image URL: basePath-aware src + srcset + sizes, intrinsic width/height (no layout shift)
 * and a colour + blurred-placeholder background while the image loads. Unknown URLs (uploads, external) pass through.
 */
export function imgProps(url: string | null | undefined, opts: { sizes?: string; alt?: string; eager?: boolean; placeholder?: boolean } = {}): ImgProps {
  const e = entryFor(url);
  const style: CSSProperties = {};
  if (e?.colorAvg) style.backgroundColor = e.colorAvg;
  if (e?.placeholder && opts.placeholder !== false) {
    style.backgroundImage = `url("${e.placeholder}")`;
    style.backgroundSize = 'cover';
    style.backgroundPosition = 'center';
    style.backgroundRepeat = 'no-repeat';
  }
  const srcSet = srcsetWithBase(e?.srcset);
  return {
    src: withBase(url || ''),
    srcSet,
    sizes: srcSet ? opts.sizes || DEFAULT_SIZES : undefined,
    width: e?.width || undefined,
    height: e?.height || undefined,
    alt: opts.alt ?? e?.alt ?? undefined,
    loading: opts.eager ? 'eager' : 'lazy',
    decoding: 'async',
    style,
  };
}

/** Deterministic pick from a list (stable per seed). */
export function pick<T>(list: readonly T[], seed: string): T | undefined {
  if (!list.length) return undefined;
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return list[(h >>> 0) % list.length];
}

/** Real photo for a city: exact / normalised name, Korean alias via lib/places, or a city key contained in the text. */
export function cityPhoto(city: string | null | undefined, resolve?: (s: string) => string): string | undefined {
  const ix = active();
  if (!ix || !city) return undefined;
  const keys = ix.cityKeys;
  const tries = [city, resolve?.(city) ?? ''];
  for (const t of tries) {
    const hit = t && keys.get(cityKey(t));
    if (hit) return hit;
  }
  const k = cityKey(resolve?.(city) || city);
  if (k.length >= 3) for (const [name, url] of keys) if (name.length >= 4 && k.includes(name)) return url;
  return undefined;
}

export const guideCover = (guideId: string | null | undefined): string | undefined => (guideId && active()?.map.guides[guideId]) || undefined;

/**
 * Profile photo of a person who has not uploaded one: the portrait the pipeline assigned to that user id or display
 * name, else a stable pick from the portrait pool (same key ⇒ same face on every page). The portraits are
 * openly-licensed real photos standing in for the demo personas — credited, like every other photo, on /credits.
 */
export function personPhoto(...keys: (string | null | undefined)[]): string | undefined {
  const p = active()?.map.people;
  if (!p) return undefined;
  for (const k of keys) {
    const key = String(k ?? '').trim();
    if (!key) continue;
    const hit = p.byId[key] ?? p.byName[key];
    if (hit) return hit;
  }
  const seed = keys.map((k) => String(k ?? '').trim()).find(Boolean);
  return seed ? pick(p.pool, seed) : undefined;
}
export const heroPhotos = (): string[] => active()?.map.hero ?? [];
export const charterPhotos = (): string[] => active()?.map.charter ?? [];
export const archive = (): ArchiveItem[] => active()?.map.archive ?? [];
export const embeds = (): EmbedItem[] => active()?.map.embeds ?? [];
export const embedById = (id: string): EmbedItem | undefined => active()?.map.embeds.find((e) => e.id === id);
export const credit = (url: string | null | undefined): MediaCredit | undefined => entryFor(url)?.credit;
export const altFor = (url: string | null | undefined): string | undefined => entryFor(url)?.alt;

/** Product cover from optional map extras (`products[id]`). */
export function productPhotos(productId: string | null | undefined): string[] {
  const v = productId ? active()?.map.products?.[productId] : undefined;
  return Array.isArray(v) ? v : v ? [v] : [];
}

/** A named pool from optional map extras, else a reasonable generic pool (city photos + hero). */
export function photoPool(name?: string): string[] {
  const m = active()?.map;
  if (!m) return [];
  const named = name ? m.pools?.[name] : undefined;
  if (named?.length) return named;
  if (name === 'charter' && m.charter.length) return m.charter;
  if (name === 'hero' && m.hero.length) return m.hero;
  const generic = [...new Set([...(m.pools?.destination ?? []), ...Object.values(m.cities), ...m.hero])].filter((u) => typeof u === 'string');
  return generic.length ? generic : Object.keys(m.photos);
}

/** Every licensed photo in the map with its credit (for /credits). */
export function creditedPhotos(): Array<{ url: string; entry: MediaEntry; credit: MediaCredit }> {
  const ix = active();
  if (!ix) return [];
  return Object.entries(ix.map.photos)
    .filter(([, e]) => !!e?.credit)
    .map(([url, entry]) => ({ url, entry, credit: entry.credit! }));
}

/** Platform route → CMS summary of every migrated page (media map `pages`). */
export const migratedPages = () => active()?.map.pages ?? {};
/** Photos the pipeline assigned to a property slug (fallback when the API has none). */
export const stayPhotos = (slug: string | null | undefined): string[] => (slug && active()?.map.stays?.[slug]) || [];

/** Archive record (caption, category, source page) of a migrated wontc.co.kr asset. */
export const archiveItem = (url: string | null | undefined): ArchiveItem | undefined => {
  const id = assetId(url);
  return id ? active()?.archiveById.get(id) : undefined;
};
const CHROME = new Set(['icon', 'ui-element', 'logo']);
/**
 * Site chrome captured from the old site (YouTube play glyphs, 68px avatars, SixShop UI) — kept in /archive, which
 * shows every migrated asset, but left out of editorial galleries.
 */
export function isSiteChrome(url: string | null | undefined): boolean {
  const a = archiveItem(url);
  if (a?.category && CHROME.has(a.category)) return true;
  const e = entryFor(url);
  return !!e?.width && !!e?.height && Math.max(e.width, e.height) < 200;
}

const DOC = new Set(['letter-illustration', 'screenshot-text', 'infographic', 'banner', 'map']);
/**
 * Text-heavy or portrait legacy images (letter scans, posters, infographics): show them whole (object-fit: contain
 * on their own blurred placeholder) and full width — never cropped into a 16:9 hero or a thumbnail grid.
 */
export function isDocLike(url: string | null | undefined): boolean {
  const a = archiveItem(url);
  if (a?.category) return DOC.has(a.category); // classified legacy asset: the visual category decides
  const e = entryFor(url);
  return !!e?.width && !!e?.height && e.height > e.width * 1.6;
}
