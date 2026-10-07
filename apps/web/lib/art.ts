/** Local generative "postcard" illustrations (public/art/postcards) used when a listing has no photo. */
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

export function postcardFor(place: string, seed = ''): string {
  for (const [re, name] of CITY_ART) if (re.test(place || '')) return `/art/postcards/${name}.svg`;
  return `/art/postcards/${GENERIC[hashString(seed || place || 'jetpool') % GENERIC.length]}.svg`;
}

/** A small set of postcards for carousels when a listing has no photos. */
export function postcardSet(place: string, seed: string, n = 3): string[] {
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
