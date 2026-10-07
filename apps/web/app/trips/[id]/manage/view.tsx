'use client';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { item, str, num, arr } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, ErrorText, Money, PageHeader, Section, StatusBadge, Textarea, Select } from '@/components/ui';
import { useAuth } from '@/lib/auth';

function CancelBox({ id, status }: { id: string; status: string }) {
  const { L } = useI18n();
  const router = useRouter();
  const preview = useApi<any>(['CONFIRMED', 'PAYMENT_PENDING', 'HELD'].includes(status) ? `/v1/reservations/${id}/cancellation-preview` : null, { auth: true });
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('CHANGE_OF_PLANS');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (!['CONFIRMED', 'PAYMENT_PENDING', 'HELD'].includes(status)) return <p className="muted">{L('현재 상태에서는 취소할 수 없습니다.', 'Cannot cancel in the current state.')}</p>;
  const p = item(preview.data);
  return (
    <div className="card stack">
      {preview.loading ? (
        <div className="skeleton" style={{ height: 60 }} />
      ) : p ? (
        <div className="price-lines">
          <div className="line"><span>{L('결제 금액', 'Paid')}</span><Money minor={num(p, 'paidMinor', 'totalMinor')} currency={str(p, 'currency') || 'KRW'} /></div>
          <div className="line"><span>{L('취소 수수료', 'Penalty')}</span><Money minor={num(p, 'penaltyMinor', 'feeMinor')} currency={str(p, 'currency') || 'KRW'} /></div>
          <div className="line total"><span>{L('환불 예정액', 'Refund')}</span><Money minor={num(p, 'refundMinor', 'refundAmountMinor')} currency={str(p, 'currency') || 'KRW'} /></div>
          {str(p, 'policy', 'policyCode') && <p className="small muted">{L('적용 정책', 'Policy')}: {str(p, 'policy', 'policyCode')}</p>}
        </div>
      ) : (
        <ErrorText error={preview.error} />
      )}
      <Select label={L('취소 사유', 'Reason')} value={code} onChange={(e) => setCode(e.target.value)} options={[{ value: 'CHANGE_OF_PLANS', label: L('일정 변경', 'Change of plans') }, { value: 'HOST_ISSUE', label: L('숙소 문제', 'Issue with stay') }, { value: 'EMERGENCY', label: L('긴급 상황', 'Emergency') }, { value: 'OTHER', label: L('기타', 'Other') }]} />
      <Textarea label={L('상세 사유', 'Details')} value={reason} onChange={(e) => setReason(e.target.value)} />
      <button
        className="btn danger"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm(L('예약을 취소하시겠습니까?', 'Cancel this reservation?'))) return;
          setBusy(true);
          setErr(null);
          try {
            await post(`/v1/reservations/${id}/cancel`, { reasonCode: code, reason }, { idempotencyKey: `cancel-${id}` });
            router.push(`/trips/${id}`);
          } catch (e) {
            setErr(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {L('예약 취소', 'Cancel reservation')}
      </button>
      <ErrorText error={err} />
      <p className="small muted">{L('환불은 결제 수단으로 처리되며 카드사에 따라 3~7영업일이 걸릴 수 있습니다.', 'Refunds go back to the original payment method (3–7 business days).')}</p>
    </div>
  );
}

export default function ManageTripView() {
  const { id } = useParams<{ id: string }>();
  const { L } = useI18n();
  const { user } = useAuth();
  const st = useApi<any>(`/v1/reservations/${id}`, { auth: true });
  const [err, setErr] = useState<unknown>(null);
  return (
    <RequireAuth>
      <StateView state={st}>
        {(d) => {
          const r = item(d);
          const status = str(r, 'status', 'state').toUpperCase();
          const isHost = user && str(r, 'hostId', 'host_id') === user.id;
          const allowed = arr<string>(r, 'allowedActions', 'actions');
          return (
            <>
              <PageHeader title={L('예약 관리', 'Manage reservation')} back={`/trips/${id}`} actions={<StatusBadge status={status} />} />
              {status === 'CONFIRMED' && (
                <Section title={L('체크인', 'Check-in')}>
                  <div className="card row between">
                    <p style={{ margin: 0 }}>{L('도착하셨나요? 체크인을 기록하면 호스트에게 알림이 갑니다.', 'Arrived? Record check-in to notify the host.')}</p>
                    <button
                      className="btn primary"
                      onClick={async () => {
                        setErr(null);
                        try {
                          await post(`/v1/reservations/${id}/check-in`, {}, { idempotencyKey: `checkin-${id}` });
                          st.reload();
                        } catch (e) {
                          setErr(e);
                        }
                      }}
                    >
                      {L('체크인', 'Check in')}
                    </button>
                  </div>
                </Section>
              )}
              {status === 'CHECKED_IN' && (isHost || allowed.includes('complete')) && (
                <Section title={L('체크아웃/완료', 'Complete stay')}>
                  <button className="btn" onClick={async () => { setErr(null); try { await post(`/v1/reservations/${id}/complete`, {}, { idempotencyKey: `complete-${id}` }); st.reload(); } catch (e) { setErr(e); } }}>
                    {L('숙박 완료 처리', 'Mark completed')}
                  </button>
                </Section>
              )}
              <ErrorText error={err} />
              <Section title={L('취소', 'Cancellation')}>
                <CancelBox id={id} status={status} />
              </Section>
              <Alert tone="info">{L('노쇼, 숙소 문제 등은 고객센터 분쟁 접수로 처리됩니다.', 'No-shows and property issues are handled via disputes.')}</Alert>
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
