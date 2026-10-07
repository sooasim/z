export type Lang = 'ko' | 'en';

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
  return new Intl.NumberFormat(lang === 'ko' ? 'ko-KR' : 'en-US', {
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
  return new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(d);
}

export function formatRange(start: string, end: string, lang: Lang = 'ko'): string {
  return `${formatDate(start, lang)} – ${formatDate(end, lang)}`;
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

export function initials(name: string): string {
  return (name || '?').trim().slice(0, 1).toUpperCase();
}

export function shortId(id: string): string {
  return (id || '').slice(0, 8);
}
