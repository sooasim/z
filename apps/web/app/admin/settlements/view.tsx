'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { api, post } from '@/lib/api';
import { str } from '@/lib/shape';
import { AdminListPage } from '@/components/admin/list-page';
import { Alert, Button, ErrorText, Modal } from '@/components/ui';
import { FormCard } from '@/components/form';
import { useToast } from '@/components/ui/toast';

export default function AdminSettlementsView() {
  const { L } = useI18n();
  const toast = useToast();
  const [gen, setGen] = useState(false);
  const [k, setK] = useState(0);
  const [err, setErr] = useState<unknown>(null);
  return (
    <div key={k}>
      <AdminListPage
        title={L('정산 승인', 'Settlement approval')}
        subtitle={L('원장 기준으로 산정된 정산서를 승인하면 지급 대기열로 이동합니다. 자동 지급은 payout.automatic 플래그로 제어됩니다.', 'Approving ledger-derived statements queues payouts. Automatic payout is gated by payout.automatic.')}
        path="/v1/admin/settlements"
        search={false}
        actionsHeader={
          <>
            <Button icon="plus" onClick={() => setGen(true)}>{L('정산서 생성', 'Generate')}</Button>
            <Button
              icon="doc"
              onClick={async () => {
                setErr(null);
                try {
                  const csv = await api<string>('/v1/admin/settlements/payout-export');
                  const blob = new Blob([typeof csv === 'string' ? csv : JSON.stringify(csv, null, 2)], { type: 'text/csv' });
                  const a = document.createElement('a');
                  a.href = URL.createObjectURL(blob);
                  a.download = `payout-export-${new Date().toISOString().slice(0, 10)}.csv`;
                  a.click();
                  URL.revokeObjectURL(a.href);
                } catch (e) {
                  setErr(e);
                }
              }}
            >
              {L('지급 파일', 'Payout export')}
            </Button>
          </>
        }
        aside={
          <>
            <Alert tone="warn">{L('승인·지급은 되돌릴 수 없으며, 정정은 보정 분개로만 가능합니다. 정산 권한(ACCOUNTING)과 MFA 세션이 필요합니다.', 'Approvals/payouts cannot be undone; corrections use compensating entries. Requires ACCOUNTING + MFA.')}</Alert>
            <ErrorText error={err} />
          </>
        }
        tabs={[
          { value: 'calc', label: L('승인 대기', 'To approve'), query: { status: 'CALCULATED' } },
          { value: 'approved', label: L('지급 대기', 'Approved'), query: { status: 'APPROVED' } },
          { value: 'paid', label: L('지급 완료', 'Paid'), query: { status: 'PAID' } },
          { value: 'held', label: L('보류', 'On hold'), query: { status: 'HELD' } },
        ]}
        columns={[
          { key: 'payeeId', label: L('수취인', 'Payee'), kind: 'id' },
          { key: 'payeeType', label: L('유형', 'Type') },
          { key: 'periodStart', label: L('시작', 'From'), kind: 'date' },
          { key: 'periodEnd', label: L('종료', 'To'), kind: 'date' },
          { key: 'grossMinor', label: L('매출', 'Gross'), kind: 'money' },
          { key: 'feeMinor', label: L('수수료', 'Fees'), kind: 'money' },
          { key: 'refundMinor', label: L('환불', 'Refunds'), kind: 'money' },
          { key: 'netMinor', label: L('순지급', 'Net'), kind: 'money' },
          { key: 'status', label: L('상태', 'Status'), kind: 'status' },
        ]}
        actions={[
          { label: L('승인', 'Approve'), tone: 'primary', when: (r) => str(r, 'status').toUpperCase() === 'CALCULATED', confirm: L('이 정산서를 승인할까요?', 'Approve this statement?'), run: (r) => post(`/v1/admin/settlements/${str(r, 'id')}/approve`, {}) },
          { label: L('지급 실행', 'Pay out'), when: (r) => str(r, 'status').toUpperCase() === 'APPROVED', confirm: L('지급을 실행할까요?', 'Execute payout?'), run: (r) => post(`/v1/admin/settlements/${str(r, 'id')}/payout`, {}, { idempotencyKey: `payout-${str(r, 'id')}` }) },
          { label: L('지급 완료 처리', 'Mark paid'), when: (r) => ['APPROVED', 'PAYOUT_PENDING'].includes(str(r, 'status').toUpperCase()), reason: L('은행 이체 참조번호', 'Bank transfer reference'), run: (r, reason) => post(`/v1/admin/settlements/${str(r, 'id')}/mark-paid`, { payoutRef: reason }) },
          { label: L('보류', 'Hold'), tone: 'danger', when: (r) => ['CALCULATED', 'APPROVED'].includes(str(r, 'status').toUpperCase()), reason: L('보류 사유', 'Hold reason'), run: (r, reason) => post(`/v1/admin/settlements/${str(r, 'id')}/hold`, { reason }) },
          { label: L('보류 해제', 'Release'), when: (r) => str(r, 'status').toUpperCase() === 'HELD', reason: L('해제 사유', 'Release reason'), run: (r, reason) => post(`/v1/admin/settlements/${str(r, 'id')}/release`, { reason }) },
          { label: L('대사', 'Reconcile'), when: (r) => str(r, 'status').toUpperCase() === 'PAID', run: (r) => post(`/v1/admin/settlements/${str(r, 'id')}/reconcile`, {}) },
        ]}
      />
      <Modal open={gen} onClose={() => setGen(false)} title={L('정산서 생성', 'Generate statements')}>
        <FormCard
          fields={[
            { name: 'periodStart', label: L('기간 시작', 'Period start'), type: 'date', required: true },
            { name: 'periodEnd', label: L('기간 종료', 'Period end'), type: 'date', required: true },
          ]}
          submit={async (b) => {
            await post('/v1/admin/settlements/generate', b);
            setGen(false);
            toast.show(L('정산서를 생성했어요', 'Statements generated'));
            setK(k + 1);
          }}
          submitLabel={L('생성', 'Generate')}
        />
      </Modal>
    </div>
  );
}
