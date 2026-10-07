'use client';
import { useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { ResourceTable, type Column, type RowAction } from '@/components/table';
import { PageHeader, Tabs } from '@/components/ui';

export interface AdminTab {
  value: string;
  label: string;
  query?: Record<string, string>;
  path?: string;
  columns?: Column[];
  actions?: RowAction[];
}

/** Config-driven admin list screen: tabs → query, searchable/sortable table, audited row actions. */
export function AdminListPage({ title, subtitle, path, tabs, columns, actions, query, aside, actionsHeader, empty, search = true, searchParam = 'q' }: { title: string; subtitle?: string; path: string; tabs?: AdminTab[]; columns: Column[]; actions?: RowAction[]; query?: Record<string, string>; aside?: ReactNode; actionsHeader?: ReactNode; empty?: ReactNode; search?: boolean; searchParam?: string }) {
  const { L } = useI18n();
  const [tab, setTab] = useState(tabs?.[0]?.value ?? '');
  const [q, setQ] = useState('');
  const [k, setK] = useState(0);
  const cur = tabs?.find((t) => t.value === tab);
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={actionsHeader} />
      {tabs && <Tabs label={title} value={tab} onChange={setTab} tabs={tabs} />}
      {search ? (
        <form className="row" style={{ margin: '16px 0' }} onSubmit={(e) => { e.preventDefault(); setK(k + 1); }} role="search">
          <label className="sr-only" htmlFor="adm-q">{L('서버 검색', 'Search')}</label>
          <input id="adm-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('이메일, 이름으로 검색', 'Search by email or name')} style={{ maxWidth: 360 }} />
          <button className="btn">{L('검색', 'Search')}</button>
        </form>
      ) : (
        <div style={{ height: 16 }} />
      )}
      {aside}
      <ResourceTable key={tab + k} path={cur?.path ?? path} query={{ ...(query ?? {}), ...(cur?.query ?? {}), ...(search && q ? { [searchParam]: q } : {}) }} columns={cur?.columns ?? columns} actions={cur?.actions ?? actions} caption={title} empty={empty ?? <p className="muted">{L('대기 중인 항목이 없습니다.', 'Queue is empty.')}</p>} />
    </>
  );
}
