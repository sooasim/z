'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';

const NAV = [
  { href: '/stay', key: 'nav.stay' },
  { href: '/exchange', key: 'nav.exchange' },
  { href: '/guide-friends', key: 'nav.guide' },
  { href: '/travel', key: 'nav.travel' },
  { href: '/jetpool-charter', key: 'nav.charter' },
] as const;

export function Wordmark() {
  return (
    <Link href="/" className="wordmark" aria-label="JETPOOL home">
      <span className="dot" aria-hidden="true" />
      JETPOOL
    </Link>
  );
}

export function Header() {
  const { t, lang, setLang, L } = useI18n();
  const { user, ready, logout, isStaff, hasRole } = useAuth();
  const path = usePathname() || '/';
  const router = useRouter();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const cur = (href: string) => (path === href || path.startsWith(href + '/') ? 'page' : undefined);

  return (
    <header className="site-header">
      <div className="container bar">
        <Wordmark />
        <nav className="main-nav" aria-label={L('주요 메뉴', 'Main')}>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={cur(n.href)}>
              {t(n.key)}
            </Link>
          ))}
        </nav>
        <div className="grow" />
        <button className="btn sm ghost" onClick={() => setLang(lang === 'ko' ? 'en' : 'ko')} aria-label={L('언어 전환', 'Switch language')}>
          {t('common.lang')}
        </button>
        {ready && user ? (
          <nav className="main-nav" aria-label={L('사용자 메뉴', 'User')}>
            <Link href="/trips" aria-current={cur('/trips')}>
              {t('nav.trips')}
            </Link>
            <Link href="/messages" aria-current={cur('/messages')}>
              {t('nav.messages')}
            </Link>
            {(hasRole('HOST') || hasRole('GUIDE') || hasRole('SUPPLIER')) && (
              <Link href={hasRole('HOST') ? '/host/dashboard' : hasRole('GUIDE') ? '/guide/requests' : '/supplier/products'}>{t('nav.host')}</Link>
            )}
            {isStaff && <Link href="/admin">{t('nav.admin')}</Link>}
            <Link href="/account" aria-current={cur('/account')}>
              {t('nav.account')}
            </Link>
          </nav>
        ) : ready ? (
          <div className="row" style={{ gap: 6 }}>
            <Link className="btn sm" href={`/login?next=${encodeURIComponent(path)}`}>
              {t('nav.login')}
            </Link>
            <Link className="btn sm primary" href="/signup">
              {t('nav.signup')}
            </Link>
          </div>
        ) : null}
        <button className="btn sm menu-toggle" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen(!open)}>
          ☰ <span className="sr-only">{t('nav.menu')}</span>
        </button>
      </div>
      {open && (
        <div className="container" id="mobile-nav">
          <nav className="mobile-nav" aria-label={L('모바일 메뉴', 'Mobile')}>
            {NAV.map((n) => (
              <Link key={n.href} href={n.href}>
                {t(n.key)}
              </Link>
            ))}
            <Link href="/saved">{t('nav.saved')}</Link>
            <Link href="/map">{L('지도', 'Map')}</Link>
            {user && (
              <>
                <Link href="/trips">{t('nav.trips')}</Link>
                <Link href="/messages">{t('nav.messages')}</Link>
                <Link href="/notifications">{L('알림', 'Notifications')}</Link>
                <Link href="/host/dashboard">{t('nav.host')}</Link>
                <Link href="/guide/requests">{L('가이드 센터', 'Guide center')}</Link>
                <Link href="/supplier/products">{L('공급사 센터', 'Supplier center')}</Link>
                {isStaff && <Link href="/admin">{t('nav.admin')}</Link>}
                <Link href="/account">{t('nav.account')}</Link>
                <button
                  className="btn sm"
                  onClick={async () => {
                    await logout();
                    router.push('/');
                  }}
                >
                  {t('nav.logout')}
                </button>
              </>
            )}
          </nav>
        </div>
      )}
    </header>
  );
}

export function Footer() {
  const { t, L } = useI18n();
  return (
    <footer className="site-footer">
      <div className="container cols">
        <div>
          <strong style={{ letterSpacing: '0.14em', color: 'var(--c-primary)' }}>JETPOOL</strong>
          <p className="small">{L('WONT Travel Club의 새로운 이름. 한달살기 맞교환, 전세기 공유, 로컬 라이프.', 'The new home of WONT Travel Club.')}</p>
          <p className="small">{t('footer.rights')}</p>
        </div>
        <nav aria-label={L('서비스', 'Services')}>
          <Link href="/stay">{t('nav.stay')}</Link>
          <Link href="/exchange">{t('nav.exchange')}</Link>
          <Link href="/guide-friends">{t('nav.guide')}</Link>
          <Link href="/travel">{t('nav.travel')}</Link>
          <Link href="/jetpool-charter">{t('nav.charter')}</Link>
        </nav>
        <nav aria-label={L('파트너', 'Partners')}>
          <Link href="/host/onboarding">{L('호스트 되기', 'Become a host')}</Link>
          <Link href="/guide/onboarding">{L('가이드 되기', 'Become a guide')}</Link>
          <Link href="/supplier/products">{L('여행 공급사', 'Suppliers')}</Link>
          <Link href="/discover">{L('여행지 탐색', 'Discover')}</Link>
          <Link href="/stories">{L('스토리', 'Stories')}</Link>
        </nav>
        <nav aria-label={L('지원', 'Support')}>
          <Link href="/support">{L('고객센터', 'Help center')}</Link>
          <Link href="/support/disputes">{L('분쟁/신고', 'Disputes')}</Link>
          <Link href="/assistant">{L('AI 여행 도우미', 'AI assistant')}</Link>
          <Link href="/account/privacy">{L('개인정보', 'Privacy')}</Link>
        </nav>
      </div>
    </footer>
  );
}

export function SideNav({ items, label }: { items: Array<{ href: string; label: string }>; label: string }) {
  const path = usePathname() || '';
  return (
    <nav className="side-nav" aria-label={label}>
      {items.map((i) => (
        <Link key={i.href} href={i.href} aria-current={path === i.href || (i.href.split('/').length > 2 && path.startsWith(i.href + '/')) ? 'page' : undefined}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);
  return null;
}
