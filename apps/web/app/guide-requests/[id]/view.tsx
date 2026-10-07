'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, item, str, num, f } from '@/lib/shape';
import { toMinor } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, DateText, ErrorText, Kv, Money, PageHeader, Section, StatusBadge } from '@/components/ui';

export default function GuideRequestView() {
  const { id } = useParams<{ id: string }>();
  const { L } = useI18n();
  const { user } = useAuth();
  const router = useRouter();
  const st = useApi<any>(`/v1/guide-requests/${id}`, { auth: true });
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [counterFor, setCounterFor] = useState<string | null>(null);
  const [counterPrice, setCounterPrice] = useState('');
  const [counterMsg, setCounterMsg] = useState('');
  return (
    <RequireAuth>
      <StateView state={st}>
        {(d) => {
          const r = item(d);
          const status = str(r, 'status', 'state').toUpperCase();
          const isTraveler = str(r, 'travelerId', 'requesterId') === user?.id;
          const rows = arr<any>(r, 'offers');
          const bk = f<any>(r, 'booking');
          return (
            <>
              <PageHeader title={L('가이드 요청', 'Guide request')} back="/trips?tab=guides" actions={<StatusBadge status={status} />} />
              <div className="card">
                <Kv
                  rows={[
                    [L('가이드', 'Guide'), str(r, 'guideName', 'guide.displayName') || str(r, 'guideId').slice(0, 8) || L('공개 요청', 'Open request')],
                    [L('시작', 'Starts'), <DateText key="d" value={str(r, 'startAt', 'startsAt')} time />],
                    [L('종료', 'Ends'), <DateText key="e" value={str(r, 'endAt', 'endsAt')} time />],
                    [L('인원', 'Party'), num(r, 'partySize') ?? '—'],
                    [L('도시', 'City'), str(r, 'city') || '—'],
                    [L('메시지', 'Message'), str(r, 'message') || '—'],
                  ]}
                />
              </div>
              <Section title={L('제안', 'Offers')}>
                {rows.length === 0 ? (
                  <Alert>{L('아직 받은 제안이 없습니다. 가이드가 일정과 조건을 제안하면 알려드릴게요.', 'No offers yet. We will notify you.')}</Alert>
                ) : (
                  <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
                    {rows.map((o: any) => {
                      const oid = str(o, 'id');
                      const ostatus = str(o, 'status', 'state').toUpperCase();
                      const price = f(o, 'paid') === false ? 0 : num(o, 'priceMinor', 'amountMinor', 'totalMinor');
                      const ver = num(o, 'version') ?? 1;
                      return (
                        <li key={oid} className="card stack">
                          <div className="row between">
                            <strong>{str(o, 'guideName', 'guide.displayName') || L('가이드 제안', 'Offer')}</strong>
                            <StatusBadge status={ostatus} />
                          </div>
                          <p style={{ margin: 0 }}>
                            <DateText value={str(o, 'startAt', 'startsAt')} time /> → <DateText value={str(o, 'endAt', 'endsAt')} time /> · {price ? <Money minor={price} currency={str(o, 'currency') || 'KRW'} /> : L('무료', 'Free')} · v{ver}
                          </p>
                          {str(o, 'itinerary', 'message') && <p className="muted" style={{ margin: 0, whiteSpace: 'pre-line' }}>{str(o, 'itinerary', 'message')}</p>}
                          {isTraveler && ['OFFERED', 'COUNTERED'].includes(status) && ver === num(rows[rows.length - 1], 'version') && !bk && (
                            <div className="row">
                              <button
                                className="btn primary"
                                disabled={busy}
                                onClick={async () => {
                                  setBusy(true);
                                  setErr(null);
                                  try {
                                    const res = await post(`/v1/guide-requests/${id}/accept`, { offerVersion: ver }, { idempotencyKey: `gaccept-${id}-v${ver}` });
                                    const booking = f<any>(res, 'booking') ?? f<any>(item(res), 'booking') ?? {};
                                    const bid = str(booking, 'id', 'bookingId');
                                    const bstatus = str(booking, 'status').toUpperCase();
                                    if (price && price > 0 && (bstatus === 'PAYMENT_PENDING' || !bstatus || bstatus === 'PENDING')) router.push(`/checkout?type=GUIDE_BOOKING&id=${bid}`);
                                    else router.push(`/guide-bookings/${bid}`);
                                  } catch (e) {
                                    setErr(e);
                                  } finally {
                                    setBusy(false);
                                  }
                                }}
                              >
                                {price ? L('수락하고 결제', 'Accept & pay') : L('수락', 'Accept')}
                              </button>
                              <button className="btn" onClick={() => setCounterFor(counterFor === oid ? null : oid)}>{L('조건 변경', 'Counter')}</button>
                            </div>
                          )}
                          {counterFor === oid && (
                            <form
                              className="stack"
                              onSubmit={async (e) => {
                                e.preventDefault();
                                setErr(null);
                                try {
                                  await post(`/v1/guide-requests/${id}/counter`, { startAt: str(o, 'startAt'), endAt: str(o, 'endAt'), priceMinor: counterPrice ? toMinor(counterPrice) : price ?? 0, itinerary: counterMsg || undefined });
                                  setCounterFor(null);
                                  st.reload();
                                } catch (x) {
                                  setErr(x);
                                }
                              }}
                            >
                              {price ? <label className="field"><span>{L('희망 금액(원)', 'Proposed price')}</span><input inputMode="numeric" value={counterPrice} onChange={(e) => setCounterPrice(e.target.value)} /></label> : null}
                              <label className="field"><span>{L('메시지', 'Message')}</span><textarea value={counterMsg} onChange={(e) => setCounterMsg(e.target.value)} /></label>
                              <button className="btn">{L('보내기', 'Send')}</button>
                            </form>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
                <ErrorText error={err} />
              </Section>
              <div className="row">
                {bk && <Link className="btn primary" href={`/guide-bookings/${str(bk, 'id')}`}>{L('예약 보기', 'View booking')}</Link>}
                {isTraveler && ['REQUESTED', 'OFFERED', 'COUNTERED'].includes(status) && <button className="btn ghost" onClick={async () => { setErr(null); try { await post(`/v1/guide-requests/${id}/cancel`, {}); st.reload(); } catch (e) { setErr(e); } }}>{L('요청 취소', 'Cancel request')}</button>}
              </div>
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
