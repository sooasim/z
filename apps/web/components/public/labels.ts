/**
 * Public-area label helpers: property types, guide interests, travel product kinds, refund terms, addresses.
 * Keeps raw API enums / codes ("HANOK", "food", "full_refund_hours") out of the Korean UI.
 */
import { enumLabel, knownEnumLabel } from '@/lib/enums';
import { countryLabel, placeLabel } from '@/lib/places';
import { arr, f, num, str } from '@/lib/shape';

type Lang = 'ko' | 'en';
type Pair = readonly [string, string];

export const PROPERTY_TYPES: Array<{ value: string; ko: string; en: string }> = [
  { value: 'APARTMENT', ko: '아파트', en: 'Apartment' },
  { value: 'HOUSE', ko: '단독주택', en: 'House' },
  { value: 'HANOK', ko: '한옥', en: 'Hanok' },
  { value: 'VILLA', ko: '빌라', en: 'Villa' },
  { value: 'STUDIO', ko: '원룸', en: 'Studio' },
  { value: 'GUESTHOUSE', ko: '게스트하우스', en: 'Guesthouse' },
];

export function propertyTypeLabel(code: string | null | undefined, lang: Lang): string {
  if (!code) return '';
  const t = PROPERTY_TYPES.find((x) => x.value === code.toUpperCase());
  return t ? t[lang] : knownEnumLabel(code.toUpperCase(), lang) ?? enumLabel(code, lang);
}

const INTERESTS: Record<string, Pair> = {
  food: ['맛집', 'Food'],
  cafe: ['카페', 'Cafés'],
  cafes: ['카페', 'Cafés'],
  coffee: ['커피', 'Coffee'],
  walking: ['산책', 'Walking'],
  hiking: ['등산·트레킹', 'Hiking'],
  history: ['역사', 'History'],
  culture: ['문화', 'Culture'],
  art: ['예술', 'Art'],
  photography: ['사진', 'Photography'],
  photo: ['사진', 'Photography'],
  market: ['시장', 'Markets'],
  markets: ['시장', 'Markets'],
  shopping: ['쇼핑', 'Shopping'],
  nightlife: ['야경·밤문화', 'Nightlife'],
  nature: ['자연', 'Nature'],
  sea: ['바다', 'Sea'],
  beach: ['해변', 'Beach'],
  surfing: ['서핑', 'Surfing'],
  geology: ['지질·화산', 'Geology'],
  unesco: ['유네스코 유산', 'UNESCO sites'],
  temple: ['사찰', 'Temples'],
  hanok: ['한옥', 'Hanok'],
  kpop: ['K-팝', 'K-pop'],
  music: ['음악', 'Music'],
  cooking: ['요리', 'Cooking'],
  language: ['언어 교환', 'Language exchange'],
  'language-exchange': ['언어 교환', 'Language exchange'],
  local: ['로컬 라이프', 'Local life'],
  bike: ['자전거', 'Cycling'],
  cycling: ['자전거', 'Cycling'],
  wellness: ['웰니스', 'Wellness'],
  family: ['가족 여행', 'Family'],
  kids: ['아이와 함께', 'With kids'],
};

/** "food" → "맛집"; Korean / unknown values pass through. */
export function interestLabel(v: string, lang: Lang): string {
  const k = String(v ?? '').trim();
  const p = INTERESTS[k.toLowerCase()];
  return p ? p[lang === 'ko' ? 0 : 1] : k;
}

const KINDS: Record<string, Pair> = {
  TOUR: ['투어', 'Tour'],
  TICKET: ['티켓', 'Ticket'],
  PACKAGE: ['패키지', 'Package'],
  ACTIVITY: ['액티비티', 'Activity'],
  TRANSFER: ['교통', 'Transfer'],
  TRANSPORT: ['교통', 'Transport'],
};
export function productKindLabel(kind: string, lang: Lang): string {
  const p = KINDS[(kind || '').toUpperCase()];
  return p ? p[lang === 'ko' ? 0 : 1] : enumLabel(kind, lang);
}

function hoursText(h: number, lang: Lang): string {
  if (h >= 96 && h % 24 === 0) return lang === 'ko' ? `${h / 24}일` : `${h / 24} days`;
  return lang === 'ko' ? `${h}시간` : `${h} hours`;
}

