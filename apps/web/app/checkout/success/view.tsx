'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { get, post } from '@/lib/api';
import { arr, f, item, num, str } from '@/lib/shape';
import { formatDate, formatRange, formatTimeRange } from '@/lib/format';
import { paymentPhase, paymentSubject, subjectHref } from '@/lib/payment';
import { postcardFor } from '@/lib/art';
import { placeLabel } from '@/lib/places';
import { Alert, ButtonLink, ErrorText, Icon, Kv, Money, Spinner, Steps } from '@/components/ui';
import { EmptyState } from '@/components/states';
import { RequireAuth } from '@/components/gate';
import { realImages } from '@/components/cards';
import { ApiError } from '@/lib/errors';
import { CalendarButton, styles as s } from '@/components/traveler/ui';
import { invalidate, useCachedApi, useConversationFor, useGuides, useOrderDepartures, useProperties } from '@/components/traveler/hooks';
import { formatAddress, hhmm, paymentMethodLabel } from '@/components/traveler/labels';

function Booked({ type, id, payment, amount }: { type: string; id: string; payment: any; amount: number }) {
  const { L, lang } = useI18n();
  const t = type.toUpperCase();
  const path = !id ? null : t === 'RESERVATION' ? `/v1/reservations/${id}` : t === 'ORDER' ? `/v1/orders/${id}` : t === 'GUIDE_BOOKING' ? `/v1/guide-bookings/${id}` : null;
  const subj = useCachedApi<any>(path);
  const o = item(subj.data) ?? {};
  const props = useProperties(t === 'RESERVATION' ? [str(o, 'propertyId')] : []);
  const p = props[str(o, 'propertyId')];
  const lines = t === 'ORDER' ? arr<any>(o, 'items') : [];
  const deps = useOrderDepartures(lines);
  const guides = useGuides(t === 'GUIDE_BOOKING' ? [str(o, 'guide_id', 'guideId')] : []);
  const conv = useConversationFor(t, id, str(o, 'conversationId', 'conversation_id'));
  const cur = str(payment, 'currency') || str(o, 'currency') || 'KRW';
  const paid = num(payment, 'amountMinor', 'amount') ?? amount;
  let thumb = '';
  let title = '';
  let rows: Array<[string, React.ReactNode]> = [];
  let cal: Parameters<typeof CalendarButton>[0]['event'] | null = null;
  if (t === 'RESERVATION') {
    const city = str(o, 'property.city') || str(p, 'location.city');
    thumb = realImages((Array.isArray(p?.media) ? p.media : []).map((m: any) => str(m, 'url')))[0] || postcardFor(city, str(o, 'propertyId'));
    title = str(o, 'property.title') || str(p, 'title') || L('숙소 예약', 'Stay');
    const ci = hhmm(str(o, 'cancellationPolicy.checkInTime')) || hhmm(str(p, 'checkInTime'));
    const co = hhmm(str(p, 'checkOutTime'));
    rows = [
      [L('일정', 'Dates'), str(o, 'checkIn') ? formatRange(str(o, 'checkIn'), str(o, 'checkOut'), lang, { nights: true }) : '—'],
      [L('게스트', 'Guests'), num(o, 'guests') ? L(`${num(o, 'guests')}명`, `${num(o, 'guests')}`) : '—'],
      [L('체크인', 'Check-in'), ci ? L(`${ci} 이후`, `After ${ci}`) : L('호스트와 조율', 'Arrange with host')],
      ...(co ? ([[L('체크아웃', 'Check-out'), L(`${co}까지`, `By ${co}`)]] as Array<[string, string]>) : []),
    ];
    if (str(o, 'checkIn')) cal = { uid: id, title: `${title} · JETPOOL`, start: str(o, 'checkIn'), end: str(o, 'checkOut'), location: formatAddress(f(o, 'property.address'), lang)?.oneLine || placeLabel(city, lang), description: `${L('예약 번호', 'Booking')} ${str(o, 'code')}` };
  } else if (t === 'ORDER') {
    const first = lines[0];
    const dep = first ? deps[str(first, 'sellableId')] : undefined;
    thumb = postcardFor(dep?.city || str(first, 'title'), id);
    title = str(first, 'title') || L('여행 상품', 'Travel order');
    rows = [
      [L('출발', 'Departure'), dep?.startsAt ? formatTimeRange(dep.startsAt, dep.endsAt, lang) : L('바우처에서 확인', 'See voucher')],
      [L('인원', 'Guests'), `${lines.reduce((n, l) => n + (num(l, 'qty') ?? 1), 0)}${L('명', '')}`],
    ];
    if (dep?.startsAt) cal = { uid: id, title: `${title} · JETPOOL`, start: dep.startsAt, end: dep.endsAt || dep.startsAt, location: placeLabel(dep.city, lang), description: `${L('주문 번호', 'Order')} ${str(o, 'code')}` };
  } else if (t === 'GUIDE_BOOKING') {
    const g = guides[str(o, 'guide_id', 'guideId')];
    thumb = postcardFor(str(g, 'city') || 'Seoul', id);
    title = str(g, 'displayName') ? L(`${str(g, 'displayName')}님과의 가이드 일정`, `Session with ${str(g, 'displayName')}`) : L('가이드 예약', 'Guide booking');
    rows = [[L('일시', 'When'), formatTimeRange(str(o, 'start_at', 'startAt'), str(o, 'end_at', 'endAt'), lang)]];
    if (str(o, 'start_at', 'startAt')) cal = { uid: id, title: `${title} · JETPOOL`, start: str(o, 'start_at', 'startAt'), end: str(o, 'end_at', 'endAt'), location: placeLabel(str(g, 'city'), lang) };
  }
  const code = str(o, 'code');
  return (
    <div className="stack-lg" style={{ maxWidth: 720, margin: '0 auto' }}>
      <section className="card stack" aria-label={L('예약 요약', 'Booking summary')}>
        <div className={s.summaryHead}>
          {thumb ? <img src={thumb} alt="" /> : <span className={s.thumb} />}
          <div style={{ minWidth: 0 }}>
            <strong style={{ fontSize: 'var(--fs-lg)' }}>{title || L('불러오는 중…', 'Loading…')}</strong>
            {code && (
              <div className="small muted">
                {t === 'ORDER' ? L('주문 번호', 'Order no.') : L('예약 번호', 'Booking code')} <span className="mono" style={{ color: 'var(--text)', fontWeight: 700 }}>{code}</span>
              </div>
            )}
          </div>
        </div>
        <hr style={{ margin: '16px 0 0' }} />
        <Kv
          rows={[
            ...rows,
            [L('결제 금액', 'Amount paid'), <strong key="m"><Money minor={paid} currency={cur} /></strong>],
            [L('결제 수단', 'Paid with'), payment ? `${paymentMethodLabel(str(payment, 'method') || str(payment, 'provider'), lang)}${str(payment, 'approvedAt') ? ` · ${formatDate(str(payment, 'approvedAt'), lang, true)}` : ''}` : '—'],
          ]}
        />
      </section>
      <div className={s.toolbar} role="group" aria-label={L('다음 단계', 'Next steps')}>
        {conv && (
          <ButtonLink variant="primary" icon="chat" href={`/messages?c=${str(conv, 'id')}`} className={s.wide}>
            {t === 'RESERVATION' ? L('호스트에게 메시지', 'Message host') : t === 'GUIDE_BOOKING' ? L('가이드에게 메시지', 'Message guide') : L('공급사에 메시지', 'Message supplier')}
          </ButtonLink>
        )}
        <ButtonLink variant={conv ? 'default' : 'primary'} icon="doc" href={subjectHref(t, id)}>
          {t === 'ORDER' ? L('주문 상세·바우처', 'Order & vouchers') : L('예약 상세', 'Booking details')}
        </ButtonLink>
        <ButtonLink icon="card" href="/payments">{L('영수증', 'Receipt')}</ButtonLink>
        {cal && <CalendarButton event={cal} filename={`jetpool-${code || id.slice(0, 8)}.ics`} />}
      </div>
      {t === 'RESERVATION' && <Alert tone="info">{L('체크인 안내(출입 방법·주차 등)는 호스트가 메시지로 보내드려요. 예약 확정 메일도 발송됐어요.', 'Your host will message check-in details. A confirmation email is on its way.')}</Alert>}
      {t === 'ORDER' && <Alert tone="info">{L('바우처는 주문 상세와 이메일에서 확인할 수 있어요. 출발 당일 바우처 번호를 보여 주세요.', 'Find your vouchers in the order details and your email. Show the code on the day.')}</Alert>}
    </div>
  );
}

