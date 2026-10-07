'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api, post } from '@/lib/api';
import { arr, item, items, str } from '@/lib/shape';
import { AdminListPage } from '@/components/admin/list-page';
import { Alert, DateText, ErrorText, Modal, Timeline, StatusPill, Kv, Section } from '@/components/ui';
import { StateView } from '@/components/states';
import { toMinor } from '@/lib/format';

/**
 * Dispute workbench. Private P2P messages are NOT readable by default (invariant 10): staff must request a
 * case-scoped, time-limited (≤24h) elevated-access grant with a reason; every read is audited server-side.
 */
function DisputeCase({ id, onClose }: { id: string; onClose: () => void }) {
  const { L } = useI18n();
  const st = useApi<any>(`/v1/admin/disputes/${id}`, { auth: true });
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState('2');
  const [grant, setGrant] = useState<{ expiresAt: string; conversationId: string } | null>(null);
  const [convId, setConvId] = useState('');
  const [msgs, setMsgs] = useState<any[] | null>(null);
  const [resolution, setResolution] = useState('RESOLVED');
  const [remedy, setRemedy] = useState('NO_ACTION');
  const [refund, setRefund] = useState('');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal open onClose={onClose} title={`${L('분쟁', 'Dispute')} #${id.slice(0, 8)}`} wide>
      <StateView state={st} skeleton="detail">
        {(d) => {
          const c = item(d);
          return (
            <div className="stack-lg">
              <Kv rows={[[L('상태', 'Status'), <StatusPill key="s" status={str(c, 'status')} />], [L('사유', 'Reason'), str(c, 'reason', 'disputeType')], [L('대상', 'Context'), `${str(c, 'contextType', 'subjectType')} ${str(c, 'contextId', 'subjectId').slice(0, 8)}`], [L('심각도', 'Severity'), str(c, 'severity')], [L('신청자', 'Opened by'), str(c, 'openedByName', 'openedBy').slice(0, 12)], [L('내용', 'Description'), str(c, 'description')]]} />
              <Section title={L('증빙', 'Evidence')}>
                <ul className="stack small">{arr<any>(c, 'evidence').map((e, i) => <li key={i}>{str(e, 'evidenceType', 'kind')} · {str(e, 'content') || str(e, 'mediaId').slice(0, 8)} {str(e, 'sha256') && <span className="mono">sha256:{str(e, 'sha256').slice(0, 12)}</span>} · <DateText value={str(e, 'createdAt')} /></li>)}</ul>
              </Section>
              <Section title={L('타임라인', 'Timeline')}>
                <Timeline events={arr<any>(c, 'timeline', 'history', 'events').map((h) => ({ status: str(h, 'toState', 'status'), title: str(h, 'action', 'kind'), at: str(h, 'createdAt', 'at'), note: str(h, 'note', 'reason') }))} />
              </Section>
              <Section title={L('대화 열람 (권한 상승)', 'Message access (elevated)')}>
                {!grant ? (
                  <form
                    className="card flat stack"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setErr(null);
                      try {
                        const r = await post(`/v1/admin/disputes/${id}/elevated-access`, { conversationId: convId, reason, durationMinutes: Math.min(24, Number(hours)) * 60 });
                        setGrant({ expiresAt: str(item(r), 'expiresAt', 'expires_at'), conversationId: convId });
                      } catch (x) {
                        setErr(x);
                      }
                    }}
                  >
                    <Alert tone="warn">{L('당사자 간 비공개 메시지는 사건 범위·시간 제한 권한이 있어야만 열람할 수 있으며, 모든 열람이 감사 기록됩니다.', 'Private messages require a case-scoped, time-limited grant; every read is audited.')}</Alert>
                    <label className="field"><span>{L('대화 ID (사건 관련 대화만 허용)', 'Conversation id (must belong to this case)')}</span><input value={convId} onChange={(e) => setConvId(e.target.value)} required placeholder={arr<any>(c, 'evidence').map((e) => str(e, 'conversationId')).find(Boolean) ?? ''} /></label>
                    <label className="field"><span>{L('열람 사유 (필수)', 'Reason (required)')}</span><textarea value={reason} onChange={(e) => setReason(e.target.value)} required minLength={10} /></label>
                    <label className="field" style={{ maxWidth: 200 }}><span>{L('기간 (시간, 최대 24)', 'Duration (hours, ≤24)')}</span><input type="number" min={1} max={24} value={hours} onChange={(e) => setHours(e.target.value)} /></label>
                    <button className="btn primary" style={{ justifySelf: 'start' }}>{L('권한 요청', 'Request access')}</button>
                  </form>
                ) : (
                  <div className="stack">
                    <Alert tone="ok">{L('권한 만료', 'Access expires')}: <DateText value={grant.expiresAt} time /></Alert>
                    <button className="btn" onClick={async () => { setErr(null); try { setMsgs(items(await api(`/v1/admin/conversations/${grant.conversationId}/messages`))); } catch (x) { setErr(x); } }}>{L('대화 불러오기', 'Load messages')}</button>
                    {msgs && <div className="thread" style={{ height: 280 }}>{msgs.map((m: any) => <div key={str(m, 'id')} className="bubble"><div className="xs muted">{str(m, 'senderName', 'senderId')} · <DateText value={str(m, 'createdAt')} time /></div>{str(m, 'body', 'text')}</div>)}</div>}
                  </div>
                )}
              </Section>
              <Section title={L('처리', 'Resolve')}>
                <form
                  className="card flat stack"
                  onSubmit={async (e) => {
                    e.preventDefault();
                    setErr(null);
                    try {
                      await post(`/v1/admin/disputes/${id}/resolve`, { outcome: resolution, resolution: note, detail: { remedy, refundMinor: refund ? toMinor(refund) : undefined } });
                      onClose();
                    } catch (x) {
                      setErr(x);
                    }
                  }}
                >
                  <div className="form-grid cols-2">
                    <label className="field"><span>{L('결정', 'Outcome')}</span><select value={resolution} onChange={(e) => setResolution(e.target.value)}><option value="RESOLVED">{L('인용(해결)', 'Resolved')}</option><option value="REJECTED">{L('기각', 'Rejected')}</option></select></label>
                    <label className="field"><span>{L('조치', 'Remedy')}</span><select value={remedy} onChange={(e) => setRemedy(e.target.value)}><option value="NO_ACTION">{L('조치 없음', 'No action')}</option><option value="REFUND_GUEST">{L('게스트 환불 (결제 운영에서 실행)', 'Refund guest (execute in Payments)')}</option><option value="COMPENSATE_HOST">{L('호스트 보상', 'Compensate host')}</option><option value="SANCTION">{L('제재', 'Sanction')}</option></select></label>
                    <label className="field"><span>{L('환불/보상 금액(원)', 'Amount (KRW)')}</span><input inputMode="numeric" value={refund} onChange={(e) => setRefund(e.target.value)} /></label>
                  </div>
                  <label className="field"><span>{L('결정 사유 (당사자에게 전달)', 'Decision note (shared with parties)')}</span><textarea value={note} onChange={(e) => setNote(e.target.value)} required /></label>
                  <button className="btn accent" style={{ justifySelf: 'start' }}>{L('결정 확정', 'Submit decision')}</button>
                </form>
              </Section>
              <ErrorText error={err} />
            </div>
          );
        }}
      </StateView>
    </Modal>
  );
}

