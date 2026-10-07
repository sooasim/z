'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, item, str, num } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, DateText, ErrorText, Section } from '@/components/ui';
import { ExchangeHeader, exchangeView } from '../../shared';

export default function ExchangeAgreementView() {
  const { id } = useParams<{ id: string }>();
  const { L } = useI18n();
  const { user } = useAuth();
  const ex = useApi<any>(`/v1/exchanges/${id}`, { auth: true });
  const ag = useApi<any>(`/v1/exchanges/${id}/agreement`, { auth: true });
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <RequireAuth>
      <StateView state={ex}>
        {(d) => {
          const x = exchangeView(d);
          return (
            <>
              <ExchangeHeader x={x} />
              <StateView state={ag}>
                {(ad) => {
                  const a = item(ad);
                  const hash = str(a, 'termsHash', 'hash', 'sha256', 'contentHash');
                  const sigs = arr(a, 'signatures', 'signers');
                  const signedByMe = sigs.some((s: any) => str(s, 'userId', 'signerId') === user?.id && str(s, 'signedAt'));
                  const allSigned = sigs.length >= 2 && sigs.every((s: any) => str(s, 'signedAt'));
                  const body = str(a, 'body', 'text', 'content', 'markdown');
                  const agVersion = num(a, 'termsVersion', 'version') ?? x.version;
                  return (
                    <>
                      <Section title={L('맞교환 계약서', 'Exchange agreement')}>
                        <article className="card" style={{ maxHeight: 420, overflowY: 'auto', whiteSpace: 'pre-wrap' }} tabIndex={0} aria-label={L('계약서 본문', 'Agreement text')}>
                          {body || L('계약서 본문을 불러올 수 없습니다.', 'Agreement text unavailable.')}
                        </article>
                        <div className="card flat stack">
                          <p style={{ margin: 0 }}>
                            <strong>{L('조건 버전', 'Terms version')}</strong>: v{agVersion}
                          </p>
                          <p style={{ margin: 0 }}>
                            <strong>{L('조건 해시 (SHA-256)', 'Terms hash (SHA-256)')}</strong>: <span className="mono">{hash || '—'}</span>
                          </p>
                          <p className="small muted" style={{ margin: 0 }}>{L('서명은 이 해시가 가리키는 조건에만 유효합니다. 조건이 바뀌면 새 해시로 다시 서명해야 합니다.', 'Your signature binds only the terms with this hash. If terms change, you must sign again.')}</p>
                        </div>
                      </Section>
                      <Section title={L('서명 현황', 'Signatures')}>
                        <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
                          {sigs.length === 0 && <li className="muted">{L('아직 서명이 없습니다.', 'No signatures yet.')}</li>}
                          {sigs.map((s: any, i: number) => (
                            <li key={i} className="card flat row between">
                              <span>{str(s, 'displayName', 'name') || str(s, 'userId').slice(0, 8)} {str(s, 'userId') === user?.id && `(${L('나', 'me')})`}</span>
                              {str(s, 'signedAt') ? <span className="badge ok">✓ <DateText value={str(s, 'signedAt')} time /></span> : <span className="badge warn">{L('대기', 'Pending')}</span>}
                            </li>
                          ))}
                        </ul>
                      </Section>
                      {!signedByMe && hash && (
                        <div className="card stack">
                          <label className="check">
                            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                            <span>{L('위 계약 내용을 모두 읽었으며, 전자적 방식으로 서명하는 데 동의합니다.', 'I have read the agreement and consent to sign electronically.')}</span>
                          </label>
                          <button
                            className="btn primary"
                            disabled={!agree || busy}
                            onClick={async () => {
                              setBusy(true);
                              setErr(null);
                              try {
                                await post(`/v1/exchanges/${id}/agreement/sign`, { termsHash: hash, version: agVersion, consent: true }, { idempotencyKey: `xsign-${id}-${hash.slice(0, 16)}` });
                                ag.reload();
                                ex.reload();
                              } catch (e) {
                                setErr(e);
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            {L('전자 서명', 'Sign electronically')}
                          </button>
                        </div>
                      )}
                      {(allSigned || ['SIGNED', 'VERIFIED', 'AGREEMENT_PENDING'].includes(x.status)) && !['CONFIRMED', 'COMPLETED', 'IN_PROGRESS'].includes(x.status) && (
                        <div className="card stack" style={{ marginTop: 16 }}>
                          <p>{L('양측 서명이 완료되면 두 집의 일정을 동시에 잠그고 맞교환을 확정합니다.', 'Once both have signed, confirming locks both calendars atomically.')}</p>
                          <button
                            className="btn primary"
                            disabled={busy}
                            onClick={async () => {
                              setBusy(true);
                              setErr(null);
                              try {
                                await post(`/v1/exchanges/${id}/confirm`, { version: x.version, termsHash: hash }, { idempotencyKey: `xconfirm-${id}-v${x.version}` });
                                ex.reload();
                              } catch (e) {
                                setErr(e);
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            {L('맞교환 확정', 'Confirm exchange')}
                          </button>
                        </div>
                      )}
                      {['CONFIRMED', 'IN_PROGRESS'].includes(x.status) && (
                        <Alert tone="ok">
                          {L('맞교환이 확정되었습니다! 두 집의 일정이 잠겼습니다.', 'Exchange confirmed! Both calendars are locked.')} <Link href={`/exchange/${id}/trip`}>{L('여행 정보 보기', 'Trip details')}</Link>
                        </Alert>
                      )}
                      <ErrorText error={err} />
                    </>
                  );
                }}
              </StateView>
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
