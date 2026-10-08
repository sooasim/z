'use client';
import { useCallback, type CSSProperties, type ImgHTMLAttributes, type SyntheticEvent } from 'react';
import { imgProps, useMediaMap } from '@/lib/media';
import { realize } from '@/lib/art';
import s from './media.module.css';

export type PhotoProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src' | 'srcSet' | 'placeholder'> & {
  /** Public URL without basePath ('/photos/…', '/legacy/…'), an API URL, or a postcard (upgraded to a real photo). */
  src?: string | null;
  /** Seed for a stable pick when `src` is generated art. */
  seed?: string;
  sizes?: string;
  /** Above the fold: eager + high fetch priority. */
  eager?: boolean;
  fit?: CSSProperties['objectFit'];
  aspect?: CSSProperties['aspectRatio'];
  /** Blurred placeholder background while loading (default true). */
  blur?: boolean;
  /**
   * Emit the asset's intrinsic width/height attributes (reserves the aspect ratio before load). Only for images
   * laid out with `width: 100%; height: auto` (figures, masonry); cover-cropped images get their box from CSS.
   */
  intrinsic?: boolean;
};

/** Clears the blurred placeholder once the bitmap is decoded (transparent PNG logos must not show it through). */
function clearBg(el: HTMLImageElement) {
  el.style.backgroundImage = 'none';
}

/**
 * Responsive <img> for every real photo on the platform: basePath-aware src/srcset/sizes from public/media-map.json,
 * intrinsic size (no layout shift), lazy by default, colour + blurred placeholder while loading. Postcard / seed
 * placeholder art is upgraded to a real photo as soon as the media map has loaded.
 */
export function Photo({ src, seed, sizes, eager, fit = 'cover', aspect, blur = true, intrinsic, alt = '', style, className, onLoad, loading, ...rest }: PhotoProps) {
  useMediaMap();
  const url = realize(src || '', seed);
  const p = imgProps(url, { sizes, eager, placeholder: blur });
  const ref = useCallback((el: HTMLImageElement | null) => {
    if (el && el.complete && el.naturalWidth > 0) clearBg(el);
  }, []);
  if (!url) return <span aria-hidden="true" className={`${s.ph} ${className ?? ''}`} style={{ aspectRatio: aspect, ...style }} />;
  return (
    <img
      ref={ref}
      {...rest}
      src={p.src}
      srcSet={p.srcSet}
      sizes={p.sizes}
      width={rest.width ?? (intrinsic ? p.width : undefined)}
      height={rest.height ?? (intrinsic ? p.height : undefined)}
      alt={alt}
      loading={loading ?? p.loading}
      decoding="async"
      fetchPriority={eager ? 'high' : undefined}
      className={className}
      style={{ maxWidth: '100%', ...p.style, objectFit: fit, aspectRatio: aspect, ...style }}
      onLoad={(e: SyntheticEvent<HTMLImageElement>) => {
        clearBg(e.currentTarget);
        onLoad?.(e);
      }}
    />
  );
}
