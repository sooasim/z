'use client';
import Link from 'next/link';
import { Photo } from '@/components/media';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { arr, items, str } from '@/lib/shape';
import { postcardFor } from '@/lib/art';
import { canonicalPlace, placeLabel } from '@/lib/places';
import { CardGridSkeleton, HeadingLevel, Icon, PageHeader } from '@/components/ui';
import s from '@/components/public/public.module.css';
import { pickText, pickPair } from '@/lib/phrases';

/** Fallback destinations (CMS down / empty). `en` is the canonical API city used in search links. */
const FALLBACK = [
  { slug: 'jeju', ko: '제주', en: 'Jeju', s: ['오름과 바다 사이 한 달', 'A month between volcanic hills and sea'] },
  { slug: 'busan', ko: '부산', en: 'Busan', s: ['바다가 보이는 워케이션', 'Workation by the sea'] },
  { slug: 'gangneung', ko: '강릉', en: 'Gangneung', s: ['커피 거리와 솔숲', 'Coffee street and pine forests'] },
  { slug: 'gyeongju', ko: '경주', en: 'Gyeongju', s: ['천년 고도에서의 일상', 'Daily life in an ancient capital'] },
  { slug: 'seoul', ko: '서울', en: 'Seoul', s: ['골목과 한옥 사이 로컬 라이프', 'Local life between alleys and hanok'] },
  { slug: 'chiangmai', ko: '치앙마이', en: 'Chiang Mai', s: ['노마드의 성지', 'A nomad haven'] },
  { slug: 'lisbon', ko: '리스본', en: 'Lisbon', s: ['유럽에서 한 달 살기', 'A month in Europe'] },
] as const;

interface Dest {
  slug: string;
  city: string;
  title: string;
  sub: string;
  cover: string;
  tags: string[];
}

export default function DiscoverView() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/content/destination', { query: { limit: 24 } });
  const rows = items(st.data);
  const list: Dest[] = rows.length
    ? rows.map((r: any) => {
        const slug = str(r, 'slug');
        const fb = FALLBACK.find((x) => x.slug === slug);
        // Canonical (English) city for search links — never the localized title ("강릉" would return nothing).
        const city = canonicalPlace(str(r, 'data.city') || fb?.en || str(r, 'title', 'name'));
        // CMS entries are authored per locale; in the other language fall back to the localized place name.
        const sameLocale = (str(r, 'locale') || 'ko-KR').toLowerCase().startsWith(lang);
        return {
          slug,
          city,
          title: sameLocale ? str(r, 'title', 'name') : placeLabel(city, lang),
          sub: sameLocale ? str(r, 'summary', 'subtitle') : fb ? fb.s[1] : '',
          cover: str(r, 'data.coverUrl', 'coverUrl', 'imageUrl', 'seo.og.image'),
          tags: sameLocale ? arr<string>(r, 'data.highlights').slice(0, 3) : [],
        };
      })
    : FALLBACK.map((f) => ({ slug: f.slug, city: f.en, title: pickText(f, lang), sub: pickPair(f.s, lang) ?? '', cover: '', tags: [] }));
  return (
    <>
      <PageHeader title={L('여행지 탐색', 'Discover destinations')} subtitle={L('JETPOOL 멤버들이 살아본 도시 이야기와 추천 숙소·가이드·투어를 모았어요.', 'City guides from members who lived there, with stays, guides and tours to match.')} />
      {st.loading && !st.data ? (
        <CardGridSkeleton n={6} />
      ) : (
        <HeadingLevel level={2}>
          <div className="grid">
            {list.map((d) => {
              const q = encodeURIComponent(d.city);
              return (
                <article key={d.slug || d.city} className="lcard">
                  <Link href={`/stay?q=${q}`} className={s.destCard} style={{ aspectRatio: '4 / 3' }} tabIndex={-1} aria-hidden="true">
                    <Photo src={d.cover || postcardFor(d.city || d.title, d.slug)} seed={d.slug || d.city} alt="" sizes="(max-width: 640px) 92vw, 360px" />
                    <span className={s.cap}>
                      <strong>{d.title}</strong>
                    </span>
                  </Link>
                  <div className="body" style={{ gap: 6 }}>
                    <h2 className="lcard-title">
                      <Link href={`/stay?q=${q}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                        {L(`${d.title} 숙소 보기`, `Stays in ${d.title}`)}
                      </Link>
                    </h2>
                    {d.sub && <p className="small muted" style={{ margin: 0 }}>{d.sub}</p>}
                    {d.tags.length > 0 && (
                      <div className="row" style={{ gap: 6 }}>
                        {d.tags.map((t) => (
                          <span key={t} className="badge">{t}</span>
                        ))}
                      </div>
                    )}
                    <div className="row small" style={{ gap: 14, marginTop: 4 }}>
                      <Link href={`/guide-friends?q=${q}`} className="row" style={{ gap: 4 }}>
                        <Icon name="compass" size={14} /> {L('가이드', 'Guides')}
                      </Link>
                      <Link href={`/travel?q=${q}`} className="row" style={{ gap: 4 }}>
                        <Icon name="ticket" size={14} /> {L('투어·티켓', 'Tours')}
                      </Link>
                      <Link href={`/exchange?q=${q}`} className="row" style={{ gap: 4 }}>
                        <Icon name="swap" size={14} /> {L('맞교환', 'Exchange')}
                      </Link>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        </HeadingLevel>
      )}
    </>
  );
}
