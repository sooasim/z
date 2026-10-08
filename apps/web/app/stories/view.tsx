'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { arr, items, str } from '@/lib/shape';
import { postcardFor } from '@/lib/art';
import { StateView, EmptyState } from '@/components/states';
import { ButtonLink, DateText, HeadingLevel, PageHeader } from '@/components/ui';
import { Photo, cmsHero, markdownExcerpt } from '@/components/media';
import { useMediaMap } from '@/lib/media';

export default function StoriesView() {
  const { L } = useI18n();
  useMediaMap();
  const st = useApi<any>('/v1/content/story', { query: { limit: 24 } });
  return (
    <>
      <PageHeader title={L('스토리', 'Stories')} subtitle={L('한달살기, 홈 맞교환, 로컬 라이프 — WONT Travel Club 시절부터 이어진 여행 이야기', 'Month stays, home exchanges and local life — stories since the WONT Travel Club days')} />
      <StateView
        state={st}
        skeleton="cards"
        isEmpty={(d) => items(d).length === 0}
        empty={
          <EmptyState illo="generic" title={L('곧 새로운 이야기가 올라와요', 'New stories coming soon')} action={<ButtonLink href="/stay" variant="primary">{L('숙소 둘러보기', 'Browse stays')}</ButtonLink>}>
            {L('멤버들의 한달살기·맞교환 이야기를 준비하고 있어요.', 'We are collecting stories from members’ month-long stays and exchanges.')}
          </EmptyState>
        }
      >
        {(d) => (
          <HeadingLevel level={2}>
            <div className="grid">
              {items(d).map((s: any) => {
                const slug = str(s, 'slug', 'id');
                const excerpt = str(s, 'summary', 'excerpt') || markdownExcerpt(str(s, 'bodyMd', 'body'), 80);
                const tags = arr<string>(s, 'data.tags').slice(0, 2);
                return (
                  <Link key={slug} href={`/stories/${slug}`} className="lcard" style={{ textDecoration: 'none' }}>
                    <div className="media" style={{ aspectRatio: '16 / 10' }}>
                      <Photo src={cmsHero(s) || postcardFor(str(s, 'title'), slug)} seed={slug} alt="" sizes="(max-width: 640px) 100vw, (max-width: 1100px) 50vw, 360px" style={{ width: '100%', height: '100%' }} />
                      {tags.length > 0 && (
                        <div className="badges">
                          {tags.map((t) => (
                            <span key={t} className="badge solid">{t}</span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="body" style={{ gap: 4 }}>
                      <h2 className="lcard-title" style={{ whiteSpace: 'normal' }}>{str(s, 'title')}</h2>
                      {excerpt && <p className="small muted" style={{ margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{excerpt}</p>}
                      <span className="xs subtle">
                        <DateText value={str(s, 'publishedAt', 'createdAt')} />
                      </span>
                    </div>
                  </Link>
                );
              })}
            </div>
          </HeadingLevel>
        )}
      </StateView>
    </>
  );
}
