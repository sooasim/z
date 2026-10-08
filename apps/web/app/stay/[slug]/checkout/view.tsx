'use client';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { get, newIdempotencyKey, post } from '@/lib/api';
import { item, str } from '@/lib/shape';
import { formatRange } from '@/lib/format';
import { quoteView, readQuote, stableKey, stashQuote, type QuoteView } from '@/lib/quote';
import { RequireAuth } from '@/components/gate';
import { QuoteBreakdown } from '@/components/quote';
import { TossPayment } from '@/components/payment';
import { Alert, ErrorText, PageHeader, Spinner, Steps, Textarea } from '@/components/ui';
import { ApiError } from '@/lib/errors';

function Countdown({ until }: { until: string }) {
  const { L } = useI18n();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(until).getTime() - now;
  if (!Number.isFinite(ms)) return null;
  if (ms <= 0) return <Alert tone="error">{L('홀드가 만료되었습니다. 다시 견적을 받아 주세요.', 'Hold expired. Please re-quote.')}</Alert>;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return (
    <Alert tone="warn">
      {L('날짜를 임시로 확보했습니다. 남은 시간', 'Dates held for')} <strong aria-live="off">{m}:{String(s).padStart(2, '0')}</strong>
    </Alert>
  );
}

function Checkout() {
  const { slug } = useParams<{ slug: string }>();
  const sp = useSearchParams();
  const { L, lang } = useI18n();
  const quoteId = sp.get('quoteId') ?? '';
  const [quote, setQuote] = useState<QuoteView | null>(null);
  const [step, setStep] = useState(0);
  const [agree, setAgree] = useState(false);
  const [message, setMessage] = useState('');
  const [hold, setHold] = useState<{ id: string; expiresAt: string } | null>(null);
  const [reservationId, setReservationId] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

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
        const prop = item(await get(`/v1/properties/by-slug/${encodeURIComponent(slug)}`));
        const res = await post('/v1/booking/quotes', { propertyId: str(prop, 'id'), checkIn, checkOut, guests: Number(sp.get('guests')) || 1 });
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
      // The hold takes only { quoteId }; the reservation conversation opens on confirmation. Deliver the optional
      // note now as an inquiry to the host (idempotent per hold). Best effort — never blocks checkout.
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
    } finally {
      setBusy(false);
    }
  };

  const steps = [L('요금 확인', 'Review'), L('날짜 확보', 'Hold'), L('결제', 'Pay'), L('확정', 'Confirmed')];

  return (
    <>
      <PageHeader title={L('예약 및 결제', 'Checkout')} back={`/stay/${slug}`} />
      <Steps steps={steps} current={step} />
      {err ? (
        <div className="stack">
          <ErrorText error={err} />
          <Link className="btn" href={`/stay/${slug}?checkIn=${sp.get('checkIn') ?? ''}&checkOut=${sp.get('checkOut') ?? ''}&guests=${sp.get('guests') ?? ''}`}>
            {L('숙소로 돌아가 다시 견적 받기', 'Back to listing to re-quote')}
          </Link>
        </div>
      ) : null}
      {!quote && !err && <Spinner />}
      {quote && (
        <div className="grid-2">
          <div className="stack">
            {step < 2 && (
              <section className="card stack">
                <h2>{L('예약 정보', 'Your trip')}</h2>
                <p>
                  {quote.checkIn && quote.checkOut ? formatRange(quote.checkIn, quote.checkOut, lang) : ''} {quote.guests ? `· ${quote.guests}${L('명', ' guests')}` : ''}
                </p>
                <Textarea label={L('호스트에게 메시지 (선택)', 'Message to host (optional)')} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={1000} />
                <label className="check">
                  <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                  <span>{L('숙소 규칙, 환불 정책, 개인정보 제3자(호스트) 제공에 동의합니다.', 'I agree to house rules, cancellation policy and sharing details with the host.')}</span>
                </label>
                <button
                  className="btn primary"
                  disabled={!agree || busy}
                  onClick={() => {
                    setStep(1);
                    void placeHold();
                  }}
                >
                  {busy ? L('날짜 확보 중…', 'Holding dates…') : L('날짜 확보하고 결제로', 'Hold dates & continue')}
                </button>
              </section>
            )}
            {step >= 2 && reservationId && (
              <section className="card stack">
                <h2>{L('결제', 'Payment')}</h2>
                {hold?.expiresAt && <Countdown until={hold.expiresAt} />}
                <TossPayment subjectType="RESERVATION" subjectId={reservationId} />
              </section>
            )}
          </div>
          <aside className="card stack">
            <h2>{L('요금 상세', 'Price details')}</h2>
            <QuoteBreakdown q={quote} />
            {quote.cancellationPolicy && <p className="small">{L('환불 정책', 'Cancellation')}: {quote.cancellationPolicy}</p>}
          </aside>
        </div>
      )}
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

