'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { items, str, f } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { EmptyState, StateView } from '@/components/states';
import { DataTable } from '@/components/table';
import { Alert, Badge, Button, DateText, ErrorText, Modal, PageHeader, Section, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { Switch, styles as s } from '@/components/traveler/ui';

/** Core documents every member must accept; service-specific terms are accepted when that service is first used. */
const CORE = ['TERMS', 'PRIVACY', 'REFUND_POLICY'];
const SERVICE = ['EXCHANGE_TERMS', 'GUIDE_TERMS'];
const OPTIONAL = ['MARKETING'];
const NAMES: Record<string, [string, string]> = {
  TERMS: ['서비스 이용약관', 'Terms of service'],
  PRIVACY: ['개인정보 처리방침', 'Privacy policy'],
  REFUND_POLICY: ['취소·환불 정책', 'Cancellation & refund policy'],
  EXCHANGE_TERMS: ['홈 맞교환 약정', 'Home exchange terms'],
  GUIDE_TERMS: ['가이드 프렌드 이용 조건', 'Guide friend terms'],
  MARKETING: ['마케팅 정보 수신', 'Marketing messages'],
};
const REQUEST_TYPE: Record<string, [string, string]> = { EXPORT: ['데이터 내보내기', 'Data export'], DELETE: ['회원 탈퇴', 'Account deletion'], DELETION: ['회원 탈퇴', 'Account deletion'], RESTRICT: ['처리 제한', 'Restriction'] };

/** "2026-10-draft" → "2026-10" (drafts are versioned by month for members). */
const cleanVersion = (v: string) => v.replace(/-draft$/i, '');
const cleanTitle = (t: string) => t.replace(/\s*\((초안|draft)\)\s*/gi, '').trim();

function Consents() {
  const { L, lang } = useI18n();
  const toast = useToast();
  const st = useApi<any>('/v1/consents', { auth: true });
  const docs = useApi<any>('/v1/consent-documents');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const current = new Map<string, any>();
  const rows = Array.isArray(st.data?.current) ? st.data.current : items(st.data);
  for (const c of rows) current.set(str(c, 'consentType', 'consent_type', 'type').toUpperCase(), c);
  const docList = items(docs.data);
  const doc = (t: string) => docList.find((d: any) => str(d, 'type') === t);
  const granted = (t: string) => {
    const r = current.get(t);
    return !!r && f(r, 'granted') !== false && !str(r, 'withdrawnAt', 'revokedAt');
  };
  const missing = CORE.filter((t) => doc(t) && !granted(t));
  const record = async (list: Array<{ type: string; granted: boolean }>) => {
    setErr(null);
    setBusy(true);
    try {
      await post('/v1/consents', { consents: list.map((c) => ({ type: c.type, version: str(doc(c.type), 'version') || str(current.get(c.type), 'version'), granted: c.granted })) });
      st.reload();
      return true;
    } catch (x) {
      setErr(x);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const row = (t: string, kind: 'core' | 'service' | 'optional') => {
    const d = doc(t);
    const r = current.get(t);
    const on = granted(t);
    const name = NAMES[t]?.[lang === 'ko' ? 0 : 1] ?? cleanTitle(str(d, 'title'));
    return (
      <div className={s.consentRow} key={t}>
        <div style={{ minWidth: 0 }}>
          <strong className="small">{name}</strong>{' '}
          {kind === 'core' ? <Badge tone="info">{L('필수', 'Required')}</Badge> : kind === 'service' ? <Badge>{L('서비스 이용 시 필수', 'Required for that service')}</Badge> : <Badge>{L('선택', 'Optional')}</Badge>}
          <div className={s.meta}>
            {d && <span>{L('버전', 'Version')} {cleanVersion(str(d, 'version'))}</span>}
            {r ? (
              <span>
                {on ? L('동의함', 'Agreed') : L('동의 철회', 'Withdrawn')} · <DateText value={str(r, 'createdAt', 'created_at', 'grantedAt')} />
              </span>
            ) : (
              <span>{L('아직 동의하지 않음', 'Not agreed yet')}</span>
            )}
            {d && (
              <button type="button" className="btn link" style={{ minHeight: 24, fontSize: 'var(--fs-xs)' }} onClick={() => setOpen(t)}>
                {L('전문 보기', 'Read')}
              </button>
            )}
          </div>
        </div>
        {kind === 'optional' ? (
          <Switch
            checked={on}
            disabled={busy || !d}
            label={name}
            onChange={async (v) => {
              if (await record([{ type: t, granted: v }])) toast.show(v ? L('수신에 동의했어요', 'Subscribed') : L('수신 동의를 철회했어요', 'Unsubscribed'));
            }}
          />
        ) : on ? (
          <Badge tone="ok">{L('동의 완료', 'Agreed')}</Badge>
        ) : kind === 'core' ? (
          <Button size="sm" disabled={busy || !d} onClick={async () => (await record([{ type: t, granted: true }])) && toast.show(L('동의했어요', 'Agreed'))}>
            {L('동의하기', 'Agree')}
          </Button>
        ) : (
          <span className="xs muted">{L('미동의', 'Not agreed')}</span>
        )}
      </div>
    );
  };
  const od = open ? doc(open) : null;
  return (
    <Section title={L('약관 · 동의 관리', 'Terms & consents')}>
      <StateView state={st}>
        {() => (
          <div className="stack">
            {missing.length > 0 && (
              <Alert tone="warn">
                <div className="row between" style={{ gap: 12 }}>
                  <span>
                    <strong>{L('서비스 이용을 위해 필수 약관 동의가 필요해요.', 'Please accept the required terms to keep using JETPOOL.')}</strong>{' '}
                    {missing.map((t) => NAMES[t]?.[lang === 'ko' ? 0 : 1]).join(', ')}
                  </span>
                  <Button
                    size="sm"
                    variant="primary"
                    loading={busy}
                    onClick={async () => {
                      if (await record(missing.map((t) => ({ type: t, granted: true })))) toast.show(L('필수 약관에 동의했어요', 'Required terms accepted'));
                    }}
                  >
                    {L('필수 약관 모두 동의', 'Accept all required')}
                  </Button>
                </div>
              </Alert>
            )}
            <div className="card" style={{ paddingTop: 4, paddingBottom: 4 }}>
              {CORE.map((t) => row(t, 'core'))}
              {OPTIONAL.map((t) => row(t, 'optional'))}
              {SERVICE.map((t) => row(t, 'service'))}
            </div>
            <ErrorText error={err} />
            <p className="xs muted" style={{ margin: 0 }}>{L('필수 동의는 회원 탈퇴로만 철회할 수 있어요. 모든 동의 변경은 문서 버전과 함께 기록돼요.', 'Required consents can only be withdrawn by deleting your account. Every change is recorded with the document version.')}</p>
          </div>
        )}
      </StateView>
      <Modal open={!!od} onClose={() => setOpen(null)} title={open ? NAMES[open]?.[lang === 'ko' ? 0 : 1] ?? cleanTitle(str(od, 'title')) : ''} wide>
        <div className="stack">
          <p className="xs muted" style={{ margin: 0 }}>
            {L('버전', 'Version')} {cleanVersion(str(od, 'version'))}
            {str(od, 'publishedAt') ? ` · ${L('시행일', 'Effective')} ${str(od, 'publishedAt').slice(0, 10)}` : ` · ${L('시행 준비 중', 'Not yet in effect')}`}
          </p>
          {str(od, 'bodyMd', 'body')
            .split(/\n{2,}/)
            .map((para, i) => (
              <p key={i} style={{ whiteSpace: 'pre-line', margin: 0 }}>
                {para.replace(/^#+\s*/, '')}
              </p>
            ))}
        </div>
      </Modal>
    </Section>
  );
}

function Requests() {
  const { L, lang } = useI18n();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const reqs = useApi<any>('/v1/privacy/requests', { auth: true });
  return (
    <>
      {dialog}
      <Section title={L('내 정보 내보내기 · 탈퇴', 'Export & delete')}>
        <div className="grid-2 even" style={{ alignItems: 'start' }}>
          <div className="card stack">
            <h3 style={{ margin: 0 }}>{L('데이터 내보내기', 'Export my data')}</h3>
            <p className="muted small" style={{ margin: 0 }}>{L('예약, 메시지, 결제, 후기 등 내 데이터를 파일로 받아요. 준비되면 알림으로 다운로드 링크를 보내드려요.', 'Get a copy of your bookings, messages, payments and reviews. We’ll notify you with a download link.')}</p>
            <div className="row">
              <Button
                icon="download"
                loading={busy}
                onClick={async () => {
                  setErr(null);
                  setBusy(true);
                  try {
                    await post('/v1/privacy/export', {});
                    toast.show(L('내보내기를 요청했어요. 준비되면 알려드릴게요.', 'Export requested. We’ll let you know when it’s ready.'));
                    reqs.reload();
                  } catch (x) {
                    setErr(x);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {L('내보내기 요청', 'Request export')}
              </Button>
            </div>
          </div>
          <div className="card stack">
            <h3 style={{ margin: 0 }}>{L('회원 탈퇴', 'Delete account')}</h3>
            <p className="muted small" style={{ margin: 0 }}>{L('진행 중인 예약·정산·분쟁이 있으면 법정 보관 기간 동안 일부 데이터가 제한 처리된 뒤 삭제돼요.', 'Records under legal retention are restricted first and deleted when allowed.')}</p>
            <div className="row">
              <Button
                variant="ghost"
                icon="trash"
                style={{ color: 'var(--danger)' }}
                onClick={async () => {
                  setErr(null);
                  const r = await confirm({
                    title: L('정말 탈퇴를 요청할까요?', 'Request account deletion?'),
                    tone: 'danger',
                    body: L('탈퇴하면 예약 내역·메시지·저장 목록에 더 이상 접근할 수 없어요. 처리 상태는 아래 요청 내역에서 확인할 수 있어요.', 'You’ll lose access to bookings, messages and saved lists. Track the status under requests below.'),
                    fields: [
                      { name: 'reason', label: L('탈퇴 사유 (선택)', 'Reason (optional)'), type: 'textarea' },
                      { name: 'password', label: L('비밀번호 확인 (소셜 전용 계정은 비워 두세요)', 'Confirm password (leave empty for social-only accounts)'), type: 'text' },
                    ],
                    confirmLabel: L('탈퇴 요청', 'Request deletion'),
                    run: (_r, v) => post('/v1/privacy/delete', { confirm: 'DELETE', reason: v.reason || undefined, password: v.password || undefined }),
                  });
                  if (r.ok) {
                    toast.show(L('탈퇴 요청을 접수했어요', 'Deletion requested'));
                    reqs.reload();
                  }
                }}
              >
                {L('탈퇴 요청', 'Request deletion')}
              </Button>
            </div>
          </div>
        </div>
        <ErrorText error={err} />
      </Section>
      <Section title={L('요청 내역', 'Your requests')}>
        <StateView
          state={reqs}
          skeleton="table"
          isEmpty={(d) => items(d).length === 0}
          empty={
            <EmptyState illo="generic" title={L('요청 내역이 없어요', 'No requests yet')}>
              {L('데이터 내보내기나 탈퇴를 요청하면 처리 상태가 여기에 표시돼요.', 'Export and deletion requests show up here with their status.')}
            </EmptyState>
          }
        >
          {(d) => (
            <DataTable
              rows={items(d)}
              caption={L('요청 내역', 'Requests')}
              filterable={false}
              paged={false}
              columns={[
                { key: 'requestType|type', label: L('유형', 'Type'), primary: true, render: (r) => (REQUEST_TYPE[str(r, 'requestType', 'type').toUpperCase()] ?? [str(r, 'requestType', 'type'), str(r, 'requestType', 'type')])[lang === 'ko' ? 0 : 1] },
                { key: 'status', label: L('상태', 'Status'), kind: 'status' },
                { key: 'requestedAt|createdAt', label: L('요청일', 'Requested'), kind: 'datetime' },
                { key: 'completedAt', label: L('완료일', 'Completed'), kind: 'datetime' },
              ]}
            />
          )}
        </StateView>
      </Section>
    </>
  );
}

export default function PrivacyView() {
  const { L } = useI18n();
  return (
    <RequireAuth>
      <PageHeader title={L('개인정보 · 동의', 'Privacy & consent')} subtitle={L('약관 동의 상태를 확인하고, 내 데이터를 내보내거나 탈퇴를 요청할 수 있어요.', 'Review your consents, export your data or delete your account.')} />
      <Consents />
      <Requests />
    </RequireAuth>
  );
}
