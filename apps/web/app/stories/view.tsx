'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { items, str } from '@/lib/shape';
import { postcardFor } from '@/lib/art';
import { StateView, EmptyState } from '@/components/states';
import { DateText, PageHeader } from '@/components/ui';

export default function StoriesView() {
  const { L } = useI18n();
  const st = useApi<any>('/v1/content/story', { query: { limit: 24 } });
  return (
    <>
      <PageHeader title={L('스토리', 'Stories')} subtitle={L('한달살기, 홈 맞교환, 로컬 라이프 — WONT Travel Club 시절부터 이어진 여행 이야기', 'Month stays, home exchanges and local life — stories since the WONT Travel Club days')} />
      <StateView state={st} skeleton="cards" isEmpty={(d) => items(d).length === 0} empty={<EmptyState illo="generic" title={L('곧 새로운 이야기가 올라옵니다', 'New stories coming soon')} />}>
        {(d) => (
          <div className="grid">
            {items(d).map((s: any) => (
              <Link key={str(s, 'slug', 'id')} href={`/stories/${str(s, 'slug', 'id')}`} className="lcard" style={{ textDecoration: 'none' }}>
                <div className="media" style={{ aspectRatio: '16 / 10' }}>
                  <img src={str(s, 'coverUrl', 'imageUrl') || postcardFor(str(s, 'title'), str(s, 'slug'))} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
                <div className="body">
                  <h3>{str(s, 'title')}</h3>
                  <p className="meta">{str(s, 'summary', 'excerpt')}</p>
                  <span className="xs muted"><DateText value={str(s, 'publishedAt', 'createdAt')} /></span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </StateView>
    </>
  );
}
