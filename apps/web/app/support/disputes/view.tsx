'use client';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { post } from '@/lib/api';
import { presignedUpload } from '@/lib/media';
import { RequireAuth } from '@/components/gate';
import { ResourceTable } from '@/components/table';
import { Alert, ErrorText, PageHeader, Section, Select, Textarea, Input } from '@/components/ui';

export default function DisputesView() {
  const { L } = useI18n();
  const sp = useSearchParams();
  const [subjectType, setSubjectType] = useState(sp.get('subjectType') ?? 'RESERVATION');
  const [subjectId, setSubjectId] = useState(sp.get('subjectId') ?? '');
  const [kind, setKind] = useState('PROPERTY_NOT_AS_DESCRIBED');
  const [desc, setDesc] = useState('');
  const [files, setFiles] = useState<FileList | null>(null);
  const [safety, setSafety] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [k, setK] = useState(0);
  return (
    <RequireAuth>
      <PageHeader title={L('분쟁 · 안전 신고', 'Disputes & safety')} subtitle={L('긴급 상황에서는 먼저 112/119에 연락하세요.', 'In an emergency, call local emergency services first.')} />
      <Section title={L('신규 접수', 'Open a case')}>
        <form
          className="card stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            setOk(false);
            try {
              const evidenceIds: string[] = [];
              for (const f of Array.from(files ?? [])) evidenceIds.push(await presignedUpload(f, { purpose: 'DISPUTE_EVIDENCE', visibility: 'PRIVATE' }));
              await post(safety ? '/v1/safety-reports' : '/v1/disputes', { subjectType, subjectId, disputeType: kind, category: kind, description: desc, evidenceIds }, { idempotencyKey: true });
              setOk(true);
              setDesc('');
              setK(k + 1);
            } catch (x) {
              setErr(x);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid cols-2">
            <Select label={L('대상 유형', 'Subject')} value={subjectType} onChange={(e) => setSubjectType(e.target.value)} options={[{ value: 'RESERVATION', label: L('숙소 예약', 'Stay') }, { value: 'EXCHANGE', label: L('홈 맞교환', 'Exchange') }, { value: 'GUIDE_BOOKING', label: L('가이드 예약', 'Guide') }, { value: 'ORDER', label: L('여행 주문', 'Order') }, { value: 'USER', label: L('사용자', 'User') }, { value: 'MESSAGE', label: L('메시지', 'Message') }]} />
            <Input label={L('대상 번호', 'Subject id')} value={subjectId} onChange={(e) => setSubjectId(e.target.value)} required />
          </div>
          <Select label={L('유형', 'Type')} value={kind} onChange={(e) => setKind(e.target.value)} options={[{ value: 'PROPERTY_NOT_AS_DESCRIBED', label: L('숙소가 설명과 다름', 'Not as described') }, { value: 'DAMAGE', label: L('파손/손해', 'Damage') }, { value: 'NO_SHOW', label: L('노쇼', 'No-show') }, { value: 'REFUND', label: L('환불 분쟁', 'Refund dispute') }, { value: 'HARASSMENT', label: L('괴롭힘/부적절한 행동', 'Harassment') }, { value: 'SAFETY', label: L('안전 위협', 'Safety threat') }, { value: 'FRAUD', label: L('사기 의심', 'Fraud') }]} />
          <Textarea label={L('상황 설명', 'What happened?')} value={desc} onChange={(e) => setDesc(e.target.value)} required minLength={20} />
          <label className="field">
            <span>{L('증빙 (사진/PDF, 여러 개 가능)', 'Evidence (photos/PDF)')}</span>
            <input type="file" multiple accept="image/*,application/pdf" onChange={(e) => setFiles(e.target.files)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={safety} onChange={(e) => setSafety(e.target.checked)} />
            <span>{L('즉각적인 안전 문제입니다 (우선 처리)', 'This is an urgent safety issue (priority)')}</span>
          </label>
          <button className="btn primary" disabled={busy}>{busy ? L('접수 중…', 'Submitting…') : L('접수', 'Submit')}</button>
          {ok && <Alert tone="ok">{L('접수되었습니다. 담당자가 배정되면 알려드립니다.', 'Submitted. We will notify you once assigned.')}</Alert>}
          <ErrorText error={err} />
          <p className="small muted">{L('분쟁 처리 중 담당자는 사유를 기록한 시간 제한 권한으로만 관련 메시지를 열람할 수 있으며, 모든 열람은 감사 기록됩니다.', 'Staff may read related messages only with time-limited, reason-logged access; every read is audited.')}</p>
        </form>
      </Section>
      <Section title={L('내 분쟁', 'My cases')}>
        <ResourceTable
          key={k}
          path="/v1/disputes"
          columns={[
            { key: 'id', label: '#', kind: 'id' },
            { key: 'disputeType|category', label: L('유형', 'Type') },
            { key: 'subjectType', label: L('대상', 'Subject') },
            { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
            { key: 'createdAt', label: L('접수일', 'Opened'), kind: 'datetime' },
          ]}
          empty={<p className="muted">{L('접수된 분쟁이 없습니다.', 'No disputes.')}</p>}
        />
      </Section>
    </RequireAuth>
  );
}
