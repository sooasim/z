'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { f } from '@/lib/shape';
import { formatRange } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { Alert, Button, ButtonLink, Icon, Kv, Section, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { formatAddress } from '@/components/public/labels';
import { ExchangeHeader, exchangeView, homeTitle } from '../../shared';
import s from '@/components/public/public.module.css';

export default function ExchangeTripView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const st = useApi<any>(`/v1/exchanges/${id}`, { auth: true });
  return (
    <RequireAuth>
      {dialog}
      <StateView state={st} skeleton="detail">
        {(d) => {
          const x = exchangeView(d, user?.id);
          const confirmed = ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED'].includes(x.status);
          const iAmA = x.role === 'REQUESTER';
          const addr = f<any>(x.addresses, iAmA ? 'B' : 'A');
          const theirT = homeTitle(x.theirHome, L('상대 집', 'their home'));
          const myT = homeTitle(x.myHome, L('내 집', 'my home'));
          const complete = () =>
            confirm({
              title: L('맞교환을 완료 처리할까요?', 'Mark this exchange completed?'),
              body: L('양쪽 모두 체크아웃한 뒤에 완료해 주세요. 완료하면 서로 후기를 남길 수 있어요.', 'Complete it after both of you have checked out. You can then review each other.'),
              tone: 'primary',
              confirmLabel: L('완료 처리', 'Mark completed'),
              run: async () => {
                await post(`/v1/exchanges/${id}/complete`, {});
                toast.show(L('맞교환을 완료했어요', 'Exchange completed'));
                st.reload();
              },
            });
          const cancel = () =>
            confirm({
              title: L('확정된 맞교환을 취소할까요?', 'Cancel this confirmed exchange?'),
              body: (
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  <li>{L(`${theirT}과 ${myT}의 일정 잠금이 함께 풀려요.`, `Both ${theirT} and ${myT} are released.`)}</li>
                  <li>{L('상대방에게 즉시 알림이 가고, 사유가 함께 전달돼요.', 'The other member is notified right away with your reason.')}</li>
                  <li>{L('출발이 임박한 취소는 이후 맞교환 자격에 영향을 줄 수 있어요.', 'Late cancellations can affect your future exchange eligibility.')}</li>
                </ul>
              ),
              tone: 'danger',
              confirmLabel: L('맞교환 취소', 'Cancel exchange'),
              cancelLabel: L('유지하기', 'Keep it'),
              requireReason: L('취소 사유 (상대에게 전달돼요)', 'Reason (shared with the other member)'),
              reasonMinLength: 3,
              run: async (reason) => {
                await post(`/v1/exchanges/${id}/cancel`, { reason });
                toast.show(L('맞교환을 취소했어요', 'Exchange cancelled'));
                st.reload();
              },
            });
          return (
            <>
              <ExchangeHeader x={x} />
              {!confirmed ? (
                <EmptyState illo="lock" title={L('맞교환이 확정되면 주소를 알려드려요', 'The address appears once confirmed')} action={<ButtonLink href={`/exchange/${id}`} variant="primary">{L('진행 상황 보기', 'See progress')}</ButtonLink>}>
                  {L('양측 서명과 확정이 끝나면 머무를 집의 정확한 주소와 입실 안내가 이곳에 표시돼요.', 'After both sign and confirm, the exact address and check-in details show up here.')}
                </EmptyState>
              ) : (
                <>
                  <Section title={L('내가 머무를 집', 'Where I’m staying')}>
                    <div className="card">
                      <Kv
                        rows={[
                          [L('집', 'Home'), theirT],
                          [L('기간', 'Dates'), x.myStay.start ? formatRange(x.myStay.start, x.myStay.end, lang, { nights: true }) : '—'],
                          [L('인원', 'Guests'), x.myGuests ? L(`${x.myGuests}명`, `${x.myGuests}`) : '—'],
                          [L('주소', 'Address'), addr ? formatAddress(addr, lang) : L('메시지로 안내돼요', 'Shared in messages')],
                        ]}
                      />
                    </div>
                  </Section>
                  <Section title={L('상대가 머무를 내 집', 'Guests at my home')}>
                    <div className="card">
                      <Kv
                        rows={[
                          [L('집', 'Home'), myT],
                          [L('기간', 'Dates'), x.theirStay.start ? formatRange(x.theirStay.start, x.theirStay.end, lang, { nights: true }) : '—'],
                          [L('인원', 'Guests'), x.theirGuests ? L(`${x.theirGuests}명`, `${x.theirGuests}`) : '—'],
                        ]}
                      />
                    </div>
                    <Alert>{L('도착 전에 집 안내서(와이파이, 쓰레기 배출, 비상 연락처)를 메시지로 공유해 주세요.', 'Before arrival, share a house guide (Wi-Fi, rubbish, emergency contacts) in messages.')}</Alert>
                  </Section>
                </>
              )}
              <Section title={L('도움이 필요하신가요?', 'Need anything?')}>
                <div className={s.actionsStack}>
                  {x.conversationId && (
                    <ButtonLink href={`/messages?c=${x.conversationId}`} variant="primary" icon="chat">
                      {L('상대와 메시지', 'Message them')}
                    </ButtonLink>
                  )}
                  {x.status === 'IN_PROGRESS' && (
                    <Button variant="accent" icon="check" onClick={complete}>
                      {L('맞교환 완료', 'Complete exchange')}
                    </Button>
                  )}
                  {['COMPLETED'].includes(x.status) && (
                    <ButtonLink href={`/reviews?targetType=USER&subjectType=EXCHANGE&subjectId=${id}`} variant="accent" icon="star">
                      {L('후기 쓰기', 'Write a review')}
                    </ButtonLink>
                  )}
                  <ButtonLink href={`/support/disputes?subjectType=EXCHANGE&subjectId=${id}`} variant="ghost" icon="flag">
                    {L('문제 신고', 'Report a problem')}
                  </ButtonLink>
                </div>
                {x.status === 'CONFIRMED' && (
                  <details style={{ marginTop: 16 }}>
                    <summary className="btn ghost sm" style={{ listStyle: 'none', display: 'inline-flex' }}>
                      <Icon name="more" size={16} /> {L('더 보기', 'More options')}
                    </summary>
                    <div className="card flat stack" style={{ marginTop: 8, maxWidth: 420 }}>
                      <p className="small muted" style={{ margin: 0 }}>{L('일정이 어긋났다면 취소하기 전에 상대와 먼저 이야기해 보세요.', 'If plans changed, talk to the other member before cancelling.')}</p>
                      <Button variant="ghost" size="sm" icon="x-circle" onClick={cancel} style={{ color: 'var(--danger)', justifySelf: 'start' }}>
                        {L('맞교환 취소', 'Cancel exchange')}
                      </Button>
                    </div>
                  </details>
                )}
              </Section>
              <p className="small" style={{ marginTop: 24 }}>
                <Link href={`/exchange/${id}`}>{L('← 맞교환 상세로', '← Exchange overview')}</Link>
              </p>
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
