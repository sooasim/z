'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { str } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, ErrorText, Kv, Section } from '@/components/ui';
import { ExchangeHeader, exchangeView } from '../../shared';

export default function ExchangeTripView() {
  const { id } = useParams<{ id: string }>();
  const { L } = useI18n();
  const { user } = useAuth();
  const st = useApi<any>(`/v1/exchanges/${id}`, { auth: true });
  const [err, setErr] = useState<unknown>(null);
  return (
    <RequireAuth>
      <StateView state={st}>
        {(d) => {
          const x = exchangeView(d);
          const confirmed = ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED'].includes(x.status);
          const iAmRequester = user?.id === x.requesterId;
          const theirHome = iAmRequester ? x.counterpartProperty : x.requesterProperty;
          return (
            <>
              <ExchangeHeader x={x} />
              {!confirmed ? (
                <Alert tone="warn">{L('맞교환이 확정된 후 주소와 체크인 안내가 공개됩니다.', 'Address and check-in details appear after confirmation.')}</Alert>
              ) : (
                <Section title={L('내가 머무를 집', 'Where I am staying')}>
                  <div className="card">
                    <Kv
                      rows={[
                        [L('집', 'Home'), str(theirHome, 'title', 'name')],
                        [L('주소', 'Address'), str(theirHome, 'address', 'exactAddress') || str(x.raw, 'counterpartAddress', 'address') || L('메시지로 안내됩니다', 'Shared in messages')],
                        [L('체크인 안내', 'Check-in'), str(theirHome, 'checkInInstructions') || '—'],
                      ]}
                    />
                  </div>
                </Section>
              )}
              <div className="row" style={{ marginTop: 16 }}>
                {x.conversationId && <Link className="btn" href={`/messages?c=${x.conversationId}`}>{L('상대와 메시지', 'Message')}</Link>}
                <Link className="btn ghost" href={`/support/disputes?subjectType=EXCHANGE&subjectId=${id}`}>{L('문제 신고', 'Report a problem')}</Link>
                {['CONFIRMED', 'IN_PROGRESS'].includes(x.status) && (
                  <button
                    className="btn primary"
                    onClick={async () => {
                      if (!window.confirm(L('맞교환을 완료 처리할까요? (양측 체크아웃 후)', 'Mark the exchange completed? (after both checked out)'))) return;
                      setErr(null);
                      try {
                        await post(`/v1/exchanges/${id}/complete`, { version: x.version }, { idempotencyKey: `xcomplete-${id}` });
                        st.reload();
                      } catch (e) {
                        setErr(e);
                      }
                    }}
                  >
                    {L('맞교환 완료', 'Complete exchange')}
                  </button>
                )}
                {x.status === 'COMPLETED' && <Link className="btn primary" href={`/reviews?targetType=USER&subjectType=EXCHANGE&subjectId=${id}`}>{L('후기 쓰기', 'Write review')}</Link>}
              </div>
              <ErrorText error={err} />
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
