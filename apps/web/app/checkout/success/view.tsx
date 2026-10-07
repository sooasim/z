'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { get, post } from '@/lib/api';
import { item, str } from '@/lib/shape';
import { paymentPhase, paymentSubject, subjectHref } from '@/lib/payment';
import { Alert, ErrorText, PageHeader, Spinner, Money } from '@/components/ui';
import { RequireAuth } from '@/components/gate';
import { ApiError } from '@/lib/errors';

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
          const row = pid ? item(res) : (Array.isArray(res?.items) ? res.items[0] : item(res));
          setPayment(row);
          ph = paymentPhase({ item: row });
        }
        setPhase(ph === 'approved' ? 'approved' : ph === 'failed' ? 'failed' : 'pending');
      } catch (e) {
        setErr(e);
        setPhase('failed');
      }
    })();
  }, [paymentKey, orderId, amount, L]);

  const subj = payment ? paymentSubject({ item: payment }) : { type: sp.get('subjectType') ?? '', id: sp.get('subjectId') ?? '' };
  const type = subj.type || sp.get('subjectType') || '';
  const id = subj.id || sp.get('subjectId') || '';

  return (
    <>
      <PageHeader title={L('결제 확인', 'Payment confirmation')} />
      {phase === 'confirming' && <Spinner label={L('결제를 확인하고 있습니다… 창을 닫지 마세요.', 'Confirming your payment… please keep this page open.')} />}
      {phase === 'pending' && (
        <div className="stack">
          <Spinner label={L('결제 승인 대기 중… 승인되면 자동으로 갱신됩니다.', 'Awaiting approval… this page updates automatically.')} />
          <Alert tone="info">{L('승인이 지연되면 내 결제 내역에서 상태를 확인할 수 있습니다. 승인 전에는 예약이 확정되지 않습니다.', 'If approval is delayed, check Payments. Nothing is confirmed until approved.')}</Alert>
          <Link href="/payments">{L('결제 내역 보기', 'View payments')}</Link>
        </div>
      )}
      {phase === 'approved' && (
        <div className="state stack" role="status">
          <h2>✅ {L('결제가 승인되었습니다', 'Payment approved')}</h2>
          <p>
            <Money minor={str(payment, 'amountMinor', 'amount') || amount} currency={str(payment, 'currency') || 'KRW'} />
          </p>
          <p className="muted small mono">
            {L('주문번호', 'Order')} {orderId}
          </p>
          <div className="row" style={{ justifyContent: 'center' }}>
            <Link className="btn primary" href={subjectHref(type, id)}>
              {L('예약/주문 상세 보기', 'View booking')}
            </Link>
            <Link className="btn" href="/trips">
              {L('내 여행', 'My trips')}
            </Link>
          </div>
        </div>
      )}
      {phase === 'failed' && (
        <div className="stack">
          <ErrorText error={err ?? new Error(L('결제가 승인되지 않았습니다.', 'Payment was not approved.'))} />
          <p>{L('결제가 확정되지 않았습니다. 청구된 금액이 있다면 자동으로 취소됩니다.', 'Payment not confirmed. Any authorisation will be voided.')}</p>
          <Link className="btn" href="/trips">
            {L('내 여행으로', 'Go to trips')}
          </Link>
        </div>
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
