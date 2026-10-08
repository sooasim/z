'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { get, newIdempotencyKey, post } from '@/lib/api';
import { f, item, str } from '@/lib/shape';
import { propertyView } from '@/lib/domain';
import { postcardFor } from '@/lib/art';
import { formatMoney, formatRange } from '@/lib/format';
import { placeLabel } from '@/lib/places';
import { quoteView, readQuote, stableKey, stashQuote, type QuoteView } from '@/lib/quote';
import { RequireAuth } from '@/components/gate';
import { QuoteBreakdown } from '@/components/quote';
import { TossPayment } from '@/components/payment';
import { realImages } from '@/components/cards';
import { Alert, Button, ErrorText, Icon, MobileActionBar, Modal, PageHeader, Skeleton, Steps, Textarea } from '@/components/ui';
import { ApiError } from '@/lib/errors';
import { policyName, refundLines } from '@/components/public/labels';
import s from '@/components/public/public.module.css';

function Countdown({ until }: { until: string }) {
  const { L, lang } = useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const end = new Date(until);
  const ms = end.getTime() - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return <Alert tone="error">{L('날짜 유지 시간이 끝났어요. 숙소로 돌아가 다시 견적을 받아 주세요.', 'Your hold expired. Go back to the listing and re-quote.')}</Alert>;
  const m = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  const at = new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(end);
  return (
    <p className="row small" style={{ gap: 8, margin: 0 }}>
      <span className="badge info" style={{ fontVariantNumeric: 'tabular-nums' }}>
        <Icon name="clock" size={14} /> {m}:{String(sec).padStart(2, '0')}
      </span>
      <span className="muted">{L(`${at}까지 날짜가 유지돼요`, `Dates held until ${at}`)}</span>
    </p>
  );
}

/** What is being booked: photo, title, area, rating, dates · guests (with a change link) and the refund timeline. */
function BookingSummary({ p, quote, slug, onPolicy }: { p: any; quote: QuoteView; slug: string; onPolicy: () => void }) {
  const { L, lang } = useI18n();
  const v = propertyView(p);
  const img = realImages([v.cover, ...v.media])[0] || postcardFor(v.city || v.title, v.id);
  const nights = quote.nights ?? 0;
  const policy = f<any>(p, 'cancellationPolicy');
  const first = refundLines(policy, lang, ['체크인', 'check-in'])[0];
  const back = `/stay/${encodeURIComponent(slug)}?checkIn=${quote.checkIn}&checkOut=${quote.checkOut}&guests=${quote.guests ?? ''}`;
  return (
    <div className="stack">
      <div className="row nowrap" style={{ alignItems: 'flex-start', gap: 14 }}>
        <img src={img} alt="" style={{ width: 96, height: 80, objectFit: 'cover', borderRadius: 'var(--r-md)', flex: '0 0 auto' }} />
        <div className="grow">
          <strong style={{ display: 'block', lineHeight: 1.35 }}>{v.title}</strong>
          <span className="small muted">{str(p, 'location.areaLabel') && lang === 'ko' ? str(p, 'location.areaLabel') : placeLabel(v.city, lang)}</span>
          {v.reviewCount > 0 && v.rating !== undefined && (
            <span className="small row" style={{ gap: 4, marginTop: 2 }}>
              <Icon name="star" size={13} filled /> {v.rating.toFixed(2)} <span className="muted">({v.reviewCount})</span>
            </span>
          )}
        </div>
      </div>
      <div className="row between small" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
        <span>
          <strong style={{ display: 'block' }}>{quote.checkIn && quote.checkOut ? formatRange(quote.checkIn, quote.checkOut, lang) : '—'}</strong>
          <span className="muted">{[nights ? L(`${nights}박`, `${nights} night${nights === 1 ? '' : 's'}`) : '', quote.guests ? L(`게스트 ${quote.guests}명`, `${quote.guests} guest${quote.guests === 1 ? '' : 's'}`) : ''].filter(Boolean).join(' · ')}</span>
        </span>
        <Link href={back} className="small">{L('변경', 'Change')}</Link>
      </div>
      {(policy || quote.cancellationPolicy) && (
        <div className="small" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
          <strong style={{ display: 'block' }}>{L('환불 정책', 'Cancellation')} · {policyName(str(policy, 'name') || quote.cancellationPolicy, lang)}</strong>
          {first && <span className="muted">{first}. </span>}
          <button type="button" className="btn link sm" style={{ padding: 0, minHeight: 0 }} onClick={onPolicy}>
            {L('자세히', 'Details')}
          </button>
        </div>
      )}
    </div>
  );
}

