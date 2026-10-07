'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { post, api } from '@/lib/api';
import { presignedUpload } from '@/lib/media';
import { RequireAuth } from '@/components/gate';
import { ResourceTable } from '@/components/table';
import { FormCard } from '@/components/form';
import { Alert, ErrorText, PageHeader, Section } from '@/components/ui';

export default function VerificationView() {
  const { L } = useI18n();
  const [kind, setKind] = useState('IDENTITY');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [k, setK] = useState(0);
  const [msg, setMsg] = useState('');
  const KINDS = [
    { value: 'IDENTITY', label: L('본인 확인 (신분증)', 'Identity (ID)') },
    { value: 'BUSINESS', label: L('사업자 확인 (호스트/공급사)', 'Business registration') },
    { value: 'PAYOUT_ACCOUNT', label: L('정산 계좌 확인', 'Payout account') },
    { value: 'GUIDE_LICENSE', label: L('가이드 자격증', 'Guide licence') },
  ];
  return (
    <RequireAuth>
      <PageHeader title={L('본인 · 사업자 인증', 'Verification')} subtitle={L('제출 서류는 비공개 저장소에 암호화 보관되며 심사 목적으로만 열람됩니다.', 'Documents are stored privately and used only for review.')} />
      <Section title={L('인증 신청', 'Start a verification')}>
        <form
          className="card stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setErr(null);
            setMsg('');
            try {
              const documentIds: string[] = [];
              if (file) documentIds.push(await presignedUpload(file, { purpose: 'VERIFICATION_DOCUMENT', visibility: 'PRIVATE' }));
              await post('/v1/verifications', { verificationType: kind, type: kind, documentIds }, { idempotencyKey: true });
              setMsg(L('제출되었습니다. 심사 결과는 알림으로 안내됩니다.', 'Submitted. We will notify you of the result.'));
              setK(k + 1);
            } catch (x) {
              setErr(x);
            }
          }}
        >
          <label className="field">
            <span>{L('인증 유형', 'Type')}</span>
            <select value={kind} onChange={(e) => setKind(e.target.value)}>
              {KINDS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>{L('증빙 서류 (PDF/JPG/PNG, 10MB 이하)', 'Document (PDF/JPG/PNG, ≤10MB)')}</span>
            <input type="file" accept="application/pdf,image/jpeg,image/png" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
          <button className="btn primary">{L('제출', 'Submit')}</button>
          {msg && <Alert tone="ok">{msg}</Alert>}
          <ErrorText error={err} />
        </form>
      </Section>
      <Section title={L('정산 계좌', 'Payout account')}>
        <FormCard
          cols={2}
          fields={[
            { name: 'bankCode', label: L('은행', 'Bank'), required: true, placeholder: '004' },
            { name: 'accountNumber', label: L('계좌번호', 'Account number'), required: true, hint: L('저장 시 마스킹되며 전체 번호는 표시되지 않습니다.', 'Stored masked; never displayed in full.') },
            { name: 'holderName', label: L('예금주', 'Holder name'), required: true },
          ]}
          submit={(body) => api('/v1/verifications/payout-account', { method: 'POST', body, idempotencyKey: true })}
          submitLabel={L('계좌 인증 요청', 'Verify account')}
          resetOnSuccess
        />
      </Section>
      <Section title={L('심사 현황', 'Status')}>
        <ResourceTable
          key={k}
          path="/v1/verifications"
          columns={[
            { key: 'verificationType|type', label: L('유형', 'Type') },
            { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
            { key: 'decisionReason|reason', label: L('사유', 'Reason') },
            { key: 'createdAt', label: L('신청일', 'Submitted'), kind: 'date' },
            { key: 'expiresAt', label: L('만료', 'Expires'), kind: 'date' },
          ]}
          empty={<p className="muted">{L('인증 내역이 없습니다.', 'No verifications.')}</p>}
        />
      </Section>
    </RequireAuth>
  );
}

