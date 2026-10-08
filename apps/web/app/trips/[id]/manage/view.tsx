'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { item, str, num, arr, f } from '@/lib/shape';
import { formatRange } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, Button, ErrorText, Money, PageHeader, Select, StatusPill, Textarea, useConfirm } from '@/components/ui';
import { useToast } from '@/components/ui/toast';
import { InfoCard } from '@/components/traveler/ui';
import { dayLabel, daysUntil, policyName, policySentences } from '@/components/traveler/labels';
import { reservationRange } from '../view';

const CANCELLABLE = ['CONFIRMED', 'PAYMENT_PENDING', 'HELD'];

function CancelBox({ id, status, policy }: { id: string; status: string; policy: any }) {
  const { L, lang } = useI18n();
  const router = useRouter();
  const toast = useToast();
  const { confirm, dialog } = useConfirm();
  const preview = useApi<any>(CANCELLABLE.includes(status) ? `/v1/reservations/${id}/cancellation-preview` : null, { auth: true });
  const [reason, setReason] = useState('');
  const [code, setCode] = useState('CHANGE_OF_PLANS');
  const [err, setErr] = useState<unknown>(null);
  if (!CANCELLABLE.includes(status))
    return (
      <p className="muted small" style={{ margin: 0 }}>
        {['CANCELLED', 'CANCELED'].includes(status) ? L('이미 취소된 예약이에요.', 'This booking is already cancelled.') : L('현재 상태에서는 온라인으로 취소할 수 없어요. 문제가 있다면 고객센터로 문의해 주세요.', 'This booking can’t be cancelled online now. Contact support if something is wrong.')}
      </p>
    );
  const pv = item(preview.data);
  const p = f<any>(pv, 'evaluation') ?? pv;
  const cur = str(p, 'currency') || 'KRW';
  const pct = num(p, 'refundPct');
  const nonRefundable = num(p, 'nonRefundableMinor', 'penaltyMinor') ?? 0;
  const feeOnly = nonRefundable > 0 && nonRefundable === num(p, 'platformFeeMinor') && pct === 100;
  const refund = num(p, 'refundMinor', 'refundAmountMinor') ?? 0;
  const pName = policyName(policy ?? str(p, 'policyCode'), lang);
  const doCancel = async () => {
    setErr(null);
    const r = await confirm({
      title: L('예약을 취소할까요?', 'Cancel this booking?'),
      tone: 'danger',
      confirmLabel: L('예약 취소', 'Cancel booking'),
      cancelLabel: L('돌아가기', 'Keep booking'),
      body: (
        <div className="stack">
          <p style={{ margin: 0 }}>{L('취소하면 날짜가 다른 게스트에게 열리고 되돌릴 수 없어요.', 'Your dates will be released and this can’t be undone.')}</p>
          {p && (
            <p style={{ margin: 0 }}>
              {L('환불 예정액', 'Refund')} <strong style={{ color: 'var(--text)' }}><Money minor={refund} currency={cur} /></strong> {L('· 원래 결제 수단으로 3~7영업일 내 환불', '· to your original payment method within 3–7 business days')}
            </p>
          )}
        </div>
      ),
      run: async () => {
        await post(`/v1/reservations/${id}/cancel`, { reason: `${code}${reason ? ': ' + reason : ''}`.slice(0, 500) }, { idempotencyKey: `cancel-${id}` });
      },
    });
    if (r.ok) {
      toast.show(L('예약을 취소했어요', 'Booking cancelled'), { tone: 'ok' });
      router.push(`/trips/${id}`);
    }
  };
  return (
    <div className="stack">
      {dialog}
      {preview.loading && !p ? (
        <div className="skeleton" style={{ height: 120, borderRadius: 12 }} />
      ) : p ? (
        <>
          <div className="price-lines" aria-label={L('환불 예상', 'Refund estimate')}>
            <div className="line">
              <span>{L('결제 금액', 'Paid')}</span>
              <Money minor={num(p, 'totalMinor', 'paidMinor')} currency={cur} />
            </div>
            {num(p, 'alreadyRefundedMinor') ? (
              <div className="line">
                <span>{L('이미 환불된 금액', 'Already refunded')}</span>
                <span>− <Money minor={num(p, 'alreadyRefundedMinor')} currency={cur} /></span>
              </div>
            ) : null}
            {nonRefundable ? (
              <div className="line">
                <span>{feeOnly ? L('환불 불가 서비스 수수료', 'Non-refundable service fee') : L('환불되지 않는 금액', 'Non-refundable amount')}</span>
                <span>− <Money minor={nonRefundable} currency={cur} /></span>
              </div>
            ) : null}
            <div className="line total">
              <span>{L('환불 예정액', 'Estimated refund')}</span>
              <Money minor={refund} currency={cur} />
            </div>
          </div>
          <p className="small" style={{ margin: 0 }}>
            <span className="badge info">{pName || L('취소 정책', 'Policy')}</span>{' '}
            {pct !== undefined && (pct >= 100 ? L('지금 취소하면 숙박 요금은 전액 환불돼요.', 'Cancel now for a full refund of the stay.') : pct > 0 ? L(`지금 취소하면 숙박 요금의 ${pct}%가 환불돼요.`, `Cancel now to get ${pct}% of the stay back.`) : L('지금 취소하면 환불되지 않아요.', 'Cancelling now is non-refundable.'))}
          </p>
          {policySentences(policy, lang).length > 0 && <p className="xs muted" style={{ margin: 0 }}>{policySentences(policy, lang).join(' · ')}</p>}
        </>
      ) : (
        <ErrorText error={preview.error} />
      )}
      <Select
        label={L('취소 사유', 'Reason')}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        options={[
          { value: 'CHANGE_OF_PLANS', label: L('일정 변경', 'Change of plans') },
          { value: 'HOST_ISSUE', label: L('숙소 문제', 'Issue with the stay') },
          { value: 'EMERGENCY', label: L('긴급 상황', 'Emergency') },
          { value: 'OTHER', label: L('기타', 'Other') },
        ]}
      />
      <Textarea label={L('상세 사유 (선택)', 'Details (optional)')} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={400} />
      <div className="row">
        <Button variant="danger" icon="x-circle" onClick={doCancel}>
          {L('예약 취소하기', 'Cancel booking')}
        </Button>
      </div>
      <ErrorText error={err} />
    </div>
  );
}

