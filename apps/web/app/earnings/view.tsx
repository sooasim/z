'use client';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { item, items, num, str } from '@/lib/shape';
import { formatMoney, formatMoneyCompact } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { ResourceTable } from '@/components/table';
import { Alert, BarChart, PageHeader, Section, StatCard } from '@/components/ui';

/** Ledger-derived settlement statements for hosts, guides and suppliers (FIN-02). */
export default function EarningsView() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/provider/settlements', { auth: true, query: { limit: 24 } });
  const rows = items(st.data);
  const summary = item(st.data);
  const cur = str(rows[0], 'currency') || 'KRW';
  const sum = (k: string[]) => rows.reduce((s, r: any) => s + (num(r, ...k) ?? 0), 0);
  const pending = rows.filter((r: any) => !['PAID', 'PAID_OUT', 'SETTLED'].includes(str(r, 'status').toUpperCase()));
  const series = rows.slice(0, 8).reverse().map((r: any) => ({ label: str(r, 'periodEnd', 'periodStart', 'createdAt').slice(2, 7) || '—', value: num(r, 'netMinor', 'payoutMinor', 'amountMinor') ?? 0 }));
  return (
    <RequireAuth roles={['HOST', 'GUIDE', 'SUPPLIER']}>
      <PageHeader title={L('정산', 'Earnings')} subtitle={L('복식부기 원장에서 산출된 정산 내역입니다. 수수료·세금·환불 조정이 모두 반영돼요.', 'Statements derived from the double-entry ledger, including fees, taxes and refund adjustments.')} />
      <div className="stats">
        <StatCard label={L('누적 매출', 'Gross')} value={formatMoneyCompact(num(summary, 'grossMinor') ?? sum(['grossMinor']), cur, lang)} />
        <StatCard label={L('플랫폼 수수료', 'Platform fees')} value={formatMoneyCompact(num(summary, 'feeMinor') ?? sum(['feeMinor', 'feesMinor']), cur, lang)} />
        <StatCard label={L('지급 예정', 'Pending payout')} value={formatMoneyCompact(pending.reduce((s, r: any) => s + (num(r, 'netMinor', 'payoutMinor') ?? 0), 0), cur, lang)} hint={`${pending.length}${L('건', ' statements')}`} />
        <StatCard label={L('누적 지급액', 'Paid out')} value={formatMoneyCompact(num(summary, 'paidMinor') ?? sum(['paidMinor']), cur, lang)} trend={series.map((s) => s.value)} />
      </div>
      {series.length > 1 && (
        <Section title={L('기간별 순정산액', 'Net payout by period')}>
          <div className="card"><BarChart data={series} label={L('기간별 순정산액', 'Net payout by period')} format={(n) => formatMoney(n, cur, lang)} /></div>
        </Section>
      )}
      <Section title={L('정산서', 'Statements')}>
        <ResourceTable
          path="/v1/provider/settlements"
          query={{ limit: 50 }}
          columns={[
            { key: 'periodStart', label: L('기간 시작', 'From'), kind: 'date' },
            { key: 'periodEnd', label: L('기간 종료', 'To'), kind: 'date' },
            { key: 'grossMinor', label: L('매출', 'Gross'), kind: 'money' },
            { key: 'feeMinor|feesMinor', label: L('수수료', 'Fees'), kind: 'money' },
            { key: 'adjustmentMinor|refundsMinor', label: L('조정', 'Adjustments'), kind: 'money' },
            { key: 'netMinor|payoutMinor', label: L('순지급액', 'Net'), kind: 'money' },
            { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
            { key: 'statementUrl', label: L('정산서', 'Statement'), render: (r) => (str(r, 'statementUrl') ? <a href={str(r, 'statementUrl')} target="_blank" rel="noopener noreferrer">PDF</a> : '—') },
          ]}
          empty={<p className="muted">{L('아직 정산 내역이 없습니다.', 'No statements yet.')}</p>}
        />
      </Section>
      <Alert tone="info">{L('세금계산서·원천징수 등 세무 처리는 운영 정책과 법령에 따라 적용되며, 정산 계좌는 본인 인증 메뉴에서 관리합니다.', 'Tax invoices/withholding follow policy and law; manage your payout account under Verification.')}</Alert>
    </RequireAuth>
  );
}
