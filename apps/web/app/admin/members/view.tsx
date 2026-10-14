'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api, post } from '@/lib/api';
import { arr, item, num, str } from '@/lib/shape';
import { StateView } from '@/components/states';
import { ResourceTable, type Column, type RowAction } from '@/components/table';
import { Alert, DateText, Drawer, Kv, PageHeader, StatusBadge, Tabs } from '@/components/ui';

/** Assignable roles. USER is implicit on every account, so it is not offered as a grant. */
const ROLES = ['HOST', 'GUIDE', 'SUPPLIER', 'SUPPORT', 'ACCOUNTING', 'EDITOR', 'COMPLIANCE', 'ADMIN'] as const;
const STAFF_ROLES = ['SUPPORT', 'ACCOUNTING', 'EDITOR', 'COMPLIANCE', 'ADMIN'];

const roleOptions = ROLES.map((r) => ({ value: r, label: r }));
const rolesOf = (r: any): string[] => arr<any>(r, 'roles').map((x) => (typeof x === 'string' ? x : str(x, 'role'))).filter(Boolean);

/** Read-only member profile: the account, its live sessions, active sanctions and who granted which role when. */
function MemberDetail({ id }: { id: string }) {
  const { L } = useI18n();
  const st = useApi<any>(`/v1/admin/users/${id}`, { auth: true });
  return (
    <StateView state={st}>
      {(d) => {
        const u = item<any>(d) ?? {};
        const sanctions = arr<any>(u, 'activeSanctions');
        const history = arr<any>(u, 'roleHistory');
        return (
          <div className="stack">
            <Kv
              rows={[
                [L('이름', 'Name'), str(u, 'displayName') || '—'],
                [L('이메일', 'Email'), str(u, 'email') || '—'],
                [L('전화', 'Phone'), str(u, 'phone') || '—'],
                [L('상태', 'Status'), <StatusBadge key="s" status={str(u, 'status')} />],
                [L('역할', 'Roles'), <span key="r" className="row" style={{ gap: 4 }}>{rolesOf(u).map((x) => <span key={x} className={`badge${STAFF_ROLES.includes(x) ? ' accent' : ''}`}>{x}</span>)}</span>],
                ['MFA', u.mfaEnabled ? <span key="m" className="badge ok">ON</span> : <span key="m" className="badge">OFF</span>],
                [L('이메일 인증', 'Email verified'), u.emailVerified ? '✅' : '—'],
                [L('본인 인증', 'Identity verified'), u.identityVerified ? '✅' : '—'],
                [L('활성 세션', 'Active sessions'), num(u, 'activeSessions') ?? 0],
                [L('최근 로그인', 'Last login'), <DateText key="l" value={str(u, 'lastLoginAt')} time />],
                [L('가입일', 'Joined'), <DateText key="c" value={str(u, 'createdAt')} time />],
                ['ID', <span key="i" className="mono small">{id}</span>],
              ]}
            />
            {sanctions.length > 0 && (
              <Alert tone="warn">
                {L('활성 제재', 'Active sanctions')}:{' '}
                {sanctions.map((s) => `${str(s, 'type')} (${str(s, 'reason') || '—'})`).join(', ')}
              </Alert>
            )}
            <h3>{L('역할 변경 이력', 'Role history')}</h3>
            {history.length === 0 ? (
              <p className="muted">{L('기록이 없습니다.', 'No changes recorded.')}</p>
            ) : (
              <ul className="stack small" style={{ listStyle: 'none', padding: 0 }}>
                {history.map((h, i) => (
                  <li key={`${str(h, 'role')}-${str(h, 'createdAt')}-${i}`} className="card flat row between">
                    <span>
                      <span className="badge">{str(h, 'role')}</span> {str(h, 'action')}
                      {str(h, 'reason') && <span className="muted"> · {str(h, 'reason')}</span>}
                    </span>
                    <DateText value={str(h, 'createdAt')} time />
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      }}
    </StateView>
  );
}

export default function AdminMembersView() {
  const { L } = useI18n();
  const [tab, setTab] = useState('all');
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [detail, setDetail] = useState<string | null>(null);

  const tabs = [
    { value: 'all', label: L('전체', 'All'), query: {} as Record<string, string> },
    { value: 'host', label: L('호스트', 'Hosts'), query: { role: 'HOST' } },
    { value: 'guide', label: L('가이드', 'Guides'), query: { role: 'GUIDE' } },
    { value: 'supplier', label: L('공급사', 'Suppliers'), query: { role: 'SUPPLIER' } },
    // the directory filters on one role at a time, so each staff role gets its own tab rather than a fake "staff" one
    { value: 'admin', label: 'ADMIN', query: { role: 'ADMIN' } },
    { value: 'support', label: 'SUPPORT', query: { role: 'SUPPORT' } },
    { value: 'suspended', label: L('정지', 'Suspended'), query: { status: 'SUSPENDED' } },
  ];
  const columns: Column[] = [
    { key: 'displayName', label: L('이름', 'Name'), primary: true },
    { key: 'email', label: L('이메일', 'Email') },
    {
      key: 'roles',
      label: L('역할', 'Roles'),
      render: (r) => <span className="row" style={{ gap: 4 }}>{rolesOf(r).map((x) => <span key={x} className={`badge${STAFF_ROLES.includes(x) ? ' accent' : ''}`}>{x}</span>)}</span>,
    },
    { key: 'mfaEnabled', label: 'MFA', hideOnMobile: true, render: (r) => (r.mfaEnabled ? <span className="badge ok">ON</span> : <span className="badge">OFF</span>) },
    { key: 'identityVerified', label: L('본인 인증', 'Verified'), hideOnMobile: true, render: (r) => (r.identityVerified ? '✅' : '—') },
    { key: 'status', label: L('상태', 'Status'), kind: 'status', badge: true },
    { key: 'createdAt', label: L('가입일', 'Joined'), kind: 'date', hideOnMobile: true },
  ];
  const actions: RowAction[] = [
    { label: L('상세', 'Details'), tone: 'primary', icon: 'user', run: async (r) => setDetail(str(r, 'id')) },
    {
      label: L('역할 부여', 'Grant role'),
      menu: true,
      reason: L('부여 사유', 'Reason for grant'),
      fields: [{ name: 'role', label: L('역할', 'Role'), type: 'select', options: roleOptions, required: true }],
      confirm: (r) => L(`${str(r, 'displayName') || str(r, 'email')} 에게 역할을 부여합니다. 직원 역할은 MFA(AAL2) 세션에서만 동작합니다.`, `Grants a role to ${str(r, 'displayName') || str(r, 'email')}. Staff roles only work in AAL2 sessions.`),
      run: (r, reason, values) => post(`/v1/admin/users/${str(r, 'id')}/roles`, { role: values?.role, reason }),
    },
    {
      label: L('역할 회수', 'Revoke role'),
      menu: true,
      reason: L('회수 사유', 'Reason for revoke'),
      fields: (r) => [{ name: 'role', label: L('역할', 'Role'), type: 'select', options: rolesOf(r).filter((x) => x !== 'USER').map((x) => ({ value: x, label: x })), required: true }],
      run: (r, reason, values) => api(`/v1/admin/users/${str(r, 'id')}/roles/${values?.role}`, { method: 'DELETE', query: { reason } }),
    },
    {
      label: L('계정 정지', 'Suspend'),
      tone: 'danger',
      menu: true,
      when: (r) => str(r, 'status').toUpperCase() === 'ACTIVE',
      reason: L('정지 사유', 'Suspension reason'),
      confirm: L('정지된 계정은 즉시 로그아웃되고 모든 세션이 폐기됩니다.', 'Suspending signs the account out and revokes every session.'),
      run: (r, reason) => post(`/v1/admin/users/${str(r, 'id')}/suspend`, { reason }),
    },
    {
      label: L('정지 해제', 'Restore'),
      menu: true,
      when: (r) => str(r, 'status').toUpperCase() === 'SUSPENDED',
      reason: L('해제 사유', 'Restore reason'),
      run: (r, reason) => post(`/v1/admin/users/${str(r, 'id')}/restore`, { reason }),
    },
  ];

  const cur = tabs.find((x) => x.value === tab) ?? tabs[0];
  return (
    <>
      <PageHeader
        title={L('회원 관리', 'Members')}
        subtitle={L('회원 조회, 역할 부여·회수, 계정 정지와 해제. 모든 변경은 사유와 함께 감사 기록됩니다.', 'Look up members, grant or revoke roles, suspend and restore accounts. Every change is audited with a reason.')}
      />
      <Tabs label={L('회원 관리', 'Members')} value={tab} onChange={setTab} tabs={tabs} />
      <form
        className="row"
        style={{ margin: '16px 0' }}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim());
        }}
      >
        <label className="sr-only" htmlFor="member-q">{L('이메일, 이름으로 검색', 'Search by email or name')}</label>
        <input id="member-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('이메일, 이름으로 검색', 'Search by email or name')} style={{ maxWidth: 360 }} />
        <button className="btn">{L('검색', 'Search')}</button>
      </form>
      <ResourceTable
        key={`${tab}:${submitted}`}
        path="/v1/admin/users"
        query={{ ...cur.query, ...(submitted ? { q: submitted } : {}) }}
        columns={columns}
        actions={actions}
        caption={L('회원 관리', 'Members')}
      />
      <Drawer open={!!detail} onClose={() => setDetail(null)} title={L('회원 상세', 'Member details')}>
        {detail && <MemberDetail id={detail} />}
      </Drawer>
    </>
  );
}
