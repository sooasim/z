'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { arr, item, items, str } from '@/lib/shape';
import { altFor, archive, mediaReady, useMediaMap, type ArchiveItem } from '@/lib/media';
import { CardGridSkeleton, Icon } from '@/components/ui';
import { EmptyState } from '@/components/states';
import { Breadcrumbs } from '@/components/public/Breadcrumbs';
import { useUrlSync } from '@/components/public/hooks';
import { LEGACY_PAGES, Masonry, legacyPageKey, legacyPageLabel, legacyPageRoute, type MasonryItem } from '@/components/media';
import s from '@/components/media/media.module.css';

type Group = 'brand' | 'service' | 'letter' | 'tour' | 'site';
const GROUPS: Array<{ id: Group; ko: string; en: string }> = [
  { id: 'brand', ko: '브랜드', en: 'Brand' },
  { id: 'service', ko: '서비스', en: 'Services' },
  { id: 'letter', ko: '마음편지', en: 'Heart letters' },
  { id: 'tour', ko: '지난 여행', en: 'Past tours' },
  { id: 'site', ko: '홈·기타', en: 'Home & other' },
];
const groupOf = (legacyPath: string): Group => LEGACY_PAGES[legacyPageKey(legacyPath)]?.group ?? 'site';
/** Filter key: the original wontc.co.kr path, else the platform page it lives on now. */
const keyOf = (a: ArchiveItem) => legacyPageKey(a.legacyPath || '') || a.page || '';

/** legacy path → platform route, from CMS entries that carry data.legacyUrl (PAGE / LEGACY_CONTENT / STORY). */
function useCmsRoutes() {
  const pages = useApi<any>('/v1/content/page', { query: { limit: 50 } });
  const legacy = useApi<any>('/v1/content/legacy', { query: { limit: 50 } });
  const stories = useApi<any>('/v1/content/story', { query: { limit: 50 } });
  return useMemo(() => {
    const m = new Map<string, string>();
    const add = (rows: any[], base: string) => {
      for (const e of rows) {
        const key = legacyPageKey(str(e, 'data.legacyUrl'));
        if (key && !m.has(key)) m.set(key, `${base}${str(e, 'slug')}`);
      }
    };
    add(items(pages.data), '/about/');
    add(items(legacy.data), '/about/');
    add(items(stories.data), '/stories/');
    return m;
  }, [pages.data, legacy.data, stories.data]);
}