export default function AdminDisputesView() {
  const { L } = useI18n();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <AdminListPage
        title={L('분쟁 워크벤치', 'Dispute workbench')}
        subtitle={L('사건·증빙·타임라인과 권한 상승을 통한 메시지 열람', 'Cases, evidence, timeline and elevated message access')}
        path="/v1/admin/disputes"
        tabs={[
          { value: 'open', label: L('진행 중', 'Open') },
          { value: 'unassigned', label: L('미배정', 'Unassigned'), query: { unassigned: 'true' } },
          { value: 'high', label: L('긴급', 'High severity'), query: { severity: 'HIGH' } },
          { value: 'safety', label: L('안전 신고', 'Safety reports'), path: '/v1/admin/safety-reports' },
          { value: 'resolved', label: L('해결', 'Resolved'), query: { status: 'RESOLVED' } },
        ]}
        columns={[
          { key: 'id', label: '#', kind: 'id' },
          { key: 'reason|category', label: L('사유', 'Reason') },
          { key: 'contextType|subjectType', label: L('대상', 'Context') },
          { key: 'severity', label: L('심각도', 'Severity') },
          { key: 'evidenceCount', label: L('증빙', 'Evidence') },
          { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
          { key: 'slaDueAt', label: 'SLA', kind: 'datetime' },
          { key: 'createdAt', label: L('접수', 'Opened'), kind: 'datetime' },
        ]}
        actions={[
          { label: L('사건 열기', 'Open case'), tone: 'primary', when: (r) => !str(r, 'category'), run: async (r) => setOpen(str(r, 'id')) },
          { label: L('담당 지정', 'Assign to me'), when: (r) => !str(r, 'category'), run: (r) => post(`/v1/admin/disputes/${str(r, 'id')}/assign`, {}) },
        ]}
      />
      {open && <DisputeCase id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
