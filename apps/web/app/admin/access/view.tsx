'use client';
import { useI18n } from '@/lib/i18n';
import { api, post } from '@/lib/api';
import { arr, str } from '@/lib/shape';
import { AdminListPage } from '@/components/admin/list-page';

const ROLES = ['USER', 'HOST', 'GUIDE', 'SUPPLIER', 'SUPPORT', 'ACCOUNTING', 'EDITOR', 'COMPLIANCE', 'ADMIN'];

export default function AdminAccessView() {
  const { L } = useI18n();
  const change = (action: 'GRANT' | 'REVOKE') => async (r: any, reason?: string) => {
    const role = window.prompt(L(`역할 입력 (${ROLES.join(', ')})`, `Role (${ROLES.join(', ')})`))?.toUpperCase().trim();
    if (!role) return;
    if (!ROLES.includes(role)) throw new Error(L('알 수 없는 역할입니다.', 'Unknown role.'));
    if (action === 'GRANT') await post(`/v1/admin/users/${str(r, 'id')}/roles`, { role, reason });
    else await api(`/v1/admin/users/${str(r, 'id')}/roles/${role}`, { method: 'DELETE', query: { reason } });
  };
  return (
    <AdminListPage
      title={L('권한 · 역할 관리', 'Access & roles')}
      subtitle={L('역할 부여·회수는 사유와 함께 감사 기록되며, 직원 역할은 MFA(AAL2) 세션에서만 동작합니다.', 'Grants and revocations are audited with a reason; staff roles only work in AAL2 sessions.')}
      path="/v1/admin/users"
      tabs={[
        { value: 'all', label: L('전체', 'All') },
        { value: 'admin', label: 'ADMIN', query: { role: 'ADMIN' } },
        { value: 'support', label: 'SUPPORT', query: { role: 'SUPPORT' } },
        { value: 'accounting', label: 'ACCOUNTING', query: { role: 'ACCOUNTING' } },
        { value: 'host', label: 'HOST', query: { role: 'HOST' } },
        { value: 'suspended', label: L('정지', 'Suspended'), query: { status: 'SUSPENDED' } },
      ]}
      columns={[
        { key: 'displayName|name', label: L('이름', 'Name') },
        { key: 'email', label: L('이메일', 'Email') },
        { key: 'roles', label: L('역할', 'Roles'), render: (r) => <span className="row" style={{ gap: 4 }}>{arr<any>(r, 'roles').map((x) => <span key={String(x)} className="badge">{typeof x === 'string' ? x : str(x, 'role')}</span>)}</span> },
        { key: 'mfaEnabled', label: 'MFA', render: (r) => (r.mfaEnabled || r.mfa_enabled ? <span className="badge ok">ON</span> : <span className="badge">OFF</span>) },
        { key: 'status', label: L('상태', 'Status'), kind: 'status' },
        { key: 'lastLoginAt', label: L('최근 로그인', 'Last login'), kind: 'datetime' },
      ]}
      actions={[
        { label: L('역할 부여', 'Grant role'), tone: 'primary', reason: L('부여 사유', 'Reason for grant'), run: change('GRANT') },
        { label: L('역할 회수', 'Revoke role'), reason: L('회수 사유', 'Reason for revoke'), run: change('REVOKE') },
        { label: L('계정 정지', 'Suspend'), tone: 'danger', when: (r) => str(r, 'status').toUpperCase() === 'ACTIVE', reason: L('정지 사유', 'Suspension reason'), run: (r, reason) => post(`/v1/admin/users/${str(r, 'id')}/suspend`, { reason }) },
        { label: L('복구', 'Restore'), when: (r) => str(r, 'status').toUpperCase() === 'SUSPENDED', reason: L('복구 사유', 'Restore reason'), run: (r, reason) => post(`/v1/admin/users/${str(r, 'id')}/restore`, { reason }) },
      ]}
    />
  );
}
