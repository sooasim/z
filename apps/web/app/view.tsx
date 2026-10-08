'use client';
import Link from 'next/link';
import { useRef } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { arr, items, str } from '@/lib/shape';
import { StaySearchBar } from '@/components/search/StaySearchBar';
import { Rail } from '@/components/rail';
import { GuideCard, PropertyCard } from '@/components/cards';
import { TourCard } from '@/components/public/TourCard';
import { Icon, type IconName } from '@/components/ui';
import { HomeRail, RailNav } from '@/components/public/HomeRail';
import s from '@/components/public/public.module.css';

/** `en` is the canonical (API) city name used in search links; `ko`/`en` are display names. */
const DESTINATIONS: Array<{ ko: string; en: string; art: string; tag: [string, string] }> = [
  { ko: '제주', en: 'Jeju', art: 'jeju', tag: ['한달살기 1위', '#1 month stay'] },
  { ko: '부산', en: 'Busan', art: 'busan', tag: ['바다 워케이션', 'Seaside workation'] },
  { ko: '강릉', en: 'Gangneung', art: 'gangneung', tag: ['커피와 바다', 'Coffee & coast'] },
  { ko: '서울', en: 'Seoul', art: 'seoul', tag: ['로컬 라이프', 'Local life'] },
  { ko: '경주', en: 'Gyeongju', art: 'gyeongju', tag: ['천년 고도', 'Ancient capital'] },
  { ko: '치앙마이', en: 'Chiang Mai', art: 'chiangmai', tag: ['디지털 노마드', 'Digital nomads'] },
  { ko: '도쿄', en: 'Tokyo', art: 'tokyo', tag: ['맞교환 인기', 'Exchange favourite'] },
  { ko: '리스본', en: 'Lisbon', art: 'lisbon', tag: ['유럽 한달', 'A month in Europe'] },
];

