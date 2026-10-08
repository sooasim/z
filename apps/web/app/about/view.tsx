'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { arr, items, str } from '@/lib/shape';
import { archive, assetId, embeds, entryFor, heroPhotos, isDocLike, isSiteChrome, photoPool, pick, useMediaMap } from '@/lib/media';
import { AutoHeading, ButtonLink, HeadingLevel, Icon } from '@/components/ui';
import { Breadcrumbs } from '@/components/public/Breadcrumbs';
import { LEGACY_PAGES, LiteYouTube, Photo, PhotoCredit, markdownCover, markdownExcerpt } from '@/components/media';
import s from '@/components/media/media.module.css';

/** Migrated wontc.co.kr pages (CMS PAGE slugs, data contract) grouped for the index. */
export const BRAND_SLUGS = ['about-jetpool', 'about-wontc', 'about-ceo', 'won-story'];
export const SERVICE_SLUGS = ['local-life', 'member-stay', 'jetpool-host', 'charter-platform', 'premium-lounge', 'tour-ticket', 'tour-consulting', 'customer-center'];
/** PAGE entries that are not standalone brand pages (home blocks, charter copy, the archive which has /archive). */
const HIDDEN = new Set(['wont-home', 'jetpool-charter', 'brand-archive']);

/** Same picture in another crop/size (the old site re-served photos at several sizes): same average colour + shape. */
function sameShot(a: string, b: string): boolean {
  const x = entryFor(a);
  const y = entryFor(b);
  if (!x?.colorAvg || !y?.colorAvg || !x.width || !x.height || !y.width || !y.height) return false;
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [p, q] = [rgb(x.colorAvg), rgb(y.colorAvg)];
  return p.every((v, i) => Math.abs(v - q[i]) <= 4) && Math.abs(x.width / x.height - y.width / y.height) < 0.05;
}

/** Cover for a CMS entry: data.heroUrl → coverUrl → first body image → first gallery image. */
export function entryCover(e: unknown): string {
  return entryCovers(e)[0] || '';
}
/** Every candidate cover of an entry, best first (lets an index avoid showing the same photo twice). */
export function entryCovers(e: unknown): string[] {
  const all = [...new Set([str(e, 'data.heroUrl'), str(e, 'data.coverUrl'), str(e, 'coverUrl'), markdownCover(str(e, 'bodyMd', 'body')) ?? '', ...arr<any>(e, 'data.gallery').filter((x) => typeof x === 'string')].filter(Boolean))];
  // real photos first; letter scans / posters / icons only if nothing else exists
  const good = all.filter((u) => !isDocLike(u) && !isSiteChrome(u));
  return [...good, ...all.filter((u) => !good.includes(u))];
}
/** Picks a distinct cover per entry across a list (first unused candidate; falls back to the first). */
export function distinctCovers(rows: unknown[], used = new Set<string>()): Map<unknown, string> {
  const out = new Map<unknown, string>();
  for (const e of rows) {
    const c = entryCovers(e);
    const pickd = c.find((u) => !used.has(assetId(u) ?? u)) ?? c[0] ?? '';
    if (pickd) used.add(assetId(pickd) ?? pickd);
    out.set(e, pickd);
  }
  return out;
}
export function entryExcerpt(e: unknown, n = 90): string {
  return str(e, 'summary') || markdownExcerpt(str(e, 'bodyMd', 'body'), n);
}

export function EntryCard({ href, title, summary, cover, seed }: { href: string; title: string; summary?: string; cover?: string; seed: string }) {
  useMediaMap();
  const src = cover || pick(heroPhotos().length ? heroPhotos() : photoPool(), seed) || '';
  return (
    <Link href={href} className={s.aboutCard}>
      <div className={s.media}>
        <Photo src={src} seed={seed} alt="" sizes="(max-width: 640px) 100vw, (max-width: 1100px) 50vw, 360px" />
      </div>
      <div className={s.body}>
        <AutoHeading>{title}</AutoHeading>
        {summary && <p>{summary}</p>}
      </div>
    </Link>
  );
}

function fallbackEntries(slugs: string[]) {
  const byRoute = new Map(Object.values(LEGACY_PAGES).map((p) => [p.route, p]));
  return slugs.map((slug) => ({ slug, title: byRoute.get(`/about/${slug}`)?.ko ?? slug, summary: '', data: {} }));
}

