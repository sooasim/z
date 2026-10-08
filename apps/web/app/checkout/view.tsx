'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useApi } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { arr, f, item, str, num } from '@/lib/shape';
import { formatRange, formatTimeRange } from '@/lib/format';
import { quoteView } from '@/lib/quote';
import { postcardFor } from '@/lib/art';
import { placeLabel } from '@/lib/places';
import { subjectHref } from '@/lib/payment';
import { RequireAuth } from '@/components/gate';
import { EmptyState, StateView } from '@/components/states';
import { TossPayment } from '@/components/payment';
import { QuoteBreakdown } from '@/components/quote';
import { realImages } from '@/components/cards';
import { ButtonLink, Icon, PageHeader, PriceBreakdown, StatusPill, Steps } from '@/components/ui';
import { TimerChip, styles as s } from '@/components/traveler/ui';
import { useCountdown, useGuides, useOrderDepartures, useProperties } from '@/components/traveler/hooks';
import { orderPriceLines, policyName, policySentences } from '@/components/traveler/labels';

type Kind = 'ORDER' | 'GUIDE_BOOKING' | 'RESERVATION';
const PAYABLE = ['PENDING', 'PAYMENT_PENDING', 'CREATED', 'HELD', 'QUOTED', 'DRAFT'];

function Summary({ type, o }: { type: Kind; o: any }) {
  const { L, lang } = useI18n();
  const cur = str(o, 'currency') || 'KRW';
  const lines = type === 'ORDER' ? arr<any>(o, 'items', 'lines', 'orderItems') : [];
  const deps = useOrderDepartures(lines);
  const props = useProperties(type === 'RESERVATION' ? [str(o, 'propertyId')] : []);
  const guides = useGuides(type === 'GUIDE_BOOKING' ? [str(o, 'guideId', 'guide_id')] : []);
  let thumb = '';
  let title = '';
  let meta: string[] = [];
  let breakdown: React.ReactNode = null;
  let policy: string[] = [];
  if (type === 'ORDER') {
    const first = lines[0];
    const dep = first ? deps[str(first, 'sellableId')] : undefined;
    thumb = postcardFor(dep?.city || str(first, 'title'), str(first, 'sellableId'));
    title = first ? `${str(first, 'title')}${lines.length > 1 ? L(` 외 ${lines.length - 1}건`, ` +${lines.length - 1}`) : ''}` : L('여행 상품 주문', 'Travel order');
    meta = [dep?.startsAt ? formatTimeRange(dep.startsAt, dep.endsAt, lang) : '', dep?.city ? placeLabel(dep.city, lang) : '', `${lines.reduce((n, l) => n + (num(l, 'qty') ?? 1), 0)}${L('명', ' guests')}`].filter(Boolean);
    breakdown = <PriceBreakdown currency={cur} totalMinor={num(o, 'totalMinor') ?? 0} lines={orderPriceLines(o, L)} />;
    const terms = f<any>(o, 'pricing.cancellationTerms');
    const t0 = terms && typeof terms === 'object' ? (Object.values(terms)[0] as any) : null;
    policy = t0 ? (policySentences(t0, lang, 'departure').length ? policySentences(t0, lang, 'departure') : str(t0, 'note') ? [str(t0, 'note')] : []) : [];
  } else if (type === 'RESERVATION') {
    const p = props[str(o, 'propertyId')];
    const city = str(p, 'location.city') || str(o, 'property.city');
    thumb = realImages((Array.isArray(p?.media) ? p.media : []).map((m: any) => str(m, 'url')))[0] || postcardFor(city, str(o, 'propertyId'));
    title = str(o, 'property.title') || str(p, 'title') || L('숙소 예약', 'Stay');
    meta = [str(o, 'checkIn') ? formatRange(str(o, 'checkIn'), str(o, 'checkOut'), lang, { nights: true }) : '', num(o, 'guests') ? L(`게스트 ${num(o, 'guests')}명`, `${num(o, 'guests')} guests`) : '', placeLabel(city, lang)].filter(Boolean);
    breakdown = f(o, 'quote') ? <QuoteBreakdown q={{ ...quoteView(f(o, 'quote')), expiresAt: '' }} /> : null;
    const pol = f<any>(o, 'cancellationPolicy') ?? f<any>(p, 'cancellationPolicy');
    policy = pol ? [policyName(pol, lang), ...policySentences(pol, lang)].filter(Boolean) : [];
  } else {
    const g = guides[str(o, 'guideId', 'guide_id')];
    thumb = postcardFor(str(g, 'city') || 'Seoul', str(o, 'id'));
    title = str(g, 'displayName') ? L(`${str(g, 'displayName')}님과의 가이드 일정`, `Session with ${str(g, 'displayName')}`) : L('가이드 예약', 'Guide booking');
    meta = [formatTimeRange(str(o, 'startAt', 'start_at', 'startsAt'), str(o, 'endAt', 'end_at', 'endsAt'), lang), placeLabel(str(g, 'city'), lang)].filter(Boolean);
    breakdown = <PriceBreakdown currency={cur} totalMinor={num(o, 'priceMinor', 'price_minor', 'amountMinor', 'totalMinor') ?? 0} lines={[{ label: L('가이드 요금', 'Guide fee'), amountMinor: num(o, 'priceMinor', 'price_minor', 'amountMinor') ?? 0 }]} />;
  }
  return (
    <section className="card stack" aria-label={L('주문 요약', 'Order summary')}>
      <div className={s.summaryHead}>
        <img src={thumb} alt="" />
        <div style={{ minWidth: 0 }}>
          <strong>{title}</strong>
          {meta.map((m) => (
            <div key={m} className="small muted">
              {m}
            </div>
          ))}
        </div>
      </div>
      <hr style={{ margin: 0 }} />
      {breakdown}
      {policy.length > 0 && (
        <div className="small" style={{ display: 'grid', gap: 4 }}>
          <strong className="row" style={{ gap: 6 }}>
            <Icon name="shield" size={16} /> {L('취소·환불', 'Cancellation')}
          </strong>
          <span className="muted">{policy.join(' · ')}</span>
        </div>
      )}
    </section>
  );
}

