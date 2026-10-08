'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { credit as creditOf, imgProps, useMediaMap } from '@/lib/media';
import { Icon } from '@/components/ui';
import s from './media.module.css';

export interface LightboxItem {
  src: string;
  alt?: string;
  caption?: ReactNode;
  /** In-app link for "where this image is used" (e.g. the migrated page). */
  href?: string;
  hrefLabel?: string;
}

/**
 * Full-screen photo viewer for large sets (archive: 273 images): one image at a time with srcset, keyboard
 * (←/→/Esc), swipe, focus trap and a caption with the source page and licence credit when the photo has one.
 */
export function PhotoLightbox({ items, index, onClose, title }: { items: LightboxItem[]; index: number; onClose: () => void; title?: string }) {
  const { L } = useI18n();
  useMediaMap();
  const [i, setI] = useState(index);
  const [mounted, setMounted] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const startX = useRef<number | null>(null);
  const n = items.length;
  const go = useCallback((d: number) => setI((x) => (x + d + n) % n), [n]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => setMounted(true), []);
  useEffect(() => setI(index), [index]);
  useEffect(() => {
    if (!mounted) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
      } else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else if (e.key === 'Tab') {
        const f = Array.from(ref.current?.querySelectorAll<HTMLElement>('a[href],button:not([disabled])') ?? []);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1].focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0].focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      if (prev && document.contains(prev)) prev.focus?.();
    };
  }, [mounted, go]);
  // Preload neighbours so arrowing through the archive feels instant.
  useEffect(() => {
    if (!mounted || n < 2) return;
    for (const k of [i + 1, i - 1]) {
      const it = items[(k + n) % n];
      if (!it) continue;
      const p = imgProps(it.src, { sizes: '100vw' });
      const img = new Image();
      if (p.srcSet) {
        img.sizes = '100vw';
        img.srcset = p.srcSet;
      }
      img.src = p.src;
    }
  }, [i, n, items, mounted]);
  if (!mounted || !n) return null;
  const it = items[Math.min(i, n - 1)];
  const p = imgProps(it.src, { sizes: '100vw', eager: true, placeholder: false });
  const c = creditOf(it.src);
  return createPortal(
    <div ref={ref} data-dialog-layer="" className={s.lb} role="dialog" aria-modal="true" aria-label={title ?? L('사진 보기', 'Photo viewer')}>
      <div className={s.lbBar}>
        <button type="button" className="btn ghost sm" style={{ color: "#fff" }} onClick={onClose} data-autofocus="">
          <Icon name="close" size={18} /> {L('닫기', 'Close')}
        </button>
        <span aria-live="polite" className="small">
          {i + 1} / {n}
        </span>
      </div>
      <div
        className={s.lbStage}
        onPointerDown={(e) => (startX.current = e.clientX)}
        onPointerUp={(e) => {
          if (startX.current === null) return;
          const dx = e.clientX - startX.current;
          startX.current = null;
          if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
        }}
      >
        {n > 1 && (
          <button type="button" className={`${s.lbArrow} ${s.prev}`} onClick={() => go(-1)} aria-label={L('이전 사진', 'Previous photo')}>
            <Icon name="left" size={22} />
          </button>
        )}
        <img key={p.src} src={p.src} srcSet={p.srcSet} sizes="100vw" alt={it.alt || ''} draggable={false} decoding="async" />
        {n > 1 && (
          <button type="button" className={`${s.lbArrow} ${s.next}`} onClick={() => go(1)} aria-label={L('다음 사진', 'Next photo')}>
            <Icon name="right" size={22} />
          </button>
        )}
      </div>
      <div className={s.lbCap}>
        {it.caption ? <strong>{it.caption}</strong> : it.alt ? <strong>{it.alt}</strong> : null}
        {it.href && (
          <Link href={it.href} onClick={onClose}>
            {it.hrefLabel || L('이 사진이 쓰인 페이지 보기', 'See where this photo is used')}
          </Link>
        )}
        {c && (
          <small>
            {c.title ? `“${c.title}” ` : ''}
            {c.creator ? `© ${c.creator}` : ''} {c.license ? `· ${c.license}` : ''}{' '}
            {c.landingUrl && (
              <a href={c.landingUrl} target="_blank" rel="noopener noreferrer">
                {L('원본', 'Source')}
              </a>
            )}
          </small>
        )}
      </div>
    </div>,
    document.body,
  );
}
