'use client';
import { useMemo, useState, type ReactNode } from 'react';
import { useApi } from '@/lib/hooks';
import { items as itemsOf, str, f, nextCursor } from '@/lib/shape';
import { useI18n } from '@/lib/i18n';
import { api, type RequestOptions } from '@/lib/api';
import { StateView, EmptyState } from './states';
import { DateText, ErrorText, Money, StatusBadge } from './ui/base';

export interface Column {
  key: string;
  label: string;
  kind?: 'text' | 'money' | 'date' | 'datetime' | 'status' | 'id' | 'json';
  currencyKey?: string;
  render?: (row: any) => ReactNode;
}

export function Cell({ row, col }: { row: any; col: Column }) {
  if (col.render) return <>{col.render(row)}</>;
  const keys = col.key.split('|');
  const v = f(row, ...keys);
  switch (col.kind) {
    case 'money':
      return <Money minor={v} currency={str(row, col.currencyKey || 'currency') || 'KRW'} />;
    case 'date':
      return <DateText value={v} />;
    case 'datetime':
      return <DateText value={v} time />;
    case 'status':
      return <StatusBadge status={v} />;
    case 'id':
      return <span className="mono">{String(v ?? '').slice(0, 8)}</span>;
    case 'json':
      return <span className="mono small">{v === undefined ? '—' : JSON.stringify(v).slice(0, 120)}</span>;
    default:
      return <>{v === undefined || v === null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v)}</>;
  }
}

export interface RowAction {
  label: string;
  run: (row: any, reason?: string) => Promise<unknown>;
  /** Show only when predicate passes. */
  when?: (row: any) => boolean;
  /** Ask for a free-text reason (audited actions). */
  reason?: string;
  confirm?: string;
  tone?: 'primary' | 'danger';
}

function sortValue(row: any, col: Column): string | number {
  const v = f(row, ...col.key.split('|'));
  if (v === undefined || v === null) return '';
  if (col.kind === 'money' || typeof v === 'number') return Number(v);
  return String(v).toLowerCase();
}

