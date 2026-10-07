'use client';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api, post } from '@/lib/api';
import { f, item, items, str } from '@/lib/shape';
import { addDays, isoDate, formatRange, nightsBetween } from '@/lib/format';
import { propertyView } from '@/lib/domain';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { MonthCalendar, calendarDays } from '@/components/calendar';
import { Alert, ErrorText, PageHeader, Section, Button } from '@/components/ui';
import { useToast } from '@/components/ui/toast';

/** Host calendar overlay: paid stays, exchanges, holds and host blocks share one no-overlap inventory. */
export default function HostCalendarView() {
  const { L, lang } = useI18n();
  const toast = useToast();
  const sp = useSearchParams();
  const props = useApi<any>('/v1/host/properties', { auth: true });
  const list = items(props.data);
  const [pid, setPid] = useState(sp.get('propertyId') ?? '');
  const propertyId = pid || str(list[0], 'id');
  const today = isoDate(new Date());
  const cal = useApi<any>(propertyId ? '/v1/host/calendar' : null, { auth: true, query: { propertyId, from: addDays(today, -7), to: addDays(today, 180) } });
  const [sel, setSel] = useState<{ start?: string; end?: string }>({});
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const rows = items(cal.data).length ? items(cal.data) : (f<any[]>(item(cal.data), 'days', 'blocks') ?? []);
  const days = calendarDays(rows);
  const pick = (d: string) => {
    if (!sel.start || sel.end || d <= sel.start) setSel({ start: d });
    else setSel({ start: sel.start, end: addDays(d, 1) });
  };
  const hostBlocks = (f<any[]>(item(cal.data), 'blocks') ?? []).filter((b: any) => str(b, 'type', 'blockType').toUpperCase() === 'HOST_BLOCK');
  const change = async (status: 'BLOCKED' | 'AVAILABLE') => {
    if (!sel.start) return;
    const end = sel.end ?? addDays(sel.start, 1);
    setBusy(true);
    setErr(null);
    try {
      if (status === 'BLOCKED') {
        // Host block = an inventory block (shares the no-overlap constraint with bookings/exchanges).
        await post(`/v1/properties/${propertyId}/blocks`, { start: sel.start, end, note: 'host block' });
      } else {
        const overlapping = hostBlocks.filter((b: any) => str(b, 'start') < end && sel.start! < str(b, 'end'));
        for (const b of overlapping) await api(`/v1/properties/${propertyId}/blocks/${str(b, 'blockId', 'id')}`, { method: 'DELETE' });
        await api(`/v1/properties/${propertyId}/availability`, { method: 'PUT', body: { ranges: [{ start: sel.start, end, status: 'AVAILABLE' }] } });
      }
      toast.show(status === 'BLOCKED' ? L('날짜를 막았어요', 'Dates blocked') : L('날짜를 열었어요', 'Dates opened'));
      setSel({});
      cal.reload();
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <RequireAuth roles={['HOST']}>
      <PageHeader title={L('호스트 달력', 'Host calendar')} subtitle={L('유료 숙박, 홈 맞교환, 결제 대기 홀드, 호스트 차단이 하나의 재고로 관리되어 절대 겹치지 않아요.', 'Paid stays, exchanges, holds and host blocks share one inventory — never overlapping.')} />
      <StateView state={props} isEmpty={(d) => items(d).length === 0} empty={<EmptyState illo="calendar" title={L('숙소가 없습니다', 'No listings')} />}>
        {() => (
          <>
            <label className="field" style={{ maxWidth: 420 }}>
              <span>{L('숙소 선택', 'Listing')}</span>
              <select value={propertyId} onChange={(e) => { setPid(e.target.value); setSel({}); }}>
                {list.map((p: any) => { const v = propertyView(p); return <option key={v.id} value={v.id}>{v.title}</option>; })}
              </select>
            </label>
            <div className="grid-2" style={{ marginTop: 20 }}>
              <div className="card">
                <StateView state={cal} skeleton="detail">
                  {() => <MonthCalendar days={days} selected={sel} onSelect={pick} months={1} />}
                </StateView>
              </div>
              <aside className="card stack sticky-cta">
                <h2 style={{ margin: 0 }}>{L('선택한 날짜', 'Selection')}</h2>
                {sel.start ? (
                  <p>{formatRange(sel.start, sel.end ?? addDays(sel.start, 1), lang)} · {nightsBetween(sel.start, sel.end ?? addDays(sel.start, 1))}{L('박', ' nights')}</p>
                ) : (
                  <p className="muted">{L('달력에서 시작일과 종료일을 차례로 누르세요.', 'Tap a start and end date on the calendar.')}</p>
                )}
                <div className="row">
                  <Button variant="primary" disabled={!sel.start || busy} loading={busy} onClick={() => change('BLOCKED')}>{L('예약 막기', 'Block dates')}</Button>
                  <Button disabled={!sel.start || busy} onClick={() => change('AVAILABLE')}>{L('예약 열기', 'Open dates')}</Button>
                </div>
                <ErrorText error={err} />
                <Alert tone="info">{L('예약·맞교환으로 잡힌 날짜는 직접 해제할 수 없어요. 예약 관리에서 처리하세요.', 'Dates held by bookings or exchanges must be changed from the booking itself.')}</Alert>
                <Section title={L('이번 달 일정', 'This month')}>
                  <ul className="stack small" style={{ listStyle: 'none', padding: 0 }}>
                    {(f<any[]>(item(cal.data), 'blocks') ?? []).slice(0, 10).map((b: any, i: number) => (
                      <li key={i}>• {str(b, 'start')} → {str(b, 'end')} <span className="muted">({str(b, 'type')}{str(b, 'reservation.code') ? ` · ${str(b, 'reservation.code')}` : ''})</span></li>
                    ))}
                  </ul>
                </Section>
              </aside>
            </div>
          </>
        )}
      </StateView>
    </RequireAuth>
  );
}