function Checkout() {
  const { slug } = useParams<{ slug: string }>();
  const sp = useSearchParams();
  const { L, lang } = useI18n();
  const quoteId = sp.get('quoteId') ?? '';
  const prop = useApi<any>(`/v1/properties/by-slug/${encodeURIComponent(slug)}`);
  const p = item(prop.data);
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [step, setStep] = useState(0);
  const [agree, setAgree] = useState(false);
  const [message, setMessage] = useState('');
  const [hold, setHold] = useState<{ id: string; expiresAt: string } | null>(null);
  const [reservationId, setReservationId] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [doc, setDoc] = useState<'rules' | 'refund' | null>(null);

  useEffect(() => {
    const cached = quoteId ? readQuote(quoteId) : null;
    if (cached) {
      setQuote(quoteView(cached));
      return;
    }
    // Re-quote from URL params when the tab-session cache is missing (e.g. opened in a new tab).
    const checkIn = sp.get('checkIn');
    const checkOut = sp.get('checkOut');
    if (!checkIn || !checkOut) {
      setErr(new ApiError(410, { code: 'QUOTE_EXPIRED' }));
      return;
    }
    (async () => {
      try {
        const pr = item(await get(`/v1/properties/by-slug/${encodeURIComponent(slug)}`));
        const res = await post('/v1/booking/quotes', { propertyId: str(pr, 'id'), checkIn, checkOut, guests: Number(sp.get('guests')) || 1 });
        stashQuote(res);
        setQuote(quoteView(res));
      } catch (e) {
        setErr(e);
      }
    })();
  }, [quoteId, sp, slug]);

  const placeHold = async () => {
    if (!quote) return;
    setBusy(true);
    setErr(null);
    setStep(1);
    try {
      // Idempotency-Key is stable per quote for this tab so a double click / reload replays the same hold.
      const key = stableKey('hold', quote.id, newIdempotencyKey);
      const res = await post('/v1/booking/holds', { quoteId: quote.id }, { idempotencyKey: key });
      const h = item(res);
      // API returns { item: { hold, reservation } } — the reservation (HELD) is created together with the hold.
      const holdId = str(h, 'hold.id', 'holdId', 'id');
      setHold({ id: holdId, expiresAt: str(h, 'hold.expiresAt', 'expiresAt') });
      const rid = str(h, 'reservation.id', 'reservationId');
      if (!rid) throw new Error(L('예약을 만들지 못했습니다. 다시 시도해 주세요.', 'Could not create the reservation. Please try again.'));
      setReservationId(rid);
      // The optional note goes to the host as an inquiry (idempotent per hold). Best effort — never blocks checkout.
      if (message.trim() && quote.propertyId) {
        post('/v1/conversations', {
          contextType: 'INQUIRY',
          targetType: 'PROPERTY',
          targetId: quote.propertyId,
          message: `[${L('예약 진행 중', 'Booking in progress')} ${formatRange(quote.checkIn, quote.checkOut, lang)}] ${message.trim()}`.slice(0, 4000),
          clientMessageId: `hold-note-${holdId}`,
        }).catch(() => undefined);
      }
      setStep(2);
    } catch (e) {
      setErr(e);
      setStep(0);
    } finally {
      setBusy(false);
    }
  };

  const steps = [L('요금 확인', 'Review'), L('날짜 확보', 'Hold'), L('결제', 'Pay'), L('확정', 'Confirmed')];
  const policy = f<any>(p, 'cancellationPolicy');
  const policyLines = refundLines(policy, lang, ['체크인', 'check-in']);
  const v = p ? propertyView(p) : null;
  const rules = f<any>(p, 'houseRules');
  const ruleLines: string[] = rules && typeof rules === 'object' && !Array.isArray(rules)
    ? [
        f(rules, 'smokingAllowed') === false ? L('실내 금연', 'No smoking') : '',
        f(rules, 'petsAllowed') === false ? L('반려동물 동반 불가', 'No pets') : '',
        f(rules, 'eventsAllowed') === false ? L('파티·행사 불가', 'No parties or events') : '',
        str(rules, 'quietHours') ? `${L('정숙 시간', 'Quiet hours')} ${str(rules, 'quietHours')}` : '',
        str(rules, 'extraRules'),
      ].filter(Boolean)
    : Array.isArray(rules)
      ? rules.map((r: any) => (typeof r === 'string' ? r : str(r, 'text', 'label')))
      : [];
  const times = [str(p, 'checkInTime') && `${L('체크인', 'Check-in')} ${str(p, 'checkInTime').slice(0, 5)} ${L('이후', 'or later')}`, str(p, 'checkOutTime') && `${L('체크아웃', 'Check-out')} ${str(p, 'checkOutTime').slice(0, 5)} ${L('이전', 'or earlier')}`].filter(Boolean).join(' · ');

  const holdButton = (block?: boolean) => (
    <Button variant="primary" size={block ? 'md' : 'lg'} block={block} disabled={!agree} loading={busy} onClick={() => void placeHold()} aria-describedby="hold-gate">
      {busy ? L('날짜 확보 중…', 'Holding dates…') : L('날짜 확보하고 결제로', 'Hold dates & continue')}
    </Button>
  );

  return (
    <>
      <PageHeader title={L('예약 및 결제', 'Checkout')} back={`/stay/${slug}?checkIn=${sp.get('checkIn') ?? ''}&checkOut=${sp.get('checkOut') ?? ''}&guests=${sp.get('guests') ?? ''}`} />
      <Steps steps={steps} current={step} />
      {err ? (
        <div className="stack" style={{ marginBottom: 16 }}>
          <ErrorText error={err} />
          <Link className="btn" href={`/stay/${slug}?checkIn=${sp.get('checkIn') ?? ''}&checkOut=${sp.get('checkOut') ?? ''}&guests=${sp.get('guests') ?? ''}`}>
            {L('숙소로 돌아가 다시 견적 받기', 'Back to listing to re-quote')}
          </Link>
        </div>
      ) : null}
      {!quote && !err && (
        <div className="grid-2">
          <div className="stack">
            <Skeleton h={220} r={16} />
          </div>
          <Skeleton h={320} r={24} />
        </div>
      )}
      {quote && (
        <div className="grid-2">
          <div className="stack">
            {step < 2 && (
              <section className="card stack" aria-labelledby="trip-h">
                <h2 id="trip-h">{L('예약 확인', 'Review your booking')}</h2>
                <Textarea label={L('호스트에게 메시지 (선택)', 'Message to host (optional)')} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} placeholder={L('도착 예정 시간이나 함께하는 분을 알려 주세요.', 'Tell the host when you’ll arrive and who’s coming.')} />
                <label className="check">
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                  <span>
                    {L('', 'I agree to the ')}
                    <button type="button" className="btn link sm" style={{ padding: 0, minHeight: 0, verticalAlign: 'baseline' }} onClick={() => setDoc('rules')}>
                      {L('숙소 이용 규칙', 'house rules')}
                    </button>
                    {L(', ', ', ')}
                    <button type="button" className="btn link sm" style={{ padding: 0, minHeight: 0, verticalAlign: 'baseline' }} onClick={() => setDoc('refund')}>
                      {L('환불 정책', 'cancellation policy')}
                    </button>
                    {L(', 개인정보 제3자(호스트) 제공에 동의합니다.', ' and sharing my booking details with the host.')}
                  </span>
                </label>
                <div className="row" style={{ alignItems: 'center' }}>
                  {holdButton()}
                  <span id="hold-gate" className="small muted">
                    {agree ? L('결제하는 동안 날짜를 잠시 확보해 드려요.', 'We hold the dates while you pay.') : L('위 내용에 동의하면 다음 단계로 진행할 수 있어요.', 'Agree to the terms above to continue.')}
                  </span>
                </div>
              </section>
            )}
            {step >= 2 && reservationId && (
              <section className="card stack" id="pay" aria-labelledby="pay-h">
                <h2 id="pay-h">{L('결제', 'Payment')}</h2>
                {hold?.expiresAt && <Countdown until={hold.expiresAt} />}
                <TossPayment subjectType="RESERVATION" subjectId={reservationId} />
              </section>
            )}
          </div>
          <aside className={`card stack sticky-cta ${s.aside}`} aria-label={L('예약 요약', 'Booking summary')}>
            {p ? <BookingSummary p={p} quote={quote} slug={slug} onPolicy={() => setDoc('refund')} /> : <Skeleton h={120} />}
            <div style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              <h2 style={{ fontSize: 'var(--fs-lg)' }}>{L('요금 상세', 'Price details')}</h2>
              <QuoteBreakdown q={quote} />
            </div>
          </aside>
        </div>
      )}
      {quote && step < 2 && (
        <MobileActionBar label={L('결제 요약', 'Checkout summary')}>
          <div className={s.mobileBarPrice}>
            <strong>{formatMoney(quote.totalMinor, quote.currency, lang)}</strong>
            <span>{agree ? L(`총액 · ${quote.nights ?? ''}박`, `Total · ${quote.nights ?? ''} nights`) : L('약관 동의 후 진행할 수 있어요', 'Agree to the terms to continue')}</span>
          </div>
          {holdButton(false)}
        </MobileActionBar>
      )}
      {quote && step >= 2 && (
        <MobileActionBar label={L('결제 요약', 'Checkout summary')}>
          <div className={s.mobileBarPrice}>
            <strong>{formatMoney(quote.totalMinor, quote.currency, lang)}</strong>
            <span>{L('총 결제 금액', 'Total to pay')}</span>
          </div>
          <a className="btn accent" href="#pay">
            {L('결제 수단 선택', 'Choose payment')}
          </a>
        </MobileActionBar>
      )}
      <Modal open={doc !== null} onClose={() => setDoc(null)} title={doc === 'rules' ? L('숙소 이용 규칙', 'House rules') : L('취소 및 환불 정책', 'Cancellation policy')}>
        {doc === 'rules' ? (
          <div className="stack">
            {times && <p style={{ margin: 0, fontWeight: 600 }}>{times}</p>}
            {ruleLines.length ? (
              <ul className="stack" style={{ paddingLeft: 18, margin: 0 }}>
                {ruleLines.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            ) : (
              <p className="muted">{L('호스트가 별도 규칙을 등록하지 않았어요.', 'No additional rules.')}</p>
            )}
            {v && v.maxGuests && <p className="small muted" style={{ margin: 0 }}>{L(`최대 ${v.maxGuests}명까지 머물 수 있어요.`, `Up to ${v.maxGuests} guests.`)}</p>}
          </div>
        ) : (
          <div className="stack">
            {policy && <strong>{policyName(str(policy, 'name'), lang)}</strong>}
            {policyLines.length ? (
              <ul className="stack" style={{ paddingLeft: 18, margin: 0 }}>
                {policyLines.map((r, i) => <li key={i}>{r}</li>)}
              </ul>
            ) : (
              <p className="muted">{quote?.cancellationPolicy || L('호스트의 환불 정책을 따릅니다.', 'The host’s cancellation policy applies.')}</p>
            )}
            <p className="small muted" style={{ margin: 0 }}>{L('예약 후에는 내 여행에서 취소 전 환불 예상액을 확인할 수 있어요.', 'After booking you can preview the refund in Trips before cancelling.')}</p>
          </div>
        )}
      </Modal>
    </>
  );
}

export default function StayCheckoutView() {
  return (
    <RequireAuth>
      <Checkout />
    </RequireAuth>
  );
}
