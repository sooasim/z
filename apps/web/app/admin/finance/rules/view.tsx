'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { post } from '@/lib/api';
import { AdminListPage } from '@/components/admin/list-page';
import { FormCard } from '@/components/form';
import { Alert, Modal, Button } from '@/components/ui';

export default function AdminFinanceRulesView() {
  const { L } = useI18n();
  const [open, setOpen] = useState(false);
  const [k, setK] = useState(0);
  return (
    <div key={k}>
      <AdminListPage
        title={L('수수료 · 세금 · 증빙 규칙', 'Fee, tax & evidence rules')}
        subtitle={L('하나의 고정 규칙을 하드코딩하지 않고, 유효기간이 있는 설정으로 관리합니다. 신규 규칙은 사업·법무 승인 후 적용하세요.', 'No hard-coded universal rule: effective-dated configuration requiring business/legal approval.')}
        path="/v1/finance/rules"
        actionsHeader={<Button variant="primary" icon="plus" onClick={() => setOpen(true)}>{L('새 규칙', 'New rule')}</Button>}
        search={false}
        tabs={[
          { value: 'approved', label: L('승인됨', 'Approved'), query: { status: 'APPROVED' } },
          { value: 'draft', label: L('승인 대기', 'Draft'), query: { status: 'DRAFT' } },
          { value: 'retired', label: L('폐기', 'Retired'), query: { status: 'RETIRED' } },
        ]}
        columns={[
          { key: 'domain', label: L('도메인', 'Domain') },
          { key: 'ruleType|rule_type', label: L('유형', 'Type') },
          { key: 'params.bps', label: 'bps' },
          { key: 'params.flat_minor', label: L('정액', 'Fixed'), kind: 'money' },
          { key: 'jurisdiction', label: L('관할', 'Jurisdiction') },
          { key: 'effectiveFrom|effective_from', label: L('적용 시작', 'From'), kind: 'date' },
          { key: 'effectiveUntil|effective_until', label: L('적용 종료', 'Until'), kind: 'date' },
          { key: 'status', label: L('상태', 'Status'), kind: 'status' },
        ]}
        actions={[{ label: L('승인', 'Approve'), tone: 'primary', when: (r) => String(r.status ?? '').toUpperCase() === 'DRAFT', confirm: L('사업·법무 승인을 확인했습니까?', 'Business/legal approval confirmed?'), run: (r) => post(`/v1/finance/rules/${r.id}/approve`, {}) }]}
      />
      <Modal open={open} onClose={() => setOpen(false)} title={L('새 수수료/세금 규칙', 'New fee/tax rule')} wide>
        <Alert tone="warn">{L('법무·사업 승인 근거를 반드시 기록하세요.', 'Record the legal/business approval reference.')}</Alert>
        <FormCard
          cols={2}
          fields={[
            { name: 'domain', label: L('도메인', 'Domain'), type: 'select', required: true, options: ['STAY', 'GUIDE', 'TRAVEL', 'EXCHANGE', '*'].map((v) => ({ value: v, label: v })) },
            { name: 'ruleType', label: L('유형', 'Type'), type: 'select', required: true, options: ['PLATFORM_FEE', 'HOST_FEE', 'TAX', 'WITHHOLDING', 'EVIDENCE'].map((v) => ({ value: v, label: v })) },
            { name: 'params.bps', label: L('요율 (bps, 1000=10%)', 'Rate (bps)'), type: 'number', min: 0, max: 10000 },
            { name: 'params.flat_minor', label: L('정액 (원)', 'Flat (KRW)'), type: 'money' },
            { name: 'jurisdiction', label: L('관할', 'Jurisdiction'), placeholder: 'KR' },
            { name: 'effectiveFrom', label: L('적용 시작', 'Effective from'), type: 'date', required: true },
            { name: 'effectiveUntil', label: L('적용 종료', 'Effective until'), type: 'date' },
            { name: 'note', label: L('승인 근거 (문서번호/메모)', 'Approval reference / note'), required: true },
          ]}
          submit={async (b) => {
            const toIso = (d: unknown) => (d ? new Date(`${String(d)}T00:00:00+09:00`).toISOString() : undefined);
            await post('/v1/finance/rules', { ...b, params: b.params ?? {}, effectiveFrom: toIso(b.effectiveFrom), effectiveUntil: toIso(b.effectiveUntil) ?? null });
            setOpen(false);
            setK(k + 1);
          }}
        />
      </Modal>
    </div>
  );
}
