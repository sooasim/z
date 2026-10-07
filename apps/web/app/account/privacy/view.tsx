'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { items, str, f } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { ResourceTable } from '@/components/table';
import { Alert, DateText, ErrorText, PageHeader, Section, Textarea } from '@/components/ui';

const CONSENTS = [
  { type: 'TERMS', ko: '이용약관', en: 'Terms of service', required: true },
  { type: 'PRIVACY', ko: '개인정보 수집·이용', en: 'Privacy policy', required: true },
  { type: 'MARKETING', ko: '마케팅 정보 수신', en: 'Marketing', required: false },
  { type: 'LOCATION', ko: '위치기반 서비스', en: 'Location services', required: false },
  { type: 'PERSONALIZATION', ko: '맞춤형 추천(행태정보)', en: 'Personalisation', required: false },
  { type: 'THIRD_PARTY', ko: '제3자 제공(호스트/가이드/공급사)', en: 'Sharing with partners', required: false },
];

function Consents() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/consents', { auth: true });
  const [err, setErr] = useState<unknown>(null);
  const current = new Map<string, any>();
  for (const c of items(st.data)) current.set(str(c, 'consentType', 'type', 'purpose').toUpperCase(), c);
  return (
    <Section title={L('동의 관리', 'Consents')}>
      <ErrorText error={err ?? st.error} />
      <div className="card stack">
        {CONSENTS.map((c) => {
          const row = current.get(c.type);
          const granted = row ? f(row, 'granted', 'accepted') !== false && !str(row, 'withdrawnAt', 'revokedAt') : false;
          return (
            <div key={c.type} className="row between">
              <div>
                <strong>{c[lang]}</strong> {c.required && <span className="badge">{L('필수', 'Required')}</span>}
                {row && (
                  <div className="small muted">
                    v{str(row, 'version', 'documentVersion') || '1'} · <DateText value={str(row, 'createdAt', 'grantedAt', 'updatedAt')} time />
                  </div>
                )}
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={granted}
                  disabled={c.required && granted}
                  onChange={async (e) => {
                    setErr(null);
                    try {
                      await post('/v1/consents', { consentType: c.type, type: c.type, granted: e.target.checked });
                      st.reload();
                    } catch (x) {
                      setErr(x);
                    }
                  }}
                />
                <span className="sr-only">{c[lang]}</span>
              </label>
            </div>
          );
        })}
        <p className="small muted">{L('필수 동의 철회는 회원 탈퇴로만 가능합니다. 모든 동의 변경은 버전과 함께 증적으로 보관됩니다.', 'Required consents can only be withdrawn by deleting your account. All changes are versioned evidence.')}</p>
      </div>
    </Section>
  );
}

function Requests() {
  const { L } = useI18n();
  const [reason, setReason] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [k, setK] = useState(0);
  return (
    <Section title={L('내 정보 내보내기 · 삭제', 'Export & delete')}>
      <div className="grid-2 even">
        <div className="card stack">
          <h3>{L('데이터 내보내기', 'Export my data')}</h3>
          <p className="muted small">{L('예약, 메시지, 결제, 후기 등 내 데이터를 파일로 받아요. 준비되면 알림으로 링크를 보내드립니다.', 'Get a copy of your data. We notify you with a download link.')}</p>
          <button
            className="btn"
            onClick={async () => {
              setErr(null);
              try {
                await post('/v1/privacy/export', {}, { idempotencyKey: true });
                setMsg(L('내보내기 요청이 접수되었습니다.', 'Export requested.'));
                setK(k + 1);
              } catch (x) {
                setErr(x);
              }
            }}
          >
            {L('내보내기 요청', 'Request export')}
          </button>
        </div>
        <div className="card stack">
          <h3>{L('회원 탈퇴 및 삭제', 'Delete account')}</h3>
          <p className="muted small">{L('진행 중인 예약/정산/분쟁이 있으면 법정 보관 기간 동안 일부 데이터가 제한 처리된 뒤 삭제됩니다.', 'Records under legal retention are restricted then deleted when allowed.')}</p>
          <Textarea label={L('사유 (선택)', 'Reason (optional)')} value={reason} onChange={(e) => setReason(e.target.value)} />
          <button
            className="btn danger"
            onClick={async () => {
              if (!window.confirm(L('정말 탈퇴를 요청하시겠습니까?', 'Really request deletion?'))) return;
              setErr(null);
              try {
                await post('/v1/privacy/delete', { reason }, { idempotencyKey: true });
                setMsg(L('삭제 요청이 접수되었습니다. 처리 상태는 아래에서 확인하세요.', 'Deletion requested.'));
                setK(k + 1);
              } catch (x) {
                setErr(x);
              }
            }}
          >
            {L('탈퇴 요청', 'Request deletion')}
          </button>
        </div>
      </div>
      {msg && <Alert tone="ok">{msg}</Alert>}
      <ErrorText error={err} />
      <ResourceTable
        key={k}
        path="/v1/privacy/requests"
        caption={L('요청 내역', 'Requests')}
        columns={[
          { key: 'requestType|type', label: L('유형', 'Type') },
          { key: 'status', label: L('상태', 'Status'), kind: 'status' },
          { key: 'createdAt', label: L('요청일', 'Requested'), kind: 'datetime' },
          { key: 'downloadUrl', label: L('다운로드', 'Download'), render: (r) => (str(r, 'downloadUrl') ? <a href={str(r, 'downloadUrl')}>{L('받기', 'Download')}</a> : '—') },
        ]}
        empty={<p className="muted">{L('요청 내역이 없습니다.', 'No requests.')}</p>}
      />
    </Section>
  );
}

export default function PrivacyView() {
  const { L } = useI18n();
  return (
    <RequireAuth>
      <PageHeader title={L('개인정보 · 동의', 'Privacy & consent')} />
      <Consents />
      <Requests />
    </RequireAuth>
  );
}
