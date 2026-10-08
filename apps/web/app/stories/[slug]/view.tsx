'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { arr, item, items, str } from '@/lib/shape';
import { postcardFor } from '@/lib/art';
import { ApiError } from '@/lib/errors';
import { canonicalPlace, findPlace, placeLabel } from '@/lib/places';
import { StateView, NotFoundState } from '@/components/states';
import { Alert, ButtonLink, DateText, HeadingLevel, Icon } from '@/components/ui';
import { Breadcrumbs } from '@/components/public/Breadcrumbs';
import { Markdown } from '@/components/public/Markdown';
import { mdExcerpt } from '@/components/public/labels';

function MoreStories({ current }: { current: string }) {
  const { L } = useI18n();
  const st = useApi<any>('/v1/content/story', { query: { limit: 6 } });
  const rows = items(st.data).filter((s: any) => str(s, 'slug') !== current).slice(0, 3);
  if (!rows.length) return null;
  return (
    <section className="section" aria-labelledby="more-h">
      <h2 id="more-h">{L('다른 이야기', 'More stories')}</h2>
      <HeadingLevel level={3}>
        <div className="grid">
          {rows.map((s: any) => {
            const slug = str(s, 'slug');
            return (
              <Link key={slug} href={`/stories/${slug}`} className="lcard" style={{ textDecoration: 'none' }}>
                <div className="media" style={{ aspectRatio: '16 / 10' }}>
                  <img src={str(s, 'data.coverUrl', 'coverUrl') || postcardFor(str(s, 'title'), slug)} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                </div>
                <div className="body">
                  <h3 className="lcard-title" style={{ whiteSpace: 'normal' }}>{str(s, 'title')}</h3>
                  <p className="small muted" style={{ margin: 0 }}>{str(s, 'summary') || mdExcerpt(str(s, 'bodyMd'), 60)}</p>
                </div>
              </Link>
            );
          })}
        </div>
      </HeadingLevel>
    </section>
  );
}

/** CMS story. Markdown is rendered by a small safe renderer (no raw HTML injection). */
export default function StoryView() {
  const { slug } = useParams<{ slug: string }>();
  const { L, lang } = useI18n();
  const st = useApi<any>(`/v1/content/story/${encodeURIComponent(slug)}`);
  if (st.error instanceof ApiError && st.error.kind === 'not_found')
    return <NotFoundState as="h1" title={L('스토리를 찾을 수 없어요', 'We can’t find that story')} body={L('글이 내려갔거나 주소가 바뀌었을 수 있어요.', 'It may have been unpublished or moved.')} back={{ href: '/stories', label: L('다른 스토리 읽기', 'Read other stories') }} />;
  return (
    <StateView state={st} skeleton="detail">
      {(d) => {
        const s = item(d);
        const title = str(s, 'title');
        const body = str(s, 'bodyMd', 'body', 'content', 'markdown', 'text');
        const tags = arr<string>(s, 'data.tags');
        const place = tags.map((t) => findPlace(t)).find(Boolean);
        const locale = (str(s, 'locale') || 'ko-KR').toLowerCase();
        return (
          <article style={{ maxWidth: 760, margin: '0 auto' }}>
            <Breadcrumbs items={[{ href: '/stories', label: L('스토리', 'Stories') }, { label: title }]} />
            <header className="page-head">
              {tags.length > 0 && (
                <div className="row" style={{ gap: 6, marginBottom: 10 }}>
                  {tags.map((t) => (
                    <span key={t} className="badge accent">{t}</span>
                  ))}
                </div>
              )}
              <h1 style={{ margin: 0 }}>{title}</h1>
              {str(s, 'summary') && <p className="sub" style={{ fontSize: 'var(--fs-lg)' }}>{str(s, 'summary')}</p>}
              <p className="small subtle" style={{ margin: '8px 0 0' }}>
                <DateText value={str(s, 'publishedAt', 'createdAt')} />
              </p>
            </header>
            {lang === 'en' && locale.startsWith('ko') && <Alert>This story is only available in Korean for now.</Alert>}
            <img src={str(s, 'data.coverUrl', 'coverUrl') || postcardFor(title, slug)} alt="" style={{ width: '100%', borderRadius: 'var(--r-xl)', aspectRatio: '16 / 9', objectFit: 'cover', margin: '24px 0' }} />
            {body ? <Markdown source={body} /> : <p className="muted">{L('본문이 아직 준비되지 않았어요.', 'The full story is not available yet.')}</p>}
            {place && (
              <div className="card flat row between" style={{ background: 'var(--surface-2)', marginTop: 'var(--sp-8)' }}>
                <span>
                  <strong>{L(`${placeLabel(place.en, 'ko')}에서 한 달 살아보기`, `Spend a month in ${place.en}`)}</strong>
                  <span className="small muted" style={{ display: 'block' }}>{L('이 이야기 속 동네의 숙소와 맞교환 집을 찾아보세요.', 'Find stays and exchange homes in this neighbourhood.')}</span>
                </span>
                <ButtonLink href={`/stay?q=${encodeURIComponent(canonicalPlace(place.en))}`} variant="primary" iconRight="right">
                  {L('숙소 보기', 'See stays')}
                </ButtonLink>
              </div>
            )}
            <p style={{ marginTop: 'var(--sp-8)' }}>
              <Link href="/stories" className="row" style={{ gap: 6 }}>
                <Icon name="left" size={16} /> {L('스토리 목록으로', 'All stories')}
              </Link>
            </p>
            <MoreStories current={slug} />
          </article>
        );
      }}
    </StateView>
  );
}