/** Every migrated wontc.co.kr image (all 273, nothing filtered out by default) in a masonry grid with a lightbox. */
export default function ArchiveView() {
  const { L, lang } = useI18n();
  const sp = useSearchParams();
  const map = useMediaMap();
  const cms = useApi<any>('/v1/content/page/brand-archive');
  const intro = item(cms.data);
  const routes = useCmsRoutes();
  const [group, setGroup] = useState<Group | ''>((sp.get('group') as Group) || '');
  const [page, setPage] = useState(sp.get('page') ?? '');
  useUrlSync({ group: group || undefined, page: page || undefined });

  const all: ArchiveItem[] = useMemo(() => {
    const fromMap = archive();
    if (fromMap.length) return fromMap;
    // map not available: the CMS 'brand-archive' PAGE lists every legacy image in data.gallery
    return arr<any>(intro, 'data.gallery')
      .map((u) => (typeof u === 'string' ? { url: u } : { url: str(u, 'url', 'src'), alt: str(u, 'alt'), page: str(u, 'page'), pageTitle: str(u, 'pageTitle'), legacyPath: str(u, 'legacyPath') }))
      .filter((x) => x.url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, intro]);

  /** filter key → { label, route, count } */
  const pages = useMemo(() => {
    const c = new Map<string, { n: number; title: string; route?: string; legacy: string }>();
    for (const a of all) {
      const k = keyOf(a);
      const cur = c.get(k);
      if (cur) cur.n++;
      else c.set(k, { n: 1, title: a.pageTitle || '', route: a.page || undefined, legacy: legacyPageKey(a.legacyPath || '') });
    }
    return [...c.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [all]);
  const info = new Map(pages);
  const labelOf = (k: string) => (lang === 'ko' && info.get(k)?.title) || legacyPageLabel(info.get(k)?.legacy || k, lang);
  const routeOf = (k: string) => info.get(k)?.route || legacyPageRoute(info.get(k)?.legacy || k, routes);
  const groupOfKey = (k: string) => groupOf(info.get(k)?.legacy || k);
  const groupCounts = useMemo(() => {
    const c = new Map<Group, number>();
    for (const a of all) c.set(groupOf(a.legacyPath || ''), (c.get(groupOf(a.legacyPath || '')) ?? 0) + 1);
    return c;
  }, [all]);
  const visiblePages = pages.filter(([k]) => !group || groupOfKey(k) === group);
  const shown = all.filter((a) => (!group || groupOf(a.legacyPath || '') === group) && (!page || keyOf(a) === page));
  const tiles: MasonryItem[] = shown.map((a) => {
    const key = keyOf(a);
    const label = labelOf(key);
    const alt = a.alt || altFor(a.url) || a.captionKo || label;
    const href = routeOf(key);
    return {
      src: a.url,
      alt,
      caption: (
        <>
          {a.captionKo || alt}
          <span style={{ display: 'block', fontWeight: 400, color: '#a6b5c7', marginTop: 2 }}>
            {L('원래 페이지', 'From')}: {label}
          </span>
        </>
      ),
      tileCaption: a.captionKo || alt,
      href,
      hrefLabel: href ? L(`‘${label}’ 페이지에서 보기`, `See it on “${label}”`) : undefined,
    };
  });
  const loading = !mediaReady() && !all.length;

  return (
    <div className={s.wide}>
      <Breadcrumbs items={[{ href: '/about', label: L('브랜드 이야기', 'Our story') }, { label: L('브랜드 아카이브', 'Brand archive') }]} />
      <header className="page-head">
        <p className="eyebrow">WONT Travel Club · wontc.co.kr</p>
        <h1 style={{ margin: 0 }}>{str(intro, 'title') || L('브랜드 아카이브', 'Brand archive')}</h1>
        <p className="sub">
          {str(intro, 'summary') ||
            L(
              `원여행클럽 홈페이지(wontc.co.kr)에 있던 사진과 이미지 ${all.length || 273}점을 하나도 빠짐없이 옮겼어요. 페이지별로 골라 보고, 눌러서 크게 볼 수 있어요.`,
              `All ${all.length || 273} photos and images from the WONT Travel Club website (wontc.co.kr), none left behind. Filter by page and tap to enlarge.`,
            )}
        </p>
      </header>

      <div role="group" aria-label={L('구분', 'Section')} className={s.filters}>
        <button type="button" className="chip" aria-pressed={!group && !page} onClick={() => (setGroup(''), setPage(''))}>
          {L('전체', 'All')} <span className={s.n}>{all.length}</span>
        </button>
        {GROUPS.filter((g) => groupCounts.get(g.id)).map((g) => (
          <button key={g.id} type="button" className="chip" aria-pressed={group === g.id} onClick={() => (setGroup(group === g.id ? '' : g.id), setPage(''))}>
            {g[lang]} <span className={s.n}>{groupCounts.get(g.id)}</span>
          </button>
        ))}
      </div>
      {visiblePages.length > 1 && (
        <div role="group" aria-label={L('원래 페이지', 'Original page')} className={s.filters}>
          {visiblePages.map(([p, v]) => (
            <button key={p || 'other'} type="button" className="chip" aria-pressed={page === p && !!p} onClick={() => setPage(page === p ? '' : p)}>
              {labelOf(p)} <span className={s.n}>{v.n}</span>
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <CardGridSkeleton n={8} />
      ) : tiles.length === 0 ? (
        <EmptyState illo="search" title={L('이미지가 없어요', 'No images')}>
          {L('다른 페이지를 골라 보세요.', 'Pick another page.')}
        </EmptyState>
      ) : (
        <>
          <p className={s.count} aria-live="polite">
            {L(`${tiles.length}점`, `${tiles.length} images`)}
            {page && (
              <>
                {' · '}
                {routeOf(page) ? <Link href={routeOf(page)!}>{L(`‘${labelOf(page)}’ 페이지 열기`, `Open “${labelOf(page)}”`)}</Link> : labelOf(page)}
              </>
            )}
          </p>
          <Masonry items={tiles} label={L('브랜드 아카이브 이미지', 'Brand archive images')} />
        </>
      )}

      <p className="small muted" style={{ marginTop: 'var(--sp-8)' }}>
        <Icon name="info" size={14} /> {L('모든 이미지는 원여행클럽(WON TRAVEL CLUB) · 젯풀인터내셔날 소유이며, 소유자 승인 하에 JETPOOL로 이전했어요.', 'All images belong to WONT Travel Club / JETPOOL International and were migrated with the owner’s permission.')}{' '}
        <Link href="/credits">{L('사진 출처·라이선스', 'Photo credits')}</Link>
      </p>
    </div>
  );
}
