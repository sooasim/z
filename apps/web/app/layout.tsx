import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { Providers } from '@/components/providers';
import { Header, Footer, BottomNav, ServiceWorkerRegister } from '@/components/shell';
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

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="ko-KR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
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
          <ServiceWorkerRegister />
        </Providers>
      </body>
    </html>
  );
}
