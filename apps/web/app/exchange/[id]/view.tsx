'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { str, num } from '@/lib/shape';
import { formatRange } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, ErrorText, Kv, Section, StatusPill, Timeline, ButtonLink } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { ExchangeHeader, exchangeView } from '../shared';

const NEXT_ACTION: Record<string, [string, string]> = {
  RESPOND: ['상대의 제안에 응답할 차례예요.', 'It’s your turn to respond.'],
  AWAIT_RESPONSE: ['상대방의 응답을 기다리는 중이에요.', 'Waiting for the other member.'],
  SAFETY_ACK: ['안전 수칙 확인이 필요해요.', 'Please acknowledge the safety guidelines.'],
  AWAIT_VERIFICATION: ['양측 검증을 진행 중이에요.', 'Verification in progress.'],
  SIGN_AGREEMENT: ['계약서에 서명해 주세요.', 'Please sign the agreement.'],
  AWAIT_COUNTERPARTY_SIGNATURE: ['상대방의 서명을 기다리는 중이에요.', 'Waiting for the other signature.'],
  CONFIRM: ['양측 서명 완료! 맞교환을 확정하세요.', 'Both signed — confirm the exchange.'],
  PREPARE_TRIP: ['확정되었어요. 여행을 준비하세요!', 'Confirmed — get ready!'],
  COMPLETE_AFTER_STAY: ['머문 뒤 완료 처리해 주세요.', 'Mark complete after your stays.'],
  LEAVE_REVIEW: ['후기를 남겨 주세요.', 'Leave a review.'],
};

