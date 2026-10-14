import type { NextConfig } from 'next';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const origin = (url: string, fallback: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return fallback;
  }
};
const apiOrigin = origin(API, 'http://localhost:4000');
/**
 * Object storage the browser talks to directly: STAY-02 uploads are presigned PUTs sent from the page
 * (apps/web/lib/media.ts), and processed media is served from the public bucket / CDN. Those are a
 * different origin from the API, so without them in connect-src / img-src every upload is blocked by
 * our own CSP. Unset (AWS behind a same-origin CDN, or localhost dev) keeps the previous policy.
 */
const mediaOrigin = process.env.NEXT_PUBLIC_MEDIA_ORIGIN ? origin(process.env.NEXT_PUBLIC_MEDIA_ORIGIN, '') : '';
const isDev = process.env.NODE_ENV !== 'production';

/**
 * Content-Security-Policy.
 * - TossPayments v2 SDK (js.tosspayments.com) renders widgets in iframes from *.tosspayments.com.
 * - Map tiles come from the free OSM raster tile server; MapLibre needs blob: workers.
 * - 'unsafe-inline' for scripts is required by Next.js inline bootstrap without a nonce middleware.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' ${isDev ? "'unsafe-eval'" : ''} https://js.tosspayments.com https://*.tosspayments.com`,
  "style-src 'self' 'unsafe-inline' https://*.tosspayments.com https://cdn.jsdelivr.net",
  `img-src 'self' data: blob: https: ${mediaOrigin}`,
  "font-src 'self' data: https://cdn.jsdelivr.net",
  `connect-src 'self' ${apiOrigin} ${mediaOrigin} https://*.tosspayments.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org ${isDev ? 'ws: http://localhost:*' : ''}`,
  // youtube-nocookie: privacy-enhanced lite embeds on migrated brand pages (player loads only on click)
  'frame-src https://*.tosspayments.com https://*.tosspayments.co.kr https://www.youtube-nocookie.com',
  "worker-src 'self' blob:",
  "child-src 'self' blob: https://*.tosspayments.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://*.tosspayments.com",
  "frame-ancestors 'none'",
  // Only when the deployment itself is https: on a plain-http deployment (localhost, or a first smoke
  // test against a bare IP) upgrading would rewrite the API and media origins to https and break them.
  apiOrigin.startsWith('https:') ? 'upgrade-insecure-requests' : '',
]
  .filter(Boolean)
  .join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self), payment=(self "https://js.tosspayments.com")' },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
];

const nextConfig: NextConfig = {
  /**
   * Standalone output, so the server does not read this file at runtime.
   * `next start` loads next.config.ts with TypeScript, which a production image has pruned — it then
   * tries to install TypeScript, picks the wrong package manager because there is no lockfile beside
   * it, and exits 1 in a crash loop. Standalone serialises the config into .next/standalone/server.js,
   * which needs neither TypeScript nor this file. apps/web/Dockerfile already prefers that output.
   */
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
