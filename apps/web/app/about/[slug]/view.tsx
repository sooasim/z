'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { arr, item, items, str } from '@/lib/shape';
import { ApiError } from '@/lib/errors';
import { altFor, useMediaMap } from '@/lib/media';
import { StateView, NotFoundState } from '@/components/states';
import { Alert, HeadingLevel, Icon } from '@/components/ui';
import { Breadcrumbs } from '@/components/public/Breadcrumbs';
import { CmsExtras, Photo, PhotoCredit, RichMarkdown, cmsHero } from '@/components/media';
import s from '@/components/media/media.module.css';
import { BRAND_SLUGS, EntryCard, SERVICE_SLUGS, entryCover, entryExcerpt } from '../view';

function Related({ current }: { current: string }) {
  const { L } = useI18n();
  useMediaMap();
  const st = useApi<any>('/v1/content/page', { query: { limit: 50 } });
  const order = [...BRAND_SLUGS, ...SERVICE_SLUGS];
  const rows = items(st.data)
    .filter((e: any) => order.includes(str(e, 'slug')) && str(e, 'slug') !== current)
    .sort((a: any, b: any) => order.indexOf(str(a, 'slug')) - order.indexOf(str(b, 'slug')));
  // rotate so each page suggests its neighbours, not always the first three
  const at = Math.max(0, order.indexOf(current));
  const next = [...rows.filter((e: any) => order.indexOf(str(e, 'slug')) > at), ...rows.filter((e: any) => order.indexOf(str(e, 'slug')) < at)].slice(0, 2);
  if (!next.length) return null;
  return (
    <section className="section" aria-labelledby="related-h">
      <div className="rail-head">
        <h2 id="related-h">{L('다른 이야기', 'More of our story')}</h2>
        <Link href="/about" className="btn ghost sm">
          {L('브랜드 이야기 전체', 'All brand pages')}
        </Link>
      </div>
      <HeadingLevel level={3}>
        <div className={s.aboutGrid}>
          {next.map((e: any) => (
            <EntryCard key={str(e, 'slug')} href={`/about/${str(e, 'slug')}`} title={str(e, 'title')} summary={entryExcerpt(e, 70)} cover={entryCover(e)} seed={str(e, 'slug')} />
          ))}
        </div>
      </HeadingLevel>
    </section>
  );
}

function Article({ e, slug }: { e: any; slug: string }) {
  const { L, lang } = useI18n();
  useMediaMap();
  const title = str(e, 'title');
  const summary = str(e, 'summary');
  const body = str(e, 'bodyMd', 'body', 'content', 'markdown');
  const hero = cmsHero(e);
  const isArchive = slug === 'brand-archive';
  const galleryCount = arr(e, 'data.gallery').length;
  const locale = (str(e, 'locale') || 'ko-KR').toLowerCase();
  return (
    <article className={isArchive ? s.wide : s.article}>
      <Breadcrumbs items={[{ href: '/about', label: L('브랜드 이야기', 'Our story') }, { label: title }]} />
      {hero ? (
        <header className={s.pageHero}>
          <Photo src={hero} alt={altFor(hero) || ''} eager sizes="(max-width: 820px) 100vw, 780px" />
          <PhotoCredit src={hero} />
          <div className={s.pageHeroBody}>
            <p className="eyebrow">WONT Travel Club · JETPOOL</p>
            <h1>{title}</h1>
            {summary && <p>{summary}</p>}
          </div>
        </header>
      ) : (
        <header className="page-head">
          <p className="eyebrow">WONT Travel Club · JETPOOL</p>
          <h1 style={{ margin: 0 }}>{title}</h1>
          {summary && <p className="sub" style={{ fontSize: 'var(--fs-lg)' }}>{summary}</p>}
        </header>
      )}
      {lang === 'en' && locale.startsWith('ko') && <Alert>This page is only available in Korean for now.</Alert>}
      {body ? <RichMarkdown source={body} dropTitle={title} omit={hero ? [hero] : undefined} /> : !galleryCount && <p className="muted">{L('본문이 아직 준비되지 않았어요.', 'This page has no text yet.')}</p>}
      {isArchive && (
        <p>
          <Link href="/archive" className="btn primary">
            {L('페이지별로 모아 보기', 'Browse by page')} <Icon name="right" size={16} />
          </Link>
        </p>
      )}
      <CmsExtras e={e} hero={hero} all={isArchive} galleryTitle={isArchive ? L(`전체 이미지 ${galleryCount}점`, `All ${galleryCount} images`) : undefined} />
      {!isArchive && <Related current={slug} />}
    </article>
  );
}

/** Migrated wontc.co.kr brand page: CMS PAGE by slug (LEGACY_CONTENT fallback) with images, gallery and videos. */
export default function AboutPageView() {
  const { slug } = useParams<{ slug: string }>();
  const { L } = useI18n();
  const page = useApi<any>(`/v1/content/page/${encodeURIComponent(slug)}`);
  const pageMissing = page.error instanceof ApiError && page.error.kind === 'not_found';
  const legacy = useApi<any>(pageMissing ? `/v1/content/legacy/${encodeURIComponent(slug)}` : null);
  const st = pageMissing ? legacy : page;
  if (pageMissing && legacy.error instanceof ApiError && legacy.error.kind === 'not_found')
    return <NotFoundState as="h1" title={L('페이지를 찾을 수 없어요', 'We can’t find that page')} body={L('주소가 바뀌었거나 아직 옮겨지지 않은 페이지예요.', 'It may have moved or has not been migrated yet.')} back={{ href: '/about', label: L('브랜드 이야기 보기', 'See our story') }} />;
  return (
    <StateView state={st} skeleton="detail">
      {(d) => <Article e={item(d)} slug={slug} />}
    </StateView>
  );
}
