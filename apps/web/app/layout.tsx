import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from '@/components/providers';
import { Header, Footer, BottomNav, ScrollReset, ServiceWorkerRegister } from '@/components/shell';
import { THEME_SCRIPT } from '@/components/theme';
import { SITE_URL } from '@/lib/env';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: { default: 'JETPOOL — 숙소 · 홈 맞교환 · 가이드 프렌드 · 여행', template: '%s · JETPOOL' },
  description: '한달살기 홈 맞교환, 검증된 숙소, 로컬 가이드 프렌드, 여행 상품과 전세기 공유까지. WONT Travel Club의 새로운 이름 JETPOOL.',
  applicationName: 'JETPOOL',
  manifest: '/manifest.webmanifest',
  icons: { icon: '/icons/icon.svg', apple: '/icons/icon.svg' },
  openGraph: { type: 'website', siteName: 'JETPOOL', locale: 'ko_KR' },
  // The share card (app/opengraph-image.tsx) is 1200×630: ask X for the large card rather than a thumbnail.
  twitter: { card: 'summary_large_image' },
  alternates: { canonical: '/' },
};

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#08121f' },
  ],
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
};

/**
 * Brand font: Pretendard Variable, self-hosted as a unicode-range dynamic subset under /public/fonts/pretendard
 * (no third-party CDN, CSP `font-src 'self'`). next/font/local cannot express unicode-range slices, and the single
 * 2 MB variable file is far heavier than the ~40–120 KB of slices a Korean page actually needs. The slice holding
 * Latin + the most frequent Hangul syllables is preloaded so first paint rarely swaps.
 */
const FONT_CSS = '/fonts/pretendard/pretendard.css';
const FONT_PRELOAD = '/fonts/pretendard/PretendardVariable.subset.91.woff2';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-scroll-behavior: Next disables CSS smooth scrolling while it restores/resets scroll on route changes.
    <html lang="ko-KR" suppressHydrationWarning data-scroll-behavior="smooth">
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link rel="preload" href={FONT_PRELOAD} as="font" type="font/woff2" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-css-tags -- static, cacheable @font-face sheet (unicode-range slices) */}
        <link rel="stylesheet" href={FONT_CSS} />
      </head>
      <body>
        <a href="#main" className="skip-link">
          본문 바로가기 / Skip to content
        </a>
        <Providers lang="ko">
          <Header />
          <main id="main" tabIndex={-1}>
            <div className="container">{children}</div>
          </main>
          <Footer />
          <BottomNav />
          <ScrollReset />
          <ServiceWorkerRegister />
        </Providers>
      </body>
    </html>
  );
}
