'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, items, str } from '@/lib/shape';
import { formatRange } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { ErrorText, PageHeader, Section, Timeline, DateRangeField } from '@/components/ui';

export default function TripPlannerView() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/itineraries', { auth: true });
  const [title, setTitle] = useState('');
  const [range, setRange] = useState({ start: '', end: '' });
  const [err, setErr] = useState<unknown>(null);
  return (
    <RequireAuth>
      <PageHeader title={L('여행 플래너', 'Trip planner')} subtitle={L('숙소, 맞교환, 가이드, 투어를 하나의 일정으로 엮어 보세요.', 'Combine stays, exchanges, guides and tours into one plan.')} actions={<Link className="btn" href="/assistant">✨ {L('AI로 일정 짜기', 'Plan with AI')}</Link>} />
      <form
        className="card stack"
        onSubmit={async (e) => {
          e.preventDefault();
          setErr(null);
          try {
            await post('/v1/itineraries', { title, startDate: range.start || undefined, endDate: range.end || undefined });
            setTitle('');
            st.reload();
          } catch (x) {
            setErr(x);
          }
        }}
      >
        <div className="form-grid cols-2">
          <label className="field"><span>{L('여행 이름', 'Trip name')}</span><input value={title} onChange={(e) => setTitle(e.target.value)} required placeholder={L('11월 제주 한달살기', 'November in Jeju')} /></label>
          <DateRangeField start={range.start} end={range.end} onChange={setRange} labels={[L('시작', 'Start'), L('종료', 'End')]} boxed />
        </div>
        <button className="btn primary" style={{ justifySelf: 'start' }}>{L('새 일정 만들기', 'Create plan')}</button>
        <ErrorText error={err} />
      </form>
      <Section title={L('내 일정', 'My plans')}>
        <StateView state={st} isEmpty={(d) => items(d).length === 0} empty={<EmptyState illo="calendar" title={L('아직 일정이 없어요', 'No plans yet')} />}>
          {(d) => (
            <div className="grid">
              {items(d).map((it: any) => (
                <article key={str(it, 'id')} className="card stack">
                  <h3 style={{ margin: 0 }}>{str(it, 'title', 'name')}</h3>
                  <p className="small muted" style={{ margin: 0 }}>{str(it, 'startDate') && str(it, 'endDate') ? formatRange(str(it, 'startDate'), str(it, 'endDate'), lang) : L('날짜 미정', 'Dates TBD')}</p>
                  <Timeline events={arr<any>(it, 'items').slice(0, 5).map((x) => ({ title: str(x, 'title', 'productTitle', 'kind') || str(x, 'productId').slice(0, 8), at: str(x, 'startsAt', 'date') }))} />
                </article>
              ))}
            </div>
          )}
        </StateView>
      </Section>
    </RequireAuth>
  );
}
