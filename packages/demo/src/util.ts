/** Small helpers shared by the demo runtime. */
export type Obj = Record<string, any>;

export const nativeFetch: typeof fetch = window.fetch.bind(window);

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const h = new Headers({ 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', 'x-jetpool-demo': '1', ...headers });
  if (status === 204 || body === undefined) return new Response(null, { status: status === 204 ? 204 : status, headers: h });
  return new Response(JSON.stringify(body), { status, headers: h });
}

export function problem(status: number, code: string, detail?: string, extra: Obj = {}): Response {
  return json(status, { type: 'about:blank', title: detail || code, status, code, detail, ...extra });
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function') return (crypto as any).randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function code(n = 10): string {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => '0123456789ABCDEF'[x % 16]).join('');
}

export const clone = <T>(x: T): T => (x === undefined || x === null ? x : JSON.parse(JSON.stringify(x)));
export const nowIso = () => new Date().toISOString();
export const isoDate = (d: Date) => d.toISOString().slice(0, 10);
export const today = () => isoDate(new Date());
export function addDays(iso: string, n: number): string {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}
export function nightsBetween(a: string, b: string): number {
  if (!a || !b) return 0;
  return Math.round((Date.parse(b.slice(0, 10) + 'T00:00:00Z') - Date.parse(a.slice(0, 10) + 'T00:00:00Z')) / 86400000);
}
export function dateRange(a: string, b: string): string[] {
  const out: string[] = [];
  for (let d = a.slice(0, 10); d < b.slice(0, 10) && out.length < 800; d = addDays(d, 1)) out.push(d);
  return out;
}

export const itemsOf = (b: any): any[] => (Array.isArray(b) ? b : Array.isArray(b?.items) ? b.items : Array.isArray(b?.data) ? b.data : []);
export const itemOf = (b: any): any => (b && typeof b === 'object' && b.item && typeof b.item === 'object' ? b.item : b);

/** Tolerant field read (camelCase / snake_case). */
export function fld(o: any, ...keys: string[]): any {
  if (!o || typeof o !== 'object') return undefined;
  for (const k of keys) {
    for (const c of [k, k.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()), k.replace(/_([a-z0-9])/g, (_, x) => x.toUpperCase())]) {
      if (o[c] !== undefined && o[c] !== null) return o[c];
    }
  }
  return undefined;
}

export function base64url(s: string): string {
  return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unbase64url(s: string): string {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return decodeURIComponent(escape(atob(b + '='.repeat((4 - (b.length % 4)) % 4))));
}

export function sortedQuery(q: URLSearchParams): string {
  const e = [...q.entries()].filter(([, v]) => v !== '');
  e.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return new URLSearchParams(e).toString();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
