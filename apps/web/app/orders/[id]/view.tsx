'use client';
import Link from 'next/link';
import { Photo } from '@/components/media';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, f, item, str, num } from '@/lib/shape';
import { formatDate, formatMoney, formatTimeRange } from '@/lib/format';
import { postcardFor } from '@/lib/art';
import { placeLabel } from '@/lib/places';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, Button, ButtonLink, Icon, PageHeader, PriceBreakdown, StatusPill, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { CopyButton, InfoCard, Milestones, TimerChip, styles as s } from '@/components/traveler/ui';
import { useConversationFor, useCountdown, useOrderDepartures } from '@/components/traveler/hooks';
import { ORDER_STATUS_LABELS, orderPriceLines, policySentences } from '@/components/traveler/labels';

const UNPAID = ['PENDING', 'PAYMENT_PENDING', 'CREATED', 'CART'];

/** Order progress for travelers (history is not exposed by the API): 주문 → 결제 → 확정 → 바우처. */
function orderStep(status: string, hasVouchers: boolean): number {
  if (UNPAID.includes(status)) return 1;
  if (status === 'PAID') return hasVouchers ? 4 : 2;
  if (status === 'CONFIRMED') return hasVouchers ? 4 : 3;
  if (['FULFILLED', 'COMPLETED', 'REVIEWED'].includes(status)) return 4;
  return 0;
}

function PayPanel({ o }: { o: any }) {
  const { L, lang } = useI18n();
  const id = str(o, 'id');
  const c = useCountdown(str(o, 'expiresAt'));
  const total = formatMoney(num(o, 'totalMinor') ?? 0, str(o, 'currency') || 'KRW', lang);
  if (c.valid && c.expired)
    return <Alert tone="warn">{L('결제 시간이 지나 좌석 확보가 해제됐어요. 새로고침하면 최신 상태를 볼 수 있어요.', 'The payment window has passed and the seats were released. Refresh to see the latest status.')}</Alert>;
  return (
    <section className={s.payPanel} aria-label={L('결제 필요', 'Payment required')}>
      <div className={s.payRow}>
        <div>
          <strong>{L('결제를 완료해야 예약이 확정돼요', 'Complete payment to confirm')}</strong>
          <p className="small muted" style={{ margin: '2px 0 0' }}>{L('시간 안에 결제하지 않으면 확보한 좌석이 자동으로 해제돼요.', 'Seats are released automatically if payment isn’t completed in time.')}</p>
        </div>
        <TimerChip expiresAt={str(o, 'expiresAt')}>{(t) => L(`${t} 안에 결제`, `Pay within ${t}`)}</TimerChip>
      </div>
      <ButtonLink variant="accent" size="lg" href={`/checkout?type=ORDER&id=${id}`} iconRight="right">
        {L(`${total} 결제하기`, `Pay ${total}`)}
      </ButtonLink>
    </section>
  );
}

