'use client';
import { useI18n } from '@/lib/i18n';
import { str } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { ResourceTable } from '@/components/table';
import { PageHeader, Section } from '@/components/ui';
import { subjectHref } from '@/lib/payment';
import Link from 'next/link';

export default function PaymentsView() {
  const { L } = useI18n();
  return (
    <RequireAuth>
      <PageHeader title={L('결제 · 환불', 'Payments & refunds')} />
      <Section title={L('결제 내역', 'Payments')}>
        <ResourceTable
          path="/v1/payments"
          caption={L('결제 내역', 'Payments')}
          columns={[
            { key: 'createdAt', label: L('일시', 'Date'), kind: 'datetime' },
            { key: 'orderName|subjectType', label: L('내용', 'For'), render: (r) => <Link href={subjectHref(str(r, 'subjectType'), str(r, 'subjectId'))}>{str(r, 'orderName', 'subjectType')}</Link> },
            { key: 'method|provider', label: L('수단', 'Method') },
            { key: 'amountMinor|amount', label: L('금액', 'Amount'), kind: 'money' },
            { key: 'status|state', label: L('결제 상태', 'Status'), kind: 'status' },
            { key: 'refundStatus|refund.status', label: L('환불 상태', 'Refund'), kind: 'status' },
          ]}
          empty={<p className="muted">{L('결제 내역이 없습니다.', 'No payments yet.')}</p>}
        />
      </Section>
      <Section title={L('영수증 · 증빙', 'Receipts')}>
        <ResourceTable
          path="/v1/receipts"
          caption={L('영수증', 'Receipts')}
          columns={[
            { key: 'issuedAt|createdAt', label: L('발행일', 'Issued'), kind: 'date' },
            { key: 'receiptType|type', label: L('유형', 'Type') },
            { key: 'amountMinor', label: L('금액', 'Amount'), kind: 'money' },
            { key: 'url', label: L('보기', 'View'), render: (r) => (str(r, 'url', 'receiptUrl') ? <a href={str(r, 'url', 'receiptUrl')} target="_blank" rel="noopener noreferrer">{L('영수증', 'Receipt')}</a> : '—') },
          ]}
          empty={<p className="muted">{L('발행된 영수증이 없습니다.', 'No receipts.')}</p>}
        />
      </Section>
    </RequireAuth>
  );
}
