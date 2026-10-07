'use client';
import { useI18n } from '@/lib/i18n';
import { AdminListPage } from '@/components/admin/list-page';

export default function AdminAuditView() {
  const { L } = useI18n();
  return (
    <AdminListPage
      title={L('감사 로그', 'Audit logs')}
      subtitle={L('돈, 권한, 준수, 권한 상승 열람 기록. 로그에는 비밀번호·토큰·카드번호 등 민감정보가 저장되지 않습니다.', 'Money, permission, compliance and elevated-access events. No secrets or card data are stored.')}
      path="/v1/admin/audit-logs"
      search={false}
      tabs={[
        { value: 'all', label: L('전체', 'All') },
        { value: 'money', label: L('돈', 'Money'), query: { category: 'MONEY' } },
        { value: 'perm', label: L('권한', 'Permission'), query: { category: 'PERMISSION' } },
        { value: 'compliance', label: L('준수', 'Compliance'), query: { category: 'COMPLIANCE' } },
        { value: 'elevated', label: L('권한 상승 열람', 'Elevated access'), query: { category: 'ELEVATED_ACCESS' } },
        { value: 'privacy', label: L('개인정보', 'Privacy'), query: { category: 'PRIVACY' } },
        { value: 'security', label: L('보안', 'Security'), query: { category: 'SECURITY' } },
      ]}
      columns={[
        { key: 'createdAt|at', label: L('일시', 'At'), kind: 'datetime' },
        { key: 'actorId|actor_id', label: L('행위자', 'Actor'), kind: 'id' },
        { key: 'category', label: L('분류', 'Category') },
        { key: 'action', label: L('행위', 'Action') },
        { key: 'resourceType|resource_type', label: L('대상', 'Target') },
        { key: 'resourceId|resource_id', label: 'ID', kind: 'id' },
        { key: 'reason', label: L('사유', 'Reason') },
        { key: 'correlationId', label: L('추적 ID', 'Correlation'), kind: 'id' },
      ]}
      empty={<p className="muted">{L('기록이 없습니다.', 'No events.')}</p>}
    />
  );
}
