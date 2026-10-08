import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { isCalendarDate } from '../../platform/http.js';

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

// ---------------------------------------------------------------- time zones

export const DEFAULT_ICAL_TIME_ZONE = 'Asia/Seoul';

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
const partFormatters = new Map<string, Intl.DateTimeFormat>();

/** True for an IANA zone name the runtime knows ('America/New_York'); false for garbage / Windows zone names. */
export function isValidTimeZone(zone: string | null | undefined): zone is string {
  if (!zone || zone.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Calendar date (YYYY-MM-DD) of a UTC instant in `zone` (DST-aware). */
function localDateIn(utcMs: number, zone: string): string {
  let f = dayFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(zone, f);
  }
  return f.format(new Date(utcMs));
}

/** Offset (ms) of `zone` from UTC at the instant `utcMs`. */
function zoneOffsetMs(zone: string, utcMs: number): number {
  let f = partFormatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    partFormatters.set(zone, f);
  }
  const p: Record<string, number> = {};
  for (const part of f.formatToParts(new Date(utcMs))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utcMs / 1000) * 1000;
}

/** UTC instant of a wall-clock time in `zone` (two passes settle DST transitions). */
function wallToUtc(wallMs: number, zone: string): number {
  const first = wallMs - zoneOffsetMs(zone, wallMs);
  return wallMs - zoneOffsetMs(zone, first);
}

interface TzOpts {
  /** IANA zone of the property: UTC / TZID instants are converted to this zone's calendar date. */
  zone: string | null;
  /** legacy fixed offset, used only when no zone is given */
  offsetHours: number;
}

/**
 * DATE or DATE-TIME value → calendar date in the property's time zone. Returns null for malformed values and
 * for impossible calendar dates/times (20270230, T250000), so one corrupt event is skipped instead of reaching
 * a `::date` cast and aborting the whole reconcile.
 */
function toDate(params: string, value: string, tz: TzOpts): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, y, mo, d, hh, mi, ss, z] = m;
  const ymd = `${y}-${mo}-${d}`;
  if (!isCalendarDate(ymd)) return null;
  if (!hh || /VALUE=DATE(?!-)/i.test(params)) return ymd;
  if (+hh > 23 || +mi > 59 || +ss > 60) return null;
  const wall = Date.UTC(+y, +mo - 1, +d, +hh, +mi, +ss);
  if (z) return tz.zone ? localDateIn(wall, tz.zone) : new Date(wall + tz.offsetHours * 3600_000).toISOString().slice(0, 10);
  // TZID=<zone> local time: re-express in the property's zone when the two differ (e.g. an OTA exporting in UTC+0)
  const tzid = /(?:^|;)TZID=("?)([^";:]+)\1/i.exec(params)?.[2]?.trim();
  if (tz.zone && tzid && tzid !== tz.zone && isValidTimeZone(tzid)) return localDateIn(wallToUtc(wall, tzid), tz.zone);
  return ymd; // floating / same-zone local time: use the local date
}

export function parseIcs(text: string, opts: { timeZone?: string | null; tzOffsetHours?: number; maxEvents?: number } = {}): IcsEvent[] {
  // the property's IANA zone wins; a bare legacy offset is honoured only when no zone is given; default Asia/Seoul
  const zone = isValidTimeZone(opts.timeZone) ? opts.timeZone : opts.tzOffsetHours === undefined ? DEFAULT_ICAL_TIME_ZONE : null;
  const tz: TzOpts = { zone, offsetHours: opts.tzOffsetHours ?? 9 };
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

/**
 * Every non-public range. BlockList matches IPv4-mapped IPv6 in ANY notation (::ffff:7f00:1, ::ffff:127.0.0.1)
 * against the IPv4 rules, so the WHATWG URL parser's hex rewrite of `[::ffff:127.0.0.1]` cannot slip through.
 */
const BLOCKED = (() => {
  const b = new BlockList();
  const v4: Array<[string, number]> = [
    ['0.0.0.0', 8], // "this" network
    ['10.0.0.0', 8],
    ['100.64.0.0', 10], // CGNAT
    ['127.0.0.0', 8],
    ['169.254.0.0', 16], // link-local / cloud metadata
    ['172.16.0.0', 12],
    ['192.0.0.0', 24], // IETF protocol assignments
    ['192.0.2.0', 24], // TEST-NET-1
    ['192.88.99.0', 24], // 6to4 relay anycast
    ['192.168.0.0', 16],
    ['198.18.0.0', 15], // benchmarking
    ['198.51.100.0', 24], // TEST-NET-2
    ['203.0.113.0', 24], // TEST-NET-3
    ['224.0.0.0', 4], // multicast
    ['240.0.0.0', 4], // reserved + broadcast
  ];
  for (const [a, p] of v4) b.addSubnet(a, p, 'ipv4');
  const v6: Array<[string, number]> = [
    ['::', 96], // unspecified, loopback, deprecated IPv4-compatible
    ['::ffff:0:0:0', 96], // IPv4-translated (SIIT)
    ['64:ff9b::', 96], // NAT64 well-known prefix (embeds any IPv4, internal ones included)
    ['64:ff9b:1::', 48], // NAT64 local-use
    ['100::', 64], // discard-only
    ['2001::', 23], // IETF protocol assignments (Teredo, ORCHID, benchmarking)
    ['2001:db8::', 32], // documentation
    ['2002::', 16], // 6to4 (embeds any IPv4)
    ['fc00::', 7], // unique local
    ['fe80::', 10], // link-local
    ['fec0::', 10], // site-local (deprecated)
    ['ff00::', 8], // multicast
  ];
  for (const [a, p] of v6) b.addSubnet(a, p, 'ipv6');
  return b;
})();

/** True when `ip` is not a public unicast address (fails closed for anything that is not an IP literal). */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, ''); // brackets, IPv6 zone id
  const family = isIP(v);
  if (family === 4) return BLOCKED.check(v, 'ipv4');
  if (family === 6) return BLOCKED.check(v, 'ipv6');
  return true;
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

