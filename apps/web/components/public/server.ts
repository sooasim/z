import { cache } from 'react';
import { notFound } from 'next/navigation';
import { buildUrl } from '@/lib/api';
import { API_INTERNAL_URL } from '@/lib/env';
import { item } from '@/lib/shape';

/**
 * Server-side probe for detail pages: GET the entity once per request (shared by generateMetadata and the page via
 * React `cache`). Distinguishes a confirmed 404 (→ `notFound()`, real HTTP 404) from transient failures (timeout,
 * API down → `status: 0`), where the client view still renders and handles errors itself.
 */
export const probe = cache(async (path: string): Promise<{ status: number; data: any }> => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(buildUrl(path, undefined, API_INTERNAL_URL), { signal: ctrl.signal, headers: { accept: 'application/json' }, next: { revalidate: 120 } } as RequestInit);
    if (!res.ok) return { status: res.status, data: null };
    return { status: res.status, data: item(await res.json()) };
  } catch {
    return { status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
});

/**
 * public/media-map.json read on the server (once per request), for share images (og:image) of entities whose API
 * payload carries only media ids (travel products) or no photo at all (guide profiles). Null when unavailable.
 */
const mediaMap = cache(async (): Promise<{ products?: Record<string, string[]>; guides?: Record<string, string> } | null> => {
  try {
    const [{ readFile }, path] = await Promise.all([import('node:fs/promises'), import('node:path')]);
    return JSON.parse(await readFile(path.join(process.cwd(), 'public/media-map.json'), 'utf8'));
  } catch {
    return null;
  }
});

/** Root-relative real-photo URL ('/photos/…', '/legacy/…') for a travel product or guide share image, or ''. */
export async function sharePhoto(kind: 'product' | 'guide', id: string): Promise<string> {
  const m = await mediaMap();
  const v = kind === 'product' ? m?.products?.[id]?.[0] : m?.guides?.[id];
  return typeof v === 'string' && v.startsWith('/') ? v : '';
}

/** True when the API confirmed the entity does not exist (404, or 400 for a malformed id such as a non-UUID). */
export const isMissing = (status: number, malformedIs404 = false) => status === 404 || (malformedIs404 && status === 400);

/** Throws Next's notFound() only when the API confirmed the entity does not exist. */
export async function ensureExists(path: string, malformedIs404 = false) {
  const r = await probe(path);
  if (isMissing(r.status, malformedIs404)) notFound();
  return r;
}