/**
 * The PG redirect to this page is NOT a confirmation (invariant 3). We call the API, which confirms with
 * TossPayments server-to-server and validates order/amount, and show "confirming…" until it returns APPROVED.
 */
function Confirm() {
  const sp = useSearchParams();
  const { L } = useI18n();
  const paymentKey = sp.get('paymentKey') ?? '';
  const orderId = sp.get('orderId') ?? '';
  const amount = Number(sp.get('amount') ?? '0');
  const [phase, setPhase] = useState<'confirming' | 'approved' | 'failed' | 'pending'>('confirming');
  const [payment, setPayment] = useState<any>(null);
  const [err, setErr] = useState<unknown>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!paymentKey || !orderId || !Number.isFinite(amount)) {
      setPhase('failed');
      setErr(new ApiError(400, { code: 'INVALID_INPUT', detail: L('결제 정보가 올바르지 않습니다.', 'Invalid payment parameters.') }));
      return;
    }
    (async () => {
      try {
        // Deterministic key: reloading this page replays the same confirm instead of double-confirming.
        let res: any = await post('/v1/payments/toss/confirm', { paymentKey, orderId, amount }, { idempotencyKey: `confirm-${orderId}` });
        setPayment(item(res));
        let ph = paymentPhase(res);
        const pid = str(item(res), 'id', 'paymentId');
        // Async approval (e.g. virtual account / provider latency): poll authoritative status.
        for (let i = 0; ph === 'pending' && i < 20; i++) {
          setPhase('pending');
          await new Promise((r) => setTimeout(r, 2000 + i * 500));
          res = pid ? await get(`/v1/payments/${pid}`) : await get('/v1/payments', { orderId });
          const row = pid ? item(res) : Array.isArray(res?.items) ? res.items[0] : item(res);
          setPayment(row);
          ph = paymentPhase({ item: row });
        }
        // Fresh booking state for the summary (statuses changed with the approval).
        invalidate('/v1/');
        setPhase(ph === 'approved' ? 'approved' : ph === 'failed' ? 'failed' : 'pending');
      } catch (e) {
        setErr(e);
        setPhase('failed');
      }
    })();
  }, [paymentKey, orderId, amount, L]);

  const subj = payment ? paymentSubject({ item: payment }) : { type: sp.get('subjectType') ?? '', id: sp.get('subjectId') ?? '' };
  const type = (subj.type || sp.get('subjectType') || '').toUpperCase();
  const id = subj.id || sp.get('subjectId') || '';
  const isStay = type === 'RESERVATION';
  const steps = isStay ? [L('요금 확인', 'Review'), L('날짜 확보', 'Hold'), L('결제', 'Pay'), L('확정', 'Confirmed')] : [L('상품 선택', 'Choose'), L('결제', 'Pay'), L('확정', 'Confirmed')];
  const last = steps.length - 1;

  return (
    <>
      {(phase === 'confirming' || phase === 'pending') && <h1 className="sr-only">{L('결제 확인', 'Confirming payment')}</h1>}
      <Steps steps={steps} current={phase === 'approved' ? last : last - 1} />
      {phase === 'confirming' && <Spinner label={L('결제를 확인하고 있어요… 창을 닫지 마세요.', 'Confirming your payment… please keep this page open.')} />}
      {phase === 'pending' && (
        <div className="stack">
          <Spinner label={L('결제 승인을 기다리고 있어요… 승인되면 자동으로 갱신돼요.', 'Awaiting approval… this page updates automatically.')} />
          <Alert tone="info">
            {L('승인이 지연되면 결제 내역에서 상태를 확인할 수 있어요. 승인 전에는 예약이 확정되지 않아요.', 'If approval is delayed, check Payments. Nothing is confirmed until approved.')} <Link href="/payments">{L('결제 내역 보기', 'View payments')}</Link>
          </Alert>
        </div>
      )}
      {phase === 'approved' && (
        <>
          <div className={s.success} role="status">
            <span className={s.successIco} aria-hidden="true">
              <Icon name="check" size={34} strokeWidth={2.6} />
            </span>
            <h1>{isStay ? L('예약이 확정되었어요', 'Your booking is confirmed') : type === 'ORDER' ? L('주문이 완료되었어요', 'Your order is complete') : L('예약이 확정되었어요', 'You’re booked')}</h1>
            <p>{L('결제가 승인되었어요. 확정 내용을 이메일로도 보내드렸어요.', 'Payment approved. We’ve emailed you the details.')}</p>
          </div>
          <Booked type={type} id={id} payment={payment} amount={amount} />
          <p className={`${s.ref} center`} style={{ marginTop: 16 }}>
            ref: {orderId}
          </p>
        </>
      )}
      {phase === 'failed' && (
        <EmptyState
          illo="error"
          as="h1"
          title={L('결제가 확정되지 않았어요', 'Payment was not confirmed')}
          action={
            <>
              {id && <ButtonLink variant="primary" href={subjectHref(type, id)}>{L('예약으로 돌아가기', 'Back to booking')}</ButtonLink>}
              <ButtonLink href="/trips">{L('내 여행', 'My trips')}</ButtonLink>
            </>
          }
        >
          <div className="stack" style={{ maxWidth: 520, margin: '0 auto' }}>
            <ErrorText error={err ?? new Error(L('결제가 승인되지 않았습니다.', 'Payment was not approved.'))} />
            <p className="muted small">{L('청구된 금액이 있다면 자동으로 취소돼요.', 'Any authorisation will be voided automatically.')}</p>
          </div>
        </EmptyState>
      )}
    </>
  );
}

export default function CheckoutSuccessView() {
  return (
    <RequireAuth>
      <Confirm />
    </RequireAuth>
  );
}
