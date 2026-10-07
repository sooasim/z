'use client';
import { useEffect, useRef, useState } from 'react';
import { post, newIdempotencyKey } from '@/lib/api';
import { loadScript, parsePrepare, TOSS_SDK, type Prepared } from '@/lib/payment';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { Alert, ErrorText, Money, Spinner } from './ui';

declare global {
  interface Window {
    TossPayments?: (clientKey: string) => any;
  }
}

/**
 * Embedded TossPayments v2 payment widget (PAY-01). Card data is entered only inside Toss-hosted iframes
 * (invariant 9). Success redirect lands on /checkout/success which confirms server-side (invariant 3).
 */
export function TossPayment({ subjectType, subjectId, onPrepared }: { subjectType: 'RESERVATION' | 'GUIDE_BOOKING' | 'ORDER'; subjectId: string; onPrepared?: (p: Prepared) => void }) {
  const { L } = useI18n();
  const { user } = useAuth();
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [ready, setReady] = useState(false);
  const [paying, setPaying] = useState(false);
  const widgetsRef = useRef<any>(null);
  const keyRef = useRef<string>('');
  if (!keyRef.current) keyRef.current = newIdempotencyKey();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await post('/v1/payments/toss/prepare', { subjectType, subjectId }, { idempotencyKey: keyRef.current });
        const p = parsePrepare(res);
        if (cancelled) return;
        setPrep(p);
        onPrepared?.(p);
        if (p.provider !== 'TOSS' || !p.clientKey) {
          setReady(true);
          return;
        }
        await loadScript(TOSS_SDK);
        if (cancelled || !window.TossPayments) return;
        const toss = window.TossPayments(p.clientKey);
        const widgets = toss.widgets({ customerKey: p.customerKey || user?.id || 'ANONYMOUS' });
        await widgets.setAmount({ currency: p.currency || 'KRW', value: p.amount });
        await Promise.all([widgets.renderPaymentMethods({ selector: '#toss-methods', variantKey: 'DEFAULT' }), widgets.renderAgreement({ selector: '#toss-agreement', variantKey: 'AGREEMENT' })]);
        widgetsRef.current = widgets;
        setReady(true);
      } catch (e) {
        if (!cancelled) setErr(e);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subjectType, subjectId]);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const back = `subjectType=${subjectType}&subjectId=${encodeURIComponent(subjectId)}`;

  const pay = async () => {
    if (!prep) return;
    setPaying(true);
    setErr(null);
    try {
      if (prep.provider !== 'TOSS' || !widgetsRef.current) {
        // MOCK provider (staging/dev): simulate the PG redirect. The API still performs confirmation.
        window.location.href = `/checkout/success?paymentKey=${encodeURIComponent('mock_' + prep.orderId)}&orderId=${encodeURIComponent(prep.orderId)}&amount=${prep.amount}&${back}`;
        return;
      }
      await widgetsRef.current.requestPayment({
        orderId: prep.orderId,
        orderName: prep.orderName,
        successUrl: `${origin}/checkout/success?${back}`,
        failUrl: `${origin}/checkout/fail?${back}`,
        customerEmail: prep.customerEmail || user?.email || undefined,
        customerName: prep.customerName || user?.displayName || undefined,
      });
    } catch (e) {
      setErr(e);
      setPaying(false);
    }
  };

  if (err) return <ErrorText error={err} />;
  if (!prep) return <Spinner label={L('결제 준비 중…', 'Preparing payment…')} />;
  return (
    <div className="stack">
      <div className="row between">
        <strong>{L('결제 금액', 'Amount')}</strong>
        <strong>
          <Money minor={prep.amount} currency={prep.currency} />
        </strong>
      </div>
      {prep.provider !== 'TOSS' && <Alert tone="warn">{L('테스트 결제 모드(MOCK)입니다. 실제 청구되지 않습니다.', 'Test payment mode (MOCK). No real charge.')}</Alert>}
      <div id="toss-methods" />
      <div id="toss-agreement" />
      {!ready && <Spinner label={L('결제 수단 불러오는 중…', 'Loading payment methods…')} />}
      <button className="btn primary block" onClick={pay} disabled={!ready || paying}>
        {paying ? L('결제창 여는 중…', 'Opening…') : L('결제하기', 'Pay now')}
      </button>
      <p className="small muted">{L('카드 정보는 토스페이먼츠 결제창에서만 입력되며 JETPOOL에 저장되지 않습니다. 결제 확정은 서버 승인 후에만 이루어집니다.', 'Card details are entered only in the TossPayments window. Payment is final only after server approval.')}</p>
    </div>
  );
}