export default function AboutIndexView() {
  const { L, lang } = useI18n();
  useMediaMap();
  const pages = useApi<any>('/v1/content/page', { query: { limit: 50 } });
  const legacy = useApi<any>('/v1/content/legacy', { query: { limit: 50 } });
  const stories = useApi<any>('/v1/content/story', { query: { limit: 50 } });
  const pageRows = items(pages.data).filter((e: any) => !HIDDEN.has(str(e, 'slug')));
  const bySlug = new Map(pageRows.map((e: any) => [str(e, 'slug'), e]));
  const loaded = !pages.loading;
  const group = (slugs: string[]) => {
    const rows = slugs.map((x) => bySlug.get(x)).filter(Boolean);
    return rows.length || !loaded ? rows : fallbackEntries(slugs);
  };
  const brand = group(BRAND_SLUGS);
  const service = group(SERVICE_SLUGS);
  const known = new Set([...BRAND_SLUGS, ...SERVICE_SLUGS]);
  const morePages = pageRows.filter((e: any) => !known.has(str(e, 'slug')));
  const legacyRows = items(legacy.data);
  const letters = items(stories.data)
    .filter((e: any) => /^heart-letter-/.test(str(e, 'slug')))
    .sort((a: any, b: any) => str(a, 'slug').localeCompare(str(b, 'slug')));
  const hero = heroPhotos()[0];
  const arch = archive();
  const vids = embeds();
  const covers = distinctCovers([...brand, ...service, ...letters, ...morePages, ...legacyRows], new Set(hero ? [assetId(hero) ?? hero] : []));
  const card = (e: any, base = '/about/') => <EntryCard key={str(e, 'slug')} href={`${base}${str(e, 'slug')}`} title={str(e, 'title')} summary={entryExcerpt(e)} cover={covers.get(e) || entryCover(e)} seed={str(e, 'slug')} />;
  return (
    <>
      <Breadcrumbs items={[{ label: L('브랜드 이야기', 'Our story') }]} />
      <section className={s.pageHero} aria-labelledby="about-h">
        <Photo src={hero} alt="" eager sizes="(max-width: 1200px) 100vw, 1200px" />
        <PhotoCredit src={hero} />
        <div className={s.pageHeroBody}>
          <p className="eyebrow">WONT Travel Club → JETPOOL</p>
          <h1 id="about-h">{L('여행을 사는 사람들의 이야기', 'The people who live their travels')}</h1>
          <p>{L('1993년 해외여행 인솔자로 시작한 원치승 대표의 원여행클럽(WONT)이 한달살기 맞교환·전세기 공유 플랫폼 JETPOOL로 이어집니다. wontc.co.kr의 모든 글과 사진을 이곳으로 옮겼어요.', 'WONT Travel Club, founded by tour leader Michael Won, continues as JETPOOL — month-long home exchanges and charter sharing. Every page and photo from wontc.co.kr now lives here.')}</p>
        </div>
      </section>

      <HeadingLevel level={3}>
        <section className="section" aria-labelledby="about-brand">
          <h2 id="about-brand">{L('원여행클럽과 JETPOOL', 'WONT Travel Club & JETPOOL')}</h2>
          <div className={s.aboutGrid}>{brand.map((e) => card(e))}</div>
        </section>

        <section className="section" aria-labelledby="about-service">
          <h2 id="about-service">{L('서비스 이야기', 'What we do')}</h2>
          <div className={s.aboutGrid}>{service.map((e) => card(e))}</div>
        </section>

        {letters.length > 0 && (
          <section className="section" aria-labelledby="about-letters">
            <div className="rail-head">
              <div>
                <h2 id="about-letters">{L('마음편지', 'Heart letters')}</h2>
                <p>{L('IMF 시절부터 고객님께 띄운 원치승 대표의 편지 (통산 77호)', 'Letters to our travellers since the IMF crisis (77 issues)')}</p>
              </div>
              <Link href="/stories" className="btn ghost sm">
                {L('스토리 전체', 'All stories')}
              </Link>
            </div>
            <div className={s.aboutGrid}>{letters.map((e: any) => card(e, '/stories/'))}</div>
          </section>
        )}

        {vids.length > 0 && (
          <section className="section" aria-labelledby="about-videos">
            <h2 id="about-videos">{L('방송 속 원여행클럽', 'WONT on TV')}</h2>
            <div className={s.videoGrid}>
              {vids.map((v) => (
                <LiteYouTube key={v.id} id={v.id} title={v.title} thumb={v.thumb} date={v.dateText || v.date} />
              ))}
            </div>
          </section>
        )}

        <section className="section" aria-labelledby="about-archive">
          <div className="rail-head">
            <div>
              <h2 id="about-archive">{L('브랜드 아카이브', 'Brand archive')}</h2>
              <p>{L(`wontc.co.kr에서 옮겨 온 사진과 이미지 ${arch.length || 273}점 전부`, `All ${arch.length || 273} photos and images migrated from wontc.co.kr`)}</p>
            </div>
            <ButtonLink href="/archive" variant="primary" iconRight="right">
              {L('아카이브 열기', 'Open the archive')}
            </ButtonLink>
          </div>
          <Link href="/archive" aria-label={L('브랜드 아카이브 열기', 'Open the brand archive')} className={s.archiveStrip}>
            {/* Preview: photographs only (site chrome such as the popup-close icon, and letter scans, live in /archive). */}
            {/* …and one copy per picture (the old site served the same photo at several sizes). */}
            {arch
              .filter((a) => !isSiteChrome(a.url) && !isDocLike(a.url))
              .filter((a, i, list) => !list.slice(0, i).some((b) => sameShot(a.url, b.url)))
              .slice(0, 16)
              .map((a, i) => (
                <Photo key={a.url + i} src={a.url} alt="" aspect="1 / 1" sizes="160px" style={{ width: '100%', height: '100%', borderRadius: 'var(--r-sm)' }} />
              ))}
          </Link>
        </section>

        {(morePages.length > 0 || legacyRows.length > 0) && (
          <section className="section" aria-labelledby="about-more">
            <h2 id="about-more">{L('지난 여행 · 옛 홈페이지', 'Past tours & the old site')}</h2>
            <div className={s.aboutGrid}>
              {morePages.map((e: any) => card(e))}
              {legacyRows.map((e: any) => card(e, '/stories/'))}
            </div>
          </section>
        )}
      </HeadingLevel>

      <p className="small muted" style={{ marginTop: 'var(--sp-8)' }}>
        <Icon name="info" size={14} /> {L('원여행클럽(WONT) · 젯풀인터내셔날의 글과 사진은 소유자의 승인을 받아 이전했어요. 오픈 라이선스 사진의 출처는 ', 'WONT / JETPOOL International text and images were migrated with the owner’s permission. Openly-licensed photos are credited on the ')}
        <Link href="/credits">{L('사진 출처·라이선스', 'photo credits')}</Link>
        {lang === 'ko' ? ' 페이지에 있어요.' : ' page.'}
      </p>
    </>
  );
}
