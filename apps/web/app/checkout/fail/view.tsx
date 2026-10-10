'use client';
import { useSearchParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { subjectHref } from '@/lib/payment';
import { ButtonLink, Steps } from '@/components/ui';
import { EmptyState } from '@/components/states';
import { styles as s } from '@/components/traveler/ui';
import { pickPair } from '@/lib/phrases';

/** Friendly copy for common TossPayments failure codes (the PG message is shown when we don't know the code). */
const CODES: Record<string, [string, string]> = {
  PAY_PROCESS_CANCELED: ['결제를 취소했어요', 'You cancelled the payment'],
  USER_CANCEL: ['결제를 취소했어요', 'You cancelled the payment'],
  PAY_PROCESS_ABORTED: ['결제가 중단되었어요', 'The payment was interrupted'],
  REJECT_CARD_COMPANY: ['카드사에서 결제를 승인하지 않았어요', 'Your card issuer declined the payment'],
  REJECT_CARD_PAYMENT: ['카드 결제가 거절되었어요', 'The card payment was declined'],
  INVALID_CARD_EXPIRATION: ['카드 유효기간을 확인해 주세요', 'Check your card’s expiry date'],
  EXCEED_MAX_DAILY_PAYMENT_COUNT: ['오늘 결제 가능 횟수를 초과했어요', 'Daily payment limit reached'],
  EXCEED_MAX_AMOUNT: ['결제 한도를 초과했어요', 'Payment limit exceeded'],
  NOT_ENOUGH_BALANCE: ['잔액이 부족해요', 'Insufficient balance'],
};

export default function CheckoutFailView() {
  const sp = useSearchParams();
  const { L, lang } = useI18n();
  const code = sp.get('code') ?? '';
  const message = sp.get('message') ?? '';
  const known = CODES[code.toUpperCase()];
  const cancelled = code === 'PAY_PROCESS_CANCELED' || code === 'USER_CANCEL';
  const type = (sp.get('subjectType') ?? '').toUpperCase();
  const id = sp.get('subjectId') ?? '';
  const isStay = type === 'RESERVATION';
  const steps = isStay ? [L('요금 확인', 'Review'), L('날짜 확보', 'Hold'), L('결제', 'Pay'), L('확정', 'Confirmed')] : [L('상품 선택', 'Choose'), L('결제', 'Pay'), L('확정', 'Confirmed')];
  const title = known ? pickPair(known, lang) : L('결제가 완료되지 않았어요', 'Payment didn’t go through');
  const retryHref = id && ['RESERVATION', 'ORDER', 'GUIDE_BOOKING'].includes(type) ? `/checkout?type=${type}&id=${id}` : '';
  return (
    <>
      <Steps steps={steps} current={steps.length - 2} />
      <EmptyState
        illo={cancelled ? 'generic' : 'error'}
        as="h1"
        title={title}
        action={
          <>
            {retryHref && (
              <ButtonLink variant="primary" href={retryHref} icon="refresh">
                {L('다시 결제하기', 'Try again')}
              </ButtonLink>
            )}
            {id && <ButtonLink href={subjectHref(type, id)}>{L('예약으로 돌아가기', 'Back to booking')}</ButtonLink>}
            {!id && <ButtonLink href="/trips">{L('내 여행', 'My trips')}</ButtonLink>}
          </>
        }
      >
        <div className="stack" style={{ maxWidth: 520, margin: '0 auto' }}>
          {message && !known && <p style={{ margin: 0 }}>{message}</p>}
          <p className="muted small" style={{ margin: 0 }}>
            {cancelled
              ? L('결제창을 닫아 결제가 진행되지 않았어요. 청구된 금액은 없어요.', 'The payment window was closed, so nothing was charged.')
              : L('청구된 금액은 없어요. 날짜·좌석 확보 시간이 남아 있다면 같은 예약으로 다시 결제할 수 있어요. 시간이 지나면 자동으로 해제돼요.', 'Nothing was charged. If your hold is still active you can retry; otherwise it’s released automatically.')}
          </p>
          {code && <p className={s.ref} style={{ margin: 0 }}>ref: {code}</p>}
        </div>
      </EmptyState>
    </>
  );
}
