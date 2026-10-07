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
import { Alert, PageHeader, Section, StatusBadge } from '@/components/ui';
import { ApiError } from '@/lib/errors';

export default function GuideOnboardingView() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/guides/profile', { auth: true });
  const [type, setType] = useState<string>('');
  const notFound = st.error instanceof ApiError && st.error.status === 404;
  const state = notFound ? { ...st, error: null, data: { item: {} } } : st;
  return (
    <RequireAuth>
      <PageHeader title={L('가이드 등록', 'Guide onboarding')} subtitle={L('유형에 따라 필요한 검증이 다릅니다. 유료·전문 가이드는 자격·사업자 검증 후 결제를 받을 수 있어요.', 'Requirements depend on type. Paid/pro guides need credential and business checks before accepting payments.')} />
      <StateView state={state}>
        {(d) => {
          const p = item(d) ?? {};
          const current = type || str(p, 'guideType', 'type') || 'FRIEND';
          const paid = GUIDE_TYPE_LABEL[current]?.paid;
          const gate = f<any>(p, 'paidGate', 'eligibility', 'gate');
          const checks = arr(gate, 'checks', 'requirements');
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
                    { name: 'displayName', label: L('활동명', 'Display name'), required: true },
                    { name: 'city', label: L('활동 지역', 'City'), required: true },
                    { name: 'languages', label: L('언어 (쉼표 구분)', 'Languages'), type: 'list', placeholder: 'ko, en' },
                    { name: 'interests', label: L('전문 분야 (쉼표 구분)', 'Specialties'), type: 'list' },
                    ...(paid ? [{ name: 'hourlyRateMinor', label: L('시간당 요금(원)', 'Hourly rate (KRW)'), type: 'money' as const }] : []),
                    ...(current === 'PROFESSIONAL' ? [{ name: 'licenseNumber', label: L('자격증 번호', 'Licence number') }] : []),
                    { name: 'bio', label: L('소개', 'About'), type: 'textarea' },
                  ]}
                  submit={async (body) => {
                    const r = await api('/v1/guides/profile', { method: str(p, 'id') ? 'PATCH' : 'POST', body: { ...body, guideType: current } });
                    st.setData(r);
                  }}
                  submitLabel={L('저장하고 심사 요청', 'Save & submit')}
                />
              </Section>
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
