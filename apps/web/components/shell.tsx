'use client';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { useI18n } from '@/lib/i18n';
import { LANGS, langInfo } from '@/lib/langs';
import type { Lang } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { items, str } from '@/lib/shape';
import { Icon, type IconName } from './ui/icons';
import { Avatar } from './ui/display';
import { usePopover, useFitPopover } from './ui/pickers';
import { Drawer, Modal } from './ui/modal';
import { ThemeToggle } from './theme';

const NAV = [
  { href: '/stay', key: 'nav.stay' },
  { href: '/exchange', key: 'nav.exchange' },
  { href: '/guide-friends', key: 'nav.guide' },
  { href: '/travel', key: 'nav.travel' },
  { href: '/jetpool-charter', key: 'nav.charter' },
] as const;

/**
 * Brand lockup. The files under `public/brand/` are transparent cut-outs of the supplied artwork
 * (regenerate with `scripts/brand/cutout-logo.py`); the `-dark` pair is lightness-lifted so the
 * navy half of the gradient stays legible on the dark theme. The artwork is painted by CSS
 * (`.wordmark .logo`) rather than an <img> pair so a browser only ever fetches the variant the
 * active theme actually shows; the link itself carries the accessible name.
 * `lockup` adds the "JETPOOL INTERNATIONAL Corp." line — footer only, the header bar is too short.
 */
export function Wordmark({ lockup = false }: { lockup?: boolean }) {
  return (
    <Link href="/" className={lockup ? 'wordmark lockup' : 'wordmark'} aria-label="JETPOOL home">
      <span className="logo" aria-hidden="true" />
    </Link>
  );
}

type MenuLink = [href: string, label: string, icon: IconName];

/** The brand ("About") section: one source for the footer column, the header menu and the mobile drawer. */
const brandLinks = (L: (ko: string, en: string) => string): MenuLink[] => [
  ['/about', L('브랜드 이야기', 'Our story'), 'sparkle'],
  ['/about/about-ceo', L('CEO 원치승', 'CEO Michael Won'), 'user'],
  ['/archive', L('브랜드 아카이브', 'Brand archive'), 'image'],
  ['/credits', L('사진 출처·라이선스', 'Photo credits'), 'camera'],
];

/**
 * Shared `role=menu` keyboard behaviour: ↑/↓/Home/End move, Space activates, Esc closes and refocuses the
 * button, Tab closes. Used by the user menu and the language menu so they stay consistent.
 */
function menuKeys(listRef: RefObject<HTMLUListElement | null>, close: (refocus?: boolean) => void) {
  return (e: KeyboardEvent<HTMLUListElement>) => {
    const els = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]') ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    let n = -1;
    if (e.key === 'ArrowDown') n = (i + 1) % els.length;
    else if (e.key === 'ArrowUp') n = (i - 1 + els.length) % els.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = els.length - 1;
    else if (e.key === ' ' && i >= 0) {
      e.preventDefault();
      els[i].click();
      return;
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
      return;
    } else if (e.key === 'Tab') {
      close();
      return;
    }
    if (n >= 0) {
      e.preventDefault();
      els[n]?.focus();
    }
  };
}

