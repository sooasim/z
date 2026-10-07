'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api } from '@/lib/api';
import { item, str, arr, f } from '@/lib/shape';
import { GUIDE_TYPES, GUIDE_TYPE_LABEL } from '@/lib/domain';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { FormCard } from '@/components/form';
import { Alert, ErrorText, PageHeader, Section, StatusBadge } from '@/components/ui';
import { presignedUpload } from '@/lib/media';
import { ApiError } from '@/lib/errors';

function PublishButton({ onDone }: { onDone: () => void }) {
  const { L } = useI18n();
  const [err, setErr] = useState<unknown>(null);
  return (
    <span className="stack" style={{ alignItems: 'flex-end' }}>
      <button className="btn accent" onClick={async () => { setErr(null); try { await api('/v1/guides/profile/publish', { method: 'POST', body: {} }); onDone(); } catch (e) { setErr(e); } }}>{L('프로필 공개', 'Publish profile')}</button>
      <ErrorText error={err} />
    </span>
  );
}

function QualificationUpload({ onDone }: { onDone: () => void }) {
  const { L } = useI18n();
  const [type, setType] = useState('GUIDE_LICENSE');
  const [ref, setRef] = useState('');
  const [until, setUntil] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="card stack"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!file) return;
        setBusy(true);
        setErr(null);
        try {
          const documentMediaId = await presignedUpload(file, 'VERIFICATION');
          await api('/v1/guides/qualifications', { method: 'POST', body: { qualificationType: type, documentMediaId, referenceNo: ref || undefined, validUntil: until || undefined } });
          setFile(null);
          onDone();
        } catch (x) {
          setErr(x);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid cols-3">
        <label className="field"><span>{L('서류 유형', 'Type')}</span><select value={type} onChange={(e) => setType(e.target.value)}>{['GUIDE_LICENSE', 'BUSINESS_REGISTRATION', 'INSURANCE', 'TRAVEL_AGENCY_REGISTRATION', 'OTHER'].map((t) => <option key={t}>{t}</option>)}</select></label>
        <label className="field"><span>{L('번호', 'Reference no.')}</span><input value={ref} onChange={(e) => setRef(e.target.value)} /></label>
        <label className="field"><span>{L('유효기간', 'Valid until')}</span><input type="date" value={until} onChange={(e) => setUntil(e.target.value)} /></label>
      </div>
      <label className="field"><span>{L('서류 파일', 'Document')}</span><input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required /></label>
      <button className="btn primary" disabled={busy} data-loading={busy ? 'true' : undefined} style={{ justifySelf: 'start' }}>{L('제출', 'Submit')}</button>
      <ErrorText error={err} />
    </form>
  );
}

