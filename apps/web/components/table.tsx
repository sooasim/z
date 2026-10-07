'use client';
import { useState, type ReactNode } from 'react';
import { useApi } from '@/lib/hooks';
import { items as itemsOf, str, f, nextCursor } from '@/lib/shape';
import { useI18n } from '@/lib/i18n';
import { api, type RequestOptions } from '@/lib/api';
import { StateView, EmptyState } from './states';
import { DateText, ErrorText, Money, StatusBadge } from './ui';

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

export function DataTable({ rows, columns, actions, onChanged, caption }: { rows: any[]; columns: Column[]; actions?: RowAction[]; onChanged?: () => void; caption?: string }) {
  const { t } = useI18n();
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  return (
    <div className="stack">
      <ErrorText error={err} />
      <div className="table-wrap">
        <table>
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} scope="col">
                  {c.label}
                </th>
              ))}
              {actions && actions.length > 0 && <th scope="col">{t('common.actions')}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
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
                      <div className="row" style={{ gap: 6 }}>
                        {actions
                          .filter((a) => !a.when || a.when(r))
                          .map((a) => (
                            <button
                              key={a.label}
                              className={`btn sm ${a.tone ?? ''}`}
                              disabled={busy === id + a.label}
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
      <StateView state={st} isEmpty={(d) => itemsOf(d).length === 0} empty={empty ?? <EmptyState />}>
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
