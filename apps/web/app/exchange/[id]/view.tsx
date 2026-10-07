'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, str, num } from '@/lib/shape';
import { formatRange } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, DateText, ErrorText, Kv, Section, StatusBadge } from '@/components/ui';
import { ExchangeHeader, exchangeView } from '../shared';

export default function ExchangeDetailView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const st = useApi<any>(`/v1/exchanges/${id}`, { auth: true });
  const [err, setErr] = useState<unknown>(null);
  const [counter, setCounter] = useState(false);
  const [c, setC] = useState({ aStart: '', aEnd: '', bStart: '', bEnd: '', note: '' });
  const act = async (path: string, body: any, idem?: string) => {
    setErr(null);
    try {
      await post(`/v1/exchanges/${id}/${path}`, body, idem ? { idempotencyKey: idem } : {});
      setCounter(false);
      st.reload();
    } catch (e) {
      setErr(e);
    }
  };
  return (
    <RequireAuth>
      <StateView state={st}>
        {(d) => {
          const x = exchangeView(d);
          const isRequester = user?.id === x.requesterId;
          const myTurn = x.lastActorId ? x.lastActorId !== user?.id : !isRequester;
          const negotiating = ['PROPOSED', 'COUNTERED', 'REQUESTED'].includes(x.status);
          const proposals = arr(x.raw, 'proposals', 'versions', 'history');
          return (
            <>
              <ExchangeHeader x={x} />
              <div className="grid-2 even">
                <section className="card stack">
                  <h2>{L('요청자 집', 'Requester home')}</h2>
                  <p><strong>{str(x.requesterProperty, 'title', 'name') || x.requesterProperty?.id?.slice(0, 8)}</strong> {str(x.requesterProperty, 'city')}</p>
                  <p className="small muted">{x.b.start && formatRange(x.b.start, x.b.end, lang)}</p>
                </section>
                <section className="card stack">
                  <h2>{L('상대 집', 'Counterpart home')}</h2>
                  <p><strong>{str(x.counterpartProperty, 'title', 'name') || x.counterpartProperty?.id?.slice(0, 8)}</strong> {str(x.counterpartProperty, 'city')}</p>
                  <p className="small muted">{x.a.start && formatRange(x.a.start, x.a.end, lang)}</p>
                </section>
              </div>
              <Section title={L('현재 조건', 'Current terms')}>
                <div className="card">
                  <Kv rows={[[L('버전', 'Version'), `v${x.version}`], [L('인원', 'Guests'), x.guests ?? '—'], [L('메모', 'Note'), x.note || '—'], [L('상태', 'Status'), <StatusBadge key="s" status={x.status} />]]} />
                </div>
              </Section>
              <ErrorText error={err} />
              {negotiating && (
                <Section title={L('응답', 'Respond')}>
                  {myTurn ? (
                    <div className="card stack">
                      <p className="small muted">{L('수락은 현재 버전(v' + x.version + ')에 대해서만 유효합니다. 그 사이 상대가 조건을 바꾸면 다시 확인해야 합니다.', `Accepting applies to v${x.version} only; if terms change you must re-confirm.`)}</p>
                      <div className="row">
                        <button className="btn primary" onClick={() => act('accept', { version: x.version, expectedVersion: x.version }, `xaccept-${id}-v${x.version}`)}>{L(`v${x.version} 조건 수락`, `Accept v${x.version}`)}</button>
                        <button className="btn" onClick={() => setCounter(!counter)}>{L('조건 변경 제안', 'Counter')}</button>
                        <button className="btn ghost" onClick={() => act('decline', { version: x.version })}>{L('거절', 'Decline')}</button>
                      </div>
                      {counter && (
                        <form
                          className="stack"
                          onSubmit={(e) => {
                            e.preventDefault();
                            void act('counter', { version: x.version, expectedVersion: x.version, requesterStart: c.aStart || x.a.start, requesterEnd: c.aEnd || x.a.end, counterpartStart: c.bStart || x.b.start, counterpartEnd: c.bEnd || x.b.end, note: c.note });
                          }}
                        >
                          <div className="form-grid cols-4">
                            <label className="field"><span>{L('A 시작', 'A from')}</span><input type="date" defaultValue={x.a.start} onChange={(e) => setC({ ...c, aStart: e.target.value })} /></label>
                            <label className="field"><span>{L('A 종료', 'A to')}</span><input type="date" defaultValue={x.a.end} onChange={(e) => setC({ ...c, aEnd: e.target.value })} /></label>
                            <label className="field"><span>{L('B 시작', 'B from')}</span><input type="date" defaultValue={x.b.start} onChange={(e) => setC({ ...c, bStart: e.target.value })} /></label>
                            <label className="field"><span>{L('B 종료', 'B to')}</span><input type="date" defaultValue={x.b.end} onChange={(e) => setC({ ...c, bEnd: e.target.value })} /></label>
                          </div>
                          <label className="field"><span>{L('메모', 'Note')}</span><textarea onChange={(e) => setC({ ...c, note: e.target.value })} /></label>
                          <button className="btn primary">{L(`v${x.version + 1} 제안 보내기`, `Send v${x.version + 1}`)}</button>
                        </form>
                      )}
                    </div>
                  ) : (
                    <Alert>{L('상대방의 응답을 기다리는 중입니다.', 'Waiting for the other member.')}</Alert>
                  )}
                </Section>
              )}
              <Section title={L('다음 단계', 'Next steps')}>
                <div className="row">
                  <Link className="btn" href={`/exchange/${id}/verification`}>{L('검증 체크리스트', 'Verification checklist')}</Link>
                  <Link className="btn" href={`/exchange/${id}/agreement`}>{L('계약서 보기·서명', 'Agreement')}</Link>
                  <Link className="btn" href={`/exchange/${id}/trip`}>{L('맞교환 여행', 'Trip')}</Link>
                  {x.conversationId && <Link className="btn ghost" href={`/messages?c=${x.conversationId}`}>{L('메시지', 'Messages')}</Link>}
                </div>
              </Section>
              {proposals.length > 0 && (
                <Section title={L('제안 이력', 'Proposal history')}>
                  <ol className="stack">
                    {proposals.map((p: any, i: number) => (
                      <li key={i}>
                        v{num(p, 'version') ?? i + 1} · {str(p, 'actorName', 'proposedBy', 'actorId').slice(0, 12)} · <DateText value={str(p, 'createdAt')} time /> {str(p, 'kind', 'action') && <StatusBadge status={str(p, 'kind', 'action')} />}
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