export default function ManageTripView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const toast = useToast();
  const st = useApi<any>(`/v1/reservations/${id}`, { auth: true });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const act = async (path: string, msg: string) => {
    setErr(null);
    setBusy(true);
    try {
      await post(`/v1/reservations/${id}/${path}`, {}, { idempotencyKey: `${path}-${id}` });
      toast.show(msg, { tone: 'ok' });
      st.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <RequireAuth>
      <StateView state={st} skeleton="detail" back={{ href: '/trips', label: L('내 여행으로', 'Back to trips') }}>
        {(d) => {
          const r = item(d);
          const status = str(r, 'status', 'state').toUpperCase();
          const isHost = user && str(r, 'hostId', 'host_id') === user.id;
          const allowed = arr<string>(r, 'allowedActions', 'actions');
          const { start, end } = reservationRange(r);
          const until = daysUntil(start);
          const canCheckIn = until <= 0;
          const title = str(r, 'property.title', 'propertyTitle');
          return (
            <>
              <PageHeader
                title={L('예약 관리', 'Manage booking')}
                subtitle={[title, start && end ? formatRange(start, end, lang, { nights: true }) : '', str(r, 'code')].filter(Boolean).join(' · ')}
                back={`/trips/${id}`}
                actions={<StatusPill status={status} />}
              />
              <div className="stack-lg">
                {status === 'CONFIRMED' && (
                  <InfoCard title={L('체크인', 'Check-in')} icon="key">
                    <div className="row between" style={{ gap: 12 }}>
                      <p style={{ margin: 0 }} className="small">
                        {canCheckIn
                          ? L('도착하셨나요? 체크인을 기록하면 호스트에게 알림이 가요.', 'Arrived? Record your check-in to let the host know.')
                          : L(`체크인은 ${dayLabel(start, lang)}부터 할 수 있어요.`, `Check-in opens on ${dayLabel(start, lang)}.`)}
                      </p>
                      <Button variant="primary" icon="key" disabled={!canCheckIn || busy} loading={busy} onClick={() => act('check-in', L('체크인을 기록했어요', 'Checked in'))} aria-describedby={!canCheckIn ? 'checkin-hint' : undefined}>
                        {L('체크인하기', 'Check in')}
                      </Button>
                    </div>
                    {!canCheckIn && (
                      <p id="checkin-hint" className="xs muted" style={{ margin: 0 }}>
                        {L(`체크인까지 ${until}일 남았어요.`, `${until} days to go.`)}
                      </p>
                    )}
                  </InfoCard>
                )}
                {status === 'CHECKED_IN' && (isHost || allowed.includes('complete')) && (
                  <InfoCard title={L('체크아웃 · 이용 완료', 'Complete stay')} icon="check-circle">
                    <div className="row">
                      <Button disabled={busy} onClick={() => act('complete', L('이용 완료로 처리했어요', 'Marked as completed'))}>
                        {L('숙박 완료 처리', 'Mark completed')}
                      </Button>
                    </div>
                  </InfoCard>
                )}
                <ErrorText error={err} />
                <InfoCard title={L('예약 취소', 'Cancel booking')} icon="x-circle">
                  <CancelBox id={id} status={status} policy={f(r, 'cancellationPolicy')} />
                </InfoCard>
                <Alert tone="info">
                  {L('노쇼, 숙소 상태 문제 등은 ', 'No-shows or problems with the stay are handled through ')}
                  <Link href={`/support/disputes?subjectType=RESERVATION&subjectId=${id}`}>{L('분쟁·안전 신고', 'disputes & safety reports')}</Link>
                  {L('로 접수해 주세요. 담당자가 확인 후 연락드려요.', '. Our team will follow up.')}
                </Alert>
              </div>
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