export function DataTable({ rows, columns, actions, onChanged, caption, pageSize = 20, filterable = true, toolbar }: { rows: any[]; columns: Column[]; actions?: RowAction[]; onChanged?: () => void; caption?: string; pageSize?: number; filterable?: boolean; toolbar?: ReactNode }) {
  const { t, L } = useI18n();
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const view = useMemo(() => {
    let r = rows;
    if (filter.trim()) {
      const needle = filter.trim().toLowerCase();
      r = r.filter((row) => JSON.stringify(row).toLowerCase().includes(needle));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col) r = [...r].sort((a, b) => (sortValue(a, col) > sortValue(b, col) ? sort.dir : sortValue(a, col) < sortValue(b, col) ? -sort.dir : 0));
    }
    return r;
  }, [rows, filter, sort, columns]);
  const pages = Math.max(1, Math.ceil(view.length / pageSize));
  const cur = Math.min(page, pages - 1);
  const pageRows = view.slice(cur * pageSize, cur * pageSize + pageSize);
  return (
    <div className="stack">
      {(filterable || toolbar) && (
        <div className="table-toolbar">
          {filterable && rows.length > 5 ? (
            <label className="field" style={{ flex: '1 1 240px', maxWidth: 360 }}>
              <span className="sr-only">{L('표 내 검색', 'Filter rows')}</span>
              <input type="search" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }} placeholder={L('🔍 결과 내 검색', '🔍 Filter rows')} />
            </label>
          ) : <span />}
          {toolbar}
        </div>
      )}
      <ErrorText error={err} />
      <div className="table-wrap">
        <table>
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {columns.map((c) => {
                const active = sort?.key === c.key;
                return (
                  <th key={c.key} scope="col" aria-sort={active ? (sort!.dir === 1 ? 'ascending' : 'descending') : undefined}>
                    {c.render && !c.kind ? (
                      c.label
                    ) : (
                      <button className="sort" onClick={() => setSort(active ? (sort!.dir === 1 ? { key: c.key, dir: -1 } : null) : { key: c.key, dir: 1 })}>
                        {c.label} <span aria-hidden="true">{active ? (sort!.dir === 1 ? '▲' : '▼') : '↕'}</span>
                      </button>
                    )}
                  </th>
                );
              })}
              {actions && actions.length > 0 && <th scope="col">{t('common.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={columns.length + (actions?.length ? 1 : 0)} className="center muted">{L('일치하는 항목이 없습니다.', 'No matching rows.')}</td>
              </tr>
            )}
            {pageRows.map((r, i) => {
              const id = str(r, 'id') || String(i);
              return (
                <tr key={id}>
                  {columns.map((c) => (
                    <td key={c.key}>
                      <Cell row={r} col={c} />
                    </td>
                  ))}
                  {actions && actions.length > 0 && (
                    <td>
                      <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                        {actions
                          .filter((a) => !a.when || a.when(r))
                          .map((a) => (
                            <button
                              key={a.label}
                              className={`btn sm ${a.tone ?? ''}`}
                              disabled={busy === id + a.label}
                              data-loading={busy === id + a.label ? 'true' : undefined}
                              onClick={async () => {
                                let reason: string | undefined;
                                if (a.reason) {
                                  const v = window.prompt(a.reason);
                                  if (!v || !v.trim()) return;
                                  reason = v.trim();
                                }
                                if (a.confirm && !window.confirm(a.confirm)) return;
                                setBusy(id + a.label);
                                setErr(null);
                                try {
                                  await a.run(r, reason);
                                  onChanged?.();
                                } catch (e) {
                                  setErr(e);
                                } finally {
                                  setBusy(null);
                                }
                              }}
                            >
                              {a.label}
                            </button>
                          ))}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <div className="pager">
          <span>
            {cur * pageSize + 1}–{Math.min(view.length, (cur + 1) * pageSize)} / {view.length}
          </span>
          <button className="btn sm" disabled={cur === 0} onClick={() => setPage(cur - 1)} aria-label={L('이전 페이지', 'Previous page')}>‹</button>
          <button className="btn sm" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} aria-label={L('다음 페이지', 'Next page')}>›</button>
        </div>
      )}
    </div>
  );
}

/** Fetches a list endpoint and renders it as a table with standard states and cursor pagination. */
export function ResourceTable({
  path,
  query,
  columns,
  actions,
  empty,
  caption,
  auth = true,
  toolbar,
}: {
  path: string | null;
  query?: RequestOptions['query'];
  columns: Column[];
  actions?: RowAction[];
  empty?: ReactNode;
  caption?: string;
  auth?: boolean;
  toolbar?: ReactNode;
}) {
  const { t } = useI18n();
  const st = useApi<any>(path, { query, auth });
  const [extra, setExtra] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const base = itemsOf(st.data);
  const nc = cursor ?? nextCursor(st.data);
  return (
    <div className="stack">
      {toolbar}
      <StateView state={st} skeleton="table" isEmpty={(d) => itemsOf(d).length === 0} empty={empty ?? <EmptyState />}>
        {() => (
          <>
            <DataTable
              rows={[...base, ...extra]}
              columns={columns}
              actions={actions}
              caption={caption}
              onChanged={() => {
                setExtra([]);
                setCursor(null);
                st.reload();
              }}
            />
            {nc && path && (
              <button
                className="btn"
                disabled={loadingMore}
                onClick={async () => {
                  setLoadingMore(true);
                  try {
                    const r = await api(path, { query: { ...(query || {}), cursor: nc } });
                    setExtra((e) => [...e, ...itemsOf(r)]);
                    setCursor(nextCursor(r) ?? '');
                  } finally {
                    setLoadingMore(false);
                  }
                }}
              >
                {t('common.more')}
              </button>
            )}
          </>
        )}
      </StateView>
    </div>
  );
}
