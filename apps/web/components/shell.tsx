'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { Icon, type IconName } from './ui/icons';
import { Avatar } from './ui/display';
import { usePopover } from './ui/pickers';
import { ThemeToggle } from './theme';

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

function UserMenu() {
  const { user, logout, isStaff, hasRole } = useAuth();
  const { t, L } = useI18n();
  const router = useRouter();
  const p = usePopover();
  if (!user) return null;
  const links: Array<[string, string, IconName]> = [
    ['/trips', t('nav.trips'), 'bag'],
    ['/messages', t('nav.messages'), 'chat'],
    ['/saved', t('nav.saved'), 'heart'],
    ['/notifications', L('알림', 'Notifications'), 'bell'],
    ['/account', t('nav.account'), 'user'],
  ];
  const partner: Array<[string, string, IconName]> = [
    [hasRole('HOST') ? '/host/dashboard' : '/host/onboarding', hasRole('HOST') ? L('호스트 센터', 'Host center') : L('호스트 되기', 'Become a host'), 'home'],
    [hasRole('GUIDE') ? '/guide/requests' : '/guide/onboarding', hasRole('GUIDE') ? L('가이드 센터', 'Guide center') : L('가이드 되기', 'Become a guide'), 'compass'],
  ];
  if (hasRole('SUPPLIER')) partner.push(['/supplier/products', L('공급사 센터', 'Supplier center'), 'ticket']);
  if (hasRole('HOST') || hasRole('GUIDE') || hasRole('SUPPLIER')) partner.push(['/earnings', L('정산', 'Earnings'), 'coin']);
  if (isStaff) partner.push(['/admin', t('nav.admin'), 'chart']);
  return (
    <div className="popover-anchor" ref={p.ref}>
      <button type="button" className="user-chip" aria-expanded={p.open} aria-haspopup="menu" onClick={() => p.setOpen(!p.open)}>
        <Icon name="menu" size={16} />
        <Avatar name={user.displayName} size={30} verified={user.aal === 'aal2'} />
        <span className="sr-only">{L('사용자 메뉴', 'User menu')}</span>
      </button>
      {p.open && (
        <div className="popover right" role="menu" style={{ minWidth: 240, padding: 8 }}>
          <div style={{ padding: '8px 12px 10px' }}>
            <strong>{user.displayName}</strong>
            <div className="xs muted">{user.email}</div>
          </div>
          <ul className="listbox" style={{ maxHeight: 'none' }}>
            {[...links, ...partner].map(([href, label, icon]) => (
              <li key={href} role="menuitem" onClick={() => { p.setOpen(false); router.push(href); }} onKeyDown={(e) => e.key === 'Enter' && router.push(href)} tabIndex={0}>
                <Icon name={icon} size={18} /> <span className="small">{label}</span>
              </li>
            ))}
            <li role="menuitem" tabIndex={0} onClick={async () => { p.setOpen(false); await logout(); router.push('/'); }}>
              <Icon name="logout" size={18} /> <span className="small">{t('nav.logout')}</span>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

export function Header() {
  const { t, lang, setLang, L } = useI18n();
  const { user, ready, isStaff } = useAuth();
  const path = usePathname() || '/';
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const cur = (href: string) => (path === href || path.startsWith(href + '/') ? 'page' : undefined);
  return (
    <header className="site-header">
      <div className="container bar">
        <Wordmark />
        <nav className="main-nav" aria-label={L('주요 메뉴', 'Main')} style={{ marginLeft: 12 }}>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={cur(n.href)}>
              {t(n.key)}
            </Link>
          ))}
        </nav>
        <div className="grow" />
        {user && isStaff && (
          <Link href="/admin" className="btn ghost sm hide-mobile" aria-current={cur('/admin')}>
            <Icon name="chart" size={16} /> {t('nav.admin')}
          </Link>
        )}
        <button className="btn ghost sm" onClick={() => setLang(lang === 'ko' ? 'en' : 'ko')} aria-label={L('언어 전환 (English)', 'Switch language (한국어)')}>
          <Icon name="globe" size={16} /> <span className="hide-mobile">{t('common.lang')}</span>
        </button>
        <ThemeToggle />
        {ready && user ? (
          <UserMenu />
        ) : ready ? (
          <div className="row" style={{ gap: 6 }}>
            <Link className="btn ghost sm" href={`/login?next=${encodeURIComponent(path)}`}>
              {t('nav.login')}
            </Link>
            <Link className="btn accent sm hide-mobile" href="/signup">
              {t('nav.signup')}
            </Link>
          </div>
        ) : (
          <span className="skeleton" style={{ width: 74, height: 38, borderRadius: 999 }} aria-hidden="true" />
        )}
        <button className="btn ghost icon sm menu-toggle" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen(!open)} aria-label={t('nav.menu')}>
          <Icon name={open ? 'close' : 'menu'} size={20} />
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
            <Link href="/map">{L('지도로 찾기', 'Map')}</Link>
            <Link href="/discover">{L('여행지 탐색', 'Discover')}</Link>
            <Link href="/assistant">{L('AI 여행 도우미', 'AI assistant')}</Link>
            <Link href="/support">{L('고객센터', 'Help')}</Link>
            {!user && <Link href="/signup">{t('nav.signup')}</Link>}
          </nav>
        </div>
      )}
    </header>
  );
}

