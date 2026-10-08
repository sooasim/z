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

/** True when the API confirmed the entity does not exist (404, or 400 for a malformed id such as a non-UUID). */
export const isMissing = (status: number, malformedIs404 = false) => status === 404 || (malformedIs404 && status === 400);

/** Throws Next's notFound() only when the API confirmed the entity does not exist. */
export async function ensureExists(path: string, malformedIs404 = false) {
  const r = await probe(path);
  if (isMissing(r.status, malformedIs404)) notFound();
  return r;
}