function Pay({ type, id, o }: { type: Kind; id: string; o: any }) {
  const { L } = useI18n();
  const status = str(o, 'status', 'state').toUpperCase();
  const c = useCountdown(type === 'ORDER' ? str(o, 'expiresAt') : '');
  const detail = subjectHref(type, id);
  if (!PAYABLE.includes(status))
    return (
      <EmptyState illo="payments" title={['PAID', 'CONFIRMED', 'FULFILLED', 'COMPLETED'].includes(status) ? L('이미 결제가 완료됐어요', 'Already paid') : L('지금은 결제할 수 없어요', 'This can’t be paid now')} action={<ButtonLink variant="primary" href={detail}>{L('상세 보기', 'View details')}</ButtonLink>}>
        <p className="muted">
          {L('현재 상태', 'Status')}: <StatusPill status={status} />
        </p>
      </EmptyState>
    );
  if (c.valid && c.expired)
    return (
      <EmptyState illo="calendar" title={L('결제 시간이 만료되었어요', 'The payment window expired')} action={<ButtonLink variant="primary" href={detail}>{L('주문 보기', 'View order')}</ButtonLink>}>
        <p className="muted">{L('좌석 확보가 해제되었어요. 상품 페이지에서 다시 예약해 주세요.', 'Your seats were released. Please book again from the product page.')}</p>
      </EmptyState>
    );
  return (
    <section className="card stack" aria-label={L('결제', 'Payment')}>
      <div className="row between">
        <h2 style={{ margin: 0, fontSize: 'var(--fs-xl)' }}>{L('결제 수단', 'Payment method')}</h2>
        {type === 'ORDER' && <TimerChip expiresAt={str(o, 'expiresAt')}>{(t) => L(`${t} 동안 좌석이 유지돼요`, `Seats held for ${t}`)}</TimerChip>}
      </div>
      <TossPayment subjectType={type} subjectId={id} />
      <p className="xs muted" style={{ margin: 0 }}>
        {L('결제하면 ', 'By paying you agree to the ')}
        <Link href="/support">{L('취소·환불 정책', 'cancellation policy')}</Link>
        {L('과 이용약관에 동의하는 것으로 간주돼요.', ' and terms of service.')}
      </p>
    </section>
  );
}

/** Generic checkout for travel orders and paid guide bookings: /checkout?type=ORDER|GUIDE_BOOKING&id=… */
function Inner() {
  const sp = useSearchParams();
  const { L } = useI18n();
  const raw = (sp.get('type') ?? 'ORDER').toUpperCase();
  const type: Kind = raw === 'GUIDE_BOOKING' || raw === 'RESERVATION' ? raw : 'ORDER';
  const id = sp.get('id') ?? '';
  const path = !id ? null : type === 'ORDER' ? `/v1/orders/${id}` : type === 'GUIDE_BOOKING' ? `/v1/guide-bookings/${id}` : `/v1/reservations/${id}`;
  const st = useApi<any>(path, { auth: true });
  const back = id ? subjectHref(type, id) : '/trips';
  if (!id)
    return (
      <>
        <PageHeader title={L('결제하기', 'Checkout')} back="/trips" />
        <EmptyState illo="payments" title={L('결제할 주문이 없어요', 'Nothing to pay for')} action={<ButtonLink variant="primary" href="/travel">{L('여행 상품 보기', 'Browse travel')}</ButtonLink>}>
          {L('주문이나 예약에서 결제하기를 눌러 이 페이지로 오세요.', 'Start checkout from an order or booking.')}
        </EmptyState>
      </>
    );
  return (
    <>
      <PageHeader title={L('결제하기', 'Checkout')} subtitle={L('결제가 승인되면 예약이 확정돼요.', 'Your booking is confirmed once payment is approved.')} back={back} />
      <Steps steps={[L('상품 선택', 'Choose'), L('결제', 'Pay'), L('확정', 'Confirmed')]} current={1} />
      <StateView state={st} skeleton="detail" back={{ href: back, label: L('돌아가기', 'Go back') }}>
        {(d) => {
          const o = item(d);
          return (
            <div className={s.checkoutGrid}>
              <div className={s.sumCol}>
                <Summary type={type} o={o} />
              </div>
              <div className={s.payCol}>
                <Pay type={type} id={id} o={o} />
              </div>
            </div>
          );
        }}
      </StateView>
    </>
  );
}

export default function CheckoutView() {
  return (
    <RequireAuth>
      <Inner />
    </RequireAuth>
  );
}
