'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { items, num, str } from '@/lib/shape';
import { subjectHref } from '@/lib/payment';
import { RequireAuth } from '@/components/gate';
import { EmptyState, StateView } from '@/components/states';
import { DataTable, type Column } from '@/components/table';
import { Alert, Button, ButtonLink, DateText, Icon, Money, PageHeader, Section, StatusPill } from '@/components/ui';
import { paymentMethodLabel, prettyOrderName, receiptTypeLabel, subjectLabel } from '@/components/traveler/labels';

const FAILURE: Record<string, [string, string]> = {
  EXPIRED: ['결제 시간 만료', 'Payment window expired'],
  USER_CANCEL: ['결제 취소', 'Cancelled by you'],
  PAY_PROCESS_CANCELED: ['결제 취소', 'Cancelled by you'],
  REJECT_CARD_COMPANY: ['카드사 거절', 'Declined by card issuer'],
};

function Payments() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/payments', { auth: true, query: { limit: 100 } });
  const [showAbandoned, setShowAbandoned] = useState(false);
  const all = items(st.data);
  // Checkout attempts the traveler closed before paying (no approval) are noise in the history: fold them away.
  const abandoned = all.filter((r) => ['CANCELLED', 'CANCELED', 'ABORTED'].includes(str(r, 'status').toUpperCase()) && !str(r, 'approvedAt'));
  const rows = showAbandoned ? all : all.filter((r) => !abandoned.includes(r));
  const anyRefund = rows.some((r) => (num(r, 'refundedMinor') ?? 0) > 0 || str(r, 'refundStatus', 'refund.status'));
  const columns: Column[] = [
    {
      key: 'orderName',
      label: L('내용', 'For'),
      primary: true,
      render: (r) => {
        const failure = str(r, 'failureCode');
        return (
          <div>
            <Link href={subjectHref(str(r, 'subjectType'), str(r, 'subjectId'))} style={{ fontWeight: 700 }}>
              {prettyOrderName(str(r, 'orderName'), lang) || subjectLabel(str(r, 'subjectType'), lang)}
            </Link>
            <div className="xs muted">
              {subjectLabel(str(r, 'subjectType'), lang)}
              {failure && ` · ${(FAILURE[failure] ?? [L('결제 실패', 'Failed'), 'Failed'])[lang === 'ko' ? 0 : 1]}`}
            </div>
          </div>
        );
      },
    },
    { key: 'createdAt', label: L('결제일', 'Date'), kind: 'datetime', render: (r) => <DateText value={str(r, 'approvedAt', 'createdAt')} time /> },
    { key: 'method', label: L('결제 수단', 'Method'), hideOnMobile: true, render: (r) => (str(r, 'method') || str(r, 'provider') ? paymentMethodLabel(str(r, 'method') || str(r, 'provider'), lang) : '—') },
    { key: 'amountMinor', label: L('금액', 'Amount'), kind: 'money', align: 'right' },
    { key: 'status', label: L('결제 상태', 'Status'), kind: 'status', badge: true },
    ...(anyRefund
      ? ([
          {
            key: 'refundedMinor',
            label: L('환불', 'Refunded'),
            render: (r: any) => ((num(r, 'refundedMinor') ?? 0) > 0 ? <span style={{ color: 'var(--success)', fontWeight: 700 }}><Money minor={num(r, 'refundedMinor')} currency={str(r, 'currency') || 'KRW'} /></span> : str(r, 'refundStatus') ? <StatusPill status={str(r, 'refundStatus')} /> : '—'),
          },
        ] as Column[])
      : []),
  ];
  return (
    <StateView
      state={st}
      skeleton="table"
      isEmpty={(d) => items(d).length === 0}
      empty={
        <EmptyState illo="payments" title={L('아직 결제 내역이 없어요', 'No payments yet')} action={<ButtonLink variant="primary" href="/stay">{L('숙소 둘러보기', 'Browse stays')}</ButtonLink>}>
          {L('숙소·가이드·여행 상품을 결제하면 여기에서 영수증과 환불 내역을 확인할 수 있어요.', 'Receipts and refunds for your bookings will appear here.')}
        </EmptyState>
      }
    >
      {() => (
        <>
          <DataTable rows={rows} columns={columns} caption={L('결제 내역', 'Payments')} paged={false} filterable={rows.length > 8} />
          {abandoned.length > 0 && (
            <div className="row">
              <Button size="sm" variant="ghost" icon={showAbandoned ? 'minus' : 'plus'} onClick={() => setShowAbandoned((v) => !v)} aria-expanded={showAbandoned}>
                {showAbandoned ? L('중단된 결제 시도 숨기기', 'Hide abandoned attempts') : L(`중단된 결제 시도 ${abandoned.length}건 보기`, `Show ${abandoned.length} abandoned attempts`)}
              </Button>
            </div>
          )}
          {anyRefund && <p className="xs muted" style={{ margin: 0 }}>{L('환불은 원래 결제 수단으로 처리되며, 카드사에 따라 반영까지 3~7영업일이 걸릴 수 있어요.', 'Refunds go back to the original payment method and can take 3–7 business days to appear.')}</p>}
        </>
      )}
    </StateView>
  );
}

