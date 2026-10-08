/**
 * Place-name i18n. The API stores canonical English city names ("Jeju"); the Korean UI shows "제주".
 * - canonicalPlace('제주') → 'Jeju' (search params, API queries)
 * - placeLabel('Jeju', 'ko') → '제주' (cards, headings, inputs)
 * Unknown names pass through unchanged so free-text search keeps working.
 */
export interface Place {
  en: string;
  ko: string;
  /** Extra spellings that should resolve to this place. */
  aliases?: string[];
  /** Postcard art name under /public/art/postcards, when one exists. */
  art?: string;
  lat?: number;
  lng?: number;
}

export const PLACES: Place[] = [
  { en: 'Seoul', ko: '서울', aliases: ['서울시', '서울특별시'], art: 'seoul', lat: 37.5665, lng: 126.978 },
  { en: 'Jeju', ko: '제주', aliases: ['제주도', '제주시', 'Jeju-si', 'Jeju Island', 'Jejudo'], art: 'jeju', lat: 33.4996, lng: 126.5312 },
  { en: 'Seogwipo', ko: '서귀포', aliases: ['서귀포시'], art: 'jeju', lat: 33.2541, lng: 126.56 },
  { en: 'Busan', ko: '부산', aliases: ['부산시', '부산광역시', 'Pusan'], art: 'busan', lat: 35.1796, lng: 129.0756 },
  { en: 'Gangneung', ko: '강릉', aliases: ['강릉시'], art: 'gangneung', lat: 37.7519, lng: 128.8761 },
  { en: 'Gyeongju', ko: '경주', aliases: ['경주시'], art: 'gyeongju', lat: 35.8562, lng: 129.2247 },
  { en: 'Jeonju', ko: '전주', aliases: ['전주시'], art: 'gyeongju', lat: 35.8242, lng: 127.148 },
  { en: 'Sokcho', ko: '속초', art: 'gangneung', lat: 38.207, lng: 128.5918 },
  { en: 'Yangyang', ko: '양양', art: 'gangneung', lat: 38.0754, lng: 128.6189 },
  { en: 'Yeosu', ko: '여수', lat: 34.7604, lng: 127.6622 },
  { en: 'Tongyeong', ko: '통영', lat: 34.8544, lng: 128.4331 },
  { en: 'Namhae', ko: '남해', lat: 34.8376, lng: 127.8924 },
  { en: 'Andong', ko: '안동', lat: 36.5684, lng: 128.7294 },
  { en: 'Chuncheon', ko: '춘천', lat: 37.8813, lng: 127.7298 },
  { en: 'Incheon', ko: '인천', lat: 37.4563, lng: 126.7052 },
  { en: 'Daegu', ko: '대구', lat: 35.8714, lng: 128.6014 },
  { en: 'Daejeon', ko: '대전', lat: 36.3504, lng: 127.3845 },
  { en: 'Gwangju', ko: '광주', lat: 35.1595, lng: 126.8526 },
  { en: 'Pohang', ko: '포항', lat: 36.019, lng: 129.3435 },
  { en: 'Tokyo', ko: '도쿄', aliases: ['東京', '동경'], art: 'tokyo', lat: 35.6762, lng: 139.6503 },
  { en: 'Osaka', ko: '오사카', aliases: ['大阪'], art: 'osaka', lat: 34.6937, lng: 135.5023 },
  { en: 'Kyoto', ko: '교토', aliases: ['京都'], art: 'osaka', lat: 35.0116, lng: 135.7681 },
  { en: 'Fukuoka', ko: '후쿠오카', lat: 33.5904, lng: 130.4017 },
  { en: 'Sapporo', ko: '삿포로', lat: 43.0618, lng: 141.3545 },
  { en: 'Okinawa', ko: '오키나와', lat: 26.2124, lng: 127.6809 },
  { en: 'Taipei', ko: '타이베이', aliases: ['타이페이'], lat: 25.033, lng: 121.5654 },
  { en: 'Bangkok', ko: '방콕', art: 'bangkok', lat: 13.7563, lng: 100.5018 },
  { en: 'Chiang Mai', ko: '치앙마이', aliases: ['Chiangmai'], art: 'chiangmai', lat: 18.7883, lng: 98.9853 },
  { en: 'Da Nang', ko: '다낭', aliases: ['Danang'], art: 'hanoi', lat: 16.0544, lng: 108.2022 },
  { en: 'Hanoi', ko: '하노이', art: 'hanoi', lat: 21.0278, lng: 105.8342 },
  { en: 'Ho Chi Minh City', ko: '호치민', aliases: ['Saigon', '사이공', '호찌민'], art: 'hanoi', lat: 10.8231, lng: 106.6297 },
  { en: 'Bali', ko: '발리', aliases: ['Ubud', '우붓'], art: 'bali', lat: -8.3405, lng: 115.092 },
  { en: 'Cebu', ko: '세부', lat: 10.3157, lng: 123.8854 },
  { en: 'Singapore', ko: '싱가포르', lat: 1.3521, lng: 103.8198 },
  { en: 'Hong Kong', ko: '홍콩', lat: 22.3193, lng: 114.1694 },
  { en: 'Lisbon', ko: '리스본', aliases: ['Lisboa'], art: 'lisbon', lat: 38.7223, lng: -9.1393 },
  { en: 'Porto', ko: '포르투', art: 'lisbon', lat: 41.1579, lng: -8.6291 },
  { en: 'Paris', ko: '파리', art: 'paris', lat: 48.8566, lng: 2.3522 },
  { en: 'London', ko: '런던', lat: 51.5072, lng: -0.1276 },
  { en: 'Barcelona', ko: '바르셀로나', lat: 41.3874, lng: 2.1686 },
  { en: 'New York', ko: '뉴욕', aliases: ['NYC'], lat: 40.7128, lng: -74.006 },
];

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
const INDEX = new Map<string, Place>();
for (const p of PLACES) for (const k of [p.en, p.ko, ...(p.aliases ?? [])]) INDEX.set(norm(k), p);

export function findPlace(text: string | null | undefined): Place | undefined {
  if (!text) return undefined;
  return INDEX.get(norm(text));
}

/** Canonical (API) name for a typed/shown place: '제주' → 'Jeju'. Unknown text is returned trimmed, unchanged. */
export function canonicalPlace(text: string | null | undefined): string {
  const t = (text ?? '').trim();
  return findPlace(t)?.en ?? t;
}

/** Localized display name: placeLabel('Jeju','ko') → '제주'. Unknown names are returned unchanged. */
export function placeLabel(value: string | null | undefined, lang: 'ko' | 'en' = 'ko'): string {
  const v = (value ?? '').trim();
  if (!v) return '';
  const p = findPlace(v);
  return p ? p[lang] : v;
}

const regionNames: Partial<Record<'ko' | 'en', Intl.DisplayNames | null>> = {};
/** ISO-3166 country code → localized country name ('KR' → '대한민국'); other strings pass through. */
export function countryLabel(code: string | null | undefined, lang: 'ko' | 'en' = 'ko'): string {
  const c = (code ?? '').trim();
  if (!/^[A-Za-z]{2}$/.test(c)) return c;
  if (regionNames[lang] === undefined) {
    try {
      regionNames[lang] = new Intl.DisplayNames([lang === 'ko' ? 'ko-KR' : 'en'], { type: 'region' });
    } catch {
      regionNames[lang] = null;
    }
  }
  try {
    return regionNames[lang]?.of(c.toUpperCase()) ?? c;
  } catch {
    return c;
  }
}
