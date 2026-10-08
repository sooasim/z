'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { arr, str } from '@/lib/shape';
import { altFor, isDocLike, isSiteChrome, useMediaMap } from '@/lib/media';
import { Icon } from '@/components/ui';
import { LiteYouTube } from './LiteYouTube';
import { Masonry } from './Masonry';
import { markdownCover, markdownMedia, sameAsset } from './RichMarkdown';
import { legacyPageLabel } from './legacy-pages';
import s from './media.module.css';

/**
 * Hero / cover image of a CMS entry: the first of data.heroUrl → data.coverUrl → coverUrl → body images → gallery that
 * is a real photo (not a letter scan, poster or site-chrome icon, which are shown whole in the body instead).
 * Falls back to the declared hero when nothing better exists or the media map has not loaded yet.
 */
export function cmsHero(e: unknown): string {
  const declared = str(e, 'data.heroUrl', 'data.coverUrl', 'coverUrl', 'imageUrl');
  const body = markdownMedia(str(e, 'bodyMd', 'body')).images;
  const gallery = arr<any>(e, 'data.gallery').filter((x) => typeof x === 'string');
  const all = [declared, ...body, ...gallery].filter(Boolean);
  return all.find((u) => !isDocLike(u) && !isSiteChrome(u)) || declared || markdownCover(str(e, 'bodyMd', 'body')) || '';
}

/**
 * What a migrated CMS entry carries besides its body (data contract): YouTube embeds not already inline,
 * the rest of its gallery (images not already in the body / hero) and the wontc.co.kr source notice.
 */
export function CmsExtras({ e, hero, galleryTitle, headingLevel = 2, all }: { e: unknown; hero?: string; galleryTitle?: string; headingLevel?: 2 | 3; /** Keep site-chrome assets too (the brand archive shows everything). */ all?: boolean }) {
  const { L, lang } = useI18n();
  useMediaMap();
  const title = str(e, 'title');
  const body = str(e, 'bodyMd', 'body', 'content', 'markdown');
  const legacyUrl = str(e, 'data.legacyUrl');
  const inBody = markdownMedia(body);
  const embedIds = arr<any>(e, 'data.embeds')
    .map((x) => (typeof x === 'string' ? x : str(x, 'id')))
    .filter((id) => id && !inBody.videos.includes(id));
  const shown = [hero ?? '', ...inBody.images].filter(Boolean);
  const gallery = arr<any>(e, 'data.gallery')
    .map((x) => (typeof x === 'string' ? x : str(x, 'url', 'src')))
    // (the array parameter must not be named `all`: it would shadow the prop and keep site chrome everywhere)
    .filter((u, i, list) => u && list.indexOf(u) === i && !shown.some((v) => sameAsset(u, v)) && (all || !isSiteChrome(u)));
  const H = `h${headingLevel}` as 'h2' | 'h3';
  return (
    <>
      {embedIds.length > 0 && (
        <section className="section" aria-label={L('영상', 'Videos')}>
          <H>{L('영상', 'Videos')}</H>
          <div className={s.videoGrid}>
            {embedIds.map((id) => (
              <LiteYouTube key={id} id={id} />
            ))}
          </div>
        </section>
      )}
      {gallery.length > 0 && (
        <section className="section" aria-label={galleryTitle || L('사진', 'Photos')}>
          <H>{galleryTitle || L(`사진 더 보기 (${gallery.length})`, `More photos (${gallery.length})`)}</H>
          <Masonry label={L(`${title} 사진`, `${title} photos`)} items={gallery.map((u) => ({ src: u, alt: altFor(u) || title, caption: altFor(u) || title }))} />
        </section>
      )}
      {legacyUrl && (
        <aside className={s.source} aria-label={L('원본 정보', 'Source')}>
          <span>
            <Icon name="doc" size={14} /> {L('원본 페이지', 'Original page')}:{' '}
            <a href={legacyUrl} target="_blank" rel="noopener noreferrer">
              {legacyUrl}
            </a>{' '}
            ({legacyPageLabel(legacyUrl, lang)})
          </span>
          <span>{L('원여행클럽(WON TRAVEL CLUB) · 젯풀인터내셔날 소유 콘텐츠로, 소유자 승인 하에 JETPOOL로 이전했어요.', 'Content owned by WONT Travel Club / JETPOOL International, migrated with the owner’s permission.')}</span>
          <span>
            <Link href="/archive">{L('브랜드 아카이브', 'Brand archive')}</Link> · <Link href="/credits">{L('사진 출처·라이선스', 'Photo credits')}</Link>
          </span>
        </aside>
      )}
    </>
  );
}
