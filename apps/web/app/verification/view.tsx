'use client';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { presignedUpload, sha256Hex } from '@/lib/media';
import { f, items, str } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { EmptyState, StateView } from '@/components/states';
import { DataTable } from '@/components/table';
import { FileDrop } from '@/components/form';
import { Alert, Button, ErrorText, Icon, PageHeader, Section, type IconName } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { styles as s } from '@/components/traveler/ui';
import { VERIFICATION_TYPE_LABEL } from '@/components/traveler/labels';

const KINDS: Array<{ value: string; icon: IconName; ko: string; en: string; dko: string; den: string; doc: string; cta?: { href: string; ko: string; en: string } }> = [
  { value: 'IDENTITY', icon: 'user', ko: '본인 확인', en: 'Identity', dko: '신분증으로 본인임을 확인해요', den: 'Confirm who you are with an ID', doc: 'ID_CARD' },
  { value: 'HOST', icon: 'home', ko: '호스트', en: 'Host', dko: '숙박업 신고증 등 영업 자격', den: 'Lodging registration', doc: 'LODGING_REGISTRATION', cta: { href: '/host/onboarding', ko: '호스트 시작하기', en: 'Start hosting' } },
  { value: 'GUIDE', icon: 'compass', ko: '가이드 자격', en: 'Guide credentials', dko: '관광통역안내사 등 자격증', den: 'Guide licence', doc: 'GUIDE_LICENSE', cta: { href: '/guide/onboarding', ko: '가이드 등록하기', en: 'Become a guide' } },
  { value: 'BUSINESS', icon: 'doc', ko: '사업자', en: 'Business', dko: '사업자등록증', den: 'Business registration', doc: 'BUSINESS_REGISTRATION' },
  { value: 'SUPPLIER', icon: 'ticket', ko: '여행 공급사', en: 'Travel supplier', dko: '여행업 등록증', den: 'Travel agency registration', doc: 'TRAVEL_AGENCY_REGISTRATION', cta: { href: '/support?topic=supplier', ko: '입점 문의', en: 'Apply' } },
];

