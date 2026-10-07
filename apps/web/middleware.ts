import { NextResponse, type NextRequest } from 'next/server';
import { isKnownPath, parseRedirect } from './lib/routes';

/**
 * Legacy WONT Travel Club / Sixshop URL redirects (MIG-01, OPS-03). Only unknown paths hit the API
 * (`/v1/seo/redirects?path=`), results (incl. misses) are cached in-memory per edge instance for 10 minutes.
 */
const cache = new Map<string, { at: number; to: string | null; status: number }>();
const TTL = 10 * 60 * 1000;
const API = (process.env.API_INTERNAL_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000').replace(/\/$/, '');

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isKnownPath(pathname)) return NextResponse.next();
  const key = pathname + search;
  const hit = cache.get(key);
  let entry = hit && Date.now() - hit.at < TTL ? hit : null;
  if (!entry) {
    let to: string | null = null;
    let status = 301;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 1500);
      const res = await fetch(`${API}/v1/seo/redirects?path=${encodeURIComponent(key)}`, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      clearTimeout(timer);
      if (res.ok) {
        const r = parseRedirect(await res.json());
        if (r) {
          to = r.to;
          status = r.status;
        }
      }
    } catch {
      /* API down → fall through to 404 */
    }
    entry = { at: Date.now(), to, status };
    if (cache.size > 5000) cache.clear();
    cache.set(key, entry);
  }
  if (entry.to) return NextResponse.redirect(new URL(entry.to, req.url), entry.status);
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/|api/|icons/|favicon.ico).*)'],
};
