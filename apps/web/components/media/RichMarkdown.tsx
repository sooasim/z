'use client';
import Link from 'next/link';
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { altFor, isDocLike, useMediaMap } from '@/lib/media';
import { Photo } from './Photo';
import { LiteYouTube } from './LiteYouTube';
import { IMG, parseMarkdown, safeUrl, sameAsset, type MdBlock, type MdImage } from './markdown';
export { parseMarkdown, markdownMedia, markdownExcerpt, markdownCover, sameAsset, safeUrl, type MdBlock, type MdImage } from './markdown';
import { PhotoLightbox, type LightboxItem } from './Lightbox';
import s from './media.module.css';

// ------------------------------------------------------------------------------------------------ inline

const INLINE = new RegExp(
  [
    String.raw`\\([\\\`*_{}\[\]()#+\-.!<>|~])`, // 1 escape
    String.raw`\`([^\`]+)\``, // 2 code
    String.raw`\*\*(.+?)\*\*`, // 3 bold
    String.raw`__(.+?)__`, // 4 bold
    String.raw`\*(?!\s)(.+?)\*`, // 5 em
    IMG, // 6 alt, 7 src, 8 title
    String.raw`\[([^\]]+)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)`, // 9 label, 10 href
    String.raw`(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"’”])`, // 11 bare URL
  ].join('|'),
  'g',
);

function A({ href, children }: { href: string; children: ReactNode }) {
  if (href.startsWith('/') && !href.startsWith('//')) return <Link href={href}>{children}</Link>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

export function inline(text: string, key = 'i'): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  INLINE.lastIndex = 0;
  const re = new RegExp(INLINE.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const id = `${key}.${k++}`;
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(<code key={id}>{m[2]}</code>);
    else if (m[3] !== undefined || m[4] !== undefined) out.push(<strong key={id}>{inline(m[3] ?? m[4], id)}</strong>);
    else if (m[5] !== undefined) out.push(<em key={id}>{inline(m[5], id)}</em>);
    else if (m[7] !== undefined) out.push(safeUrl(m[7]) ? <Photo key={id} src={m[7]} alt={m[6] || ''} className={s.inlineImg} blur={false} /> : m[6]);
    else if (m[9] !== undefined) out.push(safeUrl(m[10]) ? <A key={id} href={m[10]}>{inline(m[9], id)}</A> : m[9]);
    else if (m[11] !== undefined) out.push(<A key={id} href={m[11]}>{m[11]}</A>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// ------------------------------------------------------------------------------------------------ renderer

/**
 * Safe Markdown renderer for migrated CMS pages and stories: real <Photo> images (srcset, placeholder, lazy),
 * click-to-zoom lightbox over every image in the body, lite YouTube embeds, and NO raw HTML injection.
 * `baseLevel` maps the body's top heading level to h2 (page has its own h1) without skipping levels.
 */
export function RichMarkdown({ source, compact, baseLevel = 2, dropTitle, omit, sizes = '(max-width: 820px) 100vw, 780px' }: { source: string; compact?: boolean; baseLevel?: 2 | 3; dropTitle?: string; /** Images shown elsewhere on the page (e.g. the hero). */ omit?: string[]; sizes?: string }) {
  const { L } = useI18n();
  useMediaMap();
  const omitKey = (omit ?? []).join('|');
  const blocks = useMemo(() => {
    const skip = omitKey ? omitKey.split('|') : [];
    return parseMarkdown(source, { dropTitle })
      .map((b) => (b.t === 'images' && skip.length ? { ...b, images: b.images.filter((img) => !skip.some((o) => sameAsset(o, img.src))) } : b))
      .filter((b) => b.t !== 'images' || b.images.length > 0);
  }, [source, dropTitle, omitKey]);
  const [open, setOpen] = useState<number | null>(null);
  const gallery: LightboxItem[] = useMemo(() => blocks.flatMap((b) => (b.t === 'images' ? b.images.map((i) => ({ src: i.src, alt: i.alt || i.title || '', caption: i.title || i.alt })) : [])), [blocks]);
  const minLevel = Math.min(6, ...blocks.filter((b): b is Extract<MdBlock, { t: 'h' }> => b.t === 'h').map((b) => b.level));
  const H = (level: number) => `h${Math.min(6, Math.max(baseLevel, level - minLevel + baseLevel))}` as 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
  let imgIndex = 0;
  return (
    <div className={`${s.md} ${compact ? s.compact : ''}`}>
      {blocks.map((b, i) => {
        switch (b.t) {
          case 'h': {
            const Tag = H(b.level);
            return <Tag key={i}>{inline(b.text, `h${i}`)}</Tag>;
          }
          case 'hr':
            return <hr key={i} />;
          case 'p':
            return (
              <p key={i} className={b.note ? s.note : undefined}>
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {inline(l, `p${i}.${j}`)}
                  </Fragment>
                ))}
              </p>
            );
          case 'ul':
          case 'ol': {
            const Tag = b.t;
            return (
              <Tag key={i}>
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `l${i}.${j}`)}</li>
                ))}
              </Tag>
            );
          }
          case 'quote':
            return (
              <blockquote key={i}>
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {inline(l, `q${i}.${j}`)}
                  </Fragment>
                ))}
              </blockquote>
            );
          case 'video':
            return <LiteYouTube key={i} id={b.id} title={b.title} thumb={b.thumb} caption={b.caption} />;
          case 'images': {
            const start = imgIndex;
            imgIndex += b.images.length;
            const one = (img: MdImage, k: number, single = b.images.length === 1) => {
              const alt = img.alt || altFor(img.src) || '';
              const pic = <Photo src={img.src} alt={alt} sizes={single ? sizes : '(max-width: 640px) 50vw, 390px'} intrinsic />;
              return (
                <figure key={k} className={s.figure} style={single ? undefined : { margin: '0 0 10px', breakInside: 'avoid' }}>
                  {img.href ? (
                    <A href={img.href}>{pic}</A>
                  ) : (
                    <button type="button" className={s.frame} onClick={() => setOpen(start + k)} aria-label={`${alt || L('사진', 'Photo')} — ${L('크게 보기', 'view larger')}`}>
                      {pic}
                    </button>
                  )}
                  {img.title && <figcaption>{img.title}</figcaption>}
                </figure>
              );
            };
            if (b.images.length === 1) return one(b.images[0], 0);
            // Photos pair up in two columns; letter scans / posters stay full width so they remain readable.
            const runs: Array<{ doc: boolean; items: Array<[MdImage, number]> }> = [];
            b.images.forEach((img, k) => {
              const doc = isDocLike(img.src);
              const last = runs[runs.length - 1];
              if (last && !doc && !last.doc) last.items.push([img, k]);
              else runs.push({ doc, items: [[img, k]] });
            });
            return (
              <Fragment key={i}>
                {runs.map((r, j) =>
                  r.items.length === 1 ? (
                    <Fragment key={j}>{one(r.items[0][0], r.items[0][1], true)}</Fragment>
                  ) : (
                    <div key={j} style={{ columns: '2 200px', columnGap: 10, margin: 'var(--sp-6) 0' }}>
                      {r.items.map(([img, k]) => one(img, k))}
                    </div>
                  ),
                )}
              </Fragment>
            );
          }
        }
      })}
      {open !== null && <PhotoLightbox items={gallery} index={open} onClose={() => setOpen(null)} />}
    </div>
  );
}