function StatusGrid({ summary, onStart }: { summary: any; onStart: (k: string) => void }) {
  const { L, lang } = useI18n();
  const rows = [...KINDS.map((k) => k.value), 'PAYOUT_ACCOUNT'];
  return (
    <ul className={s.statusGrid}>
      {rows.map((t) => {
        const k = KINDS.find((x) => x.value === t);
        const sv = f<any>(summary, t) ?? {};
        const verified = f(sv, 'verified') === true;
        const st = str(sv, 'status').toUpperCase();
        const pending = ['PENDING', 'SUBMITTED', 'IN_REVIEW', 'UNDER_REVIEW'].includes(st);
        const rejected = ['REJECTED', 'NEEDS_INFO'].includes(st);
        const label = (VERIFICATION_TYPE_LABEL[t] ?? [t, t])[lang === 'ko' ? 0 : 1];
        return (
          <li key={t} className={`${s.statusItem} ${verified ? s.ok : pending ? s.pending : ''}`}>
            <span className={s.ico} aria-hidden="true">
              <Icon name={verified ? 'check' : pending ? 'clock' : k?.icon ?? 'card'} size={20} />
            </span>
            <div style={{ minWidth: 0 }}>
              <strong>{label}</strong>
              <div className={s.meta}>
                {verified ? L('인증 완료', 'Verified') : pending ? L('심사 중 · 보통 1~2영업일', 'In review · 1–2 business days') : rejected ? L('보완이 필요해요', 'Needs more info') : t === 'PAYOUT_ACCOUNT' ? L('정산을 받을 때 등록해요', 'Add when you start earning') : k ? (lang === 'ko' ? k.dko : k.den) : ''}
              </div>
              {!verified && !pending && (
                <div style={{ marginTop: 6 }}>
                  {t === 'PAYOUT_ACCOUNT' ? (
                    <Link className="small" href="/earnings">
                      {L('정산 페이지로', 'Go to earnings')}
                    </Link>
                  ) : t === 'IDENTITY' || t === 'BUSINESS' || rejected ? (
                    <button type="button" className="btn link" style={{ minHeight: 24, padding: 0, fontSize: 'var(--fs-sm)' }} onClick={() => onStart(t)}>
                      {rejected ? L('다시 제출하기', 'Resubmit') : L('인증하기', 'Verify now')}
                    </button>
                  ) : k?.cta ? (
                    <Link className="small" href={k.cta.href}>
                      {lang === 'ko' ? k.cta.ko : k.cta.en}
                    </Link>
                  ) : null}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export default function VerificationView() {
  const { L, lang } = useI18n();
  const toast = useToast();
  const st = useApi<any>('/v1/verifications', { auth: true });
  const payouts = useApi<any>('/v1/payout-accounts', { auth: true });
  const summary = f<any>(st.data, 'summary') ?? {};
  const done = (t: string) => f(f<any>(summary, t), 'verified') === true;
  const firstOpen = KINDS.find((k) => !done(k.value))?.value ?? 'IDENTITY';
  const [kind, setKind] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!kind && st.data) setKind(firstOpen);
  }, [st.data, kind, firstOpen]);
  const k = KINDS.find((x) => x.value === kind);
  return (
    <RequireAuth>
      <PageHeader title={L('본인 · 사업자 인증', 'Verification')} subtitle={L('인증을 마치면 예약과 정산을 더 안전하게 이용할 수 있어요. 제출 서류는 암호화해 비공개로 보관하고 심사에만 사용해요.', 'Verification keeps bookings and payouts safe. Documents are encrypted, kept private and used only for review.')} />
      <Section title={L('인증 현황', 'Your status')}>
        <StateView state={st}>{() => <StatusGrid summary={summary} onStart={(t) => { setKind(t); formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} />}</StateView>
      </Section>
      <Section title={L('인증 신청', 'Submit a verification')}>
        <form
          ref={formRef}
          className="card stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            if (!files[0] || !k) return;
            setBusy(true);
            try {
              const file = files[0];
              const sha256 = await sha256Hex(file);
              const mediaId = await presignedUpload(file, 'VERIFICATION', (pct) => setProgress({ [file.name]: pct }));
              await post('/v1/verifications', { subjectType: k.value, documents: [{ documentType: k.doc, mediaId, sha256 }] });
              toast.show(L('제출했어요. 심사 결과는 알림으로 알려드려요.', 'Submitted. We’ll notify you of the result.'));
              setFiles([]);
              setProgress({});
              st.reload();
            } catch (x) {
              setErr(x);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label className="field" htmlFor="vf-kind" style={{ maxWidth: 420 }}>
            <span>{L('인증 유형', 'Type')}</span>
            <select id="vf-kind" value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((o) => (
                <option key={o.value} value={o.value} disabled={done(o.value)}>
                  {(lang === 'ko' ? o.ko : o.en) + (done(o.value) ? L(' · 완료', ' · done') : '')}
                </option>
              ))}
            </select>
            {k && <small className="hint">{lang === 'ko' ? `필요 서류: ${k.dko}` : `Document: ${k.den}`}</small>}
          </label>
          {kind && done(kind) ? (
            <Alert tone="ok">{L('이미 인증을 마친 유형이에요. 다른 유형을 선택하세요.', 'Already verified. Choose another type.')}</Alert>
          ) : (
            <FileDrop label={L('증빙 서류', 'Document')} files={files} onChange={setFiles} multiple={false} accept=".pdf,.jpg,.jpeg,.png" maxSizeMb={10} required progress={progress} disabled={busy} hint={L('정보가 모두 잘 보이도록 촬영하세요. 주민등록번호 뒷자리는 가려도 돼요.', 'Make sure all details are readable. You may mask the last digits of your resident number.')} />
          )}
          <div className="row">
            <Button type="submit" variant="primary" icon="upload" loading={busy} disabled={!files.length || (!!kind && done(kind))}>
              {L('제출하기', 'Submit')}
            </Button>
          </div>
          <ErrorText error={err} />
        </form>
      </Section>
      <Section title={L('심사 내역', 'History')}>
        <StateView
          state={st}
          skeleton="table"
          isEmpty={(d) => items(d).length === 0}
          empty={
            <EmptyState illo="generic" title={L('제출한 서류가 없어요', 'No submissions yet')}>
              {L('서류를 제출하면 심사 진행 상황을 여기서 확인할 수 있어요.', 'Submitted documents and their review status appear here.')}
            </EmptyState>
          }
        >
          {(d) => (
            <DataTable
              rows={items(d)}
              caption={L('심사 내역', 'History')}
              filterable={false}
              paged={false}
              columns={[
                { key: 'subjectType|verificationType', label: L('유형', 'Type'), primary: true, render: (r) => (VERIFICATION_TYPE_LABEL[str(r, 'subjectType', 'verificationType').toUpperCase()] ?? [str(r, 'subjectType'), str(r, 'subjectType')])[lang === 'ko' ? 0 : 1] },
                { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
                { key: 'decisionReason|reason|rejectionReason', label: L('사유', 'Reason') },
                { key: 'submittedAt|createdAt', label: L('신청일', 'Submitted'), kind: 'date' },
                { key: 'expiresAt', label: L('유효기간', 'Expires'), kind: 'date' },
              ]}
            />
          )}
        </StateView>
      </Section>
      <Section title={L('정산 계좌', 'Payout account')}>
        <StateView
          state={payouts}
          skeleton="table"
          isEmpty={(d) => items(d).length === 0}
          empty={
            <EmptyState illo="payments" title={L('등록된 정산 계좌가 없어요', 'No payout account')}>
              {L('호스트·가이드·공급사로 수익을 받을 때 정산 계좌를 등록해요. 계좌 본인확인은 결제대행사 연동 후 제공돼요.', 'Add one when you start earning as a host, guide or supplier. Account verification opens with our payment partner.')}
            </EmptyState>
          }
        >
          {(d) => (
            <DataTable
              rows={items(d)}
              caption={L('정산 계좌', 'Payout accounts')}
              filterable={false}
              paged={false}
              columns={[
                { key: 'bankCode', label: L('은행', 'Bank'), primary: true },
                { key: 'accountLast4', label: L('계좌', 'Account'), render: (r) => `•••• ${str(r, 'accountLast4')}` },
                { key: 'holderName', label: L('예금주', 'Holder') },
                { key: 'status', label: L('상태', 'Status'), kind: 'status' },
              ]}
            />
          )}
        </StateView>
        <p className="xs muted" style={{ margin: 0 }}>{L('JETPOOL은 계좌번호 전체를 저장하지 않아요. 결제대행사가 발급한 토큰과 끝 4자리만 보관하며, 등록에는 2단계 인증이 필요해요.', 'We never store full account numbers — only a provider token and the last 4 digits. Adding one requires two-step verification.')}</p>
      </Section>
    </RequireAuth>
  );
}
