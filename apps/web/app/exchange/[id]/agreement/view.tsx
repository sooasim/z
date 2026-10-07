'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { f, item, str, num } from '@/lib/shape';
import { formatRange, parseDateRange } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, DateText, ErrorText, Section, Button, Kv } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { ExchangeHeader, exchangeView } from '../../shared';

const CLAUSES: Array<[string, string]> = [
  ['제1조 (목적) 양 당사자는 아래 조건에 따라 각자의 주거를 상호 교환하여 사용한다. 본 교환에는 금전 대가가 수반되지 않는다.', 'Art. 1 (Purpose) The parties exchange the use of their homes on the terms below. No rent is paid.'],
  ['제2조 (사용 기간·인원) 각 집의 사용 기간과 인원은 아래 조건 요약을 따르며, 변경은 새 버전의 합의와 재서명으로만 가능하다.', 'Art. 2 (Dates & guests) Dates and guests follow the summary below; changes need a new version and re-signing.'],
  ['제3조 (관리 의무) 사용자는 선량한 관리자의 주의로 집을 사용하고 원상태로 반환한다. 손상은 즉시 상대방과 JETPOOL에 알린다.', 'Art. 3 (Care) Each guest uses the home with due care, returns it as found and reports damage promptly.'],
  ['제4조 (취소) 확정 이후 취소는 JETPOOL 정책에 따르며, 두 집의 일정 잠금은 함께 해제된다.', 'Art. 4 (Cancellation) Cancellation after confirmation follows JETPOOL policy; both calendar locks are released together.'],
  ['제5조 (분쟁) 분쟁은 JETPOOL 분쟁 절차를 우선 이용하며, 관련 기록은 사건 범위 내에서만 열람된다.', 'Art. 5 (Disputes) Disputes go through the JETPOOL process; related records are accessed only within the case scope.'],
];

