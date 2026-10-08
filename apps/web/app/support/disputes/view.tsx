'use client';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { item, items, str } from '@/lib/shape';
import { presignedUpload } from '@/lib/media';
import { RequireAuth } from '@/components/gate';
import { EmptyState, StateView } from '@/components/states';
import { DataTable } from '@/components/table';
import { FileDrop } from '@/components/form';
import { Alert, Button, ErrorText, PageHeader, Section } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { SubjectPicker, type Subject } from '@/components/traveler/SubjectPicker';
import { styles as s } from '@/components/traveler/ui';
import { DISPUTE_REASON_LABEL, SEVERITY_LABEL, subjectLabel } from '@/components/traveler/labels';

const KINDS = ['PROPERTY_NOT_AS_DESCRIBED', 'CLEANLINESS', 'NO_ACCESS', 'DAMAGE', 'NO_SHOW', 'REFUND', 'HARASSMENT', 'SAFETY', 'FRAUD', 'OTHER'];
const SAFETY_CAT: Record<string, string> = { HARASSMENT: 'HARASSMENT', SAFETY: 'SAFETY_THREAT', FRAUD: 'FRAUD', PROPERTY_NOT_AS_DESCRIBED: 'PROPERTY_MISREPRESENTATION' };
const MIN = 20;

function NewCase({ onSent }: { onSent: () => void }) {
  const { L, lang } = useI18n();
  const sp = useSearchParams();
  const toast = useToast();
  const [subj, setSubj] = useState<Subject>({ type: (sp.get('subjectType') as Subject['type']) || '', id: sp.get('subjectId') ?? '' });
  const [kind, setKind] = useState('');
  const [desc, setDesc] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [safety, setSafety] = useState(false);
  const [touched, setTouched] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const errs = {
    subject: !subj.id ? L('신고할 예약을 선택해 주세요.', 'Choose the booking this is about.') : '',
    kind: !kind ? L('유형을 선택해 주세요.', 'Choose what happened.') : '',
    desc: desc.trim().length < MIN ? L(`상황을 ${MIN}자 이상 설명해 주세요.`, `Describe it in at least ${MIN} characters.`) : '',
  };
  const invalid = Object.values(errs).some(Boolean);
  return (
    <form
      className="card stack-lg"
      noValidate
      data-dispute=""
      onSubmit={async (e) => {
        e.preventDefault();
        setTouched(true);
        if (invalid) {
          requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-dispute] [aria-invalid="true"], [data-dispute] [role="radio"]')?.focus());
          return;
        }
        setBusy(true);
        setErr(null);
        try {
          const evidenceIds: string[] = [];
          for (const f of files) evidenceIds.push(await presignedUpload(f, 'EVIDENCE', (pct) => setProgress((p) => ({ ...p, [f.name]: pct }))));
          if (safety) {
            await post('/v1/safety-reports', { subjectType: subj.type, subjectId: subj.id, category: SAFETY_CAT[kind] ?? 'OTHER', description: desc.trim(), urgent: true });
          } else {
            const r = await post('/v1/disputes', { contextType: subj.type || 'OTHER', contextId: subj.id, reason: kind, description: desc.trim(), severity: kind === 'SAFETY' || kind === 'HARASSMENT' ? 'HIGH' : 'NORMAL' });
            const did = str(item(r), 'id');
            for (const mediaId of evidenceIds) if (did && mediaId) await post(`/v1/disputes/${did}/evidence`, { evidenceType: 'MEDIA', mediaId });
          }
          toast.show(safety ? L('안전 신고를 접수했어요. 우선 처리할게요.', 'Safety report received. We’ll prioritize it.') : L('접수했어요. 담당자가 배정되면 알려드려요.', 'Submitted. We’ll let you know once it’s assigned.'));
          setDesc('');
          setFiles([]);
          setProgress({});
          setKind('');
          setTouched(false);
          onSent();
        } catch (x) {
          setErr(x);
        } finally {
          setBusy(false);
        }
      }}
    >
      <SubjectPicker label={L('어떤 예약인가요?', 'Which booking?')} value={subj} onChange={setSubj} />
      {touched && errs.subject && <small className="err" role="alert" style={{ marginTop: -12 }}>{errs.subject}</small>}
      <div className="form-grid cols-2">
        <label className="field" htmlFor="dp-kind">
          <span>
            {L('무슨 일이 있었나요?', 'What happened?')} <span aria-hidden="true">*</span>
          </span>
          <select id="dp-kind" value={kind} onChange={(e) => setKind(e.target.value)} required aria-invalid={touched && errs.kind ? true : undefined} aria-describedby={touched && errs.kind ? 'dp-kind-e' : undefined}>
            <option value="">{L('선택하세요', 'Choose…')}</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {(DISPUTE_REASON_LABEL[k] ?? [k, k])[lang === 'ko' ? 0 : 1]}
              </option>
            ))}
          </select>
          {touched && errs.kind && <small className="err" id="dp-kind-e">{errs.kind}</small>}
        </label>
        <label className="field full" htmlFor="dp-desc">
          <span>
            {L('상황 설명', 'Describe the situation')} <span aria-hidden="true">*</span>
          </span>
          <textarea id="dp-desc" rows={6} maxLength={10000} value={desc} onChange={(e) => setDesc(e.target.value)} aria-invalid={touched && errs.desc ? true : undefined} aria-describedby="dp-desc-c" placeholder={L('언제, 어디서, 무슨 일이 있었는지와 원하는 해결 방법을 적어 주세요.', 'When and where it happened, and what outcome you’d like.')} />
          <span className="row between">
            {touched && errs.desc ? <small className="err">{errs.desc}</small> : <small className="hint">{L(`${MIN}자 이상`, `At least ${MIN} characters`)}</small>}
            <small id="dp-desc-c" className={`${s.counter} ${desc.trim().length > 0 && desc.trim().length < MIN ? s.over : ''}`}>
              {desc.trim().length}
            </small>
          </span>
        </label>
        <div className="full">
          <FileDrop label={L('증빙 자료 (선택)', 'Evidence (optional)')} files={files} onChange={setFiles} accept=".jpg,.jpeg,.png,.webp,.pdf" maxSizeMb={15} maxFiles={10} progress={progress} hint={L('사진·영수증·대화 캡처 등 상황을 보여 주는 자료를 올려 주세요.', 'Photos, receipts or screenshots that show what happened.')} disabled={busy} />
        </div>
      </div>
      <label className="check">
        <input type="checkbox" checked={safety} onChange={(e) => setSafety(e.target.checked)} />
        <span>
          <strong>{L('지금 안전이 위협받는 상황이에요', 'I feel unsafe right now')}</strong>
          <span className="xs muted" style={{ display: 'block' }}>{L('안전팀이 최우선으로 확인해요. 위급하면 112/119에 먼저 연락하세요.', 'Our safety team reviews these first. In an emergency call local services.')}</span>
        </span>
      </label>
      <div className="row">
        <Button type="submit" variant={safety ? 'danger' : 'primary'} icon="flag" loading={busy}>
          {safety ? L('안전 신고 접수', 'Send safety report') : L('분쟁 접수', 'Open a case')}
        </Button>
      </div>
      <ErrorText error={err} />
      <p className="xs muted" style={{ margin: 0 }}>{L('담당자는 사유가 기록된 시간 제한 권한으로만 관련 메시지를 열람할 수 있고, 모든 열람은 감사 기록에 남아요.', 'Staff can read related messages only with time-limited, reason-logged access; every read is audited.')}</p>
    </form>
  );
}

