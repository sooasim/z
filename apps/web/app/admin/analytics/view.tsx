'use client';
import { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { arr, f, item, num, str } from '@/lib/shape';
import { formatMoneyCompact } from '@/lib/format';
import { StateView } from '@/components/states';
import { BarChart, PageHeader, Section, StatCard, Tabs } from '@/components/ui';

export default function AdminAnalyticsView() {
  const { L, lang } = useI18n();
  const [range, setRange] = useState<'7' | '30' | '90'>('30');
  const q = useMemo(() => ({ from: new Date(Date.now() - Number(range) * 86400000).toISOString(), to: new Date().toISOString() }), [range]);
  const funnel = useApi<any>('/v1/admin/analytics/funnel', { auth: true, query: q });
  const kpis = useApi<any>('/v1/admin/analytics/kpis', { auth: true, query: q });
  const STEP: Record<string, [string, string]> = { search: ['검색', 'Search'], quote: ['견적', 'Quote'], hold: ['홀드', 'Hold'], paid: ['결제', 'Paid'] };
  return (
    <>
      <PageHeader title={L('분석', 'Analytics')} subtitle={L('검색 → 견적 → 홀드 → 결제 전환 퍼널과 핵심 지표', 'Search → quote → hold → paid funnel and KPIs')} />
      <Tabs label={L('기간', 'Range')} value={range} onChange={setRange} tabs={[{ value: '7', label: L('7일', '7 days') }, { value: '30', label: L('30일', '30 days') }, { value: '90', label: L('90일', '90 days') }]} />
      <Section title={L('예약 전환 퍼널', 'Booking funnel')}>
        <StateView state={funnel} skeleton="table">
          {(d) => {
            const fu = item(d) ?? {};
            const steps = arr<any>(fu, 'steps').map((s: any) => ({ label: STEP[str(s, 'step')]?.[lang === 'ko' ? 0 : 1] ?? str(s, 'step'), value: num(s, 'count') ?? 0, conv: num(s, 'conversionFromPrevious') }));
            return (
              <div className="card stack">
                {steps.length ? <BarChart data={steps} label={L('예약 전환 퍼널', 'Booking funnel')} /> : <p className="muted">{L('데이터 없음', 'No data')}</p>}
                <div className="row small muted">
                  {steps.slice(1).map((s) => <span key={s.label}>{s.label}: {s.conv != null ? `${(s.conv * 100).toFixed(1)}%` : '—'}</span>)}
                  <strong>{L('전체 전환율', 'Overall')}: {num(fu, 'overallConversion') != null ? `${((num(fu, 'overallConversion') ?? 0) * 100).toFixed(2)}%` : '—'}</strong>
                </div>
              </div>
            );
          }}
        </StateView>
      </Section>
      <Section title={L('핵심 지표', 'KPIs')}>
        <StateView state={kpis} skeleton="table">
          {(d) => {
            const k = item(d) ?? {};
            const g = arr<any>(k, 'gmv')[0] ?? {};
            const tr = arr<any>(k, 'takeRate')[0] ?? {};
            const cr = f<any>(k, 'cancellationRate') ?? {};
            const ec = f<any>(k, 'exchangeCompletion') ?? {};
            const gb = f<any>(k, 'guideBookings') ?? {};
            const pct = (v: number | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
            return (
              <div className="stats">
                <StatCard label="GMV" value={formatMoneyCompact(num(g, 'gmvMinor') ?? 0, str(g, 'currency') || 'KRW', lang)} hint={`${num(g, 'payments') ?? 0} ${L('건 결제', 'payments')}`} />
                <StatCard label={L('수수료 수익률 (take rate)', 'Take rate')} value={num(tr, 'takeRateBps') != null ? `${((num(tr, 'takeRateBps') ?? 0) / 100).toFixed(2)}%` : '—'} hint={formatMoneyCompact(num(tr, 'feeRevenueMinor') ?? 0, str(tr, 'currency') || 'KRW', lang)} />
                <StatCard label={L('예약 취소율', 'Cancellation rate')} value={pct(num(cr, 'rate'))} hint={`${num(cr, 'cancelled') ?? 0} / ${num(cr, 'reservations') ?? 0}`} />
                <StatCard label={L('맞교환 완료율', 'Exchange completion')} value={pct(num(ec, 'rate'))} hint={`${num(ec, 'completed') ?? 0} / ${num(ec, 'confirmed') ?? 0}`} />
                <StatCard label={L('가이드 예약 (유료/무료)', 'Guide bookings (paid/free)')} value={`${num(gb, 'paid') ?? 0} / ${num(gb, 'free') ?? 0}`} hint={`${L('완료', 'Completed')} ${num(gb, 'completed') ?? 0}`} />
              </div>
            );
          }}
        </StateView>
      </Section>
    </>
  );
}
