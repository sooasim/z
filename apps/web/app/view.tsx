'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { arr, item, str } from '@/lib/shape';
import { StaySearchBar } from '@/components/search/StaySearchBar';
import { Rail } from '@/components/rail';
import { GuideCard, ProductCard, PropertyCard } from '@/components/cards';

const FALLBACK_BLOCKS = [
  {
    key: 'month-exchange',
    ko: { title: '한달살기 맞교환', body: '내 집을 비우는 동안 다른 도시의 집에서 한 달을 살아보세요. 검증된 회원끼리, 서로의 집을 맞교환합니다.', cta: '홈 맞교환 둘러보기' },
    en: { title: 'Month-long home exchange', body: 'Live a month in another city while a verified member stays in yours.', cta: 'Explore exchange' },
    href: '/exchange',
  },
  {
    key: 'charter',
    ko: { title: '전세기 공유 JETPOOL', body: '함께 타면 더 가까워지는 여행. 전세기·항공 공유 수요를 모아 여행을 제안합니다. (직접 예약 아님 · 상담 신청)', cta: '전세기 소식 보기' },
    en: { title: 'Charter sharing JETPOOL', body: 'We pool demand for charter flights. Lead form only — no direct booking.', cta: 'Charter news' },
    href: '/jetpool-charter',
  },
  {
    key: 'local-life',
    ko: { title: 'Local Life', body: '관광지가 아닌 동네의 일상. 현지 프렌드와 걷고, 먹고, 이야기하는 여행.', cta: '가이드 프렌드 만나기' },
    en: { title: 'Local Life', body: 'Neighbourhood life, not tourist spots. Walk, eat and talk with local friends.', cta: 'Meet guide friends' },
    href: '/guide-friends',
  },
];

function BrandBlocks() {
  const { lang, L } = useI18n();
  const st = useApi<any>('/v1/content/brand/home');
  const remote = arr(item(st.data), 'blocks', 'sections');
  const blocks =
    remote.length > 0
      ? remote.map((b: any, i: number) => ({ key: str(b, 'key', 'id') || String(i), title: str(b, 'title'), body: str(b, 'body', 'summary', 'text'), cta: str(b, 'cta', 'ctaLabel') || L('자세히', 'Learn more'), href: str(b, 'href', 'url', 'link') || '/' }))
      : FALLBACK_BLOCKS.map((b) => ({ key: b.key, ...b[lang], href: b.href }));
  return (
    <section aria-label={L('WONT Travel Club 이야기', 'WONT Travel Club stories')} style={{ marginTop: 40 }}>
      <p className="small muted" style={{ letterSpacing: '0.1em', fontWeight: 700 }}>
        WONT TRAVEL CLUB → JETPOOL
      </p>
      <div className="grid">
        {blocks.map((b) => (
          <article key={b.key} className="brand-block stack">
            <h3>{b.title}</h3>
            <p className="muted">{b.body}</p>
            <Link className="btn" href={b.href}>
              {b.cta}
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}

export default function HomeView() {
  const { L } = useI18n();
  return (
    <>
      <section className="hero stack">
        <h1>{L('살아보는 여행, JETPOOL', 'Travel like you live there')}</h1>
        <p>{L('검증된 숙소, 한달살기 홈 맞교환, 로컬 가이드 프렌드, 여행 상품을 한 곳에서.', 'Verified stays, month-long home exchange, local guide friends and travel — together.')}</p>
        <StaySearchBar />
        <nav aria-label={L('바로가기', 'Shortcuts')} className="chip-group" style={{ marginTop: 8 }}>
          <Link className="chip" href="/stay">🏠 {L('숙소', 'Stays')}</Link>
          <Link className="chip" href="/exchange">🔁 {L('홈 맞교환', 'Exchange')}</Link>
          <Link className="chip" href="/guide-friends">🧭 {L('가이드 프렌드', 'Guide friends')}</Link>
          <Link className="chip" href="/travel">🎫 {L('투어·티켓', 'Tours & tickets')}</Link>
          <Link className="chip" href="/map">🗺 {L('지도로 보기', 'Map')}</Link>
        </nav>
      </section>
      <Rail title={L('추천 숙소', 'Recommended stays')} path="/v1/search/properties" query={{ limit: 12, sort: "recommended" }} href="/stay" render={(p) => <PropertyCard p={p} />} />
      <Rail title={L('홈 맞교환 가능한 집', 'Homes open to exchange')} path="/v1/exchange/homes" query={{ limit: 12 }} href="/exchange" render={(p) => <PropertyCard p={p} href={`/exchange?home=${p.id}`} />} />
      <Rail title={L('로컬 가이드 프렌드', 'Local guide friends')} path="/v1/search/guides" query={{ limit: 12 }} href="/guide-friends" render={(g) => <GuideCard g={g} />} />
      <Rail title={L('투어·티켓·패키지', 'Tours, tickets & packages')} path="/v1/travel-products" query={{ limit: 12 }} href="/travel" render={(p) => <ProductCard p={p} />} />
      <BrandBlocks />
    </>
  );
}
