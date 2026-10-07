'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { post } from '@/lib/api';
import { arr, item, items, str } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { FormCard } from '@/components/form';
import { Alert, PageHeader, Section, StatusPill, Stepper } from '@/components/ui';
import { ApiError } from '@/lib/errors';

export default function HostOnboardingView() {
  const { L } = useI18n();
  const { reloadMe } = useAuth();
  const app = useApi<any>('/v1/host-applications', { auth: true });
  const ver = useApi<any>('/v1/verifications', { auth: true });
  const props = useApi<any>('/v1/host/properties', { auth: true });
  const [done, setDone] = useState(false);
  const a = items(app.data)[0] ?? item(app.data);
  const status = str(a, 'status', 'state').toUpperCase();
  const vs = items(ver.data);
  const has = (t: string) => vs.some((v: any) => str(v, 'subjectType', 'verificationType', 'type').toUpperCase() === t && ['APPROVED', 'VERIFIED', 'PASSED'].includes(str(v, 'status').toUpperCase()));
  const checklist: Array<[string, boolean, string]> = [
    [L('본인 인증', 'Identity verified'), has('IDENTITY'), '/verification'],
    [L('호스트·숙박업 신고 확인', 'Host / lodging registration'), has('HOST') || has('BUSINESS'), '/verification'],
    [L('첫 숙소 작성', 'First listing drafted'), items(props.data).length > 0, '/host/listings'],
    [L('숙소 게시', 'A listing published'), items(props.data).some((p: any) => str(p, 'status').toUpperCase() === 'PUBLISHED'), '/host/listings'],
  ];
  const current = checklist.findIndex((c) => !c[1]);
  const notFound = app.error instanceof ApiError && app.error.status === 404;
  return (
    <RequireAuth>
      <PageHeader title={L('호스트 시작하기', 'Become a host')} subtitle={L('검증과 인허가 확인을 마친 숙소만 유료 예약을 받을 수 있어요. 맞교환은 본인 인증 후 가능합니다.', 'Only verified, compliant listings accept paid bookings. Exchanges need identity verification.')} />
      <Stepper steps={checklist.map((c) => c[0])} current={current < 0 ? checklist.length : current} />
      <div className="grid-2">
        <Section title={L('체크리스트', 'Checklist')}>
          <ul className="card stack" style={{ listStyle: 'none' }}>
            {checklist.map(([label, ok, href]) => (
              <li key={label} className="row between">
                <span>{ok ? '✅' : '⬜'} {label}</span>
                {!ok && <Link className="btn sm" href={href}>{L('진행', 'Start')}</Link>}
              </li>
            ))}
          </ul>
        </Section>
        <Section title={L('호스트 신청', 'Host application')}>
          <StateView state={notFound ? { ...app, error: null, data: {} } : app}>
            {() =>
              status && !done ? (
                <div className="card stack">
                  <p>{L('신청 상태', 'Status')}: <StatusPill status={status} /></p>
                  {str(a, 'decisionReason', 'reason') && <Alert tone="warn">{str(a, 'decisionReason', 'reason')}</Alert>}
                  {['APPROVED', 'ACTIVE'].includes(status) && <Link className="btn primary" href="/host/listings">{L('숙소 관리로 이동', 'Go to listings')}</Link>}
                </div>
              ) : done ? (
                <Alert tone="ok">{L('신청이 접수되었습니다. 심사 결과를 알려드릴게요.', 'Application submitted. We’ll notify you.')}</Alert>
              ) : (
                <FormCard
                  fields={[
                    { name: 'displayName', label: L('호스트 활동명', 'Host display name'), required: true },
                    { name: 'about', label: L('호스트 소개 (운영 지역, 숙소 유형, 사업자 여부)', 'About you (area, property type, business?)'), type: 'textarea', required: true },
                    { name: 'agreeHostTerms', label: L('[필수] 호스트 약관과 숙박 관련 법령 준수에 동의합니다', '[Required] I agree to the host terms and applicable lodging laws'), type: 'checkbox', required: true },
                  ]}
                  submit={async (b) => {
                    if (!b.agreeHostTerms) throw new Error(L('약관 동의가 필요합니다.', 'Please accept the terms.'));
                    await post('/v1/host-applications', { displayName: b.displayName, about: b.about });
                    setDone(true);
                    await reloadMe();
                  }}
                  submitLabel={L('신청하기', 'Submit application')}
                />
              )
            }
          </StateView>
        </Section>
      </div>
    </RequireAuth>
  );
}
