'use client';
import { useMemo, useRef, useState, type ReactNode, type KeyboardEvent } from 'react';
import { useApi } from '@/lib/hooks';
import { items as itemsOf, str, f, nextCursor } from '@/lib/shape';
import { useI18n } from '@/lib/i18n';
import { api, type RequestOptions } from '@/lib/api';
import { enumLabel, knownEnumLabel } from '@/lib/enums';
import { StateView, EmptyState } from './states';
import { DateText, ErrorText, Money, StatusBadge } from './ui/base';
import { Icon } from './ui/icons';
import { ConfirmDialog, type DialogField } from './ui/modal';
import { usePopover, useFitPopover } from './ui/pickers';

export interface Column {
  key: string;
  label: string;
  kind?: 'text' | 'money' | 'date' | 'datetime' | 'status' | 'id' | 'json' | 'enum';
  currencyKey?: string;
  render?: (row: any) => ReactNode;
  /** Card heading on phones (defaults to the first column). */
  primary?: boolean;
  /** Pinned top-right on phone cards (defaults to the first status column). */
  badge?: boolean;
  /** Omit from phone cards (secondary detail). */
  hideOnMobile?: boolean;
  align?: 'left' | 'right' | 'center';
  className?: string;
}

/** Plain text cell: known machine enums (RESERVATION, CARD, PAYMENT_APPROVED, auth.login …) are localized. */
function textValue(v: unknown, lang: 'ko' | 'en'): ReactNode {
  if (v === undefined || v === null || v === '') return '—';
  if (typeof v === 'boolean') return v ? (lang === 'ko' ? '예' : 'Yes') : lang === 'ko' ? '아니요' : 'No';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 80);
  const s = String(v);
  return knownEnumLabel(s, lang) ?? s;
}

export function Cell({ row, col }: { row: any; col: Column }) {
  const { lang } = useI18n();
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
    case 'enum':
      return <>{enumLabel(v, lang)}</>;
    case 'id':
      return (
        <span className="mono" title={String(v ?? '')}>
          {String(v ?? '').slice(0, 8) || '—'}
        </span>
      );
    case 'json':
      return <span className="mono small">{v === undefined ? '—' : JSON.stringify(v).slice(0, 120)}</span>;
    default:
      return <>{textValue(v, lang)}</>;
  }
}

export interface RowAction {
  label: string;
  /** `reason` is the audited reason (when `reason` is set); `values` holds `fields` input. */
  run: (row: any, reason?: string, values?: Record<string, any>) => Promise<unknown>;
  /** Show only when predicate passes. */
  when?: (row: any) => boolean;
  /** Ask for a free-text reason (audited actions); the string is the field label. */
  reason?: string;
  /** Minimum reason length (default 5). */
  reasonMin?: number;
  /** Confirmation text; with `reason`/`fields` it becomes the dialog body. */
  confirm?: string | ((row: any) => ReactNode);
  /** Dialog title (defaults to the action label). */
  title?: string | ((row: any) => string);
  /** Extra inputs collected in the same dialog (role picker, refund amount …). Function form gets the row. */
  fields?: DialogField[] | ((row: any) => DialogField[]);
  tone?: 'primary' | 'danger';
  /** Render inside the row's "⋯" overflow menu instead of inline. */
  menu?: boolean;
  icon?: string;
}

function sortValue(row: any, col: Column): string | number {
  const v = f(row, ...col.key.split('|'));
  if (v === undefined || v === null) return '';
  if (col.kind === 'money' || typeof v === 'number') return Number(v);
  return String(v).toLowerCase();
}

