'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { str } from '@/lib/shape';
import { AdminListPage } from '@/components/admin/list-page';
import { DataTable } from '@/components/table';
import { Modal } from '@/components/ui';
import { StateView } from '@/components/states';
import { items } from '@/lib/shape';

function RefundList({ paymentId, onClose }: { paymentId: string; onClose: () => void }) {
  const { L } = useI18n();
  const st = useApi<any>(`/v1/payments/${paymentId}/refunds`, { auth: true });
  return (
    <Modal open onClose={onClose} title={L('환불 내역', 'Refunds')} wide>
      <StateView state={st} skeleton="table" isEmpty={(d) => items(d).length === 0} empty={<p className="muted">{L('환불이 없습니다.', 'No refunds.')}</p>}>
        {(d) => (
          <DataTable
            rows={items(d)}
            filterable={false}
            columns={[
              { key: 'id', label: '#', kind: 'id' },
              { key: 'amountMinor', label: L('금액', 'Amount'), kind: 'money' },
              { key: 'reason', label: L('사유', 'Reason') },
              { key: 'status', label: L('상태', 'Status'), kind: 'status' },
              { key: 'createdAt', label: L('요청', 'Requested'), kind: 'datetime' },
            ]}
          />
        )}
      </StateView>
    </Modal>
  );
}

/** PAY-02: refunds are tracked per payment (cancellation policy → refund intent → PG cancel). */
export default function AdminRefundsView() {
  const { L } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <AdminListPage
        title={L('환불 오케스트레이션', 'Refund orchestration')}
        subtitle={L('취소 정책으로 생성된 환불과 수동 환불의 PG 처리 상태를 결제별로 확인합니다. 실패한 환불은 작업 큐가 자동 재시도합니다.', 'Track policy-driven and manual refunds per payment; failed refunds are retried by the job queue.')}
        path="/v1/admin/payments"
        search={false}
        tabs={[
          { value: 'pending', label: L('환불 진행 중', 'Refund pending'), query: { status: 'REFUND_PENDING' } },
          { value: 'partial', label: L('부분 환불', 'Partially refunded'), query: { status: 'PARTIALLY_REFUNDED' } },
          { value: 'refunded', label: L('전액 환불', 'Refunded'), query: { status: 'REFUNDED' } },
        ]}
        columns={[
          { key: 'orderId', label: L('주문번호', 'Order id'), render: (r) => <span className="mono">{str(r, 'orderId').slice(0, 20)}</span> },
          { key: 'subjectType', label: L('대상', 'Subject') },
          { key: 'amountMinor', label: L('결제액', 'Paid'), kind: 'money' },
          { key: 'refundedMinor', label: L('환불액', 'Refunded'), kind: 'money' },
          { key: 'status', label: L('상태', 'Status'), kind: 'status' },
        ]}
        actions={[{ label: L('환불 내역', 'View refunds'), tone: 'primary', run: async (r) => setOpen(str(r, 'id')) }]}
      />
      {open && <RefundList paymentId={open} onClose={() => setOpen(null)} />}
    </>
  );
}
