import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/** INT-01 iCalendar (RFC 5545) helpers — pure parse/build + an SSRF-guarded fetcher. */

export interface IcsEvent {
  uid: string;
  start: string; // YYYY-MM-DD (inclusive)
  end: string; // YYYY-MM-DD (exclusive)
  status: string | null;
}

/** Unfold folded lines (CRLF + space/tab continuation). */
function unfold(text: string): string[] {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '').split('\n');
}

const addDays = (d: string, n: number) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/** DATE or DATE-TIME value → calendar date in the property's timezone (UTC times shifted by tzOffsetHours). */
function toDate(params: string, value: string, tzOffsetHours: number): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  if (!hh || /VALUE=DATE(?!-)/i.test(params)) return `${y}-${mo}-${d}`;
  if (z) {
    const utc = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss) + tzOffsetHours * 3600_000;
    return new Date(utc).toISOString().slice(0, 10);
  }
  return `${y}-${mo}-${d}`; // floating / TZID local time: use the local date
}

export function parseIcs(text: string, opts: { tzOffsetHours?: number; maxEvents?: number } = {}): IcsEvent[] {
  const tz = opts.tzOffsetHours ?? 9; // Asia/Seoul
  const events: IcsEvent[] = [];
  let cur: Record<string, { params: string; value: string }> | null = null;
  for (const line of unfold(text)) {
    if (/^BEGIN:VEVENT$/i.test(line.trim())) {
      cur = {};
      continue;
    }
    if (/^END:VEVENT$/i.test(line.trim())) {
      if (cur?.DTSTART) {
        const start = toDate(cur.DTSTART.params, cur.DTSTART.value, tz);
        let end = cur.DTEND ? toDate(cur.DTEND.params, cur.DTEND.value, tz) : null;
        if (start) {
          if (!end || end <= start) end = addDays(start, 1);
          const uid = (cur.UID?.value ?? `${start}_${end}`).slice(0, 255);
          events.push({ uid, start, end, status: cur.STATUS?.value?.toUpperCase() ?? null });
        }
      }
      cur = null;
      if (events.length >= (opts.maxEvents ?? 2000)) break;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const head = line.slice(0, idx);
    const [name, ...params] = head.split(';');
    const key = name.toUpperCase();
    if (['UID', 'DTSTART', 'DTEND', 'STATUS'].includes(key)) cur[key] = { params: params.join(';'), value: line.slice(idx + 1) };
    // SUMMARY/DESCRIPTION/ATTENDEE are deliberately ignored (guest PII)
  }
  return events;
}

const icsDate = (d: string) => d.replace(/-/g, '');
const icsStamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

/** Busy dates only — no guest names, no reservation codes. */
export function buildIcs(calendarName: string, ranges: Array<{ uid: string; start: string; end: string }>): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//JETPOOL//Availability 1.0//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${calendarName.replace(/[\r\n,;]/g, ' ')}`];
  const stamp = icsStamp();
  for (const r of ranges) {
    lines.push('BEGIN:VEVENT', `UID:${r.uid}@jetpool`, `DTSTAMP:${stamp}`, `DTSTART;VALUE=DATE:${icsDate(r.start)}`, `DTEND;VALUE=DATE:${icsDate(r.end)}`, 'SUMMARY:Not available', 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

// ---------------------------------------------------------------- SSRF-guarded fetch

export type IcalFetcher = (url: string) => Promise<string>;

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateAddress(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

export function assertIcalUrl(raw: string, allowHttp: boolean): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw Object.assign(new Error('invalid iCal URL'), { code: 'INVALID_ICAL_URL' });
  }
  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) throw Object.assign(new Error('iCal URL must use https'), { code: 'INVALID_ICAL_URL' });
  if (u.username || u.password) throw Object.assign(new Error('credentials in URL are not allowed'), { code: 'INVALID_ICAL_URL' });
  return u;
}

export function defaultIcalFetcher(opts: { allowHttp: boolean; maxBytes?: number; timeoutMs?: number }): IcalFetcher {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  return async (raw) => {
    const u = assertIcalUrl(raw, opts.allowHttp);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error('iCal host resolves to a private address');
    const res = await fetch(u, { redirect: 'error', signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000), headers: { accept: 'text/calendar' } });
    if (!res.ok) throw new Error(`iCal fetch failed with HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') ?? 0);
    if (len > maxBytes) throw new Error('iCal feed too large');
    const text = await res.text();
    if (text.length > maxBytes) throw new Error('iCal feed too large');
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error('response is not an iCalendar feed');
    return text;
  };
}
