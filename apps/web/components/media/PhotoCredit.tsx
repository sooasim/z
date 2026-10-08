'use client';
import { useI18n } from '@/lib/i18n';
import { credit, useMediaMap } from '@/lib/media';
import { realize } from '@/lib/art';
import s from './media.module.css';

/**
 * Tiny on-image attribution for an openly-licensed photo (CC BY / BY-SA need "reasonable" attribution near the
 * work): "© creator · CC BY 2.0" linking to the source. Renders nothing for owned (wontc.co.kr) or unknown images.
 * Every credited photo is also listed on /credits.
 */
export function PhotoCredit({ src, seed, className, style }: { src?: string | null; seed?: string; className?: string; style?: React.CSSProperties }) {
  const { L } = useI18n();
  useMediaMap();
  const c = credit(realize(src || '', seed));
  if (!c) return null;
  const text = [c.creator ? `© ${c.creator}` : '', c.license].filter(Boolean).join(' · ');
  if (!text) return null;
  const href = c.landingUrl || c.licenseUrl;
  return href ? (
    <a className={`${s.creditTag} ${className ?? ''}`} style={style} href={href} target="_blank" rel="noopener noreferrer" title={L(`사진: ${c.title ?? ''} ${text}`, `Photo: ${c.title ?? ''} ${text}`)}>
      {text}
    </a>
  ) : (
    <span className={`${s.creditTag} ${className ?? ''}`} style={style}>
      {text}
    </span>
  );
}
