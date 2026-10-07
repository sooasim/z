'use client';
import { useI18n } from '@/lib/i18n';
import { post } from '@/lib/api';
import { str } from '@/lib/shape';
import { AdminListPage } from '@/components/admin/list-page';

export default function AdminVerificationsView() {
  const { L } = useI18n();
  return (
    <AdminListPage
      title={L('본인 · 사업자 인증 심사', 'Identity & business verification')}
      subtitle={L('서류 원본은 비공개 저장소에서 시간 제한 링크로만 열람되며, 열람 기록이 남습니다.', 'Documents open via short-lived private links; every view is logged.')}
      path="/v1/admin/verifications"
      search={false}
      tabs={[
        { value: 'submitted', label: L('접수', 'Submitted'), query: { status: 'SUBMITTED' } },
        { value: 'review', label: L('심사 중', 'In review'), query: { status: 'IN_REVIEW' } },
        { value: 'approved', label: L('승인', 'Approved'), query: { status: 'APPROVED' } },
        { value: 'rejected', label: L('반려', 'Rejected'), query: { status: 'REJECTED' } },
      ]}
      columns={[
        { key: 'userDisplayName|userEmail|userId|user_id', label: L('사용자', 'User') },
        { key: 'subjectType|subject_type', label: L('유형', 'Type') },
        { key: 'status', label: L('상태', 'Status'), kind: 'status' },
        { key: 'documentCount|documents.length', label: L('서류', 'Docs') },
        { key: 'submittedAt|createdAt|created_at', label: L('신청', 'Submitted'), kind: 'datetime' },
      ]}
      actions={[
        { label: L('심사 시작', 'Start review'), when: (r) => str(r, 'status').toUpperCase() === 'SUBMITTED', run: (r) => post(`/v1/admin/verifications/${str(r, 'id')}/start-review`, {}) },
        { label: L('승인', 'Approve'), tone: 'primary', when: (r) => ['SUBMITTED', 'IN_REVIEW'].includes(str(r, 'status').toUpperCase()), run: (r) => post(`/v1/admin/verifications/${str(r, 'id')}/approve`, {}) },
        { label: L('반려', 'Reject'), tone: 'danger', when: (r) => ['SUBMITTED', 'IN_REVIEW'].includes(str(r, 'status').toUpperCase()), reason: L('반려 사유 (사용자에게 전달)', 'Reason (sent to user)'), run: (r, reason) => post(`/v1/admin/verifications/${str(r, 'id')}/reject`, { reason }) },
      ]}
    />
  );
}
