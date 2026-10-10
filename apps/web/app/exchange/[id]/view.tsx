'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { str, num } from '@/lib/shape';
import { formatDate, formatRange, validRange } from '@/lib/format';
import { ApiError } from '@/lib/errors';
import { RequireAuth } from '@/components/gate';
import { StateView, NotFoundState } from '@/components/states';
import { Alert, Button, ButtonLink, DateRangeField, ErrorText, Kv, Section, Textarea, Timeline, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { ExchangeHeader, NEXT_ACTION, exchangeView, homeTitle, offerLabel, termRows } from '../shared';
import s from '@/components/public/public.module.css';
import { pickPair } from '@/lib/phrases';

export { NEXT_ACTION };

const AFTER_ACCEPT = ['MUTUAL_ACCEPTED', 'VERIFICATION_PENDING', 'AGREEMENT_PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED'];

export default function ExchangeDetailView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const st = useApi<any>(`/v1/exchanges/${id}`, { auth: true });
  const [err, setErr] = useState<unknown>(null);
  const [counter, setCounter] = useState(false);
  const [busy, setBusy] = useState('');
  const [mine, setMine] = useState({ start: '', end: '' });
  const [theirs, setTheirs] = useState({ start: '', end: '' });
  const [cMsg, setCMsg] = useState('');
  const [cErr, setCErr] = useState('');
  const act = async (path: string, body: any, idem?: string, msg?: string) => {
    setErr(null);
    setBusy(path);
    try {
      await post(`/v1/exchanges/${id}/${path}`, body, idem ? { idempotencyKey: idem } : {});
      setCounter(false);
      if (msg) toast.show(msg);
      st.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy('');
    }
  };
  return (
    <RequireAuth>
      {dialog}
      {st.error instanceof ApiError && (st.error.kind === 'not_found' || st.error.kind === 'validation') ? (
        <NotFoundState as="h1" title={L('맞교환을 찾을 수 없어요', 'We can’t find that exchange')} body={L('취소되었거나 참여하지 않은 맞교환일 수 있어요.', 'It may have been cancelled, or you are not part of it.')} back={{ href: '/trips?tab=exchanges', label: L('내 맞교환 보기', 'My exchanges') }} />
      ) : (
        <StateView state={st} skeleton="detail">
          {(d) => {
            const x = exchangeView(d, user?.id);
            const negotiating = ['REQUESTED', 'COUNTERED'].includes(x.status);
            const myTurn = x.nextAction === 'RESPOND';
            const na = NEXT_ACTION[x.nextAction];
            const iAmA = x.role === 'REQUESTER';
            const myHomeT = homeTitle(x.myHome, L('내 집', 'my home'));
            const theirHomeT = homeTitle(x.theirHome, L('상대 집', 'their home'));
            const agreementOpen = ['AGREEMENT_PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED'].includes(x.status);
            const tripOpen = ['CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED'].includes(x.status);
            const terms = termRows(x.terms, L);
            const openCounter = () => {
              setMine(x.myStay);
              setTheirs(x.theirStay);
              setCMsg('');
              setCErr('');
              setCounter(true);
            };
            const sendCounter = () => {
              if (!validRange(mine.start, mine.end) || !validRange(theirs.start, theirs.end)) {
                setCErr(L('두 기간 모두 체크인과 체크아웃 날짜를 골라 주세요.', 'Choose both dates for each stay.'));
                return;
              }
              setCErr('');
              // datesB = when home B is used; datesA = when home A is used.
              const myAsB = iAmA ? { datesB: mine, datesA: theirs } : { datesA: mine, datesB: theirs };
              void act('counter', { expectedVersion: x.version, ...myAsB, message: cMsg.trim() || null }, undefined, L('새 제안을 보냈어요', 'Counter-offer sent'));
            };
            const decline = () =>
              confirm({
                title: L('이 제안을 거절할까요?', 'Decline this proposal?'),
                body: L('거절하면 이 맞교환은 종료되고 다시 열 수 없어요. 날짜만 맞지 않다면 ‘조건 변경 제안’으로 다른 날짜를 제안해 보세요.', 'Declining ends this exchange and it cannot be reopened. If only the dates don’t work, send a counter-offer instead.'),
                tone: 'danger',
                confirmLabel: L('거절하기', 'Decline'),
                requireReason: L('거절 사유 (상대에게 전달돼요)', 'Reason (shared with the other member)'),
                reasonMinLength: 3,
                reasonPlaceholder: L('예: 해당 기간에는 집을 비울 수 없어요.', 'e.g. We can’t leave home on those dates.'),
                run: async (reason) => {
                  await post(`/v1/exchanges/${id}/decline`, { reason });
                  toast.show(L('제안을 거절했어요', 'Declined'));
                  st.reload();
                },
              });
            const withdraw = () =>
              confirm({
                title: L('제안을 철회할까요?', 'Withdraw your proposal?'),
                body: L('철회하면 상대방은 더 이상 이 제안에 응답할 수 없어요.', 'The other member will no longer be able to respond.'),
                tone: 'danger',
                confirmLabel: L('철회하기', 'Withdraw'),
                run: async () => {
                  await post(`/v1/exchanges/${id}/withdraw`, { reason: null });
                  toast.show(L('제안을 철회했어요', 'Withdrawn'));
                  st.reload();
                },
              });
            return (
              <>
                <ExchangeHeader x={x} back={false} />
                {na && (
                  <Alert tone={['RESPOND', 'SAFETY_ACK', 'SIGN_AGREEMENT', 'CONFIRM'].includes(x.nextAction) ? 'warn' : 'info'}>
                    <strong>{pickPair(na, lang)}</strong>
                    {myTurn && x.respondBy && <span className="small" style={{ display: 'block' }}>{L(`${formatDate(x.respondBy, 'ko', true)}까지 응답하지 않으면 제안이 만료돼요.`, `The offer expires if not answered by ${formatDate(x.respondBy, 'en', true)}.`)}</span>}
                  </Alert>
                )}
                <Section title={negotiating ? L(`현재 조건 · ${offerLabel(x.version, L)}`, `Current terms · ${offerLabel(x.version, L)}`) : L('합의한 조건', 'Agreed terms')}>
                  <div className="card">
                    <Kv
                      rows={[
                        [L(`내가 ${theirHomeT}에 머무는 기간`, `My stay at ${theirHomeT}`), x.myStay.start ? formatRange(x.myStay.start, x.myStay.end, lang, { nights: true }) : '—'],
                        [L(`상대가 내 집(${myHomeT})에 머무는 기간`, `Their stay at my home (${myHomeT})`), x.theirStay.start ? formatRange(x.theirStay.start, x.theirStay.end, lang, { nights: true }) : '—'],
                        [L('인원', 'Guests'), L(`우리 ${x.myGuests ?? '—'}명 · 상대 ${x.theirGuests ?? '—'}명`, `Us ${x.myGuests ?? '—'} · them ${x.theirGuests ?? '—'}`)],
                        ...terms,
                        ...(x.message ? [[str(x.raw, 'currentOffer.createdBy') === user?.id ? L('내 메시지', 'My message') : L('상대 메시지', 'Their message'), x.message] as [string, string]] : []),
                      ]}
                    />
                  </div>
                </Section>
                <ErrorText error={err} />
                {negotiating && myTurn && (
                  <Section title={L('응답하기', 'Respond')}>
                    <div className="card stack">
                      <p className="small muted" style={{ margin: 0 }}>{L('수락하면 위 조건(최신 제안)으로 다음 단계인 양측 검증이 시작돼요. 그사이 상대가 조건을 바꾸면 다시 확인을 요청드려요.', 'Accepting binds the latest offer above and starts verification. If the terms change meanwhile, we’ll ask you to confirm again.')}</p>
                      <div className={s.actionsStack}>
                        <Button variant="accent" loading={busy === 'accept'} onClick={() => act('accept', { offerVersion: x.version }, `xaccept-${id}-v${x.version}`, L('수락했어요', 'Accepted'))}>
                          {L('이 조건으로 수락', 'Accept these terms')}
                        </Button>
                        <Button onClick={() => (counter ? setCounter(false) : openCounter())} aria-expanded={counter} icon="edit">
                          {L('조건 변경 제안', 'Counter-offer')}
                        </Button>
                        <Button variant="ghost" onClick={decline} style={{ color: 'var(--danger)' }}>
                          {L('거절', 'Decline')}
                        </Button>
                      </div>
                      {counter && (
                        <form
                          className="stack"
                          noValidate
                          onSubmit={(e) => {
                            e.preventDefault();
                            sendCounter();
                          }}
                          style={{ borderTop: '1px solid var(--border)', paddingTop: 16 }}
                        >
                          <div className="form-grid cols-2">
                            <div className="field">
                              <span>{L(`내가 ${theirHomeT}에 머무는 기간`, `My stay at ${theirHomeT}`)}</span>
                              <DateRangeField start={mine.start} end={mine.end} onChange={setMine} boxed />
                            </div>
                            <div className="field">
                              <span>{L('상대가 내 집에 머무는 기간', 'Their stay at my home')}</span>
                              <DateRangeField start={theirs.start} end={theirs.end} onChange={setTheirs} boxed align="right" />
                            </div>
                          </div>
                          <Textarea label={L('메시지', 'Message')} value={cMsg} onChange={(e) => setCMsg(e.target.value)} maxLength={2000} placeholder={L('바꾼 이유를 함께 적어 주면 합의가 빨라져요.', 'Explain the change — it helps you agree faster.')} />
                          {cErr && <Alert tone="error">{cErr}</Alert>}
                          <div className="row">
                            <Button type="submit" variant="primary" loading={busy === 'counter'}>
                              {L(`${offerLabel(x.version + 1, L)} 보내기`, `Send ${offerLabel(x.version + 1, L).toLowerCase()}`)}
                            </Button>
                            <Button variant="ghost" onClick={() => setCounter(false)}>
                              {L('취소', 'Cancel')}
                            </Button>
                          </div>
                        </form>
                      )}
                    </div>
                  </Section>
                )}
                {negotiating && !myTurn && x.role === 'REQUESTER' && (
                  <p style={{ marginTop: 16 }}>
                    <Button variant="ghost" size="sm" onClick={withdraw} style={{ color: 'var(--danger)' }}>
                      {L('제안 철회', 'Withdraw request')}
                    </Button>
                  </p>
                )}
                <Section title={L('다음 단계', 'Next steps')}>
                  <div className={s.actionsStack}>
                    {x.conversationId && (
                      <ButtonLink href={`/messages?c=${x.conversationId}`} variant="primary" icon="chat">
                        {L('상대와 메시지', 'Message them')}
                      </ButtonLink>
                    )}
                    {AFTER_ACCEPT.includes(x.status) && (
                      <ButtonLink href={`/exchange/${id}/verification`} variant={x.nextAction === 'SAFETY_ACK' ? 'accent' : 'default'} icon="shield">
                        {L('검증 체크리스트', 'Verification')}
                      </ButtonLink>
                    )}
                    {agreementOpen ? (
                      <ButtonLink href={`/exchange/${id}/agreement`} variant={['SIGN_AGREEMENT', 'CONFIRM'].includes(x.nextAction) ? 'accent' : 'default'} icon="doc">
                        {L('계약서 · 서명', 'Agreement')}
                      </ButtonLink>
                    ) : (
                      <Button icon="doc" disabled title={L('양측 검증이 끝나면 열려요', 'Opens after verification')}>
                        {L('계약서 (검증 후 열림)', 'Agreement (after verification)')}
                      </Button>
                    )}
                    {tripOpen && (
                      <ButtonLink href={`/exchange/${id}/trip`} icon="home">
                        {L('여행 정보 · 주소', 'Trip & address')}
                      </ButtonLink>
                    )}
                  </div>
                </Section>
                {x.offers.length > 0 && (
                  <Section title={L('제안 기록', 'Offer history')}>
                    <div className="card">
                      <Timeline
                        events={[...x.offers].reverse().map((o: any) => {
                          const v = num(o, 'version') ?? 1;
                          const byMe = str(o, 'createdBy') === user?.id;
                          const dA = { start: str(o, 'datesA.start'), end: str(o, 'datesA.end') };
                          const dB = { start: str(o, 'datesB.start'), end: str(o, 'datesB.end') };
                          const myS = iAmA ? dB : dA;
                          return {
                            title: `${offerLabel(v, L)} · ${byMe ? L('내가 보냄', 'sent by me') : L(`${x.otherName || '상대'} 님이 보냄`, `sent by ${x.otherName || 'them'}`)}${v === x.version ? L(' · 최신', ' · latest') : ''}`,
                            at: str(o, 'createdAt'),
                            note: [myS.start ? L(`내 숙박 ${formatRange(myS.start, myS.end, 'ko')}`, `My stay ${formatRange(myS.start, myS.end, 'en')}`) : '', str(o, 'message')].filter(Boolean).join(' — '),
                          };
                        })}
                      />
                    </div>
                  </Section>
                )}
              </>
            );
          }}
        </StateView>
      )}
    </RequireAuth>
  );
}
