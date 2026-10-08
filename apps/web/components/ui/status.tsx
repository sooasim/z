'use client';
import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { enumLabel, humanizeEnum } from '@/lib/enums';

import { STATES, type Tone } from '@/lib/statuses';

export { STATES };
export type { Tone };

export function statusTone(status: string): Tone {
  return STATES[(status || '').toUpperCase()]?.[0] ?? 'neutral';
}

/** Localized label for a status value (falls back to a humanized enum, never the raw SNAKE_CASE). */
export function statusLabel(status: string | null | undefined, lang: 'ko' | 'en' = 'ko', labels?: Record<string, string | [string, string]>): string {
  if (!status) return '—';
  const s = String(status).toUpperCase();
  const o = labels?.[s] ?? labels?.[String(status)];
  if (o) return Array.isArray(o) ? o[lang === 'ko' ? 0 : 1] : o;
  const def = STATES[s];
  return def ? (lang === 'ko' ? def[1] : def[2]) : humanizeEnum(s, lang);
}

/**
 * Status pill. `labels` overrides wording per perspective, e.g. `{ OFFERED: ['제안 보냄', 'Offer sent'] }` on the
 * guide side. An empty status renders a muted dash (no pill).
 */
export function StatusPill({ status, live, labels, tone }: { status: string | undefined | null; live?: boolean; labels?: Record<string, string | [string, string]>; tone?: Tone }) {
  const { lang } = useI18n();
  if (!status)
    return (
      <span className="pill-empty" aria-label={lang === 'ko' ? '상태 없음' : 'No status'}>
        —
      </span>
    );
  const s = String(status).toUpperCase();
  const def = STATES[s];
  return <span className={`pill ${tone ?? def?.[0] ?? 'neutral'} ${live ? 'live' : ''}`}>{statusLabel(status, lang, labels)}</span>;
}

/** Localized text for a non-status enum / action key (RESERVATION → 숙소 예약, auth.login → 로그인). */
export function EnumText({ value, fallback }: { value: unknown; fallback?: ReactNode }) {
  const { lang } = useI18n();
  if (value === null || value === undefined || value === '') return <>{fallback ?? '—'}</>;
  return <>{enumLabel(value, lang)}</>;
}

export function Badge({ tone, children, icon }: { tone?: 'ok' | 'warn' | 'danger' | 'info' | 'accent' | 'exchange' | 'solid'; children: ReactNode; icon?: ReactNode }) {
  return (
    <span className={`badge ${tone ?? ''}`}>
      {icon}
      {children}
    </span>
  );
}
