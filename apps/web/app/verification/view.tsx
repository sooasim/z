'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { post } from '@/lib/api';
import { presignedUpload, sha256Hex } from '@/lib/media';
import { str } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { ResourceTable } from '@/components/table';
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
    { value: 'HOST', label: L('호스트 (숙박업 신고증)', 'Host (lodging registration)') },
    { value: 'BUSINESS', label: L('사업자 확인', 'Business registration') },
    { value: 'GUIDE', label: L('가이드 자격', 'Guide credentials') },
    { value: 'SUPPLIER', label: L('여행 공급사 (여행업 등록증)', 'Travel supplier') },
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
              if (!file) throw new Error(L('증빙 서류를 첨부하세요.', 'Attach a document.'));
              const sha256 = await sha256Hex(file);
              const mediaId = await presignedUpload(file, 'VERIFICATION');
              const DOC: Record<string, string> = { IDENTITY: 'ID_CARD', BUSINESS: 'BUSINESS_REGISTRATION', GUIDE: 'GUIDE_LICENSE', HOST: 'LODGING_REGISTRATION', SUPPLIER: 'TRAVEL_AGENCY_REGISTRATION' };
              await post('/v1/verifications', { subjectType: kind, documents: [{ documentType: DOC[kind] ?? 'OTHER', mediaId, sha256 }] });
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
        <Alert tone="info">{L('계좌번호 전체는 JETPOOL에 저장되지 않습니다. 제휴 PG의 계좌 본인확인을 거쳐 발급된 토큰과 끝 4자리만 보관하며, 등록에는 MFA 세션이 필요합니다.', 'Full account numbers are never stored: only a PG-issued token and the last 4 digits. Registration requires an MFA session.')}</Alert>
        <ResourceTable
          path="/v1/payout-accounts"
          columns={[
            { key: 'bankCode', label: L('은행', 'Bank') },
            { key: 'accountLast4', label: L('계좌 끝자리', 'Last 4'), render: (r) => `•••• ${str(r, 'accountLast4')}` },
            { key: 'holderName', label: L('예금주', 'Holder') },
            { key: 'status', label: L('상태', 'Status'), kind: 'status' },
          ]}
          empty={<p className="muted">{L('등록된 정산 계좌가 없습니다. 계좌 인증은 PG 본인확인 연동 후 제공됩니다.', 'No payout account yet. Registration opens with the PG account-verification integration.')}</p>}
        />
      </Section>
      <Section title={L('심사 현황', 'Status')}>
        <ResourceTable
          key={k}
          path="/v1/verifications"
          columns={[
            { key: 'subjectType|verificationType', label: L('유형', 'Type') },
            { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
            { key: 'decisionReason|reason|rejectionReason', label: L('사유', 'Reason') },
            { key: 'submittedAt|createdAt', label: L('신청일', 'Submitted'), kind: 'date' },
            { key: 'expiresAt', label: L('만료', 'Expires'), kind: 'date' },
          ]}
          empty={<p className="muted">{L('인증 내역이 없습니다.', 'No verifications.')}</p>}
        />
      </Section>
    </RequireAuth>
  );
}

