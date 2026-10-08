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
import { Alert, DateText, ErrorText, Section, Button, Kv, Icon } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { ExchangeHeader, exchangeView, homeTitle } from '../../shared';

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
                  // Perspective: my home vs. the home I stay at (A = requester's home, B = responder's).
                  const iAmA = x.role === 'REQUESTER';
                  const mySnap = iAmA ? homeA : homeB;
                  const theirSnap = iAmA ? homeB : homeA;
                  const myTitle = str(mySnap, 'title') || homeTitle(x.myHome, L('내 집', 'my home'));
                  const theirTitle = str(theirSnap, 'title') || homeTitle(x.theirHome, L('상대 집', 'their home'));
                  const myDates = iAmA ? dB : dA;
                  const theirDates = iAmA ? dA : dB;
                  const myG = num(offer, iAmA ? 'guestsB' : 'guestsA') ?? x.myGuests;
                  const theirG = num(offer, iAmA ? 'guestsA' : 'guestsB') ?? x.theirGuests;
                  // Show the platform terms by name only — never draft markers or version codes.
                  const termsTitle = (t: string) => (t || L('홈 맞교환 이용 약정', 'Home Exchange terms')).replace(/\s*\((초안|draft)\)\s*/gi, '').trim();
                  return (
                    <>
                      <Section title={L('맞교환 계약서', 'Exchange agreement')}>
                        <article className="card stack" tabIndex={0} aria-label={L('계약서 본문', 'Agreement text')} style={{ maxHeight: 460, overflowY: 'auto' }}>
                          {CLAUSES.map((c, i) => <p key={i} style={{ margin: 0 }}>{c[lang === 'ko' ? 0 : 1]}</p>)}
                          <hr />
                          <h3>{L('합의한 조건', 'Agreed terms')}</h3>
                          <Kv
                            rows={[
                              [L(`내가 머무는 집 · ${theirTitle}`, `I stay at ${theirTitle}`), myDates.start ? formatRange(myDates.start, myDates.end, lang, { nights: true }) : '—'],
                              [L(`상대가 머무는 내 집 · ${myTitle}`, `They stay at ${myTitle}`), theirDates.start ? formatRange(theirDates.start, theirDates.end, lang, { nights: true }) : '—'],
                              [L('인원', 'Guests'), L(`우리 ${myG ?? '—'}명 · 상대 ${theirG ?? '—'}명`, `Us ${myG ?? '—'} · them ${theirG ?? '—'}`)],
                              ...(times(theirSnap) ? [[L('내가 머무는 집 입·퇴실', 'Check-in/out where I stay'), times(theirSnap)] as [string, string]] : []),
                              ...(rules(theirSnap) ? [[L('내가 머무는 집 규칙', 'House rules where I stay'), rules(theirSnap)] as [string, string]] : []),
                              ...(rules(mySnap) ? [[L('내 집 규칙', 'My house rules'), rules(mySnap)] as [string, string]] : []),
                              ...(platformTerms ? [[L('플랫폼 약관', 'Platform terms'), termsTitle(str(platformTerms, 'title'))] as [string, string]] : []),
                            ]}
                          />
                        </article>
                        <p className="small muted row" style={{ gap: 6, flexWrap: 'nowrap', alignItems: 'flex-start', margin: '12px 0 0' }}>
                          <Icon name="lock" size={14} style={{ flex: '0 0 auto', marginTop: 3 }} /> {L('최종 합의 내용은 계약서에 안전하게 기록돼 변경할 수 없어요. 조건이 바뀌면 새 계약서에 다시 서명해요.', 'The final terms are recorded securely and cannot be changed. If the terms change, you sign a new agreement.')}
                        </p>
                        <details className="card flat" style={{ background: 'var(--surface-2)', marginTop: 8 }}>
                          <summary className="small" style={{ cursor: 'pointer', fontWeight: 700 }}>{L('계약 무결성 정보', 'Agreement integrity details')}</summary>
                          <p className="small muted" style={{ margin: '8px 0 4px' }}>{L('서명은 아래 지문(SHA-256)이 가리키는 조건에만 유효해요.', 'Signatures bind only the terms with this fingerprint (SHA-256).')}</p>
                          <p className="mono" style={{ margin: 0 }}>{hash || '—'}</p>
                        </details>
                      </Section>
                      <Section title={L('서명 현황', 'Signatures')}>
                        <div className="grid-2 even">
                          {(x.role === 'RESPONDER' ? [[L('나', 'Me'), sigRes, ''], [x.requesterName || L('상대', 'Them'), sigReq, '']] : [[L('나', 'Me'), sigReq, ''], [x.responderName || L('상대', 'Them'), sigRes, '']]).map(([label, sig]) => (
                            <div key={String(label)} className="card flat row between">
                              <strong>{String(label)}</strong>
                              {str(sig, 'signedAt') ? (
                                <span className="badge ok">
                                  <Icon name="check" size={14} /> <DateText value={str(sig, 'signedAt')} time />
                                </span>
                              ) : (
                                <span className="badge warn">{L('서명 대기', 'Not signed yet')}</span>
                              )}
                            </div>
                          ))}
                        </div>
                      </Section>
                      {signedByMe && !bothSigned && (
                        <div style={{ marginTop: 16 }}>
                          <Alert tone="info">
                            <strong>{L('상대방의 서명을 기다리고 있어요', 'Waiting for the other signature')}</strong>
                            <span className="small" style={{ display: 'block' }}>{L('상대가 서명하면 알림을 보내드려요. 그다음 확정하면 두 집 일정이 함께 잡혀요.', 'We’ll notify you when they sign. Then confirming books both homes together.')}</span>
                          </Alert>
                        </div>
                      )}
                      {!signedByMe && hash && (
                        <div className="card stack" style={{ marginTop: 16 }}>
                          <label className="check">
                            <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
                            <span>{L('위 계약 내용을 확인했으며, 전자적 방식으로 서명하는 데 동의합니다.', 'I have reviewed the agreement and consent to sign electronically.')}</span>
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
                          <p style={{ margin: 0 }}>{L('양측 서명이 끝났어요. 확정하면 두 집 일정이 함께 잡혀요 — 한쪽이 취소되면 모두 취소돼요.', 'Both signed. Confirming books both homes together — if one side cancels, both are cancelled.')}</p>
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
                          {L('맞교환이 확정됐어요! 두 집 일정이 함께 잡혔어요.', 'Exchange confirmed! Both homes are booked.')} <Link href={`/exchange/${id}/trip`}>{L('여행 정보 보기', 'Trip details')}</Link>
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
