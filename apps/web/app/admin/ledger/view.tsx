'use client';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { items, num, str } from '@/lib/shape';
import { formatMoney } from '@/lib/format';
import { AdminListPage } from '@/components/admin/list-page';
import { Section } from '@/components/ui';

function TrialBalance() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/admin/ledger/trial-balance', { auth: true });
  const rows = items(st.data);
  if (st.loading || st.error || rows.length === 0) return null;
  const dr = rows.reduce((s, r: any) => s + (num(r, 'debitMinor', 'debit_minor') ?? 0), 0);
  const cr = rows.reduce((s, r: any) => s + (num(r, 'creditMinor', 'credit_minor') ?? 0), 0);
  return (
    <Section title={L('시산표', 'Trial balance')}>
      <p className={dr === cr ? 'badge ok' : 'badge danger'}>{dr === cr ? L('차변 = 대변 (균형)', 'Debits = credits (balanced)') : L('불균형!', 'UNBALANCED')} · {formatMoney(dr, 'KRW', lang)}</p>
      <div className="table-wrap"><table><thead><tr><th>{L('계정', 'Account')}</th><th>{L('차변', 'Debit')}</th><th>{L('대변', 'Credit')}</th></tr></thead><tbody>{rows.map((r: any) => <tr key={str(r, 'account', 'code')}><td>{str(r, 'account', 'code', 'purpose')}</td><td className="tnum">{formatMoney(num(r, 'debitMinor', 'debit_minor'), str(r, 'currency') || 'KRW', lang)}</td><td className="tnum">{formatMoney(num(r, 'creditMinor', 'credit_minor'), str(r, 'currency') || 'KRW', lang)}</td></tr>)}</tbody></table></div>
    </Section>
  );
}

export default function AdminLedgerView() {
  const { L } = useI18n();
  return (
    <>
      <AdminListPage
        title={L('복식부기 원장', 'Double-entry ledger')}
        subtitle={L('원장은 추가 전용입니다. 수정은 보정 분개로만 기록됩니다.', 'Append-only. Corrections are compensating entries.')}
        path="/v1/admin/ledger/transactions"
        search={false}
        tabs={[
          { value: 'tx', label: L('거래', 'Transactions') },
          {
            value: 'accounts',
            label: L('계정', 'Accounts'),
            path: '/v1/admin/ledger/accounts',
            columns: [
              { key: 'code|purpose', label: L('계정', 'Account') },
              { key: 'purpose', label: L('용도', 'Purpose') },
              { key: 'ownerId|owner_id', label: L('소유', 'Owner'), kind: 'id' },
              { key: 'currency', label: L('통화', 'Currency') },
              { key: 'balanceMinor|balance_minor', label: L('잔액', 'Balance'), kind: 'money' },
            ],
          },
        ]}
        columns={[
          { key: 'id', label: L('거래', 'Tx'), kind: 'id' },
          { key: 'type|txType', label: L('유형', 'Type') },
          { key: 'sourceType', label: L('원천', 'Source') },
          { key: 'sourceId', label: 'ID', kind: 'id' },
          { key: 'totalMinor|amountMinor', label: L('금액', 'Amount'), kind: 'money' },
          { key: 'memo|description', label: L('적요', 'Memo') },
          { key: 'createdAt', label: L('일시', 'At'), kind: 'datetime' },
        ]}
      />
      <TrialBalance />
    </>
  );
}
