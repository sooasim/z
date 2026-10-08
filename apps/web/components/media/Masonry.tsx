'use client';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { Photo } from './Photo';
import { PhotoLightbox, type LightboxItem } from './Lightbox';
import s from './media.module.css';

export interface MasonryItem extends LightboxItem {
  /** Short text shown on hover (tile caption). */
  tileCaption?: string;
  badge?: ReactNode;
}

/**
 * Masonry photo grid (CSS columns — natural aspect ratios, no cropping) with a lightbox. Tiles are lazy-loaded
 * buttons with descriptive alt text, so the whole archive is keyboard- and screen-reader-navigable.
 */
export function Masonry({ items, label, sizes = '(max-width: 640px) 50vw, (max-width: 1100px) 33vw, 25vw' }: { items: MasonryItem[]; label: string; sizes?: string }) {
  const { L } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  return (
    <>
      <div className={s.masonry} role="list" aria-label={label}>
        {items.map((it, k) => (
          <div role="listitem" className={s.tileWrap} key={`${it.src}-${k}`}>
            <button type="button" className={s.tile} onClick={() => setOpen(k)} aria-label={`${it.alt || L('사진', 'Photo')} — ${L('크게 보기', 'view larger')}`}>
              <Photo src={it.src} alt={it.alt || ''} sizes={sizes} intrinsic />
              {it.badge && <span className={s.tileBadge}>{it.badge}</span>}
              {(it.tileCaption || it.alt) && (
                <span className={s.cap} aria-hidden="true">
                  {it.tileCaption || it.alt}
                </span>
              )}
            </button>
          </div>
        ))}
      </div>
      {open !== null && <PhotoLightbox items={items} index={open} onClose={() => setOpen(null)} title={label} />}
    </>
  );
}
