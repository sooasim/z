'use client';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { hashString } from '@/lib/art';
import { formatMoney } from '@/lib/format';
import { imgProps, personPhoto, useMediaMap } from '@/lib/media';
import { DateText } from './base';
import { StatusPill } from './status';

const AVATAR_BG = ['#1f4e7a', '#bf3f2a', '#2b6296', '#6d3fd6', '#166534', '#9a5800', '#0e2a47'];

/**
 * Initial/photo avatar. Exposed as one image to assistive tech ("홍길동, 본인 확인됨"); the verified tick is
 * decorative. `decorative` hides it entirely (when the name is already in adjacent text).
 *
 * Without an uploaded `src` the profile photo comes from the media map (`personId` / name → an openly-licensed real
 * portrait standing in for the demo persona, credited on /credits); only when the map has none is the initial shown.
 */
export function Avatar({ name, src, size = 40, verified, decorative, personId }: { name: string; src?: string; size?: number; verified?: boolean; decorative?: boolean; personId?: string }) {
  const { L } = useI18n();
  useMediaMap();
  const bg = AVATAR_BG[hashString(name || '?') % AVATAR_BG.length];
  const label = `${name || '?'}${verified ? `, ${L('본인 확인됨', 'verified')}` : ''}`;
  // An uploaded avatar (API URL, or a blob: preview of the file the user just picked) is rendered as it is; only the
  // portrait from the media map goes through imgProps, which adds the basePath and the 96/192/384 srcset.
  const portrait = src ? undefined : personPhoto(personId, name);
  const p = portrait ? imgProps(portrait, { sizes: `${size}px`, alt: '', placeholder: false }) : null;
  return (
    <span className="avatar" style={{ width: size, height: size, background: bg, fontSize: size * 0.42 }} {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label })}>
      {src ? <img src={src} alt="" /> : p ? <img src={p.src} srcSet={p.srcSet} sizes={p.sizes} alt="" /> : <span aria-hidden="true">{(name || '?').trim().slice(0, 1).toUpperCase()}</span>}
      {verified && (
        <span className="verified" title={L('본인 확인됨', 'Verified')} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="70%" height="70%" fill="none" stroke="#fff" strokeWidth="4" aria-hidden="true">
            <path d="M5 12.5 10 17 19 7" />
          </svg>
        </span>
      )}
    </span>
  );
}

export function RatingStars({ value, count, compact }: { value?: number; count?: number; compact?: boolean }) {
  const { L } = useI18n();
  if (value === undefined || value === null || Number.isNaN(value)) return <span className="rating muted">{L('신규', 'New')}</span>;
  const v = Math.max(0, Math.min(5, value));
  const label = `${L('평점', 'Rating')} ${v.toFixed(2)} / 5${count ? ` (${count})` : ''}`;
  if (compact)
    return (
      <span className="rating" aria-label={label}>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8L12 3.5Z" fill="currentColor" />
        </svg>
        {v.toFixed(2)}
        {count !== undefined && <span className="muted">({count})</span>}
      </span>
    );
  return (
    <span className="rating" aria-label={label}>
      <span className="stars" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((i) => {
          const fill = Math.max(0, Math.min(1, v - i));
          return (
            <svg key={i} viewBox="0 0 24 24">
              <defs>
                <linearGradient id={`rs${i}-${Math.round(v * 100)}`}>
                  <stop offset={fill} stopColor="var(--accent)" />
                  <stop offset={fill} stopColor="var(--surface-3)" />
                </linearGradient>
              </defs>
              <path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.8L12 3.5Z" fill={`url(#rs${i}-${Math.round(v * 100)})`} />
            </svg>
          );
        })}
      </span>
      {v.toFixed(1)}
      {count !== undefined && <span className="muted">({count})</span>}
    </span>
  );
}

export function Stepper({ steps, current, label }: { steps: string[]; current: number; label?: string }) {
  return (
    <ol className="stepper" aria-label={label ?? 'progress'}>
      {steps.map((s, i) => (
        <li key={s} className={i < current ? 'done' : i === current ? 'current' : ''} aria-current={i === current ? 'step' : undefined}>
          <span className="dot" aria-hidden="true">
            {i < current ? '✓' : i + 1}
          </span>
          <span>{s}</span>
        </li>
      ))}
    </ol>
  );
}

export interface TimelineEvent {
  status?: string;
  title?: ReactNode;
  at?: string;
  note?: ReactNode;
}
export function Timeline({ events }: { events: TimelineEvent[] }) {
  return (
    <ol className="timeline">
      {events.map((e, i) => (
        <li key={i}>
          <div className="row" style={{ gap: 8 }}>
            {e.status && <StatusPill status={e.status} />}
            {e.title && <strong className="small">{e.title}</strong>}
          </div>
          <div className="t-meta">
            {e.at && <DateText value={e.at} time />} {e.note && <> · {e.note}</>}
          </div>
        </li>
      ))}
    </ol>
  );
}

export interface PriceLine {
  label: string;
  amountMinor: number;
  hint?: string;
}
export function PriceBreakdown({ lines, totalMinor, currency = 'KRW', totalLabel, footnote }: { lines: PriceLine[]; totalMinor: number; currency?: string; totalLabel?: string; footnote?: ReactNode }) {
  const { L, lang } = useI18n();
  return (
    <div className="price-lines" aria-label={L('요금 상세', 'Price breakdown')}>
      {lines.map((l, i) => (
        <div key={i} className={`line ${l.amountMinor < 0 ? 'discount' : ''}`}>
          <span title={l.hint}>{l.label}</span>
          <span className="tnum">{formatMoney(l.amountMinor, currency, lang)}</span>
        </div>
      ))}
      <div className="line total">
        <span>{totalLabel ?? L('총액', 'Total')}</span>
        <span className="tnum">{formatMoney(totalMinor, currency, lang)}</span>
      </div>
      {footnote && <p className="xs muted" style={{ margin: 0 }}>{footnote}</p>}
    </div>
  );
}