function Receipts() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/receipts', { auth: true, query: { limit: 100 } });
  const rows = items(st.data);
  const columns: Column[] = [
    {
      key: 'data.orderName',
      label: L('내용', 'For'),
      primary: true,
      render: (r) => (
        <div>
          <strong>{prettyOrderName(str(r, 'data.orderName'), lang) || receiptTypeLabel(str(r, 'receiptType', 'type'), lang)}</strong>
          <div className="xs muted">{receiptTypeLabel(str(r, 'receiptType', 'type'), lang)}</div>
        </div>
      ),
    },
    { key: 'issuedAt', label: L('발행일', 'Issued'), kind: 'date' },
    { key: 'amountMinor', label: L('금액', 'Amount'), kind: 'money', align: 'right' },
    {
      key: 'url',
      label: L('영수증', 'Receipt'),
      render: (r) => {
        const url = str(r, 'url', 'receiptUrl', 'data.receiptUrl');
        return url ? (
          <a className="btn sm" href={url} target="_blank" rel="noopener noreferrer">
            <Icon name="external" size={16} /> {L('영수증 보기', 'View receipt')}
          </a>
        ) : (
          <span className="xs muted">{L('발급 준비 중', 'Being issued')}</span>
        );
      },
    },
  ];
  return (
    <StateView
      state={st}
      skeleton="table"
      isEmpty={(d) => items(d).length === 0}
      empty={
        <EmptyState illo="payments" title={L('발행된 영수증이 없어요', 'No receipts yet')}>
          {L('결제가 승인되면 결제 영수증이 자동으로 발행돼요.', 'A receipt is issued automatically once a payment is approved.')}
        </EmptyState>
      }
    >
      {() => <DataTable rows={rows} columns={columns} caption={L('영수증', 'Receipts')} paged={false} filterable={false} />}
    </StateView>
  );
}

export default function PaymentsView() {
  const { L } = useI18n();
  return (
    <RequireAuth>
      <PageHeader title={L('결제 · 환불', 'Payments & refunds')} subtitle={L('결제 내역과 영수증, 환불 진행 상황을 확인하세요.', 'Your payments, receipts and refunds.')} />
      <Section title={L('결제 내역', 'Payments')}>
        <Payments />
      </Section>
      <Section title={L('영수증 · 증빙', 'Receipts')} id="receipts">
        <Receipts />
        <Alert tone="info">{L('세금계산서·현금영수증 등 추가 증빙이 필요하면 고객센터로 문의해 주세요.', 'Need a tax invoice or other proof of payment? Contact support.')}</Alert>
      </Section>
    </RequireAuth>
  );
}