/** Mobile bottom tab bar: Explore / Saved / Trips / Messages / Profile. */
export function BottomNav() {
  const { L } = useI18n();
  const path = usePathname() || '/';
  const tabs: Array<[string, string, IconName, (p: string) => boolean]> = [
    ['/', L('둘러보기', 'Explore'), 'search', (p) => p === '/' || p.startsWith('/stay') || p.startsWith('/exchange') || p.startsWith('/guide-friends') || p.startsWith('/travel') || p.startsWith('/map')],
    ['/saved', L('저장', 'Saved'), 'heart', (p) => p.startsWith('/saved')],
    ['/trips', L('여행', 'Trips'), 'bag', (p) => p.startsWith('/trips') || p.startsWith('/orders') || p.startsWith('/guide-bookings')],
    ['/messages', L('메시지', 'Messages'), 'chat', (p) => p.startsWith('/messages')],
    ['/account', L('프로필', 'Profile'), 'user', (p) => p.startsWith('/account') || p.startsWith('/login') || p.startsWith('/signup')],
  ];
  if (path.startsWith('/admin') || path.startsWith('/checkout')) return null;
  return (
    <nav className="bottom-nav" aria-label={L('하단 메뉴', 'Bottom navigation')}>
      {tabs.map(([href, label, icon, active]) => (
        <Link key={href} href={href} aria-current={active(path) ? 'page' : undefined}>
          <Icon name={icon} />
          {label}
        </Link>
      ))}
    </nav>
  );
}

export function Footer() {
  const { t, L } = useI18n();
  return (
    <footer className="site-footer">
      <div className="container stack-lg">
        <div className="cols">
          <div className="stack">
            <Wordmark />
            <p className="small">{L('WONT Travel Club의 새로운 이름. 한달살기 맞교환, 전세기 공유, 로컬 라이프.', 'The new home of WONT Travel Club — month-long exchanges, charter sharing and local life.')}</p>
          </div>
          <nav aria-label={L('서비스', 'Services')}>
            <h3>{L('여행', 'Travel')}</h3>
            <Link href="/stay">{t('nav.stay')}</Link>
            <Link href="/exchange">{t('nav.exchange')}</Link>
            <Link href="/guide-friends">{t('nav.guide')}</Link>
            <Link href="/travel">{t('nav.travel')}</Link>
            <Link href="/jetpool-charter">{t('nav.charter')}</Link>
          </nav>
          <nav aria-label={L('파트너', 'Partners')}>
            <h3>{L('파트너', 'Partners')}</h3>
            <Link href="/host/onboarding">{L('호스트 되기', 'Become a host')}</Link>
            <Link href="/guide/onboarding">{L('가이드 되기', 'Become a guide')}</Link>
            <Link href="/supplier/products">{L('여행 공급사', 'Suppliers')}</Link>
            <Link href="/discover">{L('여행지 탐색', 'Discover')}</Link>
            <Link href="/stories">{L('스토리', 'Stories')}</Link>
          </nav>
          <nav aria-label={L('지원', 'Support')}>
            <h3>{L('지원', 'Support')}</h3>
            <Link href="/support">{L('고객센터', 'Help center')}</Link>
            <Link href="/support/disputes">{L('분쟁·안전 신고', 'Disputes & safety')}</Link>
            <Link href="/assistant">{L('AI 여행 도우미', 'AI assistant')}</Link>
            <Link href="/account/privacy">{L('개인정보 처리방침', 'Privacy')}</Link>
          </nav>
        </div>
        <hr />
        <div className="row between xs">
          <span>© JETPOOL · {t('footer.rights')}</span>
          <span>{L('결제는 토스페이먼츠를 통해 안전하게 처리됩니다.', 'Payments are processed securely by TossPayments.')}</span>
        </div>
      </div>
    </footer>
  );
}

export function SideNav({ items, label }: { items: Array<{ href: string; label: string; icon?: IconName; group?: string }>; label: string }) {
  const path = usePathname() || '';
  let lastGroup = '';
  return (
    <nav className="side-nav" aria-label={label}>
      {items.map((i) => {
        const showGroup = i.group && i.group !== lastGroup;
        if (i.group) lastGroup = i.group;
        const active = path === i.href || (i.href.split('/').length > 2 && path.startsWith(i.href + '/'));
        return (
          <span key={i.href} style={{ display: 'contents' }}>
            {showGroup && <span className="group">{i.group}</span>}
            <Link href={i.href} aria-current={active ? 'page' : undefined}>
              {i.icon && <Icon name={i.icon} size={18} />}
              {i.label}
            </Link>
          </span>
        );
      })}
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
