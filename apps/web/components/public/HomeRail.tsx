'use client';
import Link from 'next/link';
import { useRef, type ReactNode } from 'react';
import { useApi } from '@/lib/hooks';
import { items } from '@/lib/shape';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/errors';
import { CardSkeleton, HeadingLevel, Icon, type IconName } from '@/components/ui';
import s from './public.module.css';

export interface Promo {
  icon: IconName;
  title: string;
  body: string;
  cta: { href: string; label: string };
}

/** Prev/next buttons for a horizontal `.rail` (desktop only, like the shared Rail). */
export function RailNav({ target, label }: { target: React.RefObject<HTMLDivElement | null>; label?: string }) {
  const { L } = useI18n();
  const scroll = (d: number) => target.current?.scrollBy({ left: d * target.current.clientWidth * 0.9, behavior: 'smooth' });
  return (
    <div className="rail-nav" role="group" aria-label={label ?? L('목록 넘기기', 'Scroll list')}>
      <button type="button" className="btn icon sm" onClick={() => scroll(-1)} aria-label={L('이전', 'Previous')}>
        <Icon name="left" size={16} />
      </button>
      <button type="button" className="btn icon sm" onClick={() => scroll(1)} aria-label={L('다음', 'Next')}>
        <Icon name="right" size={16} />
      </button>
    </div>
  );
}

/**
 * Discovery rail like components/rail.tsx, but a short result (fewer than 3 items) becomes a grid with a promotional
 * filler card instead of a mostly empty row with a lonely "전체 보기".
 */
export function HomeRail({ title, subtitle, path, query, render, href, promo }: { title: string; subtitle?: string; path: string; query?: Record<string, any>; render: (row: any) => ReactNode; href?: string; promo: Promo }) {
  const { L } = useI18n();
  const st = useApi<any>(path, { query });
  const rows = items(st.data);
  const ref = useRef<HTMLDivElement>(null);
  const short = !st.loading && !st.error && rows.length < 3;
  const promoCard = (
    <article className={s.promo}>
      <span className={s.ico} aria-hidden="true">
        <Icon name={promo.icon} size={22} />
      </span>
      <h3>{promo.title}</h3>
      <p>{promo.body}</p>
      <Link className="btn primary" href={promo.cta.href}>
        {promo.cta.label}
      </Link>
    </article>
  );
  return (
    <section className="section" aria-label={title}>
      <div className="rail-head">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {href && rows.length > 0 && (
            <Link href={href} className="btn ghost sm">
              {L('전체 보기', 'See all')}
            </Link>
          )}
          {rows.length > 4 && <RailNav target={ref} />}
        </div>
      </div>
      {st.loading ? (
        <div className="rail" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <CardSkeleton key={i} />
          ))}
        </div>
      ) : st.error ? (
        <p className="muted small">{st.error instanceof ApiError && st.error.kind === 'disabled' ? L('곧 오픈 예정입니다.', 'Coming soon.') : L('지금은 목록을 불러올 수 없어요.', 'This list is unavailable right now.')}</p>
      ) : (
        <HeadingLevel level={3}>
          {short ? (
            <div className={s.shortGrid}>
              {rows.map((r, i) => (
                <div key={r.id ?? i}>{render(r)}</div>
              ))}
              {promoCard}
            </div>
          ) : (
            <div className="rail" ref={ref} tabIndex={0} aria-label={`${title} — ${L('좌우로 스크롤', 'scroll horizontally')}`}>
              {rows.slice(0, 16).map((r, i) => (
                <div key={r.id ?? i}>{render(r)}</div>
              ))}
            </div>
          )}
        </HeadingLevel>
      )}
    </section>
  );
}
