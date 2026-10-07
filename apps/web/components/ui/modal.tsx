'use client';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useI18n } from '@/lib/i18n';
import { Icon } from './icons';

function useFocusTrap(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const focusables = () => Array.from(el?.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])') ?? []);
    (focusables()[0] ?? el)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        const f = focusables();
        if (!f.length) return;
        const first = f[0];
        const last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      prev?.focus?.();
    };
  }, [open, onClose]);
  return ref;
}

/** Accessible modal dialog; renders as a bottom sheet on small screens (`sheet`). */
export function Modal({ open, onClose, title, children, footer, wide, sheet = true }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; sheet?: boolean }) {
  const { L } = useI18n();
  const ref = useFocusTrap(open, onClose);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!open || !mounted) return null;
  return createPortal(
    <div className={`overlay ${sheet ? 'sheet-mobile' : ''}`} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined} tabIndex={-1}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn ghost icon sm" onClick={onClose} aria-label={L('닫기', 'Close')}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Full-screen photo viewer with keyboard (←/→/Esc) and thumbnails. */
export function Lightbox({ images, index, onClose, title }: { images: string[]; index: number; onClose: () => void; title?: string }) {
  const { L } = useI18n();
  const [i, setI] = useState(index);
  const ref = useFocusTrap(true, onClose);
  const go = useCallback((d: number) => setI((x) => (x + d + images.length) % images.length), [images.length]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, [go]);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;
  return createPortal(
    <div ref={ref} className="lightbox" role="dialog" aria-modal="true" aria-label={title ?? L('사진 보기', 'Photo viewer')} tabIndex={-1}>
      <div className="lb-bar">
        <button className="btn ghost sm" style={{ color: '#fff' }} onClick={onClose}>
          <Icon name="close" size={18} /> {L('닫기', 'Close')}
        </button>
        <span aria-live="polite" className="small">
          {i + 1} / {images.length}
        </span>
      </div>
      <div className="lb-stage">
        {images.length > 1 && (
          <button className="lb-arrow prev" onClick={() => go(-1)} aria-label={L('이전 사진', 'Previous')}>
            ‹
          </button>
        )}
        <img src={images[i]} alt={`${title ?? ''} ${i + 1}`} />
        {images.length > 1 && (
          <button className="lb-arrow next" onClick={() => go(1)} aria-label={L('다음 사진', 'Next')}>
            ›
          </button>
        )}
      </div>
      <div className="lb-thumbs">
        {images.map((src, k) => (
          <button key={k} aria-current={k === i} onClick={() => setI(k)} aria-label={`${k + 1}`}>
            <img src={src} alt="" />
          </button>
        ))}
      </div>
    </div>,
    document.body,
  );
}