/**
 * Refund terms as readable lines, most generous first:
 * - `{ full_refund_hours: 72 }` → "출발 72시간 전까지 전액 환불"
 * - `{ tiers: [{ refund_pct: 100, min_hours_before: 72 }, …] }` → one line per tier
 * `event` names the reference moment ("출발" for tours, "체크인" for stays).
 */
export function refundLines(terms: unknown, lang: Lang, event: Pair = ['출발', 'departure']): string[] {
  const ko = lang === 'ko';
  const ev = ko ? event[0] : event[1];
  if (!terms || typeof terms !== 'object') return [];
  const out: string[] = [];
  const full = num(terms, 'fullRefundHours', 'full_refund_hours', 'freeCancellationHours');
  if (full !== undefined) out.push(ko ? `${ev} ${hoursText(full, lang)} 전까지 전액 환불` : `Full refund up to ${hoursText(full, lang)} before ${ev}`);
  const partial = num(terms, 'partialRefundHours', 'partial_refund_hours');
  const partialPct = num(terms, 'partialRefundPct', 'partial_refund_pct');
  if (partial !== undefined && partialPct !== undefined) out.push(ko ? `${ev} ${hoursText(partial, lang)} 전까지 ${partialPct}% 환불` : `${partialPct}% refund up to ${hoursText(partial, lang)} before ${ev}`);
  const tiers = arr<any>(terms, 'tiers')
    .map((t) => ({ pct: num(t, 'refundPct', 'refund_pct', 'percent') ?? 0, h: num(t, 'minHoursBefore', 'min_hours_before', 'hoursBefore') ?? 0 }))
    .sort((a, b) => b.h - a.h);
  if (!out.length) {
    tiers.forEach((t, i) => {
      const prev = tiers[i - 1];
      if (t.h > 0) {
        if (t.pct >= 100) out.push(ko ? `${ev} ${hoursText(t.h, lang)} 전까지 전액 환불` : `Full refund up to ${hoursText(t.h, lang)} before ${ev}`);
        else if (t.pct > 0) out.push(ko ? `${ev} ${hoursText(t.h, lang)} 전까지 ${t.pct}% 환불` : `${t.pct}% refund up to ${hoursText(t.h, lang)} before ${ev}`);
      } else if (prev) {
        out.push(t.pct > 0 ? (ko ? `그 이후 ${t.pct}% 환불` : `${t.pct}% refund after that`) : ko ? `${ev} ${hoursText(prev.h, lang)} 이내 취소 시 환불 불가` : `No refund within ${hoursText(prev.h, lang)} of ${ev}`);
      }
    });
  }
  if (f(terms, 'feeRefundable', 'fee_refundable', 'serviceFeeRefundable') === false) out.push(ko ? '서비스 수수료는 환불되지 않아요' : 'Service fees are non-refundable');
  return out;
}

/** "보통 (Moderate)" → "보통" (ko) / "Moderate" (en). */
export function policyName(name: string, lang: Lang): string {
  const m = /^(.+?)\s*\((.+)\)\s*$/.exec(name || '');
  if (!m) return name || '';
  return lang === 'ko' ? m[1] : m[2];
}

/**
 * One-line address without duplicated city / English-only noise:
 * { line1: 'Seoul 데모로 1', city: 'Seoul' } → "서울 데모로 1".
 */
export function formatAddress(a: unknown, lang: Lang): string {
  if (!a || typeof a !== 'object') return '';
  const city = str(a, 'city');
  const cityL = placeLabel(city, lang);
  let line1 = str(a, 'line1', 'address1', 'street');
  if (city && line1.toLowerCase().startsWith(city.toLowerCase())) line1 = `${cityL} ${line1.slice(city.length).trim()}`.trim();
  const parts = [line1, str(a, 'line2', 'address2')];
  if (cityL && !parts.some((p) => p.includes(cityL))) parts.unshift(cityL);
  const country = str(a, 'country');
  const postal = str(a, 'postalCode', 'zip');
  const out = parts.filter(Boolean).join(' ');
  return [out, postal ? `(${postal})` : '', country && country !== 'KR' ? countryLabel(country, lang) : ''].filter(Boolean).join(' ');
}

/** Plain-text excerpt from Markdown: strips headings / emphasis / links and cuts at ~n characters. */
export function mdExcerpt(md: string, n = 80): string {
  const t = String(md || '')
    .replace(/^#+\s*/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > n ? `${t.slice(0, n).trim()}…` : t;
}
