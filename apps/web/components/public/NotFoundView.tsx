'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { Icon, Illustration, type IconName } from '@/components/ui';
import { StaySearchBar } from '@/components/search/StaySearchBar';
import s from './public.module.css';

export type NotFoundKind = 'page' | 'stay' | 'guide' | 'travel' | 'story';

const COPY: Record<NotFoundKind, { title: [string, string]; body: [string, string]; back?: { href: string; label: [string, string] } }> = {
  page: { title: ['페이지를 찾을 수 없어요', 'We can’t find that page'], body: ['주소가 바뀌었거나 삭제된 페이지일 수 있어요. 아래에서 다시 찾아보세요.', 'It may have moved or been removed. Try one of these instead.'] },
  stay: { title: ['숙소를 찾을 수 없어요', 'We can’t find that stay'], body: ['호스트가 숙소를 내렸거나 주소가 바뀌었을 수 있어요.', 'The host may have unlisted it, or the link changed.'], back: { href: '/stay', label: ['다른 숙소 둘러보기', 'Browse other stays'] } },
  guide: { title: ['가이드를 찾을 수 없어요', 'We can’t find that guide'], body: ['활동을 쉬고 있거나 프로필이 비공개로 바뀌었을 수 있어요.', 'They may be taking a break or have made their profile private.'], back: { href: '/guide-friends', label: ['다른 가이드 찾기', 'Find other guides'] } },
  travel: { title: ['여행 상품을 찾을 수 없어요', 'We can’t find that trip'], body: ['판매가 끝났거나 공급사가 상품을 내렸을 수 있어요.', 'It may have sold out or been withdrawn by the supplier.'], back: { href: '/travel', label: ['다른 투어·티켓 보기', 'See other tours'] } },
  story: { title: ['스토리를 찾을 수 없어요', 'We can’t find that story'], body: ['글이 내려갔거나 주소가 바뀌었을 수 있어요.', 'It may have been unpublished or moved.'], back: { href: '/stories', label: ['다른 스토리 읽기', 'Read other stories'] } },
};

const LINKS: Array<{ href: string; icon: IconName; label: [string, string] }> = [
  { href: '/stay', icon: 'home', label: ['숙소', 'Stays'] },
  { href: '/exchange', icon: 'swap', label: ['홈 맞교환', 'Home exchange'] },
  { href: '/guide-friends', icon: 'compass', label: ['가이드 프렌드', 'Guide friends'] },
  { href: '/travel', icon: 'ticket', label: ['투어·티켓', 'Tours & tickets'] },
  { href: '/support', icon: 'support', label: ['고객센터', 'Help centre'] },
];

/** Localized 404 used by app/not-found.tsx and the detail segments' not-found files (real HTTP 404). */
export function NotFoundView({ kind = 'page' }: { kind?: NotFoundKind }) {
  const { lang, L } = useI18n();
  const i = lang === 'ko' ? 0 : 1;
  const c = COPY[kind];
  return (
    <div className={s.notFound}>
      <div className="state" role="status" style={{ borderStyle: 'solid' }}>
        <Illustration name="search" />
        <p className="eyebrow" style={{ margin: '0 auto 4px' }}>404</p>
        <h1>{c.title[i]}</h1>
        <p className="muted">{c.body[i]}</p>
        <div className="actions">
          {c.back && (
            <Link className="btn primary" href={c.back.href}>
              {c.back.label[i]}
            </Link>
          )}
          <Link className={`btn ${c.back ? '' : 'primary'}`} href="/">
            <Icon name="home" size={16} /> {L('홈으로', 'Go home')}
          </Link>
        </div>
      </div>
      <section className={s.notFoundSearch} aria-label={L('숙소 검색', 'Search stays')}>
        <h2 className="small" style={{ margin: 0 }}>{L('어디로 떠나고 싶으세요?', 'Where would you like to go?')}</h2>
        <StaySearchBar modes={false} />
      </section>
      <nav aria-label={L('자주 찾는 곳', 'Popular sections')} className="chip-group" style={{ justifyContent: 'center' }}>
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className="chip">
            <Icon name={l.icon} size={16} /> {l.label[i]}
          </Link>
        ))}
      </nav>
    </div>
  );
}
