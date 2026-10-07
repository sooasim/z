'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { item, items, str } from '@/lib/shape';
import { GUIDE_TYPE_LABEL, guideView } from '@/lib/domain';
import { addDays, isoDate, toMinor } from '@/lib/format';
import { StateView, LoginLink } from '@/components/states';
import { MonthCalendar, calendarDays } from '@/components/calendar';
import { FavoriteButton } from '@/components/cards';
import { ErrorText, Money, PageHeader, Section, Alert } from '@/components/ui';

export default function GuideProfileView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const router = useRouter();
  const st = useApi<any>(`/v1/guides/${id}`);
  const today = isoDate(new Date());
  const av = useApi<any>(`/v1/guides/${id}/availability`, { query: { from: today, to: addDays(today, 60) } });
  const [date, setDate] = useState('');
  const [start, setStart] = useState('10:00');
  const [hours, setHours] = useState('3');
  const [people, setPeople] = useState('2');
  const [interests, setInterests] = useState('');
  const [budget, setBudget] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <StateView state={st}>
      {(d) => {
        const g = guideView(item(d));
        const tl = GUIDE_TYPE_LABEL[g.type] ?? { ko: g.type, en: g.type, paid: false };
        const avail = items(av.data);
        const days: Record<string, any> = {};
        // availability rows mark AVAILABLE slots; render booked/blocked as unavailable
        Object.assign(days, calendarDays(avail.filter((r: any) => !['AVAILABLE', 'OPEN'].includes(str(r, 'status', 'kind').toUpperCase()))));
        return (
          <>
            <PageHeader title={g.name} subtitle={[g.city, g.languages.join(', ')].filter(Boolean).join(' · ')} back="/guide-friends" actions={<FavoriteButton targetType="GUIDE" targetId={g.id} />} />
            <div className="row" style={{ gap: 6 }}>
              <span className={`badge ${tl.paid ? 'info' : 'ok'}`}>{tl[lang]}</span>
              {g.verified && <span className="badge ok">✓ {L('본인확인', 'Verified')}</span>}
              {g.rating !== undefined && <span className="badge">★ {g.rating.toFixed(1)}</span>}
              {tl.paid && g.rateMinor !== undefined && <span className="badge"><Money minor={g.rateMinor} currency={g.currency} /> / {L('시간', 'hr')}</span>}
            </div>
            <div className="grid-2" style={{ marginTop: 16 }}>
              <div>
                {g.bio && <p style={{ whiteSpace: 'pre-line' }}>{g.bio}</p>}
                {g.interests.length > 0 && (
                  <Section title={L('관심사·전문 분야', 'Interests')}>
                    <div className="chip-group">{g.interests.map((i) => <span key={i} className="badge">{i}</span>)}</div>
                  </Section>
                )}
                <Section title={L('가능 일정', 'Availability')}>
                  <MonthCalendar days={days} selected={{ start: date }} onSelect={setDate} legend={false} />
                </Section>
              </div>
              <aside className="card sticky-cta stack">
                <h2>{L('요청 보내기', 'Send a request')}</h2>
                {!tl.paid && <Alert tone="info">{L('무료 교류입니다. 금전 요구는 신고해 주세요.', 'This is a free meetup. Report any request for money.')}</Alert>}
                {user ? (
                  <form
                    className="stack"
                    onSubmit={async (e) => {
                      e.preventDefault();
                      setBusy(true);
                      setErr(null);
                      try {
                        const startsAt = date ? new Date(`${date}T${start}:00`).toISOString() : undefined;
                        const res = await post(
                          '/v1/guide-requests',
                          { guideId: g.id, date, startsAt, durationHours: Number(hours), partySize: Number(people), interests: interests.split(',').map((s) => s.trim()).filter(Boolean), budgetMinor: tl.paid && budget ? toMinor(budget) : undefined, message: msg, guideType: g.type },
                          { idempotencyKey: true },
                        );
                        router.push(`/guide-requests/${str(item(res), 'id')}`);
                      } catch (x) {
                        setErr(x);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    <div className="form-grid cols-2">
                      <label className="field"><span>{L('날짜', 'Date')}</span><input type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} required /></label>
                      <label className="field"><span>{L('시작 시간', 'Start')}</span><input type="time" value={start} onChange={(e) => setStart(e.target.value)} required /></label>
                      <label className="field"><span>{L('시간(시간)', 'Hours')}</span><input type="number" min={1} max={12} value={hours} onChange={(e) => setHours(e.target.value)} /></label>
                      <label className="field"><span>{L('인원', 'People')}</span><input type="number" min={1} max={20} value={people} onChange={(e) => setPeople(e.target.value)} /></label>
                    </div>
                    <label className="field"><span>{L('관심사 (쉼표 구분)', 'Interests (comma separated)')}</span><input value={interests} onChange={(e) => setInterests(e.target.value)} placeholder={L('카페, 시장, 사진', 'cafes, markets, photography')} /></label>
                    {tl.paid && <label className="field"><span>{L('예산 (원, 선택)', 'Budget (optional)')}</span><input inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} /></label>}
                    <label className="field"><span>{L('메시지', 'Message')}</span><textarea value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={2000} /></label>
                    <button className="btn primary" disabled={busy}>{busy ? L('보내는 중…', 'Sending…') : L('요청 보내기', 'Send request')}</button>
                    <ErrorText error={err} />
                  </form>
                ) : (
                  <LoginLink>{L('로그인하고 요청하기', 'Log in to request')}</LoginLink>
                )}
                <Link href="/support/disputes?subjectType=USER" className="small">{L('이 가이드 신고', 'Report this guide')}</Link>
              </aside>
            </div>
          </>
        );
      }}
    </StateView>
  );
}
