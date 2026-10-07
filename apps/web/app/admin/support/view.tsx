'use client';
import { useI18n } from '@/lib/i18n';
import { post } from '@/lib/api';
import { str } from '@/lib/shape';
import { AdminListPage } from '@/components/admin/list-page';

export default function AdminSupportView() {
  const { L } = useI18n();
  return (
    <AdminListPage
      title={L('고객 문의 데스크', 'Support desk')}
      path="/v1/admin/support/cases"
      search={false}
      tabs={[
        { value: 'open', label: L('신규', 'Open'), query: { status: 'OPEN' } },
        { value: 'progress', label: L('처리 중', 'In progress'), query: { status: 'IN_PROGRESS' } },
        { value: 'waiting', label: L('고객 응답 대기', 'Waiting on customer'), query: { status: 'PENDING_CUSTOMER' } },
        { value: 'resolved', label: L('해결', 'Resolved'), query: { status: 'RESOLVED' } },
      ]}
      columns={[
        { key: 'subject|title', label: L('제목', 'Subject') },
        { key: 'category', label: L('분류', 'Category') },
        { key: 'requesterName|requesterEmail', label: L('요청자', 'Requester') },
        { key: 'priority', label: L('우선순위', 'Priority'), kind: 'status' },
        { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
        { key: 'slaDueAt', label: 'SLA', kind: 'datetime' },
        { key: 'createdAt', label: L('접수', 'Opened'), kind: 'datetime' },
      ]}
      actions={[
        { label: L('담당', 'Assign me'), run: (r) => post(`/v1/admin/support/cases/${str(r, 'id')}/assign`, {}) },
        { label: L('답변', 'Reply'), tone: 'primary', reason: L('고객에게 보낼 답변', 'Reply to customer'), run: (r, reason) => post(`/v1/admin/support/cases/${str(r, 'id')}/comments`, { body: reason }) },
        { label: L('내부 메모', 'Note'), reason: L('내부 메모 (고객 비공개)', 'Internal note'), run: (r, reason) => post(`/v1/admin/support/cases/${str(r, 'id')}/notes`, { note: reason, body: reason }) },
        { label: L('해결', 'Resolve'), reason: L('처리 결과', 'Resolution'), when: (r) => !['RESOLVED', 'CLOSED'].includes(str(r, 'status').toUpperCase()), run: (r, reason) => post(`/v1/admin/support/cases/${str(r, 'id')}/status`, { to: 'RESOLVED', note: reason }) },
      ]}
    />
  );
}