function MyCases() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/disputes', { auth: true, query: { limit: 50 } });
  return (
    <StateView
      state={st}
      skeleton="table"
      isEmpty={(d) => items(d).length === 0}
      empty={
        <EmptyState illo="generic" title={L('접수한 분쟁이 없어요', 'No cases yet')}>
          {L('여행 중 문제가 생기면 위에서 접수해 주세요. 진행 상황을 여기서 볼 수 있어요.', 'If something goes wrong, open a case above and track it here.')}
        </EmptyState>
      }
    >
      {(d) => (
        <DataTable
          rows={items(d)}
          caption={L('내 분쟁', 'My cases')}
          filterable={false}
          paged={false}
          columns={[
            { key: 'reason', label: L('유형', 'Type'), primary: true, render: (r) => <strong>{(DISPUTE_REASON_LABEL[str(r, 'reason').toUpperCase()] ?? [str(r, 'reason'), str(r, 'reason')])[lang === 'ko' ? 0 : 1]}</strong> },
            { key: 'context_type|contextType', label: L('대상', 'About'), render: (r) => subjectLabel(str(r, 'contextType', 'context_type'), lang) },
            { key: 'severity', label: L('중요도', 'Priority'), hideOnMobile: true, render: (r) => (SEVERITY_LABEL[str(r, 'severity').toUpperCase()] ?? ['—', '—'])[lang === 'ko' ? 0 : 1] },
            { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
            { key: 'created_at|createdAt', label: L('접수일', 'Opened'), kind: 'datetime' },
          ]}
        />
      )}
    </StateView>
  );
}

export default function DisputesView() {
  const { L } = useI18n();
  const [k, setK] = useState(0);
  return (
    <RequireAuth>
      <PageHeader title={L('분쟁 · 안전 신고', 'Disputes & safety')} subtitle={L('숙소 상태, 노쇼, 환불, 안전 문제를 신고하면 담당자가 확인해요.', 'Report problems with a stay, no-shows, refunds or safety and we’ll look into it.')} back="/support" />
      <Alert tone="warn" icon="phone">
        {L('생명이나 안전이 위급한 상황이라면 먼저 112(경찰) 또는 119(구급)에 연락하세요.', 'If anyone is in danger, call local emergency services first (112 police / 119 ambulance in Korea).')}
      </Alert>
      <Section title={L('새로 접수하기', 'Open a case')}>
        <NewCase onSent={() => setK((x) => x + 1)} />
      </Section>
      <Section title={L('내 분쟁', 'My cases')}>
        <MyCases key={k} />
      </Section>
    </RequireAuth>
  );
}
