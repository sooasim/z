'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { item, str, num } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, DateText, ErrorText, Kv, Money, PageHeader, StatusBadge } from '@/components/ui';

export default function GuideBookingView() {
  const { id } = useParams<{ id: string }>();
  const { L } = useI18n();
  const { user } = useAuth();
  const st = useApi<any>(`/v1/guide-bookings/${id}`, { auth: true });
  const [err, setErr] = useState<unknown>(null);
  const act = async (a: string, body: any = {}) => {
    setErr(null);
    try {
      await post(`/v1/guide-bookings/${id}/${a}`, body, { idempotencyKey: `gb-${a}-${id}` });
      st.reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <RequireAuth>
      <StateView state={st}>
        {(d) => {
          const b = item(d);
          const status = str(b, 'status', 'state').toUpperCase();
          const price = num(b, 'amountMinor', 'priceMinor', 'totalMinor') ?? 0;
          const isGuide = str(b, 'guideId', 'guideUserId') === user?.id;
          return (
            <>
              <PageHeader title={L('가이드 예약', 'Guide booking')} back="/trips?tab=guides" actions={<StatusBadge status={status} />} />
              {status === 'PAYMENT_PENDING' && !isGuide && (
                <Alert tone="warn">
                  {L('결제가 완료되어야 예약이 확정됩니다.', 'Pay to confirm this booking.')} <Link className="btn sm primary" href={`/checkout?type=GUIDE_BOOKING&id=${id}`}>{L('결제하기', 'Pay now')}</Link>
                </Alert>
              )}
              <div className="card">
                <Kv
                  rows={[
                    [L('가이드', 'Guide'), str(b, 'guideName', 'guide.displayName')],
                    [L('여행자', 'Traveler'), str(b, 'travelerName', 'traveler.displayName')],
                    [L('시작', 'Starts'), <DateText key="s" value={str(b, 'startsAt', 'startAt')} time />],
                    [L('종료', 'Ends'), <DateText key="e" value={str(b, 'endsAt', 'endAt')} time />],
                    [L('만남 장소', 'Meeting point'), str(b, 'meetingPoint') || L('메시지로 조율', 'Coordinate in messages')],
                    [L('금액', 'Price'), price ? <Money key="m" minor={price} currency={str(b, 'currency') || 'KRW'} /> : L('무료', 'Free')],
                  ]}
                />
              </div>
              <div className="row" style={{ marginTop: 16 }}>
                {str(b, 'conversationId') && <Link className="btn" href={`/messages?c=${str(b, 'conversationId')}`}>{L('메시지', 'Message')}</Link>}
                {['CONFIRMED', 'PAYMENT_PENDING', 'SCHEDULED'].includes(status) && <button className="btn" onClick={() => window.confirm(L('예약을 취소할까요?', 'Cancel booking?')) && act('cancel', { reason: 'USER_REQUEST' })}>{L('취소', 'Cancel')}</button>}
                {isGuide && ['CONFIRMED', 'IN_PROGRESS', 'SCHEDULED'].includes(status) && <button className="btn primary" onClick={() => act('complete')}>{L('진행 완료', 'Mark completed')}</button>}
                {status === 'COMPLETED' && <Link className="btn primary" href={`/reviews?targetType=GUIDE&subjectType=GUIDE_BOOKING&subjectId=${id}`}>{L('후기 쓰기', 'Write review')}</Link>}
                <Link className="btn ghost" href={`/support/disputes?subjectType=GUIDE_BOOKING&subjectId=${id}`}>{L('문제 신고', 'Report')}</Link>
              </div>
              <ErrorText error={err} />
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
