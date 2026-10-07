'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { arr, item, str } from '@/lib/shape';
import { formatRange, parseDateRange } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { DateText, Kv, Money, PageHeader, Section, StatusBadge, Alert } from '@/components/ui';

export function reservationRange(r: any) {
  const dr = parseDateRange(r?.during ?? r?.stay_range ?? r?.range);
  return { start: dr?.start ?? str(r, 'checkIn', 'startDate'), end: dr?.end ?? str(r, 'checkOut', 'endDate') };
}

export default function TripDetailView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const st = useApi<any>(`/v1/reservations/${id}`, { auth: true });
  return (
    <RequireAuth>
      <StateView state={st}>
        {(d) => {
          const r = item(d);
          const { start, end } = reservationRange(r);
          const status = str(r, 'status', 'state').toUpperCase();
          const history = arr(r, 'history', 'transitions', 'stateHistory');
          const address = str(r, 'address', 'exactAddress', 'property.address');
          return (
            <>
              <PageHeader
                title={str(r, 'propertyTitle', 'property.title') || L('숙소 예약', 'Reservation')}
                subtitle={start && end ? formatRange(start, end, lang) : undefined}
                back="/trips"
                actions={
                  <>
                    <StatusBadge status={status} />
                    <Link className="btn" href={`/trips/${id}/manage`}>{L('예약 관리', 'Manage')}</Link>
                  </>
                }
              />
              {status === 'PAYMENT_PENDING' && (
                <Alert tone="warn">
                  {L('결제 승인 대기 중입니다. 승인 전에는 예약이 확정되지 않습니다.', 'Awaiting payment approval. Not confirmed yet.')}{' '}
                  <Link href={`/checkout?type=RESERVATION&id=${id}`}>{L('결제 계속하기', 'Continue payment')}</Link>
                </Alert>
              )}
              <div className="grid-2">
                <section className="card stack">
                  <Kv
                    rows={[
                      [L('예약 번호', 'Reservation'), <span className="mono" key="i">{str(r, 'code', 'id')}</span>],
                      [L('인원', 'Guests'), str(r, 'guests', 'guestCount') || '—'],
                      [L('주소', 'Address'), address || L('예약 확정 후 공개', 'Shown after confirmation')],
                      [L('체크인 안내', 'Check-in'), str(r, 'checkInInstructions') || '—'],
                      [L('환불 정책', 'Cancellation'), str(r, 'cancellationPolicy', 'cancellationPolicyCode') || '—'],
                    ]}
                  />
                  <div className="row">
                    {str(r, 'conversationId') && <Link className="btn" href={`/messages?c=${str(r, 'conversationId')}`}>{L('호스트에게 메시지', 'Message host')}</Link>}
                    {status === 'COMPLETED' && <Link className="btn" href={`/reviews?targetType=PROPERTY&subjectType=RESERVATION&subjectId=${id}`}>{L('후기 쓰기', 'Write review')}</Link>}
                    <Link className="btn ghost" href={`/support/disputes?subjectType=RESERVATION&subjectId=${id}`}>{L('문제 신고', 'Report a problem')}</Link>
                  </div>
                </section>
                <aside className="card stack">
                  <h2>{L('결제', 'Payment')}</h2>
                  <p>
                    <strong><Money minor={str(r, 'totalMinor', 'amountMinor')} currency={str(r, 'currency') || 'KRW'} /></strong>
                  </p>
                  <Link href="/payments">{L('영수증·환불 내역', 'Receipts & refunds')}</Link>
                </aside>
              </div>
              {history.length > 0 && (
                <Section title={L('상태 이력', 'Timeline')}>
                  <ol className="stack">
                    {history.map((h: any, i: number) => (
                      <li key={i}>
                        <StatusBadge status={str(h, 'toState', 'to', 'status')} /> <DateText value={str(h, 'createdAt', 'at')} time /> {str(h, 'reason') && <span className="muted small">— {str(h, 'reason')}</span>}
                      </li>
                    ))}
                  </ol>
                </Section>
              )}
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