export default function GuideOnboardingView() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/guides/me', { auth: true });
  const [type, setType] = useState<string>('');
  const notFound = st.error instanceof ApiError && st.error.status === 404;
  const state = notFound ? { ...st, error: null, data: { item: {} } } : st;
  return (
    <RequireAuth>
      <PageHeader title={L('가이드 등록', 'Guide onboarding')} subtitle={L('유형에 따라 필요한 검증이 다릅니다. 유료·전문 가이드는 자격·사업자 검증 후 결제를 받을 수 있어요.', 'Requirements depend on type. Paid/pro guides need credential and business checks before accepting payments.')} />
      <StateView state={state}>
        {(d) => {
          const p = item(d) ?? {};
          const exists = !!str(p, 'userId', 'user_id', 'guideType', 'guide_type');
          const current = type || str(p, 'guideType', 'guide_type') || 'FRIEND';
          const paid = GUIDE_TYPE_LABEL[current]?.paid;
          const gate = f<any>(d, 'eligibility') ?? {};
          const checks = [...arr<any>(gate, 'checks'), ...arr<string>(gate, 'unmet', 'missing').map((code) => ({ label: code, passed: false }))];
          const quals = arr<any>(d, 'qualifications');
          return (
            <>
              {str(p, 'status') && (
                <p>
                  {L('프로필 상태', 'Profile status')}: <StatusBadge status={str(p, 'status')} />
                </p>
              )}
              <Section title={L('1. 가이드 유형', '1. Guide type')}>
                <div className="grid">
                  {GUIDE_TYPES.map((t) => (
                    <button key={t} type="button" className="card" aria-pressed={current === t} onClick={() => setType(t)} style={{ textAlign: 'left', cursor: 'pointer', outline: current === t ? '2px solid var(--c-primary)' : undefined }}>
                      <strong>{GUIDE_TYPE_LABEL[t][lang]}</strong>
                      <p className="small muted" style={{ margin: '4px 0 0' }}>
                        {t === 'FRIEND' && L('여행자와 동네를 함께 걷는 무료 교류', 'Free local meetups')}
                        {t === 'VOLUNTEER' && L('봉사 목적의 무료 안내', 'Volunteer guidance')}
                        {t === 'PAID' && L('시간당 요금을 받는 로컬 가이드 (검증 필요)', 'Paid local guide (verification)')}
                        {t === 'PROFESSIONAL' && L('관광통역안내사 등 자격 보유 (자격증·사업자 필요)', 'Licensed professional')}
                      </p>
                    </button>
                  ))}
                </div>
              </Section>
              {paid && (
                <Section title={L('유료 활동 요건', 'Paid guide requirements')}>
                  {checks.length ? (
                    <ul className="card stack" style={{ listStyle: 'none' }}>
                      {checks.map((c: any, i: number) => (
                        <li key={i}>{f(c, 'passed', 'ok') ? '✅' : '⬜'} {str(c, 'label', 'code')}</li>
                      ))}
                    </ul>
                  ) : (
                    <Alert tone="warn">
                      {L('본인 인증, 자격증(전문), 정산 계좌, 사업자 정보 확인이 필요합니다. 승인 전에는 무료 유형으로만 노출됩니다.', 'ID, licence (pro), payout account and business info are required. Until approved you appear only as free.')}{' '}
                      <Link href="/verification">{L('인증 진행', 'Verify')}</Link>
                    </Alert>
                  )}
                </Section>
              )}
              <Section title={L('2. 프로필', '2. Profile')}>
                <FormCard
                  cols={2}
                  initial={{ ...p, guideType: current }}
                  fields={[
                    { name: 'headline', label: L('한 줄 소개', 'Headline'), required: true },
                    { name: 'city', label: L('활동 도시', 'City'), required: true },
                    { name: 'regions', label: L('활동 지역 (쉼표 구분)', 'Regions (comma separated)'), type: 'list', placeholder: L('성수동, 서울숲', 'Seongsu, Seoul Forest') },
                    { name: 'languages', label: L('언어 코드 (쉼표 구분)', 'Language codes'), type: 'list', placeholder: 'ko, en, ja' },
                    { name: 'interests', label: L('관심사', 'Interests'), type: 'list' },
                    { name: 'specialties', label: L('전문 분야', 'Specialties'), type: 'list' },
                    { name: 'maxGroupSize', label: L('최대 인원', 'Max group size'), type: 'number', min: 1, max: 50 },
                    ...(paid ? [{ name: 'hourlyPriceMinor', label: L('시간당 요금(원)', 'Hourly price (KRW)'), type: 'money' as const }] : []),
                    { name: 'bio', label: L('소개', 'About'), type: 'textarea' },
                  ]}
                  submit={async (body) => {
                    await api('/v1/guides/profile', { method: exists ? 'PATCH' : 'POST', body: { ...body, guideType: current } });
                    st.reload();
                  }}
                  submitLabel={L('프로필 저장', 'Save profile')}
                />
              </Section>
              {paid && (
                <Section title={L('3. 자격 서류', '3. Qualifications')}>
                  <QualificationUpload onDone={() => st.reload()} />
                  {quals.length > 0 && (
                    <ul className="stack small" style={{ listStyle: 'none', padding: 0 }}>
                      {quals.map((q: any, i: number) => <li key={i} className="card flat row between"><span>{str(q, 'qualificationType', 'qualification_type')} {str(q, 'referenceNo', 'reference_no')}</span><StatusBadge status={str(q, 'status')} /></li>)}
                    </ul>
                  )}
                </Section>
              )}
              {exists && (
                <Section title={L('4. 공개', '4. Publish')}>
                  <div className="card row between">
                    <span>{L('상태', 'Status')}: <StatusBadge status={str(p, 'status') || 'DRAFT'} /></span>
                    {str(p, 'status').toUpperCase() === 'PUBLISHED' ? (
                      <button className="btn" onClick={async () => { await api('/v1/guides/profile/unpublish', { method: 'POST', body: {} }); st.reload(); }}>{L('비공개로 전환', 'Unpublish')}</button>
                    ) : (
                      <PublishButton onDone={() => st.reload()} />
                    )}
                  </div>
                </Section>
              )}
              <div className="row" style={{ marginTop: 16 }}>
                <Link className="btn" href="/guide/calendar">{L('일정 관리', 'Calendar')}</Link>
                <Link className="btn" href="/guide/requests">{L('요청함', 'Requests')}</Link>
              </div>
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
