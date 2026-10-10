export type Lang = 'ko' | 'en' | 'ja' | 'zh' | 'vi';

/** BCP-47 tag per UI language. Kept here (not in lib/langs.ts) so the formatters have no import cycle. */
const LOCALE: Record<Lang, string> = { ko: 'ko-KR', en: 'en-US', ja: 'ja-JP', zh: 'zh-CN', vi: 'vi-VN' };

/** The `Intl` locale for a UI language. */
export const intlLocale = (lang: Lang = 'ko'): string => LOCALE[lang] ?? LOCALE.ko;

/** Languages that write dates as `11月10日` and need no separator before a time. */
const CJK: ReadonlySet<Lang> = new Set<Lang>(['ko', 'ja', 'zh']);

/** "3박" / "3 nights" / "3泊" / "3晚" / "3 đêm". */
export const nightsText = (n: number, lang: Lang): string =>
  lang === 'ko' ? `${n}박`
  : lang === 'ja' ? `${n}泊`
  : lang === 'zh' ? `${n}晚`
  : lang === 'vi' ? `${n} đêm`
  : `${n} night${n === 1 ? '' : 's'}`;

/** Minor-unit exponent per ISO-4217 (KRW/JPY have 0 decimals). */
export function currencyExponent(currency: string): number {
  const c = (currency || 'KRW').toUpperCase();
  if (['KRW', 'JPY', 'VND', 'CLP', 'ISK', 'TWD'].includes(c)) return c === 'TWD' ? 2 : 0;
  if (['BHD', 'KWD', 'OMR', 'JOD', 'TND'].includes(c)) return 3;
  return 2;
}

/** Format integer minor units (bigint-safe via string/number). Never uses float arithmetic for KRW. */
export function formatMoney(minor: number | string | bigint | null | undefined, currency = 'KRW', lang: Lang = 'ko'): string {
  if (minor === null || minor === undefined || minor === '') return '—';
  const cur = (currency || 'KRW').toUpperCase();
  const exp = currencyExponent(cur);
  let major: number;
  if (typeof minor === 'bigint') major = Number(minor) / 10 ** exp;
  else {
    const n = typeof minor === 'number' ? minor : Number(minor);
    if (!Number.isFinite(n)) return '—';
    major = exp === 0 ? n : n / 10 ** exp;
  }
  return new Intl.NumberFormat(intlLocale(lang), {
    style: 'currency',
    currency: cur,
    minimumFractionDigits: exp,
    maximumFractionDigits: exp,
  }).format(major);
}

/** Parse a user-entered major amount (e.g. "120,000") into integer minor units. */
export function toMinor(major: string | number, currency = 'KRW'): number {
  const exp = currencyExponent(currency);
  const s = String(major).replace(/[^\d.-]/g, '');
  if (!s) return 0;
  const [i, d = ''] = s.split('.');
  const frac = (d + '0'.repeat(exp)).slice(0, exp);
  const sign = i.startsWith('-') ? -1 : 1;
  const intPart = Math.abs(parseInt(i || '0', 10)) || 0;
  return sign * (intPart * 10 ** exp + (exp ? parseInt(frac || '0', 10) : 0));
}

