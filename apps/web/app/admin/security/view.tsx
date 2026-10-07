'use client';
import { useI18n } from '@/lib/i18n';
import { api, post } from '@/lib/api';
import { str } from '@/lib/shape';
import { AdminListPage } from '@/components/admin/list-page';

/** PLAT-05: elevated-access grants (invariant 10), sanctions and review abuse reports. */
export default function AdminSecurityView() {
  const { L } = useI18n();
  return (
    <AdminListPage
      title={L('보안 · 리스크', 'Security & risk')}
      subtitle={L('사건 범위·시간 제한 권한 상승 내역, 제재, 신고된 후기를 관리합니다.', 'Elevated-access grants, sanctions and reported reviews.')}
      path="/v1/admin/elevated-access"
      search={false}
      columns={[]}
      tabs={[
        {
          value: 'grants',
          label: L('권한 상승 내역', 'Elevated access'),
          path: '/v1/admin/elevated-access',
          columns: [
            { key: 'granteeId|grantee_id|staffId', label: L('직원', 'Staff'), kind: 'id' },
            { key: 'caseType|case_type|scope', label: L('사건', 'Case') },
            { key: 'conversationId|conversation_id', label: L('대화', 'Conversation'), kind: 'id' },
            { key: 'reason', label: L('사유', 'Reason') },
            { key: 'expiresAt|expires_at', label: L('만료', 'Expires'), kind: 'datetime' },
            { key: 'revokedAt|revoked_at', label: L('회수', 'Revoked'), kind: 'datetime' },
          ],
          actions: [{ label: L('즉시 회수', 'Revoke now'), tone: 'danger', when: (r) => !str(r, 'revokedAt', 'revoked_at'), confirm: L('권한을 회수할까요?', 'Revoke this grant?'), run: (r) => api(`/v1/admin/elevated-access/${str(r, 'id')}`, { method: 'DELETE' }) }],
        },
        {
          value: 'sanctions',
          label: L('제재', 'Sanctions'),
          path: '/v1/admin/sanctions',
          query: { active: 'true' },
          columns: [
            { key: 'userId|user_id', label: L('사용자', 'User'), kind: 'id' },
            { key: 'sanctionType|sanction_type', label: L('유형', 'Type') },
            { key: 'reason', label: L('사유', 'Reason') },
            { key: 'startsAt|starts_at', label: L('시작', 'Starts'), kind: 'datetime' },
            { key: 'endsAt|ends_at', label: L('종료', 'Ends'), kind: 'datetime' },
          ],
          actions: [{ label: L('해제', 'Lift'), reason: L('해제 사유', 'Reason'), run: (r, reason) => post(`/v1/admin/sanctions/${str(r, 'id')}/lift`, { reason }) }],
        },
        {
          value: 'reviews',
          label: L('신고된 후기', 'Reported reviews'),
          path: '/v1/admin/review-reports',
          columns: [
            { key: 'reviewId|review_id', label: L('후기', 'Review'), kind: 'id' },
            { key: 'reason', label: L('신고 사유', 'Reason') },
            { key: 'status', label: L('상태', 'Status'), kind: 'status' },
            { key: 'createdAt|created_at', label: L('신고일', 'Reported'), kind: 'datetime' },
          ],
          actions: [
            { label: L('후기 숨김', 'Hide review'), tone: 'danger', reason: L('숨김 사유', 'Reason'), run: (r, reason) => post(`/v1/admin/reviews/${str(r, 'reviewId', 'review_id')}/moderate`, { action: 'HIDE', status: 'HIDDEN', reason }) },
            { label: L('신고 기각', 'Dismiss'), reason: L('기각 사유', 'Reason'), run: (r, reason) => post(`/v1/admin/review-reports/${str(r, 'id')}/dismiss`, { reason }) },
          ],
        },
      ]}
    />
  );
}
