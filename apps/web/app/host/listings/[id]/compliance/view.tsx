'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, item, str, f } from '@/lib/shape';
import { presignedUpload } from '@/lib/media';
import { RequireAuth } from '@/components/gate';
import { ResourceTable } from '@/components/table';
import { Alert, ErrorText, PageHeader, Section, StatusPill, Button } from '@/components/ui';
import { pickText } from '@/lib/phrases';

const PERMIT_TYPES = [
  { value: 'TOURIST_LODGING', ko: '외국인관광 도시민박업', en: 'Urban homestay for foreign tourists' },
  { value: 'RURAL_LODGING', ko: '농어촌민박업', en: 'Rural homestay' },
  { value: 'HANOK_STAY', ko: '한옥체험업', en: 'Hanok experience' },
  { value: 'ACCOMMODATION_BUSINESS', ko: '숙박업 (일반/생활)', en: 'Lodging business' },
  { value: 'FIRE_SAFETY', ko: '소방 안전 점검', en: 'Fire safety inspection' },
  { value: 'INSURANCE', ko: '영업배상책임보험', en: 'Liability insurance' },
];

export default function ListingComplianceView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const prop = useApi<any>(`/v1/properties/${id}`, { auth: true });
  const [evalRes, setEvalRes] = useState<any>(null);
  const [type, setType] = useState(PERMIT_TYPES[0].value);
  const [number, setNumber] = useState('');
  const [jurisdiction, setJurisdiction] = useState('KR');
  const [expiry, setExpiry] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [k, setK] = useState(0);
  const e = evalRes ?? f<any>(item(prop.data), 'compliance');
  const decision = str(e, 'decision', 'status') || (f(item(prop.data), 'paidBookingEnabled') ? 'ALLOW' : '');
  const reasons = arr<any>(e, 'reasons', 'failures', 'checks');
  return (
    <RequireAuth roles={['HOST']}>
      <PageHeader title={L('인허가 · 준수 현황', 'Permits & compliance')} subtitle={str(item(prop.data), 'title')} back={`/host/listings/${id}`} />
      <div className="card row between">
        <div>
          <span className="lbl small muted">{L('현재 판정', 'Current decision')}</span>
          <div style={{ marginTop: 4 }}><StatusPill status={decision || 'PENDING'} /></div>
          <p className="small muted" style={{ margin: '6px 0 0' }}>{L('필수 인허가가 누락·만료·반려되면 유료 예약이 자동으로 차단됩니다. 규칙은 지역·유형별로 운영 정책에 따라 적용됩니다.', 'Paid booking is blocked automatically when a required permit is missing, expired or rejected. Rules depend on jurisdiction and type.')}</p>
        </div>
        <Button onClick={async () => { setErr(null); try { setEvalRes(item(await post('/v1/compliance/evaluate', { propertyId: id }))); prop.reload(); } catch (x) { setErr(x); } }}>{L('다시 평가', 'Re-evaluate')}</Button>
      </div>
      {reasons.length > 0 && (
        <Section title={L('판정 상세', 'Checks')}>
          <ul className="card stack" style={{ listStyle: 'none' }}>
            {reasons.map((r: any, i: number) => {
              const ok = f(r, 'passed', 'ok') === true || ['PASS', 'PASSED', 'OK'].includes(str(r, 'status').toUpperCase());
              return <li key={i} className="row between"><span>{ok ? '✅' : '❌'} {typeof r === 'string' ? r : str(r, 'label', 'message', 'code', 'rule')}</span>{str(r, 'expiresAt') && <span className="small muted">{L('만료', 'Expires')} {str(r, 'expiresAt').slice(0, 10)}</span>}</li>;
            })}
          </ul>
        </Section>
      )}
      <ErrorText error={err} />
      <Section title={L('인허가 등록', 'Add a permit')}>
        <form
          className="card stack"
          onSubmit={async (ev) => {
            ev.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              const documentId = file ? await presignedUpload(file, 'VERIFICATION') : undefined;
              await post(`/v1/properties/${id}/permits`, { permitType: type, permitNo: number || null, jurisdiction: jurisdiction || 'KR', documentMediaId: documentId ?? null, validUntil: expiry || null });
              setNumber('');
              setFile(null);
              setK(k + 1);
              prop.reload();
            } catch (x) {
              setErr(x);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid cols-2">
            <label className="field"><span>{L('인허가 유형', 'Permit type')}</span><select value={type} onChange={(e) => setType(e.target.value)}>{PERMIT_TYPES.map((p) => <option key={p.value} value={p.value}>{pickText(p, lang)}</option>)}</select></label>
            <label className="field"><span>{L('신고/허가 번호', 'Permit number')}</span><input value={number} onChange={(e) => setNumber(e.target.value)} required /></label>
            <label className="field"><span>{L('관할 (예: KR, KR-49)', 'Jurisdiction (e.g. KR, KR-49)')}</span><input value={jurisdiction} onChange={(e) => setJurisdiction(e.target.value)} pattern="(\*|[A-Za-z]{2}(-[A-Za-z0-9]{1,3})?)" /></label>
            <label className="field"><span>{L('만료일', 'Expiry date')}</span><input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} /></label>
          </div>
          <label className="field"><span>{L('증빙 서류 (PDF/이미지)', 'Document (PDF/image)')}</span><input type="file" accept="application/pdf,image/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
          <button className="btn primary" disabled={busy} data-loading={busy ? 'true' : undefined} style={{ justifySelf: 'start' }}>{L('제출', 'Submit')}</button>
        </form>
      </Section>
      <Section title={L('제출한 인허가', 'Submitted permits')}>
        <ResourceTable
          key={k}
          path={`/v1/properties/${id}/permits`}
          columns={[
            { key: 'permitType|type', label: L('유형', 'Type') },
            { key: 'permitNo|permitNumber', label: L('번호', 'Number') },
            { key: 'jurisdiction', label: L('관할', 'Jurisdiction') },
            { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
            { key: 'validUntil|expiresAt', label: L('만료', 'Expires'), kind: 'date' },
            { key: 'decisionReason|reviewNote', label: L('심사 메모', 'Review note') },
          ]}
          empty={<Alert tone="warn">{L('제출된 인허가가 없습니다. 유료 숙박을 판매하려면 필요합니다.', 'No permits yet — required to sell paid stays.')}</Alert>}
        />
      </Section>
    </RequireAuth>
  );
}