function DestinationRail() {
  const { lang, L } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const title = L('어디서 살아볼까요?', 'Where will you live next?');
  return (
    <section className="section" aria-labelledby="dest-h">
      <div className="rail-head">
        <div>
          <h2 id="dest-h">{title}</h2>
          <p>{L('JETPOOL 멤버들이 가장 많이 머무는 도시', 'Cities our members stay in most')}</p>
        </div>
        <div className="row" style={{ gap: 8 }}>
          <Link href="/discover" className="btn ghost sm">
            {L('여행지 더 보기', 'More destinations')}
          </Link>
          <RailNav target={ref} />
        </div>
      </div>
      <div className="rail" ref={ref} tabIndex={0} aria-label={`${title} — ${L('좌우로 스크롤', 'scroll horizontally')}`}>
        {DESTINATIONS.map((d) => (
          <Link key={d.en} href={`/stay?q=${encodeURIComponent(d.en)}`} className={s.destCard}>
            <img src={`/art/postcards/${d.art}.svg`} alt="" loading="lazy" />
            <span className={s.cap}>
              <strong>{d[lang]}</strong>
              <span>{d.tag[lang === 'ko' ? 0 : 1]}</span>
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

const FALLBACK_BLOCKS = [
  { key: 'month-exchange', tone: 'navy', art: 'jeju', ko: { title: '한달살기 맞교환', body: '내 집을 비우는 동안 다른 도시의 집에서 한 달을 살아보세요. 검증된 회원끼리, 돈 없이 집을 맞교환합니다.', cta: '홈 맞교환 둘러보기' }, en: { title: 'Month-long home exchange', body: 'Live a month in another city while a verified member lives in yours — no rent changes hands.', cta: 'Explore exchange' }, href: '/exchange' },
  { key: 'charter', tone: 'coral', art: 'coast', ko: { title: '전세기 공유 JETPOOL', body: '함께 타면 더 가까워지는 여행. 전세기 수요를 모아 노선을 엽니다. (상담 신청 · 직접 예약 아님)', cta: '전세기 소식 보기' }, en: { title: 'Charter sharing JETPOOL', body: 'We pool demand to open charter routes. Lead requests only — no direct booking.', cta: 'Charter news' }, href: '/jetpool-charter' },
  { key: 'local-life', tone: 'sand', art: 'seoul', ko: { title: 'Local Life', body: '관광지가 아닌 동네의 일상. 현지 프렌드와 걷고, 먹고, 이야기하는 여행.', cta: '가이드 프렌드 만나기' }, en: { title: 'Local Life', body: 'Neighbourhood life, not tourist spots. Walk, eat and talk with local friends.', cta: 'Meet guide friends' }, href: '/guide-friends' },
] as const;

function BrandBlocks() {
  const { lang, L } = useI18n();
  const st = useApi<any>('/v1/content/page', { query: { limit: 50 } });
  const entry = items(st.data).find((e: any) => str(e, 'slug') === 'wont-home');
  // CMS blocks are authored in Korean; the English UI keeps the bilingual fallback copy.
  const remote = lang === 'ko' || /^en/i.test(str(entry, 'locale')) ? arr(entry, 'data.blocks', 'blocks') : [];
  const blocks =
    remote.length > 0
      ? remote.map((b: any, i: number) => ({ key: str(b, 'key', 'id') || String(i), tone: (['navy', 'coral', 'sand'] as const)[i % 3], art: str(b, 'art') || FALLBACK_BLOCKS[i % 3].art, title: str(b, 'title'), body: str(b, 'body', 'summary', 'text'), cta: str(b, 'cta', 'ctaLabel') || L('자세히', 'Learn more'), href: str(b, 'href', 'url', 'link') || '/' }))
      : FALLBACK_BLOCKS.map((b) => ({ key: b.key, tone: b.tone, art: b.art, ...b[lang], href: b.href }));
  return (
    <section className="section" aria-labelledby="brand-h">
      <p className="eyebrow">WONT Travel Club → JETPOOL</p>
      <h2 id="brand-h">{L('여행을 사는 사람들의 클럽', 'A club for people who live their travels')}</h2>
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(280px, 100%), 1fr))' }}>
        {blocks.map((b) => (
          <article key={b.key} className={`brand-block ${b.tone}`}>
            <img className="art" src={`/art/postcards/${b.art}.svg`} alt="" style={{ borderRadius: '50%', objectFit: 'cover' }} />
            <h3 style={{ fontSize: 'var(--fs-2xl)' }}>{b.title}</h3>
            <p>{b.body}</p>
            <Link className={`btn ${b.tone === 'sand' ? 'primary' : ''}`} href={b.href}>
              {b.cta} <Icon name="right" size={16} />
            </Link>
          </article>
        ))}
      </div>
    </section>
  );
}

function TrustRow() {
  const { L } = useI18n();
  const rows: Array<[IconName, string, string]> = [
    ['shield', L('검증된 숙소만 예약', 'Only verified stays are bookable'), L('인허가·안전 요건을 통과한 숙소만 유료 예약이 열려요.', 'Paid booking opens only after permit and safety checks.')],
    ['lock', L('안전한 결제', 'Secure payments'), L('토스페이먼츠 승인 후에 예약이 확정돼요. 카드 정보는 저장하지 않아요.', 'Bookings are confirmed after TossPayments approval. We never store card details.')],
    ['swap', L('함께 확정되는 맞교환', 'Both homes, confirmed together'), L('두 집 일정이 함께 확정돼요 — 한쪽이 취소되면 모두 취소돼요.', 'Both homes are booked together — if one side cancels, both are cancelled.')],
    ['support', L('분쟁 전담 지원', 'Dedicated dispute support'), L('문제가 생기면 사진·대화 기록과 함께 접수해 주세요. 전담팀이 처리해요.', 'Report a problem with photos and messages — a dedicated team handles it.')],
  ];
  return (
    <section className="section card flat" aria-label={L('JETPOOL 안심 약속', 'Our safety promise')} style={{ background: 'var(--surface-2)', borderRadius: 'var(--r-xl)', padding: 'var(--sp-8)' }}>
      <div className="trust-row">
        {rows.map(([ico, t, d]) => (
          <div key={t} className="trust-item">
            <span className="ico" aria-hidden="true">
              <Icon name={ico} size={22} />
            </span>
            <div>
              <strong>{t}</strong>
              <p className="small muted" style={{ margin: '4px 0 0' }}>{d}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Tilted postcard collage on the right of the hero (desktop): the brand's city postcards instead of a flat sun. */
function PostcardCollage() {
  const { L } = useI18n();
  const cards: Array<[string, string]> = [
    ['jeju', L('제주', 'Jeju')],
    ['lisbon', L('리스본', 'Lisbon')],
    ['busan', L('부산', 'Busan')],
  ];
  return (
    <div className={s.collage} aria-hidden="true">
      {cards.map(([art, name]) => (
        <figure key={art}>
          <img src={`/art/postcards/${art}.svg`} alt="" />
          <figcaption>{name}</figcaption>
        </figure>
      ))}
      <span className={s.stamp}>
        JETPOOL
        <br />
        30 DAYS
      </span>
    </div>
  );
}

export default function HomeView() {
  const { L } = useI18n();
  return (
    <>
      <section className={`hero full-bleed ${s.hero}`}>
        <div className="container">
          <div className={s.heroGrid}>
            <div>
              <p className="eyebrow">{L('살아보는 여행의 시작', 'Travel like a local')}</p>
              <h1>{L('한 달, 다른 도시에서 살아보기', 'Live a month somewhere new')}</h1>
              <p className="lead" style={{ marginBottom: 0 }}>{L('검증된 숙소, 한달살기 홈 맞교환, 로컬 가이드 프렌드, 투어·티켓까지 — 한 번에 찾고 안전하게 예약하세요.', 'Verified stays, month-long home exchanges, local guide friends and tours — find them all and book safely.')}</p>
            </div>
            <PostcardCollage />
          </div>
          <StaySearchBar />
          <nav aria-label={L('바로가기', 'Shortcuts')} className="chip-group" style={{ marginTop: 20 }}>
            <Link className="chip" href="/map">
              <Icon name="map" size={16} /> {L('지도로 찾기', 'Search on map')}
            </Link>
            <Link className="chip" href="/exchange/onboarding">
              <Icon name="swap" size={16} /> {L('내 집 맞교환 등록', 'List my home for exchange')}
            </Link>
            <Link className="chip" href="/assistant">
              <Icon name="sparkle" size={16} /> {L('AI에게 일정 추천받기', 'Plan with AI')}
            </Link>
          </nav>
        </div>
      </section>
      <DestinationRail />
      <Rail title={L('지금 예약 가능한 숙소', 'Stays you can book now')} subtitle={L('인허가 확인을 마친 숙소', 'Permit-verified homes')} path="/v1/search/properties" query={{ limit: 12, sort: 'relevance' }} href="/stay" render={(p) => <PropertyCard p={p} />} />
      <Rail title={L('홈 맞교환 가능한 집', 'Homes open to exchange')} subtitle={L('돈 대신 집을 바꿔 사는 한 달', 'Swap homes for a month')} path="/v1/exchange/homes" query={{ limit: 12 }} requireAuth href="/exchange" render={(p) => <PropertyCard p={p} href={`/exchange?home=${p.id}`} />} />
      <HomeRail
        title={L('로컬 가이드 프렌드', 'Local guide friends')}
        subtitle={L('프렌드 · 자원봉사 · 유료 · 전문', 'Friend · Volunteer · Paid · Pro')}
        path="/v1/search/guides"
        query={{ limit: 12 }}
        href="/guide-friends"
        render={(g) => <GuideCard g={g} />}
        promo={{ icon: 'compass', title: L('내 동네를 소개해 보세요', 'Show travellers your neighbourhood'), body: L('카페 산책, 시장 투어, 언어 교환까지 — 가이드 프렌드로 활동하고 여행자를 만나 보세요.', 'Café walks, market tours, language exchange — become a guide friend and meet travellers.'), cta: { href: '/guide/onboarding', label: L('가이드로 활동하기', 'Become a guide') } }}
      />
      <HomeRail
        title={L('투어·티켓·패키지', 'Tours, tickets & packages')}
        subtitle={L('검증된 여행 공급사 상품', 'From verified suppliers')}
        path="/v1/travel-products"
        query={{ limit: 12 }}
        href="/travel"
        render={(p) => <TourCard p={p} />}
        promo={{ icon: 'ticket', title: L('더 많은 투어가 곧 열려요', 'More tours are on the way'), body: L('지역 공급사와 함께 새 투어·티켓을 준비하고 있어요. 원하는 여행을 AI 도우미에게 알려 주세요.', 'We are adding tours with local suppliers. Tell the AI assistant what you are looking for.'), cta: { href: '/assistant', label: L('AI에게 추천받기', 'Ask the AI assistant') } }}
      />
      <BrandBlocks />
      <TrustRow />
    </>
  );
}