function RowMenu({ actions, onPick, label }: { actions: RowAction[]; onPick: (a: RowAction) => void; label: string }) {
  const p = usePopover();
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useFitPopover(p.open, popRef);
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const els = Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const i = els.indexOf(document.activeElement as HTMLElement);
    const n = e.key === 'ArrowDown' ? (i + 1) % els.length : e.key === 'ArrowUp' ? (i - 1 + els.length) % els.length : e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : -1;
    if (n >= 0) {
      e.preventDefault();
      els[n]?.focus();
    }
  };
  return (
    <div className="popover-anchor" ref={p.ref}>
      <button
        type="button"
        className="btn ghost icon sm"
        aria-haspopup="menu"
        aria-expanded={p.open}
        aria-label={label}
        onClick={() => {
          p.setOpen(!p.open);
          setTimeout(() => listRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus(), 0);
        }}
      >
        <Icon name="more" size={20} strokeWidth={3} />
      </button>
      {p.open && (
        <div className="popover right" ref={popRef} style={{ minWidth: 200, padding: 6 }}>
          <ul className="menu" role="menu" ref={listRef} onKeyDown={onKey} aria-label={label}>
            {actions.map((a) => (
              <li key={a.label} role="none">
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className={a.tone === 'danger' ? 'danger' : ''}
                  onClick={() => {
                    p.setOpen(false);
                    onPick(a);
                  }}
                >
                  {a.icon && <Icon name={a.icon} size={16} />}
                  {a.label}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Client-side sortable/filterable table.
 * - Cells never break inside words; money/date/status/id columns don't wrap; money is right-aligned + tabular.
 * - Phones (<640px): rows become stacked cards (`mobile="cards"`, default) — first column is the heading, the first
 *   status column a badge, the rest label/value pairs. `mobile="scroll"` keeps a horizontally scrolling table.
 * - Audited actions open a styled dialog (reason, extra `fields`, confirmation) instead of window.prompt/confirm.
 *   More than two actions per row (or `menu: true`) collapse into a "⋯" overflow menu.
 * - `paged={false}` disables client paging (server cursor pagination via ResourceTable).
 */
export function DataTable({ rows, columns, actions, onChanged, caption, pageSize = 20, filterable = true, toolbar, mobile = 'cards', paged = true }: { rows: any[]; columns: Column[]; actions?: RowAction[]; onChanged?: () => void; caption?: string; pageSize?: number; filterable?: boolean; toolbar?: ReactNode; mobile?: 'cards' | 'scroll'; paged?: boolean }) {
  const { t, L } = useI18n();
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(0);
  const [dialog, setDialog] = useState<{ a: RowAction; row: any; id: string } | null>(null);
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
  const size = paged ? pageSize : Number.MAX_SAFE_INTEGER;
  const pages = Math.max(1, Math.ceil(view.length / size));
  const cur = Math.min(page, pages - 1);
  const pageRows = paged ? view.slice(cur * size, cur * size + size) : view;
  const primaryIdx = Math.max(0, columns.findIndex((c) => c.primary));
  const badgeIdx = columns.findIndex((c) => c.badge) >= 0 ? columns.findIndex((c) => c.badge) : columns.findIndex((c, i) => c.kind === 'status' && i !== primaryIdx);
  const colClass = (c: Column, i: number) =>
    [
      `c-${c.kind ?? 'text'}`,
      i === primaryIdx ? 'c-primary' : '',
      i === badgeIdx ? 'c-badge' : '',
      c.hideOnMobile ? 'c-hide-sm' : '',
      c.align === 'right' ? 'c-money' : '',
      c.className ?? '',
    ]
      .filter(Boolean)
      .join(' ');

  const execute = async (a: RowAction, r: any, id: string, reason?: string, values?: Record<string, any>) => {
    setBusy(id + a.label);
    setErr(null);
    try {
      await a.run(r, reason, values);
      onChanged?.();
    } finally {
      setBusy(null);
    }
  };
  const trigger = (a: RowAction, r: any, id: string) => {
    if (a.reason || a.confirm || a.fields) setDialog({ a, row: r, id });
    else execute(a, r, id).catch((e) => setErr(e));
  };
  const hasActions = !!actions && actions.length > 0;
  const dlg = dialog;
  const dlgFields = dlg ? (typeof dlg.a.fields === 'function' ? dlg.a.fields(dlg.row) : dlg.a.fields) : undefined;
  return (
    <div className="stack">
      {(filterable || toolbar) && (
        <div className="table-toolbar">
          {filterable && rows.length > 5 ? (
            <label className="field" style={{ flex: '1 1 240px', maxWidth: 360 }}>
              <span className="sr-only">{L('표 내 검색', 'Filter rows')}</span>
              <span className="search-input">
                <Icon name="search" size={18} />
                <input
                  type="search"
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setPage(0);
                  }}
                  placeholder={L('결과 내 검색', 'Filter rows')}
                />
              </span>
            </label>
          ) : (
            <span />
          )}
          {toolbar}
        </div>
      )}
      <ErrorText error={err} />
      <div className={`table-wrap ${mobile === 'cards' ? 'stack-sm' : ''}`}>
        <table>
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead>
            <tr>
              {columns.map((c, i) => {
                const active = sort?.key === c.key;
                return (
                  <th key={c.key} scope="col" className={colClass(c, i)} aria-sort={active ? (sort!.dir === 1 ? 'ascending' : 'descending') : undefined}>
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
              {hasActions && (
                <th scope="col" className="c-actions">
                  <span className="sr-only">{t('common.actions')}</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 && (
              <tr>
                <td colSpan={columns.length + (hasActions ? 1 : 0)} className="center muted c-empty">
                  {L('일치하는 항목이 없습니다.', 'No matching rows.')}
                </td>
              </tr>
            )}
            {pageRows.map((r, i) => {
              const id = str(r, 'id') || String(i);
              const visible = (actions ?? []).filter((a) => !a.when || a.when(r));
              let inline = visible.filter((a) => !a.menu);
              let overflow = visible.filter((a) => a.menu);
              if (inline.length > 2) {
                const keep = inline.find((a) => a.tone === 'primary') ?? inline.find((a) => a.tone !== 'danger') ?? inline[0];
                overflow = [...inline.filter((a) => a !== keep), ...overflow];
                inline = [keep];
              }
              return (
                <tr key={id}>
                  {columns.map((c, ci) => (
                    <td key={c.key} className={colClass(c, ci)} data-label={c.label}>
                      <Cell row={r} col={c} />
                    </td>
                  ))}
                  {hasActions && (
                    <td className="c-actions">
                      <div className="row-actions">
                        {inline.map((a) => (
                          <button
                            key={a.label}
                            type="button"
                            className={`btn sm ${a.tone === 'danger' ? 'danger-outline' : a.tone ?? ''}`}
                            disabled={busy === id + a.label}
                            data-loading={busy === id + a.label ? 'true' : undefined}
                            onClick={() => trigger(a, r, id)}
                          >
                            {a.label}
                          </button>
                        ))}
                        {overflow.length > 0 && <RowMenu actions={overflow} onPick={(a) => trigger(a, r, id)} label={L('더 많은 작업', 'More actions')} />}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {paged && pages > 1 && (
        <div className="pager">
          <span>
            {cur * size + 1}–{Math.min(view.length, (cur + 1) * size)} / {view.length}
          </span>
          <button className="btn sm" disabled={cur === 0} onClick={() => setPage(cur - 1)} aria-label={L('이전 페이지', 'Previous page')}>
            <Icon name="left" size={16} />
          </button>
          <button className="btn sm" disabled={cur >= pages - 1} onClick={() => setPage(cur + 1)} aria-label={L('다음 페이지', 'Next page')}>
            <Icon name="right" size={16} />
          </button>
        </div>
      )}
      {dlg && (
        <ConfirmDialog
          open
          onClose={() => setDialog(null)}
          title={typeof dlg.a.title === 'function' ? dlg.a.title(dlg.row) : dlg.a.title ?? dlg.a.label}
          body={typeof dlg.a.confirm === 'function' ? dlg.a.confirm(dlg.row) : dlg.a.confirm}
          tone={dlg.a.tone === 'danger' ? 'danger' : 'primary'}
          confirmLabel={dlg.a.label}
          requireReason={dlg.a.reason ? dlg.a.reason : undefined}
          reasonMinLength={dlg.a.reasonMin ?? 5}
          fields={dlgFields}
          onConfirm={(reason, values) => execute(dlg.a, dlg.row, dlg.id, reason, values)}
        />
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
  mobile,
}: {
  path: string | null;
  query?: RequestOptions['query'];
  columns: Column[];
  actions?: RowAction[];
  empty?: ReactNode;
  caption?: string;
  auth?: boolean;
  toolbar?: ReactNode;
  mobile?: 'cards' | 'scroll';
}) {
  const { L } = useI18n();
  const st = useApi<any>(path, { query, auth });
  const [extra, setExtra] = useState<any[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreErr, setMoreErr] = useState<unknown>(null);
  const base = itemsOf(st.data);
  const nc = cursor ?? nextCursor(st.data);
  const loaded = base.length + extra.length;
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
              mobile={mobile}
              paged={false}
              onChanged={() => {
                setExtra([]);
                setCursor(null);
                st.reload();
              }}
            />
            <div className="row between">
              <span className="table-caption" aria-live="polite">
                {nc ? L(`${loaded.toLocaleString()}건 표시 중`, `Showing ${loaded.toLocaleString()}`) : L(`전체 ${loaded.toLocaleString()}건`, `${loaded.toLocaleString()} total`)}
              </span>
              {nc && path && (
                <button
                  className="btn sm"
                  disabled={loadingMore}
                  data-loading={loadingMore ? 'true' : undefined}
                  onClick={async () => {
                    setLoadingMore(true);
                    setMoreErr(null);
                    try {
                      const r = await api(path, { query: { ...(query || {}), cursor: nc } });
                      setExtra((e) => [...e, ...itemsOf(r)]);
                      setCursor(nextCursor(r) ?? '');
                    } catch (e) {
                      setMoreErr(e);
                    } finally {
                      setLoadingMore(false);
                    }
                  }}
                >
                  {L('더 불러오기', 'Load more')}
                </button>
              )}
            </div>
            <ErrorText error={moreErr} />
          </>
        )}
      </StateView>
    </div>
  );
}
