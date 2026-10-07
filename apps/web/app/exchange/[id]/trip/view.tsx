'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { f, str } from '@/lib/shape';
import { formatRange } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, ErrorText, Kv, Section, Button } from '@/components/ui';
import { ExchangeHeader, exchangeView } from '../../shared';

export default function ExchangeTripView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const st = useApi<any>(`/v1/exchanges/${id}`, { auth: true });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <RequireAuth>
      <StateView state={st} skeleton="detail">
        {(d) => {
          const x = exchangeView(d, user?.id);
          const confirmed = ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED'].includes(x.status);
          const iAmA = x.role === 'REQUESTER';
          // A stays at home B during datesB; B stays at home A during datesA.
          const myStayHome = iAmA ? x.propertyB : x.propertyA;
          const myStayDates = iAmA ? x.datesB : x.datesA;
          const addr = f<any>(x.addresses, iAmA ? 'B' : 'A');
          return (
            <>
              <ExchangeHeader x={x} />
              {!confirmed ? (
                <Alert tone="warn">{L('맞교환이 확정된 후 주소가 공개됩니다.', 'The address appears after confirmation.')}</Alert>
              ) : (
                <Section title={L('내가 머무를 집', 'Where I’m staying')}>
                  <div className="card">
                    <Kv
                      rows={[
                        [L('집', 'Home'), str(myStayHome, 'title') || '—'],
                        [L('기간', 'Dates'), myStayDates.start ? formatRange(myStayDates.start, myStayDates.end, lang) : '—'],
                        [L('주소', 'Address'), addr ? [str(addr, 'line1'), str(addr, 'line2'), str(addr, 'city'), str(addr, 'postalCode')].filter(Boolean).join(', ') : L('메시지로 안내됩니다', 'Shared in messages')],
                      ]}
                    />
                  </div>
                </Section>
              )}
              <div className="row" style={{ marginTop: 16 }}>
                {x.conversationId && <Link className="btn" href={`/messages?c=${x.conversationId}`}>{L('상대와 메시지', 'Message')}</Link>}
                <Link className="btn ghost" href={`/support/disputes?subjectType=EXCHANGE&subjectId=${id}`}>{L('문제 신고', 'Report a problem')}</Link>
                {x.status === 'IN_PROGRESS' && (
                  <Button
                    variant="primary"
                    loading={busy}
                    onClick={async () => {
                      if (!window.confirm(L('맞교환을 완료 처리할까요? (양측 체크아웃 후)', 'Mark the exchange completed? (after both checked out)'))) return;
                      setBusy(true);
                      setErr(null);
                      try {
                        await post(`/v1/exchanges/${id}/complete`, {});
                        st.reload();
                      } catch (e) {
                        setErr(e);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {L('맞교환 완료', 'Complete exchange')}
                  </Button>
                )}
                {['CONFIRMED'].includes(x.status) && (
                  <Button
                    variant="danger"
                    onClick={async () => {
                      const reason = window.prompt(L('취소 사유를 입력하세요 (상대방에게 전달)', 'Cancellation reason (shared)'));
                      if (!reason || reason.trim().length < 3) return;
                      setErr(null);
                      try {
                        await post(`/v1/exchanges/${id}/cancel`, { reason });
                        st.reload();
                      } catch (e) {
                        setErr(e);
                      }
                    }}
                  >
                    {L('맞교환 취소', 'Cancel exchange')}
                  </Button>
                )}
                {['COMPLETED'].includes(x.status) && <Link className="btn accent" href={`/reviews?targetType=USER&subjectType=EXCHANGE&subjectId=${id}`}>{L('후기 쓰기', 'Write review')}</Link>}
              </div>
              <ErrorText error={err} />
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