/** YYYY-MM-DD in local time. */
export function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function parseIsoDate(s: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function addDays(s: string, n: number): string {
  const d = parseIsoDate(s);
  if (!d) return s;
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

/** Nights between check-in and check-out (half-open [start, end)). 0 if invalid. */
export function nightsBetween(start: string, end: string): number {
  const a = parseIsoDate(start);
  const b = parseIsoDate(end);
  if (!a || !b) return 0;
  const n = Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86400000);
  return n > 0 ? n : 0;
}

export function validRange(start: string, end: string): boolean {
  return nightsBetween(start, end) > 0;
}

/** Inclusive list of YYYY-MM-DD dates in [start, end). */
export function eachNight(start: string, end: string): string[] {
  const out: string[] = [];
  const n = nightsBetween(start, end);
  for (let i = 0; i < n && i < 400; i++) out.push(addDays(start, i));
  return out;
}

/** Do two half-open ranges overlap? */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Postgres daterange literal "[2026-01-01,2026-01-05)" → {start,end}. */
export function parseDateRange(v: unknown): { start: string; end: string } | null {
  if (typeof v !== 'string') return null;
  const m = /^[[(]\s*([\d-]+)\s*,\s*([\d-]+)\s*[\])]$/.exec(v.trim());
  if (!m) return null;
  return { start: m[1], end: m[2] };
}

export function formatDate(s: string | Date | null | undefined, lang: Lang = 'ko', withTime = false): string {
  if (!s) return '—';
  const d = typeof s === 'string' ? (s.length === 10 ? parseIsoDate(s) : new Date(s)) : s;
  if (!d || Number.isNaN(d.getTime())) return String(s);
  return new Intl.DateTimeFormat(intlLocale(lang), {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(d);
}

/** Full, screen-reader friendly date: "2026년 11월 10일 화요일" / "Tuesday, November 10, 2026". */
export function formatDateLong(s: string | Date | null | undefined, lang: Lang = 'ko'): string {
  if (!s) return '—';
  const d = typeof s === 'string' ? (s.length === 10 ? parseIsoDate(s) : new Date(s)) : s;
  if (!d || Number.isNaN(d.getTime())) return String(s);
  return new Intl.DateTimeFormat(intlLocale(lang), { dateStyle: 'full' }).format(d);
}

function toDate(s: string | Date | null | undefined): Date | null {
  if (!s) return null;
  const d = typeof s === 'string' ? (s.length === 10 ? parseIsoDate(s) : new Date(s)) : s;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

/**
 * Compact date range that drops repeated year/month: "2026년 11월 10일 – 13일", "11월 28일 – 12월 2일" (current year),
 * "Nov 10 – 13, 2026". `opts.nights` appends "· 3박" / "· 3 nights"; `opts.year: false` never prints the year.
 */
export function formatRange(start: string, end: string, lang: Lang = 'ko', opts: { nights?: boolean; year?: boolean } = {}): string {
  const a = toDate(start);
  const b = toDate(end);
  if (!a || !b) return `${formatDate(start, lang)} – ${formatDate(end, lang)}`;
  const nowY = new Date().getFullYear();
  const showYear = opts.year ?? !(a.getFullYear() === nowY && b.getFullYear() === nowY);
  const sameY = a.getFullYear() === b.getFullYear();
  const sameM = sameY && a.getMonth() === b.getMonth();
  let out: string;
  if (lang === 'ko') {
    const y = (d: Date) => (showYear ? `${d.getFullYear()}년 ` : '');
    const left = `${y(a)}${a.getMonth() + 1}월 ${a.getDate()}일`;
    const right = sameM ? `${b.getDate()}일` : sameY ? `${b.getMonth() + 1}월 ${b.getDate()}일` : `${y(b)}${b.getMonth() + 1}월 ${b.getDate()}일`;
    out = `${left} – ${right}`;
  } else {
    // `Intl` already writes 11月10日 for ja/zh and "10 thg 11" for vi, so one branch covers every non-ko language.
    const md = (d: Date) => new Intl.DateTimeFormat(intlLocale(lang), { month: 'short', day: 'numeric' }).format(d);
    if (sameM) out = `${md(a)} – ${b.getDate()}${showYear ? `, ${b.getFullYear()}` : ''}`;
    else if (sameY) out = `${md(a)} – ${md(b)}${showYear ? `, ${b.getFullYear()}` : ''}`;
    else out = `${md(a)}, ${a.getFullYear()} – ${md(b)}, ${b.getFullYear()}`;
  }
  if (opts.nights) {
    const n = nightsBetween(String(start).slice(0, 10), String(end).slice(0, 10));
    if (n > 0) out += ` · ${nightsText(n, lang)}`;
  }
  return out;
}

/**
 * Time range on one line, repeating the day only when it changes: "11월 11일 (수) 10:00–14:00",
 * "Wed, Nov 11 · 10:00–14:00"; across days "11월 11일 (수) 22:00 – 11월 12일 (목) 02:00".
 */
export function formatTimeRange(start: string | Date | null | undefined, end: string | Date | null | undefined, lang: Lang = 'ko'): string {
  const a = toDate(start);
  const b = toDate(end);
  if (!a) return '—';
  const loc = intlLocale(lang);
  const time = (d: Date) => new Intl.DateTimeFormat(loc, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  const day = (d: Date) =>
    lang === 'ko'
      ? `${d.getMonth() + 1}월 ${d.getDate()}일 (${new Intl.DateTimeFormat('ko-KR', { weekday: 'short' }).format(d)})`
      : new Intl.DateTimeFormat(loc, { weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const sep = CJK.has(lang) ? ' ' : ' · ';
  if (!b) return `${day(a)}${sep}${time(a)}`;
  if (isoDate(a) === isoDate(b)) return `${day(a)}${sep}${time(a)}–${time(b)}`;
  return `${day(a)}${sep}${time(a)} – ${day(b)}${sep}${time(b)}`;
}

/** Month grid (6 weeks x 7 days) starting Sunday, for calendar views. */
export function monthGrid(year: number, month0: number): string[] {
  const first = new Date(year, month0, 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const out: string[] = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    out.push(isoDate(d));
  }
  return out;
}

/** Like monthGrid but without trailing weeks that hold no day of the month (5-row months stay 5 rows). */
export function monthWeeks(year: number, month0: number): string[] {
  const g = monthGrid(year, month0);
  const inMonth = (d: string) => Number(d.slice(5, 7)) - 1 === month0;
  let n = 6;
  while (n > 4 && !g.slice((n - 1) * 7, n * 7).some(inMonth)) n--;
  return g.slice(0, n * 7);
}

export function initials(name: string): string {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

export function shortId(id: string): string {
  return (id || '').slice(0, 8);
}

/** Compact money for KPI tiles: ₩1.8억 (ko) / ₩184M (en). Exact values belong in tables. */
export function formatMoneyCompact(minor: number | string | null | undefined, currency = 'KRW', lang: Lang = 'ko'): string {
  if (minor === null || minor === undefined || minor === '') return '—';
  const n = Number(minor) / 10 ** currencyExponent(currency);
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) < 100000) return formatMoney(minor, currency, lang);
  return new Intl.NumberFormat(intlLocale(lang), { style: 'currency', currency: currency.toUpperCase(), notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

/** Very short price for calendar cells: "18만" / "18.5만" (ko), "₩180K" (en); other currencies use compact notation. */
export function formatPriceShort(minor: number | string | null | undefined, currency = 'KRW', lang: Lang = 'ko'): string {
  if (minor === null || minor === undefined || minor === '') return '';
  const n = Number(minor) / 10 ** currencyExponent(currency);
  if (!Number.isFinite(n)) return '';
  if ((currency || 'KRW').toUpperCase() === 'KRW') {
    // ko/ja/zh group by 10,000 (만/万); en/vi read thousands.
    const myriad = lang === 'ko' ? '만' : lang === 'ja' || lang === 'zh' ? '万' : '';
    if (myriad && n >= 10000) return `${Math.round(n / 1000) / 10}${myriad}`;
    if (!myriad && n >= 1000) return `₩${Math.round(n / 100) / 10}K`;
    return formatMoney(minor, currency, lang);
  }
  return new Intl.NumberFormat(intlLocale(lang), { style: 'currency', currency: currency.toUpperCase(), notation: 'compact', maximumFractionDigits: 1 }).format(n);
}
