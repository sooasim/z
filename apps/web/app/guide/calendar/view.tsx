'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api } from '@/lib/api';
import { items, str } from '@/lib/shape';
import { addDays, isoDate } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { MonthCalendar, calendarDays } from '@/components/calendar';
import { ErrorText, PageHeader, Section } from '@/components/ui';
import { ResourceTable } from '@/components/table';

export default function GuideCalendarView() {
  const { L } = useI18n();
  const today = isoDate(new Date());
  const st = useApi<any>('/v1/guides/me/availability', { auth: true, query: { from: today, to: addDays(today, 90) } });
  const [sel, setSel] = useState<string[]>([]);
  const [from, setFrom] = useState('10:00');
  const [to, setTo] = useState('18:00');
  const [err, setErr] = useState<unknown>(null);
  return (
    <RequireAuth roles={['GUIDE']}>
      <PageHeader title={L('가이드 일정', 'Guide schedule')} subtitle={L('가능한 날짜를 선택해 시간대를 추가하세요. 예약된 시간은 자동으로 막힙니다.', 'Pick dates and add availability. Booked times are blocked automatically.')} />
      <StateView state={st}>
        {(d) => {
          const rows = items(d);
          const days = calendarDays(rows.map((r: any) => ({ ...r, type: ['AVAILABLE', 'OPEN'].includes(str(r, 'status', 'kind').toUpperCase()) ? 'EXCHANGE' : str(r, 'kind', 'status') || 'BOOKING' })));
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
                        await api('/v1/guides/me/availability', { method: 'PUT', body: { slots: sel.map((dt) => ({ date: dt, startTime: from, endTime: to, startsAt: new Date(`${dt}T${from}:00`).toISOString(), endsAt: new Date(`${dt}T${to}:00`).toISOString(), status: 'AVAILABLE' })) } });
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
                        await api('/v1/guides/me/availability', { method: 'PUT', body: { slots: sel.map((dt) => ({ date: dt, status: 'BLOCKED' })) } });
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
            { key: 'startsAt|startAt', label: L('일시', 'When'), kind: 'datetime' },
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
