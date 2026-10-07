'use client';
import { useI18n } from '@/lib/i18n';
import { post } from '@/lib/api';
import { str, num } from '@/lib/shape';
import { toMinor, formatMoney } from '@/lib/format';
import { AdminListPage } from '@/components/admin/list-page';

export default function AdminPaymentsView() {
  const { L, lang } = useI18n();
  return (
    <AdminListPage
      title={L('결제 운영', 'Payment operations')}
      subtitle={L('PG 승인·웹훅·원장 대사 상태를 확인하고 환불을 실행합니다. 환불은 Idempotency-Key로 중복 실행이 방지됩니다.', 'Check PG approval, webhooks and ledger reconciliation; issue idempotent refunds.')}
      path="/v1/admin/payments"
      search={false}
      tabs={[
        { value: 'all', label: L('전체', 'All') },
        { value: 'confirming', label: L('승인 확인 중', 'Confirming'), query: { status: 'CONFIRMING' } },
        { value: 'approved', label: L('승인', 'Approved'), query: { status: 'APPROVED' } },
        { value: 'failed', label: L('실패', 'Failed'), query: { status: 'FAILED' } },
        {
          value: 'recon',
          label: L('대사 리포트', 'Reconciliation'),
          path: '/v1/admin/payments/reconciliation',
          columns: [
            { key: 'id|paymentId', label: '#', kind: 'id' },
            { key: 'issue|kind|code', label: L('이슈', 'Issue') },
            { key: 'status', label: L('상태', 'Status'), kind: 'status' },
            { key: 'providerStatus', label: 'PG' },
            { key: 'amountMinor', label: L('금액', 'Amount'), kind: 'money' },
          ],
          actions: [{ label: L('PG 재조회', 'Reconcile'), run: (r) => post(`/v1/admin/payments/${str(r, 'id', 'paymentId')}/reconcile`, {}) }],
        },
      ]}
      columns={[
        { key: 'orderId', label: L('주문번호', 'Order id'), render: (r) => <span className="mono">{str(r, 'orderId').slice(0, 20)}</span> },
        { key: 'subjectType', label: L('대상', 'Subject') },
        { key: 'amountMinor', label: L('금액', 'Amount'), kind: 'money' },
        { key: 'refundedMinor', label: L('환불액', 'Refunded'), kind: 'money' },
        { key: 'status', label: L('상태', 'Status'), kind: 'status' },
        { key: 'method', label: L('수단', 'Method') },
        { key: 'approvedAt|createdAt', label: L('일시', 'At'), kind: 'datetime' },
      ]}
      actions={[
        {
          label: L('환불', 'Refund'),
          tone: 'danger',
          when: (r) => ['APPROVED', 'PARTIALLY_REFUNDED'].includes(str(r, 'status').toUpperCase()),
          reason: L('환불 사유 (감사 기록)', 'Refund reason (audited)'),
          run: async (r, reason) => {
            const max = (num(r, 'amountMinor') ?? 0) - (num(r, 'refundedMinor') ?? 0);
            const v = window.prompt(L(`환불 금액(원), 최대 ${formatMoney(max, 'KRW', lang)}`, `Refund amount, max ${formatMoney(max, 'KRW', lang)}`), String(max));
            if (!v) return;
            const amountMinor = toMinor(v);
            if (amountMinor <= 0 || amountMinor > max) throw new Error(L('금액이 올바르지 않습니다.', 'Invalid amount.'));
            await post(`/v1/payments/${str(r, 'id')}/refunds`, { amountMinor, reason }, { idempotencyKey: true });
          },
        },
        { label: L('PG 재조회', 'Reconcile'), run: (r) => post(`/v1/admin/payments/${str(r, 'id')}/reconcile`, {}) },
        { label: L('영수증', 'Receipt'), when: (r) => !!str(r, 'receiptUrl'), run: async (r) => void window.open(str(r, 'receiptUrl'), '_blank', 'noopener') },
      ]}
    />
  );
}
