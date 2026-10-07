'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { items, str, num } from '@/lib/shape';
import { toMinor } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { DateText, ErrorText, PageHeader, StatusBadge, Tabs } from '@/components/ui';

function OfferForm({ r, onDone }: { r: any; onDone: () => void }) {
  const { L } = useI18n();
  const paid = ['PAID', 'PROFESSIONAL'].includes(str(r, 'guideType').toUpperCase());
  const [price, setPrice] = useState('');
  const [startsAt, setStartsAt] = useState(str(r, 'startsAt').slice(0, 16));
  const [hours, setHours] = useState(String(num(r, 'durationHours') ?? 3));
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<unknown>(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setErr(null);
        try {
          await post(`/v1/guide-requests/${str(r, 'id')}/offers`, { priceMinor: paid ? toMinor(price) : 0, startsAt: startsAt ? new Date(startsAt).toISOString() : undefined, durationHours: Number(hours), message: msg }, { idempotencyKey: true });
          onDone();
        } catch (x) {
          setErr(x);
        }
      }}
    >
      <div className="form-grid cols-2">
        <label className="field"><span>{L('일시', 'When')}</span><input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} required /></label>
        <label className="field"><span>{L('시간', 'Hours')}</span><input type="number" min={1} max={12} value={hours} onChange={(e) => setHours(e.target.value)} /></label>
        {paid ? (
          <label className="field"><span>{L('금액(원)', 'Price (KRW)')}</span><input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value)} required /></label>
        ) : (
          <p className="small muted">{L('무료 교류 요청입니다. 금액을 받을 수 없습니다.', 'Free request — no payment allowed.')}</p>
        )}
      </div>
      <label className="field"><span>{L('메시지', 'Message')}</span><textarea value={msg} onChange={(e) => setMsg(e.target.value)} /></label>
      <button className="btn primary">{L('제안 보내기', 'Send offer')}</button>
      <ErrorText error={err} />
    </form>
  );
}

export default function GuideRequestsView() {
  const { L } = useI18n();
  const [tab, setTab] = useState<'open' | 'all'>('open');
  const st = useApi<any>('/v1/guide-requests', { auth: true, query: { role: 'guide', status: tab === 'open' ? 'OPEN' : undefined } });
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<unknown>(null);
  return (
    <RequireAuth roles={['GUIDE']}>
      <PageHeader title={L('요청함', 'Requests')} actions={<Link className="btn" href="/guide/calendar">{L('일정', 'Calendar')}</Link>} />
      <Tabs label={L('필터', 'Filter')} value={tab} onChange={setTab} tabs={[{ value: 'open', label: L('응답 대기', 'Awaiting') }, { value: 'all', label: L('전체', 'All') }]} />
      <ErrorText error={err} />
      <div style={{ marginTop: 16 }}>
        <StateView state={st} isEmpty={(d) => items(d).length === 0} empty={<EmptyState title={L('새 요청이 없습니다.', 'No requests.')} />}>
          {(d) => (
            <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
              {items(d).map((r: any) => {
                const id = str(r, 'id');
                const paid = ['PAID', 'PROFESSIONAL'].includes(str(r, 'guideType').toUpperCase());
                return (
                  <li key={id} className="card stack">
                    <div className="row between">
                      <div>
                        <strong>{str(r, 'travelerName', 'traveler.displayName') || L('여행자', 'Traveler')}</strong> <span className={`badge ${paid ? 'info' : 'ok'}`}>{paid ? L('유료', 'Paid') : L('무료', 'Free')}</span>
                        <div className="small muted"><DateText value={str(r, 'startsAt', 'date')} time /> · {num(r, 'partySize') ?? 1}{L('명', ' ppl')} · {num(r, 'durationHours') ?? '—'}h</div>
                      </div>
                      <StatusBadge status={str(r, 'status', 'state')} />
                    </div>
                    {str(r, 'message') && <p style={{ margin: 0 }}>{str(r, 'message')}</p>}
                    <div className="row">
                      <button className="btn sm primary" onClick={() => setOpen(open === id ? null : id)}>{L('제안하기', 'Make offer')}</button>
                      <button className="btn sm" onClick={async () => { setErr(null); try { await post(`/v1/guide-requests/${id}/decline`, {}); st.reload(); } catch (e) { setErr(e); } }}>{L('거절', 'Decline')}</button>
                      <Link className="btn sm ghost" href={`/guide-requests/${id}`}>{L('상세', 'Details')}</Link>
                    </div>
                    {open === id && <OfferForm r={r} onDone={() => { setOpen(null); st.reload(); }} />}
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
