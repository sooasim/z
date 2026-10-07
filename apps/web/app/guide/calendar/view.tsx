'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api } from '@/lib/api';
import { item, items, str } from '@/lib/shape';
import { addDays, isoDate } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { MonthCalendar } from '@/components/calendar';
import { ErrorText, PageHeader, Section } from '@/components/ui';
import { ResourceTable } from '@/components/table';

/**
 * PUT /v1/guides/me/availability REPLACES all slots inside [from, to). To edit only the selected days we send a
 * window spanning them plus every existing free interval inside the window that is not on a selected day.
 */
function windowBody(existing: any[], sel: string[], fromT: string, toT: string, status: 'AVAILABLE' | 'BLOCKED') {
  const days = [...sel].sort();
  const wFrom = new Date(`${days[0]}T00:00:00`);
  const wTo = new Date(`${addDays(days[days.length - 1], 1)}T00:00:00`);
  const keep = existing
    .map((iv: any) => ({ startAt: new Date(str(iv, 'start', 'startAt')), endAt: new Date(str(iv, 'end', 'endAt')) }))
    .filter((iv) => iv.endAt > wFrom && iv.startAt < wTo && !sel.includes(isoDate(iv.startAt)))
    .map((iv) => ({ startAt: new Date(Math.max(iv.startAt.getTime(), wFrom.getTime())).toISOString(), endAt: new Date(Math.min(iv.endAt.getTime(), wTo.getTime())).toISOString(), status: 'AVAILABLE' as const }));
  const added = status === 'AVAILABLE' ? days.map((dt) => ({ startAt: new Date(`${dt}T${fromT}:00`).toISOString(), endAt: new Date(`${dt}T${toT}:00`).toISOString(), status })) : [];
  return { from: wFrom.toISOString(), to: wTo.toISOString(), slots: [...keep, ...added] };
}

export default function GuideCalendarView() {
  const { L } = useI18n();
  const today = isoDate(new Date());
  const me = useApi<any>('/v1/guides/me', { auth: true });
  const gid = str(item(me.data), 'userId', 'user_id', 'guideId');
  const st = useApi<any>(gid ? `/v1/guides/${gid}/availability` : null, { auth: true, query: { from: `${today}T00:00:00Z`, to: `${addDays(today, 90)}T00:00:00Z` } });
  const [sel, setSel] = useState<string[]>([]);
  const [from, setFrom] = useState('10:00');
  const [to, setTo] = useState('18:00');
  const [err, setErr] = useState<unknown>(null);
  return (
    <RequireAuth roles={['GUIDE']}>
      <PageHeader title={L('가이드 일정', 'Guide schedule')} subtitle={L('가능한 날짜를 선택해 시간대를 추가하세요. 예약된 시간은 자동으로 막힙니다.', 'Pick dates and add availability. Booked times are blocked automatically.')} />
      <StateView state={gid ? st : { ...me, data: me.data === undefined ? undefined : { items: [] } }}>
        {(d) => {
          const rows = items(d);
          const days: Record<string, any> = {};
          for (const iv of rows) {
            const s0 = str(iv, 'start', 'startAt').slice(0, 10);
            const e0 = str(iv, 'end', 'endAt').slice(0, 10);
            for (let d0 = s0; d0 && d0 <= e0; d0 = addDays(d0, 1)) days[d0] = { kind: 'exchange', label: L('가능', 'Open') };
          }
          sel.forEach((s) => (days[s] = { kind: 'hold', label: L('선택', 'Selected') }));
          return (
            <div className="grid-2">
              <MonthCalendar days={days} months={1} legend={false} onSelect={(dt) => setSel((s) => (s.includes(dt) ? s.filter((x) => x !== dt) : [...s, dt]))} />
              <div className="card stack">
                <h2>{L('시간대 추가', 'Add availability')}</h2>
                <p className="small muted">{sel.length ? sel.sort().join(', ') : L('달력에서 날짜를 선택하세요.', 'Select dates on the calendar.')}</p>
                <div className="form-grid cols-2">
                  <label className="field"><span>{L('시작', 'From')}</span><input type="time" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
                  <label className="field"><span>{L('종료', 'To')}</span><input type="time" value={to} onChange={(e) => setTo(e.target.value)} /></label>
                </div>
                <div className="row">
                  <button
                    className="btn primary"
                    disabled={!sel.length}
                    onClick={async () => {
                      setErr(null);
                      try {
                        await api('/v1/guides/me/availability', { method: 'PUT', body: windowBody(rows, sel, from, to, 'AVAILABLE') });
                        setSel([]);
                        st.reload();
                      } catch (e) {
                        setErr(e);
                      }
                    }}
                  >
                    {L('가능 시간 저장', 'Save availability')}
                  </button>
                  <button
                    className="btn"
                    disabled={!sel.length}
                    onClick={async () => {
                      setErr(null);
                      try {
                        await api('/v1/guides/me/availability', { method: 'PUT', body: windowBody(rows, sel, from, to, 'BLOCKED') });
                        setSel([]);
                        st.reload();
                      } catch (e) {
                        setErr(e);
                      }
                    }}
                  >
                    {L('휴무로 지정', 'Block days')}
                  </button>
                </div>
                <ErrorText error={err} />
              </div>
            </div>
          );
        }}
      </StateView>
      <Section title={L('예정된 가이드 예약', 'Upcoming bookings')}>
        <ResourceTable
          path="/v1/guide-bookings"
          query={{ role: 'guide' }}
          columns={[
            { key: 'startAt|startsAt', label: L('일시', 'When'), kind: 'datetime' },
            { key: 'travelerName|traveler.displayName', label: L('여행자', 'Traveler') },
            { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
            { key: 'amountMinor|priceMinor', label: L('금액', 'Price'), kind: 'money' },
          ]}
          empty={<p className="muted">{L('예정된 예약이 없습니다.', 'No upcoming bookings.')}</p>}
        />
      </Section>
    </RequireAuth>
  );
}
