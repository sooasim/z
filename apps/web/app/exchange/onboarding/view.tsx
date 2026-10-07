'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api, patch } from '@/lib/api';
import { FormCard } from '@/components/form';
import { arr, item, items, f } from '@/lib/shape';
import { propertyView } from '@/lib/domain';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, ErrorText, PageHeader, Section, StatusBadge } from '@/components/ui';

export default function ExchangeOnboardingView() {
  const { L } = useI18n();
  const elig = useApi<any>('/v1/exchange/eligibility', { auth: true });
  const homes = useApi<any>('/v1/host/properties', { auth: true });
  const [err, setErr] = useState<unknown>(null);
  return (
    <RequireAuth>
      <PageHeader title={L('홈 맞교환 시작하기', 'Start home exchange')} back="/exchange" />
      <Section title={L('자격 확인', 'Eligibility')}>
        <StateView state={elig}>
          {(d) => {
            const e = item(d) ?? {};
            const unmet = arr<string>(e, 'unmet');
            const LABEL: Record<string, [string, string, string]> = {
              ACCOUNT_NOT_ACTIVE: ['계정 활성화', 'Active account', '/account'],
              IDENTITY_NOT_VERIFIED: ['본인 인증', 'Identity verified', '/verification'],
              NO_EXCHANGE_HOME: ['맞교환 가능한 게시 숙소', 'A published home open to exchange', '/host/listings'],
              ACTIVE_SANCTION: ['제재 없음', 'No active sanctions', '/support'],
              PROFILE_INCOMPLETE: ['맞교환 프로필 작성', 'Exchange profile complete', '#profile'],
            };
            return (
              <div className="card stack">
                <p style={{ margin: 0 }}>
                  {L('현재 상태', 'Status')}: <StatusBadge status={f(e, 'eligible') ? 'ELIGIBLE' : 'INELIGIBLE'} />
                </p>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} className="stack">
                  {Object.entries(LABEL).map(([code, [ko, en, href]]) => {
                    const ok = !unmet.includes(code);
                    return (
                      <li key={code} className="row between">
                        <span><span aria-hidden="true">{ok ? '✅' : '⬜'}</span> {L(ko, en)} <span className="sr-only">{ok ? L('충족', 'met') : L('미충족', 'unmet')}</span></span>
                        {!ok && <Link className="btn sm" href={href}>{L('진행하기', 'Fix')}</Link>}
                      </li>
                    );
                  })}
                </ul>
                <button className="btn" style={{ justifySelf: 'start' }} onClick={() => elig.reload()}>{L('자격 다시 확인', 'Re-check')}</button>
              </div>
            );
          }}
        </StateView>
      </Section>
      <Section id="profile" title={L('맞교환 프로필', 'Exchange profile')}>
        <FormCard
          initial={f<any>(item(elig.data), 'profile') ?? {}}
          fields={[
            { name: 'homeDescription', label: L('우리 집과 동네 소개', 'About your home & neighbourhood'), type: 'textarea', required: true },
            { name: 'preferredDestinations', label: L('가고 싶은 도시 (쉼표 구분)', 'Preferred destinations (comma separated)'), type: 'list', placeholder: L('제주, 도쿄, 리스본', 'Jeju, Tokyo, Lisbon') },
            { name: 'flexibleDates', label: L('날짜 조율 가능', 'Flexible dates'), type: 'checkbox' },
          ]}
          submit={async (b) => { await api('/v1/exchange/profile', { method: 'PUT', body: b }); elig.reload(); }}
        />
      </Section>
      <Section title={L('맞교환에 내놓을 집', 'Homes offered for exchange')}>
        <StateView state={homes} isEmpty={(d) => items(d).length === 0} empty={<Alert>{L('등록된 집이 없습니다.', 'No homes yet.')} <Link href="/host/listings">{L('집 등록하기', 'Add a home')}</Link></Alert>}>
          {(d) => (
            <ul style={{ listStyle: 'none', padding: 0 }} className="stack">
              {items(d).map((p: any) => {
                const v = propertyView(p);
                return (
                  <li key={v.id} className="card flat row between">
                    <div>
                      <strong>{v.title}</strong> <span className="muted small">{v.city}</span> <StatusBadge status={v.status} />
                    </div>
                    <label className="check">
                      <input
                        type="checkbox"
                        defaultChecked={v.exchangeEnabled}
                        onChange={async (e) => {
                          setErr(null);
                          try {
                            await patch(`/v1/properties/${v.id}`, { exchangeEnabled: e.target.checked });
                          } catch (x) {
                            setErr(x);
                            e.target.checked = !e.target.checked;
                          }
                        }}
                      />
                      <span>{L('맞교환 허용', 'Open to exchange')}</span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </StateView>
      </Section>
    </RequireAuth>
  );
}