/** Language picker: the five shipped UI languages plus "follow the browser". */
function LangMenu() {
  const { lang, setLang, auto, t, L } = useI18n();
  const p = usePopover();
  const menuId = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  useFitPopover(p.open, popRef);
  const close = (refocus = false) => {
    p.setOpen(false);
    if (refocus) btnRef.current?.focus();
  };
  const choose = (l: Lang | null) => {
    setLang(l);
    close(true);
  };
  return (
    <div className="popover-anchor" ref={p.ref}>
      <button
        ref={btnRef}
        type="button"
        className="btn ghost sm"
        aria-expanded={p.open}
        aria-haspopup="menu"
        aria-controls={p.open ? menuId : undefined}
        onClick={() => p.setOpen(!p.open)}
        aria-label={`${L('언어', 'Language')}: ${langInfo(lang).endonym}`}
      >
        <Icon name="globe" size={16} /> <span className="hide-mobile">{langInfo(lang).endonym}</span>
      </button>
      {p.open && (
        <div className="popover right" ref={popRef} style={{ minWidth: 200, padding: 8 }}>
          <ul className="menu" role="menu" id={menuId} aria-label={t('common.lang')} ref={listRef} onKeyDown={menuKeys(listRef, close)}>
            {LANGS.map((l) => (
              <li key={l.code} role="none">
                <button type="button" role="menuitemradio" aria-checked={!auto && l.code === lang} tabIndex={-1} lang={l.locale} onClick={() => choose(l.code)}>
                  {l.endonym}
                  {!auto && l.code === lang && <Icon name="check" size={16} />}
                </button>
              </li>
            ))}
            <li role="separator" />
            <li role="none">
              <button type="button" role="menuitemradio" aria-checked={auto} tabIndex={-1} onClick={() => choose(null)}>
                {t('lang.auto')}
                {auto && <Icon name="check" size={16} />}
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * WAI-ARIA menu button, shared by the user menu and the brand menu: role=menu on the list, menuitems are links
 * (middle-click works), keys from menuKeys(), and ↑/↓ on the button itself opens the menu at its first/last item.
 */
function useMenuButton() {
  const p = usePopover();
  const menuId = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = useRef<'first' | 'last' | null>(null);
  useFitPopover(p.open, popRef);
  const itemsOf = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  useEffect(() => {
    if (!p.open || !focusOnOpen.current) return;
    const els = itemsOf();
    (focusOnOpen.current === 'last' ? els[els.length - 1] : els[0])?.focus();
    focusOnOpen.current = null;
  }, [p.open]);
  const close = (refocus = false) => {
    p.setOpen(false);
    if (refocus) btnRef.current?.focus();
  };
  const onMenuKey = menuKeys(listRef, close);
  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    focusOnOpen.current = e.key === 'ArrowDown' ? 'first' : 'last';
    if (p.open) {
      const els = itemsOf();
      (e.key === 'ArrowDown' ? els[0] : els[els.length - 1])?.focus();
    } else p.setOpen(true);
  };
  const buttonProps = {
    ref: btnRef,
    type: 'button' as const,
    'aria-expanded': p.open,
    'aria-haspopup': 'menu' as const,
    'aria-controls': p.open ? menuId : undefined,
    onClick: () => p.setOpen(!p.open),
    onKeyDown: onButtonKey,
  };
  return { p, menuId, listRef, popRef, close, onMenuKey, buttonProps };
}

/** Brand pages (the footer "About" column) as a header dropdown, so they are reachable from the main menu. */
function BrandMenu({ path }: { path: string }) {
  const { L } = useI18n();
  const m = useMenuButton();
  const links = brandLinks(L);
  const label = L('브랜드', 'About');
  const onBrandPage = links.some(([href]) => path === href || path.startsWith(href + '/'));
  return (
    <div className="popover-anchor" ref={m.p.ref}>
      <button {...m.buttonProps} className="nav-trigger" data-active={onBrandPage || undefined}>
        {label}
        <Icon name="down" size={14} />
      </button>
      {m.p.open && (
        <div className="popover" ref={m.popRef} style={{ minWidth: 232, padding: 4 }}>
          <ul className="menu" role="menu" id={m.menuId} aria-label={label} ref={m.listRef} onKeyDown={m.onMenuKey}>
            {links.map(([href, text, icon]) => (
              <li key={href} role="none">
                <Link href={href} role="menuitem" tabIndex={-1} aria-current={path === href ? 'page' : undefined} onClick={() => m.close()}>
                  <Icon name={icon} size={18} /> {text}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user, logout, isStaff, hasRole } = useAuth();
  const { t, L } = useI18n();
  const router = useRouter();
  const m = useMenuButton();
  if (!user) return null;
  const links: MenuLink[] = [
    ['/trips', t('nav.trips'), 'bag'],
    ['/messages', t('nav.messages'), 'chat'],
    ['/saved', t('nav.saved'), 'heart'],
    ['/notifications', L('알림', 'Notifications'), 'bell'],
    ['/account', t('nav.account'), 'user'],
  ];
  const partner: MenuLink[] = [
    [hasRole('HOST') ? '/host/dashboard' : '/host/onboarding', hasRole('HOST') ? L('호스트 센터', 'Host center') : L('호스트 되기', 'Become a host'), 'home'],
    [hasRole('GUIDE') ? '/guide/requests' : '/guide/onboarding', hasRole('GUIDE') ? L('가이드 센터', 'Guide center') : L('가이드 되기', 'Become a guide'), 'compass'],
  ];
  if (hasRole('SUPPLIER')) partner.push(['/supplier/products', L('공급사 센터', 'Supplier center'), 'ticket']);
  if (hasRole('HOST') || hasRole('GUIDE') || hasRole('SUPPLIER')) partner.push(['/earnings', L('정산', 'Earnings'), 'coin']);
  if (isStaff) partner.push(['/admin', t('nav.admin'), 'chart']);
  return (
    <div className="popover-anchor" ref={m.p.ref}>
      <button {...m.buttonProps} className="user-chip">
        <Icon name="menu" size={16} />
        <Avatar name={user.displayName} size={30} verified={user.aal === 'aal2'} decorative />
        <span className="sr-only">{L('사용자 메뉴', 'User menu')}</span>
      </button>
      {m.p.open && (
        <div className="popover right" ref={m.popRef} style={{ minWidth: 260, padding: 8 }}>
          <div style={{ padding: '8px 12px 10px' }}>
            <strong>{user.displayName}</strong>
            <div className="xs muted">{user.email}</div>
          </div>
          <ul className="menu" role="menu" id={m.menuId} aria-label={L('사용자 메뉴', 'User menu')} ref={m.listRef} onKeyDown={m.onMenuKey}>
            {links.map(([href, label, icon]) => (
              <li key={href} role="none">
                <Link href={href} role="menuitem" tabIndex={-1} onClick={() => m.close()}>
                  <Icon name={icon} size={18} /> {label}
                </Link>
              </li>
            ))}
            <li role="separator" />
            {partner.map(([href, label, icon]) => (
              <li key={href} role="none">
                <Link href={href} role="menuitem" tabIndex={-1} onClick={() => m.close()}>
                  <Icon name={icon} size={18} /> {label}
                </Link>
              </li>
            ))}
            <li role="separator" />
            <li role="none">
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                onClick={async () => {
                  m.close();
                  await logout();
                  router.push('/');
                }}
              >
                <Icon name="logout" size={18} /> {t('nav.logout')}
              </button>
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
          <BrandMenu path={path} />
        </nav>
        <div className="grow" />
        {user && isStaff && (
          <Link href="/admin" className="btn ghost sm hide-mobile" aria-current={cur('/admin')}>
            <Icon name="chart" size={16} /> {t('nav.admin')}
          </Link>
        )}
        <LangMenu />
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
        <button className="btn ghost icon sm menu-toggle" aria-expanded={open} aria-controls="mobile-nav" aria-haspopup="dialog" onClick={() => setOpen(true)} aria-label={t('nav.menu')}>
          <Icon name="menu" size={20} />
        </button>
      </div>
      <Drawer open={open} onClose={() => setOpen(false)} title={L('메뉴', 'Menu')} id="mobile-nav">
        <nav className="mobile-nav" aria-label={L('모바일 메뉴', 'Mobile')}>
          {NAV.map((n) => (
            <Link key={n.href} href={n.href} aria-current={cur(n.href)} onClick={() => setOpen(false)}>
              {t(n.key)}
            </Link>
          ))}
          <hr />
          <Link href="/map" onClick={() => setOpen(false)}>
            <Icon name="map" size={18} /> {L('지도로 찾기', 'Map')}
          </Link>
          <Link href="/discover" onClick={() => setOpen(false)}>
            <Icon name="globe" size={18} /> {L('여행지 탐색', 'Discover')}
          </Link>
          <Link href="/assistant" onClick={() => setOpen(false)}>
            <Icon name="sparkle" size={18} /> {L('AI 여행 도우미', 'AI assistant')}
          </Link>
          <Link href="/support" onClick={() => setOpen(false)}>
            <Icon name="support" size={18} /> {L('고객센터', 'Help')}
          </Link>
          <hr />
          <h3 className="nav-group">{L('브랜드', 'About')}</h3>
          {brandLinks(L).map(([href, label, icon]) => (
            <Link key={href} href={href} aria-current={path === href ? 'page' : undefined} onClick={() => setOpen(false)}>
              <Icon name={icon} size={18} /> {label}
            </Link>
          ))}
          {!user && (
            <div className="stack" style={{ marginTop: 12 }}>
              <Link className="btn accent block" href="/signup" onClick={() => setOpen(false)}>
                {t('nav.signup')}
              </Link>
              <Link className="btn block" href={`/login?next=${encodeURIComponent(path)}`} onClick={() => setOpen(false)}>
                {t('nav.login')}
              </Link>
            </div>
          )}
        </nav>
      </Drawer>
    </header>
  );
}

type Tab = [href: string, label: string, icon: IconName, active: (p: string) => boolean];

/** Mobile bottom tab bar. Traveler tabs by default; provider centers get their own role-specific tabs. */
export function BottomNav() {
  const { L } = useI18n();
  const path = usePathname() || '/';
  const isGuideCenter = path === '/guide' || path.startsWith('/guide/');
  const host: Tab[] = [
    ['/host/dashboard', L('대시보드', 'Dashboard'), 'chart', (p) => p.startsWith('/host/dashboard')],
    ['/host/calendar', L('달력', 'Calendar'), 'calendar', (p) => p.startsWith('/host/calendar')],
    ['/host/reservations', L('예약', 'Bookings'), 'bag', (p) => p.startsWith('/host/reservations')],
    ['/host/listings', L('숙소', 'Listings'), 'home', (p) => p.startsWith('/host/listings') || p.startsWith('/host/onboarding') || p.startsWith('/host/integrations')],
    ['/earnings', L('정산', 'Earnings'), 'coin', (p) => p.startsWith('/earnings')],
  ];
  const guide: Tab[] = [
    ['/guide/requests', L('요청', 'Requests'), 'compass', (p) => p.startsWith('/guide/requests')],
    ['/guide/calendar', L('달력', 'Calendar'), 'calendar', (p) => p.startsWith('/guide/calendar')],
    ['/messages', L('메시지', 'Messages'), 'chat', (p) => p.startsWith('/messages')],
    ['/earnings', L('정산', 'Earnings'), 'coin', (p) => p.startsWith('/earnings')],
    ['/guide/onboarding', L('프로필', 'Profile'), 'user', (p) => p.startsWith('/guide/onboarding')],
  ];
  const supplier: Tab[] = [
    ['/supplier/products', L('상품', 'Products'), 'ticket', (p) => p.startsWith('/supplier')],
    ['/messages', L('메시지', 'Messages'), 'chat', (p) => p.startsWith('/messages')],
    ['/earnings', L('정산', 'Earnings'), 'coin', (p) => p.startsWith('/earnings')],
    ['/account', L('계정', 'Account'), 'user', (p) => p.startsWith('/account')],
  ];
  const traveler: Tab[] = [
    ['/', L('둘러보기', 'Explore'), 'search', (p) => p === '/' || p.startsWith('/stay') || p.startsWith('/exchange') || p.startsWith('/guide-friends') || p.startsWith('/travel') || p.startsWith('/map')],
    ['/saved', L('저장', 'Saved'), 'heart', (p) => p.startsWith('/saved')],
    ['/trips', L('여행', 'Trips'), 'bag', (p) => p.startsWith('/trips') || p.startsWith('/orders') || p.startsWith('/guide-bookings')],
    ['/messages', L('메시지', 'Messages'), 'chat', (p) => p.startsWith('/messages')],
    ['/account', L('프로필', 'Profile'), 'user', (p) => p.startsWith('/account') || p.startsWith('/login') || p.startsWith('/signup')],
  ];
  if (path.startsWith('/admin') || path.startsWith('/checkout') || /^\/stay\/[^/]+\/checkout/.test(path)) return null;
  const tabs = path.startsWith('/host') ? host : isGuideCenter ? guide : path.startsWith('/supplier') ? supplier : path.startsWith('/earnings') ? host : traveler;
  return (
    <nav className="bottom-nav" aria-label={L('하단 메뉴', 'Bottom navigation')} style={{ gridTemplateColumns: `repeat(${tabs.length}, 1fr)` }}>
      {tabs.map(([href, label, icon, active]) => (
        <Link key={href + label} href={href} aria-current={active(path) ? 'page' : undefined}>
          <Icon name={icon} />
          {label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Operator disclosure required on Korean e-commerce sites (전자상거래법 §10). The registered
 * company details are the defaults; NEXT_PUBLIC_BIZ_* env overrides each one so a staging or
 * white-label deploy can disclose a different operator without a code change. `name` is the full
 * legal name used for the 상호 row and the copyright line; `shortName` is the one that reads
 * naturally mid-sentence in the intermediary disclaimer. Rows left empty are not rendered.
 */
const BIZ = {
  name: process.env.NEXT_PUBLIC_BIZ_NAME || '젯풀인터내셔날(주) Jetpool International Co.,LTD.',
  shortName: process.env.NEXT_PUBLIC_BIZ_SHORT_NAME || '젯풀인터내셔날(주)',
  ceo: process.env.NEXT_PUBLIC_BIZ_CEO || '원치승',
  regNo: process.env.NEXT_PUBLIC_BIZ_REG_NO || '101-86-57891',
  mailOrderNo: process.env.NEXT_PUBLIC_BIZ_MAIL_ORDER_NO || '',
  tourismNo: process.env.NEXT_PUBLIC_BIZ_TOURISM_NO || '',
  address: process.env.NEXT_PUBLIC_BIZ_ADDRESS || '서울시 강남구 영동대로 725 5F',
  phone: process.env.NEXT_PUBLIC_BIZ_PHONE || '+82.(02). 6672. 0055',
  fax: process.env.NEXT_PUBLIC_BIZ_FAX || '+82.(02).6937.1399',
  email: process.env.NEXT_PUBLIC_BIZ_EMAIL || 'ceojp@hanmail.net',
  privacyOfficer: process.env.NEXT_PUBLIC_BIZ_PRIVACY_OFFICER || '원치승',
  hosting: process.env.NEXT_PUBLIC_BIZ_HOSTING || '',
};

/** Policy document viewer (terms, privacy, refund) backed by /v1/consent-documents — no extra route needed. */
function PolicyDialog({ type, onClose }: { type: string | null; onClose: () => void }) {
  const { L } = useI18n();
  const st = useApi<any>(type ? '/v1/consent-documents' : null);
  const doc = items(st.data).find((d: any) => str(d, 'type') === type);
  const body = str(doc, 'bodyMd', 'body');
  return (
    <Modal open={!!type} onClose={onClose} title={str(doc, 'title') || (type === 'PRIVACY' ? L('개인정보 처리방침', 'Privacy policy') : type === 'REFUND_POLICY' ? L('취소·환불 정책', 'Cancellation & refunds') : L('이용약관', 'Terms of service'))} wide>
      {st.loading && !doc ? (
        <p className="muted">{L('불러오는 중…', 'Loading…')}</p>
      ) : doc ? (
        <div className="stack">
          <p className="xs muted" style={{ margin: 0 }}>
            {L('버전', 'Version')} {str(doc, 'version')}
            {str(doc, 'publishedAt') ? ` · ${L('시행일', 'Effective')} ${str(doc, 'publishedAt').slice(0, 10)}` : ` · ${L('게시 준비 중', 'Not yet published')}`}
          </p>
          {body.split(/\n{2,}/).map((para, i) => (
            <p key={i} style={{ whiteSpace: 'pre-line' }}>
              {para.replace(/^#+\s*/, '')}
            </p>
          ))}
        </div>
      ) : (
        <p className="muted">{L('문서를 불러오지 못했어요. 고객센터로 문의해 주세요.', 'Could not load this document. Please contact support.')}</p>
      )}
    </Modal>
  );
}

export function Footer() {
  const { t, L } = useI18n();
  const [doc, setDoc] = useState<string | null>(null);
  const rows: Array<[string, string]> = (
    [
      [L('상호', 'Company'), BIZ.name],
      [L('대표', 'CEO'), BIZ.ceo],
      [L('개인정보관리책임자', 'Privacy officer'), BIZ.privacyOfficer],
      [L('전화', 'Phone'), BIZ.phone],
      [L('팩스', 'Fax'), BIZ.fax],
      [L('이메일', 'Email'), BIZ.email],
      [L('주소', 'Address'), BIZ.address],
      [L('사업자등록번호', 'Business reg. no.'), BIZ.regNo],
      [L('통신판매업 신고', 'Mail-order reg. no.'), BIZ.mailOrderNo],
      [L('관광사업 등록', 'Tourism reg. no.'), BIZ.tourismNo],
      [L('호스팅 서비스', 'Hosting'), BIZ.hosting],
    ] as Array<[string, string]>
  ).filter(([, v]) => v);
  return (
    <footer className="site-footer">
      <div className="container stack-lg">
        <div className="cols">
          <div className="stack">
            <Wordmark lockup />
            <p className="small">{L('WONT Travel Club의 새로운 이름. 한달살기 맞교환, 전세기 공유, 로컬 라이프.', 'The new home of WONT Travel Club — month-long exchanges, charter sharing and local life.')}</p>
          </div>
          <nav aria-labelledby="ft-travel">
            <h2 className="footer-h" id="ft-travel">{L('여행', 'Travel')}</h2>
            <Link href="/stay">{t('nav.stay')}</Link>
            <Link href="/exchange">{t('nav.exchange')}</Link>
            <Link href="/guide-friends">{t('nav.guide')}</Link>
            <Link href="/travel">{t('nav.travel')}</Link>
            <Link href="/jetpool-charter">{t('nav.charter')}</Link>
          </nav>
          <nav aria-labelledby="ft-partner">
            <h2 className="footer-h" id="ft-partner">{L('파트너', 'Partners')}</h2>
            <Link href="/host/onboarding">{L('호스트 되기', 'Become a host')}</Link>
            <Link href="/guide/onboarding">{L('가이드 되기', 'Become a guide')}</Link>
            <Link href="/supplier/products">{L('여행 공급사', 'Suppliers')}</Link>
            <Link href="/discover">{L('여행지 탐색', 'Discover')}</Link>
            <Link href="/stories">{L('스토리', 'Stories')}</Link>
          </nav>
          <nav aria-labelledby="ft-brand">
            <h2 className="footer-h" id="ft-brand">{L('브랜드', 'About')}</h2>
            {brandLinks(L).map(([href, label]) => (
              <Link key={href} href={href}>
                {label}
              </Link>
            ))}
          </nav>
          <nav aria-labelledby="ft-support">
            <h2 className="footer-h" id="ft-support">{L('지원', 'Support')}</h2>
            <Link href="/support">{L('고객센터', 'Help center')}</Link>
            <Link href="/support/disputes">{L('분쟁·안전 신고', 'Disputes & safety')}</Link>
            <Link href="/assistant">{L('AI 여행 도우미', 'AI assistant')}</Link>
            <Link href="/account/privacy">{L('내 개인정보 관리', 'My privacy settings')}</Link>
          </nav>
        </div>
        <hr />
        <div className="stack" style={{ gap: 12 }}>
          <div className="legal-links small">
            <button type="button" className="legal-link strong" aria-haspopup="dialog" onClick={() => setDoc('TERMS')}>
              {L('이용약관', 'Terms of service')}
            </button>
            <button type="button" className="legal-link strong" aria-haspopup="dialog" onClick={() => setDoc('PRIVACY')}>
              {L('개인정보 처리방침', 'Privacy policy')}
            </button>
            <button type="button" className="legal-link" aria-haspopup="dialog" onClick={() => setDoc('REFUND_POLICY')}>
              {L('취소·환불 정책', 'Cancellation & refunds')}
            </button>
            <Link href="/support">{L('고객센터', 'Help center')}</Link>
          </div>
          <div className="biz">
            <dl aria-label={L('사업자 정보', 'Business information')}>
              {rows.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <p className="disclaimer">
            {L(
              `${BIZ.shortName}은(는) 통신판매중개자로서 통신판매의 당사자가 아닙니다. 호스트·가이드·여행 공급사가 등록한 상품의 정보와 거래에 대한 책임은 각 판매자에게 있습니다. 단, ${BIZ.shortName}이(가) 판매자로 명시된 상품은 예외입니다.`,
              `${BIZ.shortName} acts as a mail-order intermediary and is not a party to transactions between members. Hosts, guides and travel suppliers are responsible for their listings and transactions, except where ${BIZ.shortName} is named as the seller.`,
            )}
          </p>
          <div className="row between xs" style={{ color: 'var(--text-muted)' }}>
            <span>Copyright © {BIZ.name}. All rights reserved.</span>
            <span>{L('결제는 토스페이먼츠를 통해 안전하게 처리됩니다.', 'Payments are processed securely by TossPayments.')}</span>
          </div>
        </div>
      </div>
      <PolicyDialog type={doc} onClose={() => setDoc(null)} />
    </footer>
  );
}

export function SideNav({ items: navItems, label }: { items: Array<{ href: string; label: string; icon?: IconName; group?: string }>; label: string }) {
  const path = usePathname() || '';
  const ref = useRef<HTMLElement>(null);
  // On phones the side nav is a horizontal strip: keep the active item in view.
  useEffect(() => {
    const el = ref.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (el && ref.current && ref.current.scrollWidth > ref.current.clientWidth) {
      const nav = ref.current;
      nav.scrollTo({ left: el.offsetLeft - nav.clientWidth / 2 + el.clientWidth / 2, behavior: 'auto' });
    }
  }, [path]);
  let lastGroup = '';
  return (
    <nav className="side-nav" aria-label={label} ref={ref}>
      {navItems.map((i) => {
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

/**
 * Start every forward navigation to a new path at the top of the page. Next.js only resets scroll when the new
 * segment's first element is off-screen at commit time; client pages that render a skeleton/gate first (checkout,
 * exchange detail) otherwise inherit the previous page's scroll offset (mobile Reserve → checkout landed on the
 * footer). Back/forward (popstate) and #hash navigations keep the browser's own restoration.
 */
export function ScrollReset() {
  const path = usePathname();
  const pop = useRef(false);
  const first = useRef(true);
  useEffect(() => {
    const on = () => (pop.current = true);
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (pop.current) {
      pop.current = false;
      return;
    }
    if (window.location.hash) return;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  }, [path]);
  return null;
}

export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV === 'production' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);
  return null;
}
