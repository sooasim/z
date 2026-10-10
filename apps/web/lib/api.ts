import { API_URL } from './env';
import { ApiError, problemFromResponse } from './errors';
import { getAccessToken, refreshAccessToken } from './token';
import { isLang, langInfo } from './langs';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null | string[]>;
  /** Required for money/inventory-creating POSTs. Pass `true` to auto-generate. */
  idempotencyKey?: string | true;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Skip Authorization even when a token exists. */
  anonymous?: boolean;
  /** Base URL override (tests / server). */
  baseUrl?: string;
}

export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'idem-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

export function buildUrl(path: string, query?: RequestOptions['query'], base = API_URL): string {
  const url = new URL(path.startsWith('http') ? path : base + (path.startsWith('/') ? path : '/' + path));
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

/**
 * The reader's chosen UI language as a BCP-47 tag, or null on the server / before a choice exists (the API
 * then falls back to its own `Accept-Language` handling and finally to Korean).
 */
function uiLocale(): string | null {
  if (typeof document === 'undefined') return null;
  try {
    const code = document.cookie.match(/(?:^|;\s*)jp_lang=([^;]+)/)?.[1] ?? localStorage.getItem('jp_lang');
    return isLang(code) ? langInfo(code).locale : null;
  } catch {
    return null; // storage blocked
  }
}

async function doFetch(path: string, opts: RequestOptions, token: string | null): Promise<Response> {
  const headers: Record<string, string> = { accept: 'application/json', ...(opts.headers || {}) };
  // The API renders member-written content (listing copy, reviews, bios) in this language when a translation
  // is cached — see apps/api/src/platform/content-locale.ts. Read from storage rather than the React context
  // so plain `api()` calls outside a component carry it too.
  const lang = uiLocale();
  if (lang && !headers['accept-language']) headers['accept-language'] = lang;
  if (opts.body !== undefined && !(opts.body instanceof FormData)) headers['content-type'] = 'application/json';
  if (token && !opts.anonymous) headers.authorization = `Bearer ${token}`;
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey === true ? newIdempotencyKey() : opts.idempotencyKey;
  try {
    return await fetch(buildUrl(path, opts.query, opts.baseUrl), {
      method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'),
      headers,
      body: opts.body === undefined ? undefined : opts.body instanceof FormData ? opts.body : JSON.stringify(opts.body),
      signal: opts.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiError(0, { code: 'NETWORK_ERROR', detail: (e as Error)?.message });
  }
}

/** Typed JSON request. Throws ApiError (problem+json) on non-2xx. Retries once after a 401 by refreshing. */
export async function api<T = any>(path: string, opts: RequestOptions = {}): Promise<T> {
  // Fix the idempotency key once so a retry after token refresh replays the same key.
  const o: RequestOptions = opts.idempotencyKey === true ? { ...opts, idempotencyKey: newIdempotencyKey() } : opts;
  let res = await doFetch(path, o, getAccessToken());
  if (res.status === 401 && !o.anonymous && typeof window !== 'undefined') {
    const t = await refreshAccessToken();
    if (t) res = await doFetch(path, o, t);
  }
  if (!res.ok) throw new ApiError(res.status, await problemFromResponse(res));
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const get = <T = any>(path: string, query?: RequestOptions['query'], o: RequestOptions = {}) => api<T>(path, { ...o, method: 'GET', query });
export const post = <T = any>(path: string, body?: unknown, o: RequestOptions = {}) => api<T>(path, { ...o, method: 'POST', body: body ?? {} });
export const patch = <T = any>(path: string, body?: unknown, o: RequestOptions = {}) => api<T>(path, { ...o, method: 'PATCH', body: body ?? {} });
export const put = <T = any>(path: string, body?: unknown, o: RequestOptions = {}) => api<T>(path, { ...o, method: 'PUT', body: body ?? {} });
export const del = <T = any>(path: string, o: RequestOptions = {}) => api<T>(path, { ...o, method: 'DELETE' });

/** Server-side fail-safe fetch (metadata, sitemap). Never throws; returns null on any failure/timeout. */
export async function serverGet<T = any>(path: string, opts: { revalidate?: number; timeoutMs?: number; base?: string } = {}): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 2500);
  try {
    const res = await fetch(buildUrl(path, undefined, opts.base ?? (process.env.API_INTERNAL_URL || API_URL)), {
      signal: ctrl.signal,
      headers: { accept: 'application/json' },
      next: { revalidate: opts.revalidate ?? 300 },
    } as RequestInit);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
