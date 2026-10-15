'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, item, num, str } from '@/lib/shape';
import { StateView } from '@/components/states';
import { ResourceTable, type Column, type RowAction } from '@/components/table';
import { DateText, Drawer, Kv, Money, PageHeader, PriceBreakdown, Section, StatusBadge, Tabs } from '@/components/ui';

/** One order in full: the buyer's own view (line items, vouchers, fee breakdown) read one order at a time. */
function OrderDetail({ id }: { id: string }) {
  const { L } = useI18n();
  const st = useApi<any>(`/v1/orders/${id}`, { auth: true });
  return (
    <StateView state={st}>
      {(d) => {
        const o = item<any>(d) ?? {};
        const cur = str(o, 'currency') || 'KRW';
        const lines = arr<any>(o, 'items');
        return (
          <div className="stack">
            <Kv
              rows={[
                [L('주문번호', 'Order code'), <span key="c" className="mono">{str(o, 'code') || '—'}</span>],
                [L('상태', 'Status'), <StatusBadge key="s" status={str(o, 'status')} />],
                [L('판매 주체', 'Merchant of record'), str(o, 'merchantOfRecord') || '—'],
                [L('주문 일시', 'Created'), <DateText key="t" value={str(o, 'createdAt')} time />],
                [L('처리 일시', 'Fulfilled'), str(o, 'fulfilledAt') ? <DateText key="f" value={str(o, 'fulfilledAt')} time /> : '—'],
                [L('취소 일시', 'Cancelled'), str(o, 'cancelledAt') ? <DateText key="x" value={str(o, 'cancelledAt')} time /> : '—'],
                [L('구매자 ID', 'Buyer id'), <span key="b" className="mono small">{str(o, 'buyerId')}</span>],
              ]}
            />
            <Section title={L('주문 항목', 'Line items')}>
              <ul className="stack small" style={{ listStyle: 'none', padding: 0 }}>
                {lines.map((li) => (
                  <li key={str(li, 'id')} className="card flat stack">
                    <div className="row between">
                      <strong>{str(li, 'title')}</strong>
                      <Money minor={num(li, 'amountMinor')} currency={cur} />
                    </div>
                    <div className="row small muted" style={{ gap: 8 }}>
                      <span>{str(li, 'sellableType')}</span>
                      <span>× {num(li, 'qty') ?? 1}</span>
                      <StatusBadge status={str(li, 'status')} />
                    </div>
                    {arr<any>(li, 'vouchers').length > 0 && (
                      <div className="row small" style={{ gap: 6, flexWrap: 'wrap' }}>
                        {arr<any>(li, 'vouchers').map((v) => (
                          <span key={str(v, 'code')} className="badge mono">{str(v, 'code')} · {str(v, 'status')}</span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
            <PriceBreakdown
              lines={[
                { label: L('상품 금액', 'Subtotal'), amountMinor: num(o, 'subtotalMinor') ?? 0 },
                { label: L('수수료', 'Fees'), amountMinor: num(o, 'feeMinor') ?? 0 },
                ...((num(o, 'refundedMinor') ?? 0) > 0 ? [{ label: L('환불', 'Refunded'), amountMinor: -(num(o, 'refundedMinor') ?? 0) }] : []),
              ]}
              totalMinor={num(o, 'totalMinor') ?? 0}
              currency={cur}
              totalLabel={L('결제 총액', 'Order total')}
            />
          </div>
        );
      }}
    </StateView>
  );
}

export default function AdminTravelOrdersView() {
  const { L } = useI18n();
  const [tab, setTab] = useState<string>('PAID');
  const [code, setCode] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const [detail, setDetail] = useState<string | null>(null);

  const columns: Column[] = [
    { key: 'code', label: L('주문번호', 'Code'), primary: true, className: 'mono' },
    { key: 'buyerName', label: L('구매자', 'Buyer') },
    {
      key: 'items',
      label: L('상품', 'Items'),
      render: (r) => {
        const lines = arr<any>(r, 'items');
        if (lines.length === 0) return '—';
        const first = str(lines[0], 'title');
        return lines.length > 1 ? `${first} +${lines.length - 1}` : first;
      },
    },
    { key: 'totalMinor', label: L('결제 금액', 'Total'), kind: 'money', align: 'right' },
    { key: 'refundedMinor', label: L('환불', 'Refunded'), kind: 'money', align: 'right', hideOnMobile: true },
    { key: 'merchantOfRecord', label: L('판매 주체', 'Merchant'), hideOnMobile: true },
    { key: 'status', label: L('상태', 'Status'), kind: 'status', badge: true },
    { key: 'createdAt', label: L('주문 일시', 'Created'), kind: 'datetime' },
  ];
  const actions: RowAction[] = [
    { label: L('상세', 'Details'), tone: 'primary', icon: 'doc', run: async (r) => setDetail(str(r, 'id')) },
    {
      label: L('접수 완료 처리', 'Mark fulfilled'),
      menu: true,
      when: (r) => ['PAID', 'PARTIALLY_REFUNDED'].includes(str(r, 'status')),
      reason: L('처리 사유 (예: 공급사 전화 확정)', 'Reason (e.g. supplier confirmed by phone)'),
      confirm: L('상품이 제공 완료된 주문으로 표시합니다. 금액은 움직이지 않습니다.', 'Marks the order as delivered. No money moves.'),
      run: (r, reason) => post(`/v1/admin/orders/${str(r, 'id')}/fulfill`, { reason }),
    },
    {
      label: L('주문 취소 · 환불', 'Cancel & refund'),
      tone: 'danger',
      menu: true,
      when: (r) => !['CANCELLED', 'REFUNDED', 'EXPIRED'].includes(str(r, 'status')),
      reason: L('취소 사유', 'Cancellation reason'),
      confirm: L('취소 규정에 따라 환불이 계산되어 집행됩니다. 되돌릴 수 없습니다.', 'The refund is computed from the cancellation terms and executed. This cannot be undone.'),
      // the buyer-facing cancel endpoint, which staff may call for any order; it moves money, so it needs a key
      run: (r, reason) => post(`/v1/orders/${str(r, 'id')}/cancel`, { reason }, { idempotencyKey: true }),
    },
  ];

  return (
    <>
      <PageHeader
        title={L('주문 접수', 'Order intake')}
        subtitle={L('여행 상품 주문을 접수·처리하고 취소·환불을 집행합니다. 모든 처리는 사유와 함께 감사 기록됩니다.', 'Work through travel orders, mark them delivered and execute cancellations. Every action is audited with a reason.')}
      />
      {/* Intake order: paid orders first, because those are the ones waiting on the operator. `CART` is a draft
          the API never lists, so there is no tab for it. */}
      <Tabs
        label={L('주문 접수', 'Order intake')}
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'PAID', label: L('결제 완료 (처리 대기)', 'Paid — awaiting delivery') },
          { value: 'PAYMENT_PENDING', label: L('결제 대기', 'Payment pending') },
          { value: 'FULFILLED', label: L('처리 완료', 'Fulfilled') },
          { value: 'PARTIALLY_REFUNDED', label: L('부분 환불', 'Partially refunded') },
          { value: 'CANCELLED', label: L('취소', 'Cancelled') },
          { value: 'REFUNDED', label: L('환불', 'Refunded') },
          { value: 'ALL', label: L('전체', 'All') },
        ]}
      />
      <form
        className="row"
        style={{ margin: '16px 0', flexWrap: 'wrap', alignItems: 'flex-end' }}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(code.trim());
          setRange({ from: from || undefined, to: to || undefined });
        }}
      >
        <label className="field">
          <span>{L('주문번호', 'Order code')}</span>
          <input type="search" value={code} onChange={(e) => setCode(e.target.value)} placeholder="TRV-…" style={{ maxWidth: 220 }} />
        </label>
        <label className="field">
          <span>{L('주문일 시작', 'From')}</span>
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="field">
          <span>{L('주문일 종료', 'To')}</span>
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="btn">{L('조회', 'Search')}</button>
      </form>
      <ResourceTable
        key={`${tab}:${submitted}:${range.from ?? ''}:${range.to ?? ''}`}
        path="/v1/admin/orders"
        query={{
          ...(tab === 'ALL' ? {} : { status: tab }),
          ...(submitted ? { code: submitted } : {}),
          ...(range.from ? { from: range.from } : {}),
          ...(range.to ? { to: range.to } : {}),
        }}
        columns={columns}
        actions={actions}
        caption={L('주문 접수', 'Order intake')}
        empty={<p className="muted">{L('해당 조건의 주문이 없습니다.', 'No orders match.')}</p>}
      />
      <Drawer open={!!detail} onClose={() => setDetail(null)} title={L('주문 상세', 'Order details')}>
        {detail && <OrderDetail id={detail} />}
      </Drawer>
    </>
  );
}
