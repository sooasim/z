import type { NextConfig } from 'next';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
const apiOrigin = (() => {
  try {
    return new URL(API).origin;
  } catch {
    return 'http://localhost:4000';
  }
})();
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
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://cdn.jsdelivr.net",
  `connect-src 'self' ${apiOrigin} https://*.tosspayments.com https://tile.openstreetmap.org https://*.tile.openstreetmap.org ${isDev ? 'ws: http://localhost:*' : ''}`,
  'frame-src https://*.tosspayments.com https://*.tosspayments.co.kr',
  "worker-src 'self' blob:",
  "child-src 'self' blob: https://*.tosspayments.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://*.tosspayments.com",
  "frame-ancestors 'none'",
  isDev ? '' : 'upgrade-insecure-requests',
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
  reactStrictMode: true,
  poweredByHeader: false,
  typedRoutes: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