export default function ExchangeDetailView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const st = useApi<any>(`/v1/exchanges/${id}`, { auth: true });
  const [err, setErr] = useState<unknown>(null);
  const [counter, setCounter] = useState(false);
  const [c, setC] = useState({ aStart: '', aEnd: '', bStart: '', bEnd: '', message: '' });
  const act = async (path: string, body: any, idem?: string, msg?: string) => {
    setErr(null);
    try {
      await post(`/v1/exchanges/${id}/${path}`, body, idem ? { idempotencyKey: idem } : {});
      setCounter(false);
      if (msg) toast.show(msg);
      st.reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <RequireAuth>
      <StateView state={st} skeleton="detail">
        {(d) => {
          const x = exchangeView(d, user?.id);
          const negotiating = ['REQUESTED', 'COUNTERED'].includes(x.status);
          const myTurn = x.nextAction === 'RESPOND';
          const na = NEXT_ACTION[x.nextAction];
          return (
            <>
              <ExchangeHeader x={x} />
              {na && <Alert tone={['RESPOND', 'SAFETY_ACK', 'SIGN_AGREEMENT', 'CONFIRM'].includes(x.nextAction) ? 'warn' : 'info'}>{na[lang === 'ko' ? 0 : 1]}</Alert>}
              <Section title={L(`현재 조건 (v${x.version})`, `Current terms (v${x.version})`)}>
                <div className="card">
                  <Kv
                    rows={[
                      [L('집 A 사용 기간', 'Home A occupied'), x.datesA.start ? formatRange(x.datesA.start, x.datesA.end, lang) : '—'],
                      [L('집 B 사용 기간', 'Home B occupied'), x.datesB.start ? formatRange(x.datesB.start, x.datesB.end, lang) : '—'],
                      [L('인원 (A집 / B집)', 'Guests (A / B)'), `${x.guestsA ?? '—'} / ${x.guestsB ?? '—'}`],
                      [L('메시지', 'Message'), x.message || '—'],
                      [L('상태', 'Status'), <StatusPill key="s" status={x.status} />],
                    ]}
                  />
                </div>
              </Section>
              <ErrorText error={err} />
              {negotiating && myTurn && (
                <Section title={L('응답', 'Respond')}>
                  <div className="card stack">
                    <p className="small muted" style={{ margin: 0 }}>{L(`수락은 현재 버전(v${x.version})에만 적용됩니다. 그 사이 조건이 바뀌면 서버가 거부하고 다시 확인을 요청합니다.`, `Accepting binds v${x.version} only; if terms changed meanwhile the server rejects it and you re-confirm.`)}</p>
                    <div className="row">
                      <button className="btn accent" onClick={() => act('accept', { offerVersion: x.version }, `xaccept-${id}-v${x.version}`, L('수락했어요', 'Accepted'))}>{L(`v${x.version} 조건 수락`, `Accept v${x.version}`)}</button>
                      <button className="btn" onClick={() => setCounter(!counter)} aria-expanded={counter}>{L('조건 변경 제안', 'Counter-offer')}</button>
                      <button className="btn ghost" onClick={() => act('decline', { reason: null }, undefined, L('거절했어요', 'Declined'))}>{L('거절', 'Decline')}</button>
                    </div>
                    {counter && (
                      <form
                        className="stack"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void act('counter', {
                            expectedVersion: x.version,
                            datesA: { start: c.aStart || x.datesA.start, end: c.aEnd || x.datesA.end },
                            datesB: { start: c.bStart || x.datesB.start, end: c.bEnd || x.datesB.end },
                            message: c.message || null,
                          }, undefined, L('역제안을 보냈어요', 'Counter sent'));
                        }}
                      >
                        <div className="form-grid cols-4">
                          <label className="field"><span>{L('A집 시작', 'Home A from')}</span><input type="date" defaultValue={x.datesA.start} onChange={(e) => setC({ ...c, aStart: e.target.value })} /></label>
                          <label className="field"><span>{L('A집 종료', 'Home A to')}</span><input type="date" defaultValue={x.datesA.end} onChange={(e) => setC({ ...c, aEnd: e.target.value })} /></label>
                          <label className="field"><span>{L('B집 시작', 'Home B from')}</span><input type="date" defaultValue={x.datesB.start} onChange={(e) => setC({ ...c, bStart: e.target.value })} /></label>
                          <label className="field"><span>{L('B집 종료', 'Home B to')}</span><input type="date" defaultValue={x.datesB.end} onChange={(e) => setC({ ...c, bEnd: e.target.value })} /></label>
                        </div>
                        <label className="field"><span>{L('메시지', 'Message')}</span><textarea onChange={(e) => setC({ ...c, message: e.target.value })} /></label>
                        <button className="btn primary" style={{ justifySelf: 'start' }}>{L(`v${x.version + 1} 제안 보내기`, `Send v${x.version + 1}`)}</button>
                      </form>
                    )}
                  </div>
                </Section>
              )}
              {negotiating && x.role === 'REQUESTER' && !myTurn && (
                <button className="btn ghost sm" onClick={() => act('withdraw', { reason: null }, undefined, L('제안을 철회했어요', 'Withdrawn'))}>{L('제안 철회', 'Withdraw request')}</button>
              )}
              <Section title={L('다음 단계', 'Next steps')}>
                <div className="row">
                  <ButtonLink href={`/exchange/${id}/verification`} variant={x.nextAction === 'SAFETY_ACK' ? 'accent' : 'default'} icon="shield">{L('검증 체크리스트', 'Verification')}</ButtonLink>
                  <ButtonLink href={`/exchange/${id}/agreement`} variant={['SIGN_AGREEMENT', 'CONFIRM'].includes(x.nextAction) ? 'accent' : 'default'} icon="doc">{L('계약서 · 서명', 'Agreement')}</ButtonLink>
                  <ButtonLink href={`/exchange/${id}/trip`} icon="home">{L('맞교환 여행', 'Trip')}</ButtonLink>
                  {x.conversationId && <Link className="btn ghost" href={`/messages?c=${x.conversationId}`}>{L('메시지', 'Messages')}</Link>}
                </div>
              </Section>
              {x.offers.length > 0 && (
                <Section title={L('제안 이력 (버전)', 'Offer history (versions)')}>
                  <div className="card">
                    <Timeline events={[...x.offers].reverse().map((o: any) => ({ title: `v${num(o, 'version')} · ${str(o, 'createdBy') === user?.id ? L('나', 'me') : L('상대', 'them')}`, at: str(o, 'createdAt'), note: str(o, 'message') }))} />
                  </div>
                </Section>
              )}
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
