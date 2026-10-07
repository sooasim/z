'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { patch, post } from '@/lib/api';
import { arr, item, items, str, f } from '@/lib/shape';
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
            const e = item(d);
            const checks = arr(e, 'checks', 'requirements', 'criteria');
            return (
              <div className="card stack">
                <p>
                  {L('현재 상태', 'Status')}: <StatusBadge status={str(e, 'status', 'state') || 'PENDING'} />
                </p>
                {checks.length > 0 && (
                  <ul style={{ listStyle: 'none', padding: 0 }} className="stack">
                    {checks.map((c: any, i: number) => {
                      const ok = f(c, 'passed', 'ok', 'met') === true || ['PASS', 'PASSED', 'OK', 'MET'].includes(str(c, 'status').toUpperCase());
                      return (
                        <li key={i} className="row">
                          <span aria-hidden="true">{ok ? '✅' : '⬜'}</span>
                          <span>{str(c, 'label', 'name', 'code')}</span>
                          {!ok && str(c, 'href') && <Link href={str(c, 'href')}>{L('진행하기', 'Fix')}</Link>}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <div className="row">
                  <button className="btn primary" onClick={async () => { setErr(null); try { await post('/v1/exchange/eligibility', {}); elig.reload(); } catch (x) { setErr(x); } }}>
                    {L('자격 다시 확인', 'Re-check eligibility')}
                  </button>
                  <Link className="btn" href="/verification">{L('본인 인증', 'Verify identity')}</Link>
                </div>
                <ErrorText error={err} />
              </div>
            );
          }}
        </StateView>
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
