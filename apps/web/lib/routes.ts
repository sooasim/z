/** Known first path segments of this app. Anything else is a candidate legacy URL → `/v1/seo/redirects`. */
export const KNOWN_PREFIXES = [
  '', 'stay', 'map', 'exchange', 'guide-friends', 'guides', 'guide-requests', 'guide-bookings', 'guide', 'travel', 'trip-planner', 'checkout', 'orders',
  'jetpool-charter', 'discover', 'stories', 'login', 'signup', 'auth', 'account', 'verification', 'reviews', 'saved', 'trips', 'messages', 'payments',
  'notifications', 'support', 'assistant', 'host', 'earnings', 'supplier', 'admin', 'api', '_next', 'icons', 'sitemap.xml', 'robots.txt',
  'manifest.webmanifest', 'sw.js', 'offline.html', 'favicon.ico',
];

export function isKnownPath(pathname: string): boolean {
  const seg = pathname.split('/')[1] ?? '';
  return KNOWN_PREFIXES.includes(seg) || /\.[a-z0-9]{2,5}$/i.test(pathname);
}

/** Normalise a redirect API payload. Accepts {item:{toPath,statusCode}}, {to,status}, {location}, etc. */
export function parseRedirect(j: any): { to: string; status: 301 | 302 | 307 | 308 } | null {
  const r = j?.item ?? j?.redirect ?? j;
  if (!r || typeof r !== 'object') return null;
  const to = r.toPath ?? r.to_path ?? r.to ?? r.target ?? r.location ?? r.destination;
  if (typeof to !== 'string' || !to) return null;
  if (!(to.startsWith('/') || /^https?:\/\//.test(to))) return null;
  const s = Number(r.statusCode ?? r.status_code ?? r.status ?? 301);
  const status = ([301, 302, 307, 308] as const).find((x) => x === s) ?? 301;
  return { to, status };
}
