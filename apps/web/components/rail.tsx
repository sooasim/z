'use client';
import Link from 'next/link';
import { useRef, type ReactNode } from 'react';
import { useApi } from '@/lib/hooks';
import { items } from '@/lib/shape';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/errors';
import { useAuth } from '@/lib/auth';
import { CardSkeleton } from './ui/skeleton';
import { HeadingLevel } from './ui/heading';
import { RailPager } from './rail-pager';

/** Horizontal scroll-snap discovery rail. Errors degrade to a quiet inline note so the home page never breaks. */
export function Rail({ title, subtitle, path, query, render, href, emptyText, fallback, requireAuth }: { title: string; subtitle?: string; path: string; query?: Record<string, any>; render: (row: any) => ReactNode; href?: string; emptyText?: string; fallback?: ReactNode; requireAuth?: boolean }) {
  const { L } = useI18n();
  const { ready, user } = useAuth();
  const skip = requireAuth && (!ready || !user);
  const st = useApi<any>(skip ? null : path, { query });
  const rows = items(st.data);
  const ref = useRef<HTMLDivElement>(null);
  return (
    <section className="section" aria-label={title}>
      <div className="rail-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {href && (
            <Link href={href} className="btn ghost sm">
              {L('전체 보기', 'See all')}
            </Link>
          )}
          {/* The pager measures the rail itself and hides when nothing overflows, so no row-count guess here. */}
          <RailPager target={ref} label={`${title} — ${L('목록 넘기기', 'Scroll list')}`} />
        </div>
      </div>
      {requireAuth && ready && !user ? (
        <div className="card flat row between" style={{ background: 'var(--surface-2)' }}>
          <span className="muted">{L('맞교환 가능한 집은 회원에게만 공개됩니다.', 'Exchange homes are visible to members only.')}</span>
          <Link className="btn primary sm" href={`/login?next=${encodeURIComponent(href ?? '/')}`}>{L('로그인하고 보기', 'Log in to view')}</Link>
        </div>
      ) : st.loading || skip ? (
        <div className="rail" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : st.error || rows.length === 0 ? (
        fallback ?? (
          <p className="muted small">
            {st.error instanceof ApiError && st.error.kind === 'disabled' ? L('곧 오픈 예정입니다.', 'Coming soon.') : st.error ? L('지금은 목록을 불러올 수 없어요.', 'This list is unavailable right now.') : emptyText ?? L('아직 등록된 항목이 없습니다.', 'Nothing listed yet.')}
          </p>
        )
      ) : (
        <HeadingLevel level={3}>
          <div className="rail has-pager" ref={ref} tabIndex={0} aria-label={`${title} — ${L('좌우로 스크롤', 'scroll horizontally')}`}>
            {rows.slice(0, 16).map((r, i) => (
              <div key={r.id ?? i}>{render(r)}</div>
            ))}
          </div>
        </HeadingLevel>
      )}
    </section>
  );
}
