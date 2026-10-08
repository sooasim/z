import { cityPhoto, photoPool, pick, prefetchMediaMap } from './media';
import { canonicalPlace } from './places';

/**
 * Cover art when an entity has no photo of its own. Once the media map (public/media-map.json) has loaded these
 * return REAL photos (the city's photo, else a stable pick from the licensed pool); before that — or if the map is
 * unavailable — the local generative "postcard" illustrations (public/art/postcards) are used.
 * Components that render the result through <Photo>/<Carousel> upgrade postcards to photos as soon as the map loads.
 */
const CITY_ART: Array<[RegExp, string]> = [
  [/서울|seoul|성수|홍대|강남|종로/i, 'seoul'],
  [/제주|jeju|서귀포|애월/i, 'jeju'],
  [/부산|busan|해운대|광안/i, 'busan'],
  [/강릉|gangneung|속초|양양|sokcho/i, 'gangneung'],
  [/경주|gyeongju|전주|jeonju|안동/i, 'gyeongju'],
  [/도쿄|東京|tokyo/i, 'tokyo'],
  [/오사카|大阪|osaka|교토|kyoto/i, 'osaka'],
  [/방콕|bangkok/i, 'bangkok'],
  [/치앙마이|chiang ?mai/i, 'chiangmai'],
  [/리스본|lisbon|porto|포르투/i, 'lisbon'],
  [/파리|paris/i, 'paris'],
  [/발리|bali|ubud/i, 'bali'],
  [/하노이|hanoi|다낭|da ?nang|호치민/i, 'hanoi'],
];
const GENERIC = ['coast', 'mountain', 'city', 'jeju', 'lisbon', 'bali', 'gangneung', 'chiangmai'];

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Postcard art name → canonical city (for upgrading a postcard URL to that city's photo). */
const ART_CITY: Record<string, string> = { seoul: 'Seoul', jeju: 'Jeju', busan: 'Busan', gangneung: 'Gangneung', gyeongju: 'Gyeongju', tokyo: 'Tokyo', osaka: 'Osaka', bangkok: 'Bangkok', chiangmai: 'Chiang Mai', lisbon: 'Lisbon', paris: 'Paris', bali: 'Bali', hanoi: 'Hanoi' };

/** A real photo for a place: the city's own photo, else a stable pick from the generic pool (map loaded only). */
export function placePhoto(place: string, seed = ''): string | undefined {
  prefetchMediaMap();
  const art = CITY_ART.find(([re]) => re.test(place || ''))?.[1];
  return cityPhoto(place, canonicalPlace) ?? (art ? cityPhoto(ART_CITY[art]) : undefined) ?? pick(photoPool(), seed || place || 'jetpool');
}

const POSTCARD_RE = /\/art\/postcards\/([a-z]+)\.svg(?:$|[?#])/;
const PLACEHOLDER_RE = /\/placeholder\/(\d+)\.svg(?:$|[?#])/;
/** True for generated art / seed placeholders (not a real photo). */
export const isArt = (src: string | null | undefined) => !!src && (POSTCARD_RE.test(src) || PLACEHOLDER_RE.test(src));

/** Upgrades a postcard / seed-placeholder URL to a real photo once the media map is loaded; other URLs unchanged. */
export function realize(src: string, seed = ''): string {
  const m = POSTCARD_RE.exec(src || '');
  if (m) return placePhoto(ART_CITY[m[1]] ?? '', m[1] + seed) ?? src;
  const p = PLACEHOLDER_RE.exec(src || '');
  if (p) return pick(photoPool('stay'), 'placeholder' + p[1] + seed) ?? src;
  return src;
}

export function postcardFor(place: string, seed = ''): string {
  const real = placePhoto(place, seed);
  if (real) return real;
  for (const [re, name] of CITY_ART) if (re.test(place || '')) return `/art/postcards/${name}.svg`;
  return `/art/postcards/${GENERIC[hashString(seed || place || 'jetpool') % GENERIC.length]}.svg`;
}

/** A small set of postcards for carousels when a listing has no photos. */
export function postcardSet(place: string, seed: string, n = 3): string[] {
  const real = placePhoto(place, seed);
  if (real) {
    const pool = photoPool().filter((u) => u !== real);
    const out = [real];
    for (let i = 1; out.length < n && i < n + 8; i++) {
      const u = pick(pool, `${seed}:${i}`);
      if (u && !out.includes(u)) out.push(u);
    }
    return out;
  }
  const first = postcardFor(place, seed);
  const rest = GENERIC.map((g) => `/art/postcards/${g}.svg`).filter((g) => g !== first);
  const start = hashString(seed) % rest.length;
  return [first, ...Array.from({ length: n - 1 }, (_, i) => rest[(start + i) % rest.length])];
}

const FLAGS: Record<string, string> = {
  ko: '🇰🇷', en: '🇺🇸', ja: '🇯🇵', zh: '🇨🇳', es: '🇪🇸', fr: '🇫🇷', de: '🇩🇪', it: '🇮🇹', th: '🇹🇭', vi: '🇻🇳', pt: '🇵🇹', ru: '🇷🇺', id: '🇮🇩',
};
const LANG_NAME: Record<string, [string, string]> = {
  ko: ['한국어', 'Korean'], en: ['영어', 'English'], ja: ['일본어', 'Japanese'], zh: ['중국어', 'Chinese'], es: ['스페인어', 'Spanish'], fr: ['프랑스어', 'French'], de: ['독일어', 'German'], it: ['이탈리아어', 'Italian'], th: ['태국어', 'Thai'], vi: ['베트남어', 'Vietnamese'], pt: ['포르투갈어', 'Portuguese'], ru: ['러시아어', 'Russian'], id: ['인도네시아어', 'Indonesian'],
};
export function langCode(l: string): string {
  return (l || '').toLowerCase().slice(0, 2);
}
export function flagFor(l: string): string {
  return FLAGS[langCode(l)] ?? '🌐';
}
export function langName(l: string, ui: 'ko' | 'en'): string {
  const n = LANG_NAME[langCode(l)];
  return n ? n[ui === 'ko' ? 0 : 1] : l;
}
