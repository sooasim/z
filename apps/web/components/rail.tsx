'use client';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { useApi } from '@/lib/hooks';
import { items } from '@/lib/shape';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/errors';

/** Horizontal discovery rail. Errors degrade to a quiet inline note so the home page never breaks. */
export function Rail({ title, path, query, render, href, emptyText }: { title: string; path: string; query?: Record<string, any>; render: (row: any) => ReactNode; href?: string; emptyText?: string }) {
  const { L } = useI18n();
  const st = useApi<any>(path, { query });
  const rows = items(st.data);
  return (
    <section className="stack" style={{ marginTop: 32 }} aria-label={title}>
      <div className="row between">
        <h2 style={{ margin: 0 }}>{title}</h2>
        {href && <Link href={href}>{L('전체 보기', 'See all')} →</Link>}
      </div>
      {st.loading ? (
        <div className="rail" aria-busy="true">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 220 }} />
          ))}
        </div>
      ) : st.error ? (
        <p className="muted small">
          {st.error instanceof ApiError && st.error.kind === 'disabled' ? L('곧 오픈 예정입니다.', 'Coming soon.') : L('지금은 추천을 불러올 수 없습니다.', 'Recommendations are unavailable right now.')}
        </p>
      ) : rows.length === 0 ? (
        <p className="muted small">{emptyText ?? L('아직 등록된 항목이 없습니다.', 'Nothing listed yet.')}</p>
      ) : (
        <div className="rail">{rows.slice(0, 12).map((r, i) => <div key={r.id ?? i}>{render(r)}</div>)}</div>
      )}
    </section>
  );
}
