'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { api, patch } from '@/lib/api';
import { FormCard } from '@/components/form';
import { arr, item, items, f } from '@/lib/shape';
import { propertyView } from '@/lib/domain';
import { placeLabel } from '@/lib/places';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { Button, ButtonLink, ErrorText, Icon, PageHeader, Section, StatusBadge, StatusPill } from '@/components/ui';
import { AuthTeaser } from '@/components/public/AuthTeaser';
import { ELIGIBILITY } from '../shared';
import s from '@/components/public/public.module.css';
import { pickText } from '@/lib/phrases';

function Onboarding() {
  const { L, lang } = useI18n();
  const elig = useApi<any>('/v1/exchange/eligibility', { auth: true });
  const homes = useApi<any>('/v1/host/properties', { auth: true });
  const [err, setErr] = useState<unknown>(null);
  return (
    <>
      <Section title={L('맞교환 자격', 'Eligibility')}>
        <StateView state={elig}>
          {(d) => {
            const e = item(d) ?? {};
            const unmet = arr<string>(e, 'unmet');
            const ok = Boolean(f(e, 'eligible'));
            const done = Object.keys(ELIGIBILITY).filter((c) => !unmet.includes(c)).length;
            return (
              <div className="card stack">
                <div className="row between">
                  <span className="row" style={{ gap: 8 }}>
                    <StatusPill status={ok ? 'ELIGIBLE' : 'INELIGIBLE'} labels={{ ELIGIBLE: ['맞교환 가능', 'Ready to exchange'], INELIGIBLE: ['준비 중', 'Not ready yet'] }} />
                    <span className="small muted">{L(`${Object.keys(ELIGIBILITY).length}개 중 ${done}개 완료`, `${done} of ${Object.keys(ELIGIBILITY).length} done`)}</span>
                  </span>
                  <Button variant="ghost" size="sm" icon="refresh" onClick={() => elig.reload()}>
                    {L('다시 확인', 'Re-check')}
                  </Button>
                </div>
                <ul className={s.check}>
                  {Object.entries(ELIGIBILITY).map(([code, it]) => {
                    const met = !unmet.includes(code);
                    return (
                      <li key={code} className={met ? s.ok : s.todo} style={{ alignItems: 'center' }}>
                        <Icon name={met ? 'check-circle' : 'circle'} size={20} />
                        <span className="grow">
                          {pickText(it, lang)}
                          <span className="sr-only">{met ? L(' (완료)', ' (done)') : L(' (필요)', ' (to do)')}</span>
                        </span>
                        {!met && (
                          <ButtonLink href={it.href} size="sm">
                            {L('진행하기', 'Do it')}
                          </ButtonLink>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {ok && (
                  <ButtonLink href="/exchange" variant="accent" icon="swap">
                    {L('맞교환할 집 둘러보기', 'Browse homes to swap')}
                  </ButtonLink>
                )}
              </div>
            );
          }}
        </StateView>
      </Section>
      <Section id="profile" title={L('맞교환 프로필', 'Exchange profile')}>
        <FormCard
          initial={f<any>(item(elig.data), 'profile') ?? {}}
          fields={[
            { name: 'homeDescription', label: L('우리 집과 동네 소개', 'About your home & neighbourhood'), type: 'textarea', required: true, placeholder: L('예: 바다까지 걸어서 5분, 아이와 지내기 좋은 조용한 아파트예요.', 'e.g. A quiet flat five minutes from the beach, great with kids.') },
            { name: 'preferredDestinations', label: L('가고 싶은 도시 (쉼표로 구분)', 'Preferred destinations (comma separated)'), type: 'list', placeholder: L('제주, 도쿄, 리스본', 'Jeju, Tokyo, Lisbon') },
            { name: 'flexibleDates', label: L('날짜 조율 가능', 'Flexible dates'), type: 'checkbox' },
          ]}
          submit={async (b) => {
            await api('/v1/exchange/profile', { method: 'PUT', body: b });
            elig.reload();
          }}
        />
      </Section>
      <Section title={L('맞교환에 내놓을 집', 'Homes offered for exchange')}>
        <StateView
          state={homes}
          isEmpty={(d) => items(d).length === 0}
          empty={
            <EmptyState illo="generic" title={L('아직 등록한 집이 없어요', 'No homes yet')} action={<ButtonLink href="/host/listings" variant="primary" icon="plus">{L('내 집 등록하기', 'List my home')}</ButtonLink>}>
              {L('맞교환하려면 내 집을 먼저 등록하고 공개해야 해요.', 'To exchange, list and publish your own home first.')}
            </EmptyState>
          }
        >
          {(d) => (
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }} className="stack">
              {items(d).map((p: any) => {
                const v = propertyView(p);
                return (
                  <li key={v.id} className="card flat row between">
                    <div style={{ minWidth: 0 }}>
                      <strong>{v.title}</strong> <span className="muted small">{placeLabel(v.city, lang)}</span> <StatusBadge status={v.status} />
                    </div>
                    <label className="check">
                      <input
                        type="checkbox"
                        defaultChecked={v.exchangeEnabled}
                        onChange={async (e) => {
                          setErr(null);
                          const el = e.currentTarget;
                          try {
                            await patch(`/v1/properties/${v.id}`, { exchangeEnabled: el.checked });
                            elig.reload();
                          } catch (x) {
                            setErr(x);
                            el.checked = !el.checked;
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
        <ErrorText error={err} />
      </Section>
    </>
  );
}

export default function ExchangeOnboardingView() {
  const { L } = useI18n();
  const { ready, user } = useAuth();
  return (
    <>
      <PageHeader title={L('홈 맞교환 시작하기', 'Start home exchange')} subtitle={L('세 가지만 준비하면 검증된 회원과 집을 바꿔 살 수 있어요.', 'Three steps and you can swap homes with verified members.')} back="/exchange" />
      {ready && !user ? (
        <AuthTeaser
          title={L('회원만 맞교환할 수 있어요', 'Exchange is for members')}
          lead={L('가입하고 본인 인증을 마치면 내 집을 등록하고 맞교환을 제안할 수 있어요.', 'Sign up and verify your identity to list your home and propose exchanges.')}
          benefits={[
            { icon: 'verified', title: L('본인 인증', 'Verify yourself'), body: L('검증된 회원끼리만 집을 볼 수 있어요.', 'Only verified members can see homes.') },
            { icon: 'home', title: L('내 집 등록', 'List your home'), body: L('사진과 규칙을 올리고 맞교환을 허용하세요.', 'Add photos and rules, then open it to exchange.') },
            { icon: 'swap', title: L('제안하고 서명', 'Propose & sign'), body: L('조건을 합의하고 계약서에 서명하면 확정돼요.', 'Agree on terms and sign to confirm.') },
          ]}
        />
      ) : (
        <RequireAuth>
          <Onboarding />
        </RequireAuth>
      )}
    </>
  );
}