export interface IcalFetcherOptions {
  allowHttp: boolean;
  maxBytes?: number;
  timeoutMs?: number;
  /** DNS resolution (default: the system resolver, all addresses). Called once per connection. */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Address policy (default: isPrivateAddress). */
  isBlocked?: (ip: string) => boolean;
}

const privateAddressError = () => Object.assign(new Error('iCal host resolves to a private address'), { code: 'ICAL_PRIVATE_ADDRESS' });

/**
 * Connection-time DNS hook: resolves ONCE, rejects the connection if any address is non-public and hands the
 * socket exactly the addresses that were checked. The check and the connect therefore use the same IP — a
 * rebinding name (TTL 0, public answer for a check and an internal answer for the connect) has no second lookup.
 */
export function pinnedLookup(resolve: (hostname: string) => Promise<string[]>, isBlocked: (ip: string) => boolean): LookupFunction {
  return ((hostname: string, options: any, callback: any) => {
    const cb = typeof options === 'function' ? options : callback;
    const o = typeof options === 'function' ? {} : (options ?? {});
    resolve(hostname)
      .then((addrs) => {
        if (!addrs.length) throw Object.assign(new Error(`iCal host ${hostname} could not be resolved`), { code: 'ENOTFOUND' });
        if (addrs.some((a) => isBlocked(a))) throw privateAddressError();
        const wanted = o.family === 4 || o.family === 'IPv4' ? 4 : o.family === 6 || o.family === 'IPv6' ? 6 : 0;
        const entries = addrs.map((address) => ({ address, family: isIP(address) })).filter((e) => e.family !== 0 && (!wanted || e.family === wanted));
        if (!entries.length) throw Object.assign(new Error(`iCal host ${hostname} has no usable address`), { code: 'ENOTFOUND' });
        if (o.all) cb(null, entries);
        else cb(null, entries[0].address, entries[0].family);
      })
      .catch((err) => cb(err));
  }) as LookupFunction;
}

const systemResolve = async (hostname: string) => (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

export function defaultIcalFetcher(opts: IcalFetcherOptions): IcalFetcher {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const isBlocked = opts.isBlocked ?? isPrivateAddress;
  const lookup = pinnedLookup(opts.resolve ?? systemResolve, isBlocked);
  return async (raw) => {
    const u = assertIcalUrl(raw, opts.allowHttp);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    // IP literals never reach a lookup: validate them here (any notation; the URL parser already normalised them)
    if (isIP(host) && isBlocked(host)) throw privateAddressError();
    return getText(u, host, { lookup, maxBytes, timeoutMs });
  };
}

/** One GET without redirects, keep-alive or connection reuse; the body is streamed and capped at maxBytes. */
function getText(u: URL, host: string, o: { lookup: LookupFunction; maxBytes: number; timeoutMs: number }): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, text?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        req.destroy();
        reject(err);
      } else resolve(text!);
    };
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: host,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { accept: 'text/calendar', 'user-agent': 'JETPOOL-iCal/1.0' },
        lookup: o.lookup,
        agent: false,
        ...(u.protocol === 'https:' && !isIP(host) ? { servername: host } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          res.resume();
          return finish(new Error(`iCal fetch failed with HTTP ${status}`)); // 3xx included: redirects are never followed
        }
        if (Number(res.headers['content-length'] ?? 0) > o.maxBytes) return finish(new Error('iCal feed too large'));
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > o.maxBytes) return finish(new Error('iCal feed too large'));
          chunks.push(c);
        });
        res.on('error', (err) => finish(err));
        res.on('aborted', () => finish(new Error('iCal fetch aborted')));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!/BEGIN:VCALENDAR/i.test(text)) return finish(new Error('response is not an iCalendar feed'));
          finish(null, text);
        });
      },
    );
    // overall deadline (connect + headers + body): a slow-drip feed cannot hold the sync open
    const timer = setTimeout(() => finish(new Error('iCal fetch timed out')), o.timeoutMs);
    req.on('error', (err) => finish(err));
    req.end();
  });
}