function OrderDetail({ o, reload }: { o: any; reload: () => void }) {
  const { L, lang } = useI18n();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const id = str(o, 'id');
  const status = str(o, 'status', 'state').toUpperCase();
  const lines = arr<any>(o, 'items', 'lines', 'orderItems');
  const cur = str(o, 'currency') || 'KRW';
  const deps = useOrderDepartures(lines);
  const vouchers = lines.flatMap((l) => arr<any>(l, 'vouchers').map((v) => ({ ...v, title: str(l, 'title') })));
  const conv = useConversationFor('ORDER', id);
  const first = lines[0];
  const dep0 = first ? deps[str(first, 'sellableId')] : undefined;
  const terms = f<any>(o, 'pricing.cancellationTerms');
  const termList = terms && typeof terms === 'object' ? Object.values(terms) : [];
  const step = orderStep(status, vouchers.length > 0);
  const title = first ? `${str(first, 'title')}${lines.length > 1 ? L(` 외 ${lines.length - 1}건`, ` +${lines.length - 1} more`) : ''}` : `${L('주문', 'Order')} ${str(o, 'code')}`;
  return (
    <>
      {dialog}
      <PageHeader
        title={title}
        subtitle={[`${L('주문 번호', 'Order')} ${str(o, 'code') || id.slice(0, 8)}`, `${formatDate(str(o, 'createdAt'), lang)} ${L('주문', 'ordered')}`].join(' · ')}
        back="/trips?tab=orders"
        actions={<StatusPill status={status} labels={ORDER_STATUS_LABELS} />}
      />
      <div className="stack-lg">
        {UNPAID.includes(status) && <PayPanel o={o} />}
        {status === 'EXPIRED' && (
          <Alert tone="info">
            {L('결제 시간이 지나 주문이 만료되었어요. 확보했던 좌석은 해제되었고 결제는 청구되지 않았어요.', 'This order expired before payment. The seats were released and nothing was charged.')}{' '}
            {dep0?.productId && <Link href={`/travel/${dep0.productId}`}>{L('다시 예약하기', 'Book again')}</Link>}
          </Alert>
        )}
        {['CANCELLED', 'CANCELED', 'REFUNDED'].includes(status) && (
          <Alert tone="info">
            {L('취소된 주문이에요.', 'This order was cancelled.')} {num(o, 'refundedMinor') ? L(`환불 금액 ${formatMoney(num(o, 'refundedMinor'), cur, lang)} · 카드사에 따라 3~7영업일이 걸릴 수 있어요.`, `Refunded ${formatMoney(num(o, 'refundedMinor'), cur, lang)} · 3–7 business days.`) : ''}
          </Alert>
        )}
        <div className="grid-2" style={{ alignItems: 'start' }}>
          <div className="stack-lg">
            <InfoCard title={L('예약 상품', 'What you booked')} icon="ticket">
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 12 }}>
                {lines.map((l, i) => {
                  const dep = deps[str(l, 'sellableId')];
                  return (
                    <li key={str(l, 'id') || i} className={s.summaryHead}>
                      <Photo src={postcardFor(dep?.city || str(l, 'title'), str(l, 'sellableId'))} seed={str(l, 'sellableId')} alt="" sizes="120px" />
                      <div style={{ minWidth: 0 }}>
                        <strong>{dep?.productId ? <Link href={`/travel/${dep.productId}`} style={{ color: 'inherit' }}>{str(l, 'title')}</Link> : str(l, 'title')}</strong>
                        <div className="small" style={{ marginTop: 2 }}>
                          <Icon name="clock" size={14} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 4 }} />
                          {dep?.startsAt ? formatTimeRange(dep.startsAt, dep.endsAt, lang) : L('출발 일정은 바우처에서 확인하세요', 'See your voucher for the departure time')}
                        </div>
                        <div className="xs muted">
                          {[dep?.city && placeLabel(dep.city, lang), `${num(l, 'qty', 'quantity') ?? 1}${L('명', ' guests')} × ${formatMoney(num(l, 'unitPriceMinor') ?? (num(l, 'amountMinor') ?? 0) / (num(l, 'qty') ?? 1), cur, lang)}`].filter(Boolean).join(' · ')}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </InfoCard>
            <InfoCard title={L('결제 금액', 'Price')} icon="card">
              <PriceBreakdown currency={cur} totalMinor={num(o, 'totalMinor', 'amountMinor') ?? 0} totalLabel={UNPAID.includes(status) ? L('결제할 금액', 'Amount due') : L('결제 금액', 'Total paid')} lines={orderPriceLines(o, L)} />
            </InfoCard>
            <InfoCard title={L('바우처', 'Vouchers')} icon="ticket" id="vouchers">
              {vouchers.length ? (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                  {vouchers.map((v, i) => (
                    <li key={str(v, 'code') || i} className="card flat row between" style={{ padding: '12px 14px' }}>
                      <div>
                        <div className="xs muted">{v.title} · {L(`${i + 1}번째`, `#${i + 1}`)}</div>
                        <strong className="mono" style={{ fontSize: 'var(--fs-base)', letterSpacing: '0.06em' }}>{str(v, 'code')}</strong>
                      </div>
                      <span className="row" style={{ gap: 8 }}>
                        <StatusPill status={str(v, 'status')} />
                        <CopyButton text={str(v, 'code')} label={L('복사', 'Copy')} copied={L('바우처 번호를 복사했어요', 'Voucher code copied')} variant="ghost" />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="small muted" style={{ margin: 0 }}>{UNPAID.includes(status) ? L('결제가 완료되면 바우처가 발급돼요. 이메일과 이 페이지에서 확인할 수 있어요.', 'Vouchers are issued after payment, here and by email.') : L('바우처가 발급되면 이메일과 이 페이지에서 확인할 수 있어요.', 'Vouchers appear here and by email once issued.')}</p>
              )}
            </InfoCard>
            {termList.length > 0 && (
              <InfoCard title={L('취소·환불 규정', 'Cancellation terms')} icon="shield">
                {termList.map((t: any, i) => {
                  const sent = policySentences(t, lang, 'departure');
                  return (
                    <div key={i} className="small">
                      {sent.length ? (
                        <ul style={{ margin: 0, paddingLeft: 18, display: 'grid', gap: 4 }}>
                          {sent.map((x) => (
                            <li key={x}>{x}</li>
                          ))}
                        </ul>
                      ) : str(t, 'note') ? (
                        <p style={{ margin: 0 }}>{str(t, 'note')}</p>
                      ) : num(t, 'full_refund_hours') ? (
                        <p style={{ margin: 0 }}>{L(`출발 ${num(t, 'full_refund_hours')}시간 전까지 전액 환불`, `Full refund until ${num(t, 'full_refund_hours')} hours before departure`)}</p>
                      ) : null}
                      {f(t, 'fee_refundable') === false && <p className="xs muted" style={{ margin: '4px 0 0' }}>{L('서비스 수수료는 환불되지 않아요.', 'The service fee is non-refundable.')}</p>}
                    </div>
                  );
                })}
                {['CONFIRMED', 'PAID'].includes(status) && (
                  <div className="row">
                    <Button
                      variant="ghost"
                      icon="x-circle"
                      style={{ color: 'var(--danger)' }}
                      onClick={async () => {
                        const r = await confirm({
                          title: L('주문을 취소할까요?', 'Cancel this order?'),
                          tone: 'danger',
                          body: L('위 규정에 따라 환불되며, 발급된 바우처는 사용할 수 없게 돼요.', 'Refunds follow the terms above and issued vouchers stop working.'),
                          confirmLabel: L('주문 취소', 'Cancel order'),
                          cancelLabel: L('돌아가기', 'Keep order'),
                          run: () => post(`/v1/orders/${id}/cancel`, { reason: 'BUYER_REQUEST' }, { idempotencyKey: `ocancel-${id}` }),
                        });
                        if (r.ok) {
                          toast.show(L('주문을 취소했어요', 'Order cancelled'));
                          reload();
                        }
                      }}
                    >
                      {L('주문 취소', 'Cancel order')}
                    </Button>
                  </div>
                )}
              </InfoCard>
            )}
          </div>
          <aside className={s.aside}>
            <section className="card stack" aria-label={L('진행 상태', 'Progress')}>
              <h2 style={{ fontSize: 'var(--fs-lg)', margin: 0 }}>{L('진행 상태', 'Progress')}</h2>
              {['CANCELLED', 'CANCELED', 'EXPIRED', 'REFUNDED'].includes(status) ? (
                <p className="small muted" style={{ margin: 0 }}>{status === 'EXPIRED' ? L('결제 전에 만료된 주문이에요.', 'Expired before payment.') : L('취소된 주문이에요.', 'Cancelled.')}</p>
              ) : (
                <Milestones
                  label={L('주문 진행 상태', 'Order progress')}
                  current={step}
                  steps={[
                    { label: L('주문 생성', 'Order placed'), sub: formatDate(str(o, 'createdAt'), lang, true) },
                    { label: L('결제', 'Payment'), sub: UNPAID.includes(status) ? L('결제 대기 중', 'Awaiting payment') : L('결제 완료', 'Paid') },
                    { label: L('예약 확정', 'Confirmed'), sub: L('공급사가 좌석을 확정해요', 'The supplier confirms your seats') },
                    { label: L('바우처 발급', 'Vouchers issued'), sub: vouchers.length ? L(`${vouchers.length}매 발급`, `${vouchers.length} issued`) : undefined },
                  ]}
                />
              )}
            </section>
            <section className="card stack">
              <h2 style={{ fontSize: 'var(--fs-lg)', margin: 0 }}>{L('도움이 필요하세요?', 'Need help?')}</h2>
              {conv && <ButtonLink href={`/messages?c=${str(conv, 'id')}`} icon="chat" block>{L('공급사에 메시지', 'Message the supplier')}</ButtonLink>}
              <ButtonLink variant="ghost" href={`/support/disputes?subjectType=ORDER&subjectId=${id}`} icon="flag" block>{L('문제 신고', 'Report a problem')}</ButtonLink>
              <p className="xs muted" style={{ margin: 0 }}>{str(o, 'merchantOfRecord') === 'JETPOOL' ? L('이 상품은 JETPOOL이 판매자로서 결제·환불을 책임져요.', 'JETPOOL is the merchant of record for this order.') : L('결제·환불은 판매자 규정을 따릅니다.', 'Payments and refunds follow the seller’s terms.')}</p>
            </section>
          </aside>
        </div>
      </div>
    </>
  );
}

export default function OrderDetailView() {
  const { id } = useParams<{ id: string }>();
  const { L } = useI18n();
  const st = useApi<any>(`/v1/orders/${id}`, { auth: true });
  return (
    <RequireAuth>
      <StateView state={st} skeleton="detail" back={{ href: '/trips?tab=orders', label: L('내 여행으로', 'Back to trips') }}>
        {(d) => <OrderDetail o={item(d)} reload={st.reload} />}
      </StateView>
    </RequireAuth>
  );
}
