'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { items, str } from '@/lib/shape';
import { postcardFor } from '@/lib/art';
import { StateView } from '@/components/states';
import { PageHeader } from '@/components/ui';

const FALLBACK = [
  { slug: 'jeju', ko: '제주', en: 'Jeju', s: ['오름과 바다 사이 한 달', 'A month between volcanic hills and sea'] },
  { slug: 'busan', ko: '부산', en: 'Busan', s: ['바다가 보이는 워케이션', 'Workation by the sea'] },
  { slug: 'gangneung', ko: '강릉', en: 'Gangneung', s: ['커피 거리와 솔숲', 'Coffee street and pine forests'] },
  { slug: 'gyeongju', ko: '경주', en: 'Gyeongju', s: ['천년 고도에서의 일상', 'Daily life in an ancient capital'] },
  { slug: 'chiangmai', ko: '치앙마이', en: 'Chiang Mai', s: ['노마드의 성지', 'A nomad haven'] },
  { slug: 'lisbon', ko: '리스본', en: 'Lisbon', s: ['유럽에서 한 달 살기', 'A month in Europe'] },
];

export default function DiscoverView() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/content/destination', { query: { limit: 24 } });
  const rows = items(st.data);
  const list = rows.length ? rows.map((r: any) => ({ slug: str(r, 'slug'), title: str(r, 'title', 'name'), sub: str(r, 'summary', 'subtitle'), cover: str(r, 'coverUrl', 'imageUrl') })) : FALLBACK.map((f) => ({ slug: f.slug, title: f[lang], sub: f.s[lang === 'ko' ? 0 : 1], cover: '' }));
  return (
    <>
      <PageHeader title={L('여행지 탐색', 'Discover destinations')} subtitle={L('JETPOOL 멤버들이 살아본 도시 이야기와 추천 숙소·가이드를 모았어요.', 'City guides from members who lived there, with stays and guides to match.')} />
      <StateView state={{ ...st, error: null, data: st.loading ? undefined : st.data ?? {} }} skeleton="cards">
        {() => (
          <div className="grid">
            {list.map((d) => (
              <Link key={d.slug} href={`/stay?q=${encodeURIComponent(d.title)}`} className="lcard" style={{ textDecoration: 'none' }}>
                <div className="media" style={{ aspectRatio: '4 / 3' }}>
                  <img src={d.cover || postcardFor(d.title, d.slug)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
                <div className="body">
                  <h3>{d.title}</h3>
                  <p className="meta">{d.sub}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </StateView>
    </>
  );
}
