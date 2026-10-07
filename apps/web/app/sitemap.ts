import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/env';
import { serverGet } from '@/lib/api';
import { items, str } from '@/lib/shape';

export const revalidate = 3600;

const STATIC = ['/', '/stay', '/map', '/exchange', '/guide-friends', '/travel', '/jetpool-charter', '/discover', '/stories', '/login', '/signup', '/support'];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const base: MetadataRoute.Sitemap = STATIC.map((p) => ({ url: SITE_URL + p, lastModified: now, changeFrequency: 'daily', priority: p === '/' ? 1 : 0.7 }));
  // Dynamic entries from the API (published stays, guides, content). Fail-safe: build never requires the API.
  const res = await serverGet<any>('/v1/seo/sitemap', { revalidate: 3600, timeoutMs: 2000 });
  const extra = items(res)
    .map((e: any) => {
      const loc = str(e, 'loc', 'url', 'path');
      if (!loc) return null;
      const url = loc.startsWith('http') ? loc : SITE_URL + (loc.startsWith('/') ? loc : '/' + loc);
      const lm = str(e, 'lastmod', 'lastModified', 'updatedAt');
      return { url, lastModified: lm ? new Date(lm) : now, changeFrequency: 'weekly' as const, priority: 0.6 };
    })
    .filter(Boolean) as MetadataRoute.Sitemap;
  const seen = new Set<string>();
  return [...base, ...extra].filter((e) => (seen.has(e.url) ? false : (seen.add(e.url), true)));
}