export default function ExchangeAgreementView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const ex = useApi<any>(`/v1/exchanges/${id}`, { auth: true });
  const ag = useApi<any>(`/v1/exchanges/${id}/agreement`, { auth: true });
  const [agree, setAgree] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <RequireAuth>
      <StateView state={ex} skeleton="detail">
        {(d) => {
          const x = exchangeView(d, user?.id);
          return (
            <>
              <ExchangeHeader x={x} />
              <StateView state={ag}>
                {(ad) => {
                  const a = item(ad);
                  const hash = str(a, 'termsHash', 'hash');
                  const snap = f<any>(a, 'termsSnapshot') ?? {};
                  const sigReq = f<any>(a, 'signatures.requester');
                  const sigRes = f<any>(a, 'signatures.responder');
                  const mine = x.role === 'REQUESTER' ? sigReq : sigRes;
                  const signedByMe = !!str(mine, 'signedAt');
                  const bothSigned = !!str(sigReq, 'signedAt') && !!str(sigRes, 'signedAt');
                  // termsSnapshot: { offer:{datesA,datesB,guestsA,guestsB}, homes:{A:{title,houseRules,checkInTime,checkOutTime},B:{…}}, platformTerms:{title,version} }
                  const offer = f<any>(snap, 'offer') ?? snap;
                  const homeA = f<any>(snap, 'homes.A') ?? {};
                  const homeB = f<any>(snap, 'homes.B') ?? {};
                  const rangeOf = (k: string) => parseDateRange(f(offer, k)) ?? { start: str(offer, `${k}.start`), end: str(offer, `${k}.end`) };
                  const dA = rangeOf('datesA');
                  const dB = rangeOf('datesB');
                  const times = (h: any) => (str(h, 'checkInTime') ? `${L('체크인', 'Check-in')} ${str(h, 'checkInTime').slice(0, 5)} · ${L('체크아웃', 'Check-out')} ${str(h, 'checkOutTime').slice(0, 5)}` : '');
                  const rules = (h: any) => {
                    const r = f<any>(h, 'houseRules') ?? {};
                    const out = [
                      r.smoking_allowed === false || r.smokingAllowed === false ? L('금연', 'No smoking') : '',
                      r.pets_allowed === false || r.petsAllowed === false ? L('반려동물 불가', 'No pets') : '',
                      r.events_allowed === false || r.eventsAllowed === false ? L('파티 불가', 'No events') : '',
                      str(r, 'quiet_hours', 'quietHours') ? `${L('조용한 시간', 'Quiet hours')} ${str(r, 'quiet_hours', 'quietHours')}` : '',
                      str(r, 'extra_rules', 'extraRules'),
                    ].filter(Boolean);
                    return out.join(' · ');
                  };
                  const platformTerms = f<any>(snap, 'platformTerms');
                  return (
                    <>
                      <Section title={L('맞교환 계약서', 'Exchange agreement')}>
                        <article className="card stack" tabIndex={0} aria-label={L('계약서 본문', 'Agreement text')} style={{ maxHeight: 460, overflowY: 'auto' }}>
                          {CLAUSES.map((c, i) => <p key={i} style={{ margin: 0 }}>{c[lang === 'ko' ? 0 : 1]}</p>)}
                          <hr />
                          <h3>{L('조건 요약', 'Terms summary')} (v{num(a, 'offerVersion') ?? x.version})</h3>
                          <Kv
                            rows={[
                              [L('집 A', 'Home A'), `${str(homeA, 'title') || str(x.propertyA, 'title')} · ${dA.start ? formatRange(dA.start, dA.end, lang) : '—'}`],
                              [L('집 B', 'Home B'), `${str(homeB, 'title') || str(x.propertyB, 'title')} · ${dB.start ? formatRange(dB.start, dB.end, lang) : '—'}`],
                              [L('인원 (A/B)', 'Guests (A/B)'), `${num(offer, 'guestsA') ?? x.guestsA ?? '—'} / ${num(offer, 'guestsB') ?? x.guestsB ?? '—'}`],
                              ...(times(homeA) || times(homeB) ? [[L('입·퇴실 (A / B)', 'Check-in/out (A / B)'), `${times(homeA) || '—'} / ${times(homeB) || '—'}`] as [string, string]] : []),
                              ...(rules(homeA) ? [[L('집 A 규칙', 'Home A rules'), rules(homeA)] as [string, string]] : []),
                              ...(rules(homeB) ? [[L('집 B 규칙', 'Home B rules'), rules(homeB)] as [string, string]] : []),
                              ...(platformTerms ? [[L('플랫폼 약관', 'Platform terms'), `${str(platformTerms, 'title')} (${str(platformTerms, 'version') || str(a, 'termsVersion')})`] as [string, string]] : []),
                            ]}
                          />
                        </article>
                        <div className="card flat stack" style={{ background: 'var(--surface-2)' }}>
                          <p style={{ margin: 0 }}><strong>{L('조건 해시 (SHA-256)', 'Terms hash (SHA-256)')}</strong></p>
                          <p className="mono" style={{ margin: 0 }}>{hash || '—'}</p>
                          <p className="small muted" style={{ margin: 0 }}>{L('서명은 이 해시가 가리키는 조건에만 유효합니다. 조건이 바뀌면 해시가 달라지며 다시 서명해야 합니다.', 'Your signature binds only the terms with this hash. If the terms change, the hash changes and you must sign again.')}</p>
                        </div>
                      </Section>
                      <Section title={L('서명 현황', 'Signatures')}>
                        <div className="grid-2 even">
                          {[[L('요청자 (A)', 'Requester (A)'), sigReq, x.requesterName], [L('응답자 (B)', 'Responder (B)'), sigRes, x.responderName]].map(([label, sig, name]) => (
                            <div key={String(label)} className="card flat row between">
                              <span><strong>{String(label)}</strong> <span className="muted small">{String(name || '')}</span></span>
                              {str(sig, 'signedAt') ? <span className="badge ok">✓ <DateText value={str(sig, 'signedAt')} time /></span> : <span className="badge warn">{L('서명 대기', 'Pending')}</span>}
                            </div>
                          ))}
                        </div>
                      </Section>
                      {!signedByMe && hash && (
                        <div className="card stack" style={{ marginTop: 16 }}>
                          <label className="check">
                            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                            <span>{L('위 계약 내용과 조건 해시를 확인했으며, 전자적 방식으로 서명하는 데 동의합니다.', 'I have reviewed the agreement and terms hash and consent to sign electronically.')}</span>
                          </label>
                          <Button
                            variant="accent"
                            disabled={!agree}
                            loading={busy}
                            style={{ justifySelf: 'start' }}
                            onClick={async () => {
                              setBusy(true);
                              setErr(null);
                              try {
                                await post(`/v1/exchanges/${id}/agreement/sign`, { termsHash: hash });
                                toast.show(L('서명했어요', 'Signed'));
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
                          </Button>
                        </div>
                      )}
                      {bothSigned && x.status === 'AGREEMENT_PENDING' && (
                        <div className="card stack" style={{ marginTop: 16 }}>
                          <p style={{ margin: 0 }}>{L('양측 서명이 완료되었습니다. 확정하면 두 집의 일정이 동시에 잠기며, 한쪽이라도 실패하면 모두 취소됩니다.', 'Both signed. Confirming locks both calendars atomically — or neither.')}</p>
                          <Button
                            variant="accent"
                            loading={busy}
                            style={{ justifySelf: 'start' }}
                            onClick={async () => {
                              setBusy(true);
                              setErr(null);
                              try {
                                await post(`/v1/exchanges/${id}/confirm`, {}, { idempotencyKey: `xconfirm-${id}-${hash.slice(0, 16)}` });
                                toast.show(L('맞교환이 확정되었어요!', 'Exchange confirmed!'));
                                ex.reload();
                              } catch (e) {
                                setErr(e);
                              } finally {
                                setBusy(false);
                              }
                            }}
                          >
                            {L('맞교환 확정', 'Confirm exchange')}
                          </Button>
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
