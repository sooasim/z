'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { subjectHref } from '@/lib/payment';
import { Alert, PageHeader } from '@/components/ui';

export default function CheckoutFailView() {
  const sp = useSearchParams();
  const { L } = useI18n();
  const code = sp.get('code') ?? '';
  const message = sp.get('message') ?? '';
  const cancelled = code === 'PAY_PROCESS_CANCELED' || code === 'USER_CANCEL';
  return (
    <>
      <PageHeader title={cancelled ? L('결제가 취소되었습니다', 'Payment cancelled') : L('결제에 실패했습니다', 'Payment failed')} />
      <Alert tone={cancelled ? 'warn' : 'error'}>
        {message || L('결제가 완료되지 않았습니다. 다시 시도해 주세요.', 'Payment did not complete. Please retry.')}
        {code && <span className="mono small"> ({code})</span>}
      </Alert>
      <p className="muted" style={{ marginTop: 12 }}>
        {L('홀드 시간이 남아 있다면 같은 예약으로 다시 결제할 수 있습니다. 시간이 지나면 날짜가 자동 해제됩니다.', 'If your hold is still active you can retry; otherwise the dates are released automatically.')}
      </p>
      <div className="row">
        {sp.get('subjectId') && (
          <Link className="btn primary" href={subjectHref(sp.get('subjectType') ?? '', sp.get('subjectId') ?? '')}>
            {L('예약으로 돌아가기', 'Back to booking')}
          </Link>
        )}
        <Link className="btn" href="/">
          {L('홈', 'Home')}
        </Link>
      </div>
    </>
  );
}
