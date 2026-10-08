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
import { Alert, ErrorText, Section, StatusPill, Button, ButtonLink } from '@/components/ui';
import { ExchangeHeader, exchangeView } from '../../shared';

const CHECKS: Record<string, { ko: string; en: string; href?: string }> = {
  IDENTITY: { ko: '본인 확인', en: 'Identity verified', href: '/verification' },
  PROPERTY: { ko: '집 게시·인증 상태', en: 'Home verified & published', href: '/host/listings' },
  SAFETY_ACK: { ko: '안전 수칙 확인', en: 'Safety guidelines acknowledged' },
};

export default function ExchangeVerificationView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const st = useApi<any>(`/v1/exchanges/${id}`, { auth: true });
  const [ack, setAck] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async (path: string, body?: any) => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/v1/exchanges/${id}/${path}`, body);
      st.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <RequireAuth>
      <StateView state={st} skeleton="detail">
        {(d) => {
          const x = exchangeView(d, user?.id);
          const people: Array<[string, string]> = [
            [x.requesterId, x.role === 'REQUESTER' ? L('나', 'Me') : x.requesterName || L('상대', 'Them')],
            [x.responderId, x.role === 'RESPONDER' ? L('나', 'Me') : x.responderName || L('상대', 'Them')],
          ];
          // Put "me" first.
          if (x.role === 'RESPONDER') people.reverse();
          const checkOf = (uid: string, type: string) => x.verifications.find((v: any) => str(v, 'partyUserId', 'userId', 'party_user_id') === uid && str(v, 'checkType', 'check_type') === type);
          const mySafety = checkOf(user?.id ?? '', 'SAFETY_ACK');
          const myAcked = str(mySafety, 'status') === 'PASSED';
          const otherId = x.role === 'REQUESTER' ? x.responderId : x.requesterId;
          const otherPending = Object.keys(CHECKS).some((t) => str(checkOf(otherId, t), 'status') !== 'PASSED');
          const agreementReady = ['AGREEMENT_PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED'].includes(x.status);
          return (
            <>
              <ExchangeHeader x={x} />
              <Section title={L('맞교환 검증 체크리스트', 'Verification checklist')}>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">{L('항목', 'Check')}</th>
                        {people.map(([uid, name]) => <th key={uid} scope="col">{name}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(CHECKS).map(([type, c]) => (
                        <tr key={type}>
                          <th scope="row">{c[lang]}</th>
                          {people.map(([uid]) => {
                            const v = checkOf(uid, type);
                            return (
                              <td key={uid}>
                                <StatusPill status={str(v, 'status') || 'PENDING'} />
                                {uid === user?.id && str(v, 'status') === 'FAILED' && c.href && <Link href={c.href} className="small" style={{ marginLeft: 8 }}>{L('해결하기', 'Fix')}</Link>}
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
              <Section title={L('안전 수칙', 'Safety guidelines')}>
                <div className="card stack">
                  <ul style={{ margin: 0 }}>
                    <li>{L('귀중품·개인 서류는 잠금 보관하거나 치워 주세요.', 'Lock away valuables and documents.')}</li>
                    <li>{L('비상 연락처, 가스·전기 차단 위치를 집 안내서에 적어 주세요.', 'Note emergency contacts and shut-off locations.')}</li>
                    <li>{L('플랫폼 밖 금전 거래(보증금 송금 등)를 요구받으면 즉시 신고하세요.', 'Report any request for off-platform money.')}</li>
                    <li>{L('도착/출발 시 집 상태 사진을 메시지에 남겨 주세요.', 'Share condition photos on arrival and departure.')}</li>
                  </ul>
                  {myAcked ? (
                    <Alert tone="ok">{L('안전 수칙을 확인했습니다.', 'You acknowledged the safety guidelines.')}</Alert>
                  ) : (
                    <>
                      <label className="check">
                        <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                        <span>{L('위 안전 수칙을 읽고 동의합니다.', 'I have read and agree to the safety guidelines.')}</span>
                      </label>
                      <Button variant="primary" disabled={!ack} loading={busy} onClick={() => run('safety-ack', { acknowledged: true })} style={{ justifySelf: 'start' }}>{L('확인 제출', 'Acknowledge')}</Button>
                    </>
                  )}
                </div>
              </Section>
              <div className="row" style={{ marginTop: 16 }}>
                {agreementReady ? (
                  <ButtonLink variant="accent" href={`/exchange/${id}/agreement`} iconRight="right">
                    {L('계약서 확인하고 서명하기', 'Review & sign the agreement')}
                  </ButtonLink>
                ) : (
                  <span className="row small muted" style={{ gap: 8 }}>
                    <StatusPill status="PENDING" labels={{ PENDING: [otherPending && myAcked ? '상대방 검증 대기 중' : '검증 진행 중', otherPending && myAcked ? 'Waiting for the other member' : 'Verification in progress'] }} />
                    {L('양측 검증이 모두 끝나면 계약서가 열려요.', 'The agreement opens once both sides are verified.')}
                  </span>
                )}
                {['MUTUAL_ACCEPTED', 'VERIFICATION_PENDING'].includes(x.status) && (
                  <Button variant="ghost" loading={busy} onClick={() => run('verify')} icon="refresh">
                    {L('검증 상태 새로고침', 'Refresh verification status')}
                  </Button>
                )}
              </div>
              <ErrorText error={err} />
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
