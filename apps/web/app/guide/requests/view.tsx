'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { f, item, items, str, num } from '@/lib/shape';
import { toMinor } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { DateText, ErrorText, PageHeader, StatusBadge, Tabs } from '@/components/ui';

function OfferForm({ r, onDone, paidGuide }: { r: any; onDone: () => void; paidGuide: boolean }) {
  const { L } = useI18n();
  const [paid, setPaid] = useState(paidGuide);
  const [price, setPrice] = useState('');
  const toLocal = (iso: string) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '');
  const [startsAt, setStartsAt] = useState(toLocal(str(r, 'startAt')));
  const [endsAt, setEndsAt] = useState(toLocal(str(r, 'endAt')));
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<unknown>(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          await post(`/v1/guide-requests/${str(r, 'id')}/offers`, { startAt: new Date(startsAt).toISOString(), endAt: new Date(endsAt).toISOString(), paid, priceMinor: paid ? toMinor(price) : 0, itinerary: msg || undefined });
          onDone();
        } catch (x) {
          setErr(x);
        }
      }}
    >
      <div className="form-grid cols-2">
        <label className="field"><span>{L('시작', 'Start')}</span><input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required /></label>
        <label className="field"><span>{L('종료', 'End')}</span><input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} required /></label>
        {paidGuide ? (
          <>
            <label className="check"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /><span>{L('유료 제안', 'Paid offer')}</span></label>
            {paid && <label className="field"><span>{L('금액(원)', 'Price (KRW)')}</span><input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} required /></label>}
          </>
        ) : (
          <p className="small muted">{L('무료(프렌드/자원봉사) 가이드는 금액을 받을 수 없습니다.', 'Free (friend/volunteer) guides cannot charge.')}</p>
        )}
      </div>
      <label className="field"><span>{L('일정 · 메시지', 'Itinerary · message')}</span><textarea value={msg} onChange={(e) => setMsg(e.target.value)} /></label>
      <button className="btn primary" style={{ justifySelf: 'start' }}>{L('제안 보내기', 'Send offer')}</button>
      <ErrorText error={err} />
    </form>
  );
}

export default function GuideRequestsView() {
  const { L } = useI18n();
  const [tab, setTab] = useState<'mine' | 'open'>('mine');
  const st = useApi<any>('/v1/guide-requests', { auth: true, query: { role: tab === 'open' ? 'open' : 'guide' } });
  const me = useApi<any>('/v1/guides/me', { auth: true });
  const paidGuide = Boolean(f(item(me.data), 'paidEnabled', 'paid_enabled'));
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  return (
    <RequireAuth roles={['GUIDE']}>
      <PageHeader title={L('요청함', 'Requests')} actions={<Link className="btn" href="/guide/calendar">{L('일정', 'Calendar')}</Link>} />
      <Tabs label={L('필터', 'Filter')} value={tab} onChange={setTab} tabs={[{ value: 'mine', label: L('나에게 온 요청', 'Sent to me') }, { value: 'open', label: L('공개 요청 (내 지역)', 'Open requests (my city)') }]} />
      <ErrorText error={err} />
      <div style={{ marginTop: 16 }}>
        <StateView state={st} isEmpty={(d) => items(d).length === 0} empty={<EmptyState title={L('새 요청이 없습니다.', 'No requests.')} />}>
          {(d) => (
            <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
              {items(d).map((r: any) => {
                const id = str(r, 'id');
                const budget = num(r, 'scope.budgetMinor');
                return (
                  <li key={id} className="card stack">
                    <div className="row between">
                      <div>
                        <strong>{str(r, 'travelerName', 'traveler.displayName') || L('여행자', 'Traveler')}</strong> {budget ? <span className="badge info">{L('예산', 'Budget')} {budget.toLocaleString()}</span> : null}
                        <div className="small muted"><DateText value={str(r, 'startAt', 'startsAt')} time /> → <DateText value={str(r, 'endAt', 'endsAt')} time /> · {num(r, 'partySize') ?? 1}{L('명', ' ppl')} {str(r, 'city') && `· ${str(r, 'city')}`}</div>
                      </div>
                      <StatusBadge status={str(r, 'status', 'state')} />
                    </div>
                    {str(r, 'message') && <p style={{ margin: 0 }}>{str(r, 'message')}</p>}
                    <div className="row">
                      <button className="btn sm primary" onClick={() => setOpen(open === id ? null : id)}>{L('제안하기', 'Make offer')}</button>
                      <button className="btn sm" onClick={async () => { setErr(null); try { await post(`/v1/guide-requests/${id}/decline`, {}); st.reload(); } catch (e) { setErr(e); } }}>{L('거절', 'Decline')}</button>
                      <Link className="btn sm ghost" href={`/guide-requests/${id}`}>{L('상세', 'Details')}</Link>
                    </div>
                    {open === id && <OfferForm r={r} paidGuide={paidGuide} onDone={() => { setOpen(null); st.reload(); }} />}
                  </li>
                );
              })}
            </ul>
          )}
        </StateView>
      </div>
    </RequireAuth>
  );
}
