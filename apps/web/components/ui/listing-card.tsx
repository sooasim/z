'use client';
import Link from 'next/link';
import { useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { formatMoney } from '@/lib/format';
import { RatingStars } from './display';
import { Icon } from './icons';
import { AutoHeading } from './heading';
import { Photo } from '@/components/media/Photo';

const FALLBACK_ART = ['/art/postcards/coast.svg', '/art/postcards/mountain.svg', '/art/postcards/city.svg'];
/** Card media is ~1 column on phones, 2–3 on tablets, 4 on desktop. */
const CARD_SIZES = '(max-width: 640px) 92vw, (max-width: 1100px) 46vw, 320px';

export interface CardBadge {
  label: string;
  tone?: 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'exchange' | 'solid';
}

/**
 * Image carousel with dots, swipe and arrow buttons (arrows appear on hover / focus). Images render through <Photo>:
 * srcset + sizes, blurred placeholder, basePath-aware, and generated postcard art upgrades to a real photo.
 */
export function Carousel({ images, alt }: { images: string[]; alt: string }) {
  const { L } = useI18n();
  const [i, setI] = useState(0);
  const startX = useRef<number | null>(null);
  const n = images.length;
  const go = (d: number, e?: React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    setI((x) => Math.max(0, Math.min(n - 1, x + d)));
  };
  return (
    <>
      <div
        className="track"
        style={{ transform: `translateX(-${i * 100}%)` }}
        onPointerDown={(e) => (startX.current = e.clientX)}
        onPointerUp={(e) => {
          if (startX.current === null) return;
          const dx = e.clientX - startX.current;
          startX.current = null;
          if (Math.abs(dx) > 40) setI((x) => Math.max(0, Math.min(n - 1, x + (dx < 0 ? 1 : -1))));
        }}
      >
        {images.map((src, k) => (
          <Photo
            key={k}
            src={src}
            seed={`${alt}:${k}`}
            sizes={CARD_SIZES}
            alt={k === i ? alt : ''}
            data-on={k === i ? 'true' : undefined}
            aria-hidden={k === i ? undefined : true}
            loading={k === 0 ? 'eager' : 'lazy'}
            draggable={false}
            onError={(e) => {
              const el = e.currentTarget;
              if (!el.dataset.fallback) {
                el.dataset.fallback = '1';
                el.removeAttribute('srcset');
                el.src = FALLBACK_ART[k % FALLBACK_ART.length];
              }
            }}
          />
        ))}
      </div>
      {n > 1 && (
        <>
          {i > 0 && (
            <button type="button" className="nav-btn prev" onClick={(e) => go(-1, e)} aria-label={L('이전 사진', 'Previous photo')}>
              <Icon name="left" size={16} strokeWidth={2.4} />
            </button>
          )}
          {i < n - 1 && (
            <button type="button" className="nav-btn next" onClick={(e) => go(1, e)} aria-label={L('다음 사진', 'Next photo')}>
              <Icon name="right" size={16} strokeWidth={2.4} />
            </button>
          )}
          <div className="dots" aria-hidden="true">
            {images.slice(0, 5).map((_, k) => (
              <span key={k} data-on={k === Math.min(i, 4)} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

export function ListingCard({
  href,
  images,
  title,
  meta,
  rating,
  reviewCount,
  priceMinor,
  currency = 'KRW',
  priceSuffix,
  priceNote,
  badges = [],
  fav,
  active,
  onHover,
  topRight,
}: {
  href: string;
  images: string[];
  title: string;
  meta?: ReactNode;
  rating?: number;
  reviewCount?: number;
  priceMinor?: number;
  currency?: string;
  priceSuffix?: string;
  priceNote?: ReactNode;
  badges?: CardBadge[];
  fav?: ReactNode;
  active?: boolean;
  onHover?: (on: boolean) => void;
  topRight?: ReactNode;
}) {
  const { lang } = useI18n();
  return (
    // minmax(0, 1fr): the photo track (one 100%-wide slide per image) must never widen the card's column.
    <article className="lcard" style={{ gridTemplateColumns: 'minmax(0, 1fr)' }} data-active={active ? 'true' : undefined} onMouseEnter={() => onHover?.(true)} onMouseLeave={() => onHover?.(false)} onFocus={() => onHover?.(true)} onBlur={() => onHover?.(false)}>
      <div className="media">
        <Carousel images={images} alt={title} />
        <Link href={href} tabIndex={-1} aria-hidden="true" style={{ position: 'absolute', inset: 0, zIndex: 1 }} />
        {badges.length > 0 && (
          <div className="badges">
            {badges.slice(0, 2).map((b) => (
              <span key={b.label} className="badge solid">
                {b.tone === 'exchange' ? <Icon name="swap" size={13} /> : b.tone === 'ok' ? <Icon name="check" size={13} /> : null}
                {b.label}
              </span>
            ))}
          </div>
        )}
        <div className="fav">{fav ?? topRight}</div>
      </div>
      <Link href={href} className="body" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div className="title-row">
          <AutoHeading className="lcard-title">{title}</AutoHeading>
          {(rating !== undefined || reviewCount !== undefined) && <RatingStars value={rating} count={reviewCount || undefined} compact />}
        </div>
        {meta && <p className="meta">{meta}</p>}
        {priceMinor !== undefined ? (
          <p className="price" style={{ margin: '4px 0 0' }}>
            <strong className="tnum">{formatMoney(priceMinor, currency, lang)}</strong> {priceSuffix && <span className="muted">{priceSuffix}</span>}
          </p>
        ) : (
          priceNote && <p className="price" style={{ margin: '4px 0 0' }}>{priceNote}</p>
        )}
        <span className="sr-only">{title}</span>
      </Link>
    </article>
  );
}
