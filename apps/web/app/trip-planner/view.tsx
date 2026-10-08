'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, items, num, str } from '@/lib/shape';
import { addDays, formatRange } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { StateView, EmptyState } from '@/components/states';
import { Button, ButtonLink, DateRangeField, ErrorText, HeadingLevel, Icon, Input, PageHeader, Section, type IconName } from '@/components/ui';
import { AuthTeaser } from '@/components/public/AuthTeaser';
import s from '@/components/public/public.module.css';

const ITEM_ICON: Record<string, IconName> = { STAY: 'home', EXCHANGE: 'swap', GUIDE: 'compass', GUIDE_BOOKING: 'compass', TRAVEL_PRODUCT: 'ticket', TOUR: 'ticket', NOTE: 'doc', TRANSPORT: 'plane' };

function Planner() {
  const { L, lang } = useI18n();
  const st = useApi<any>('/v1/itineraries', { auth: true });
  const [title, setTitle] = useState('');
  const [range, setRange] = useState({ start: '', end: '' });
  const [titleErr, setTitleErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <>
      <form
        className="card stack"
        noValidate
        aria-labelledby="new-plan-h"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!title.trim()) {
            setTitleErr(L('여행 이름을 입력해 주세요.', 'Give your trip a name.'));
            document.getElementById('plan-title')?.focus();
            return;
          }
          setTitleErr('');
          setErr(null);
          setBusy(true);
          try {
            await post('/v1/itineraries', { title: title.trim(), startDate: range.start || undefined, endDate: range.end || undefined });
            setTitle('');
            setRange({ start: '', end: '' });
            st.reload();
          } catch (x) {
            setErr(x);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h2 id="new-plan-h" style={{ margin: 0, fontSize: 'var(--fs-lg)' }}>{L('새 여행 만들기', 'New trip')}</h2>
        <div className="form-grid cols-2">
          <Input
            id="plan-title"
            label={L('여행 이름', 'Trip name')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
            maxLength={80}
            placeholder={L('11월 제주 한달살기', 'November in Jeju')}
            aria-invalid={titleErr ? true : undefined}
            hint={titleErr ? <span className={s.err}>{titleErr}</span> : undefined}
          />
          <div className={`${s.slotField} ${s.showK}`}>
            <span className={s.lbl}>{L('여행 기간 (선택)', 'Dates (optional)')}</span>
            <DateRangeField start={range.start} end={range.end} onChange={setRange} labels={[L('시작', 'From'), L('종료', 'To')]} align="right" />
          </div>
        </div>
        <div className="row">
          <Button type="submit" variant="primary" icon="plus" loading={busy}>
            {L('여행 만들기', 'Create trip')}
          </Button>
          <span className="small muted">{L('숙소·맞교환·가이드·투어를 나중에 담을 수 있어요.', 'Add stays, exchanges, guides and tours later.')}</span>
        </div>
        <ErrorText error={err} />
      </form>
      <Section title={L('내 여행', 'My trips')}>
        <StateView
          state={st}
          skeleton="cards"
          isEmpty={(d) => items(d).length === 0}
          empty={
            <EmptyState
              illo="calendar"
              title={L('아직 만든 여행이 없어요', 'No trips yet')}
              action={
                <>
                  <ButtonLink href="/stay" variant="primary" icon="home">
                    {L('숙소 둘러보기', 'Browse stays')}
                  </ButtonLink>
                  <ButtonLink href="/assistant" icon="sparkle">
                    {L('AI로 일정 짜기', 'Plan with AI')}
                  </ButtonLink>
                </>
              }
            >
              {L('위에서 여행 이름과 날짜를 정하고, 마음에 드는 숙소나 투어 상세에서 ‘플래너에 담기’를 눌러 보세요.', 'Name a trip above, then use “Add to planner” on any stay or tour you like.')}
            </EmptyState>
          }
        >
          {(d) => (
            <HeadingLevel level={3}>
              <div className="grid">
                {items(d).map((it: any) => {
                  const start = str(it, 'startDate');
                  const end = str(it, 'endDate');
                  const list = arr<any>(it, 'items')
                    .slice()
                    .sort((a, b) => (num(a, 'dayIndex') ?? 0) - (num(b, 'dayIndex') ?? 0) || (num(a, 'sortOrder') ?? 0) - (num(b, 'sortOrder') ?? 0));
                  return (
                    <article key={str(it, 'id')} className="card stack">
                      <div>
                        <h3 style={{ margin: 0 }}>{str(it, 'title', 'name')}</h3>
                        <p className="small muted" style={{ margin: '2px 0 0' }}>{start && end ? formatRange(start, end, lang, { nights: true }) : L('날짜 미정', 'Dates TBD')}</p>
                      </div>
                      {list.length ? (
                        <ul className={s.check}>
                          {list.slice(0, 5).map((x: any) => {
                            const di = num(x, 'dayIndex');
                            const day = di !== undefined ? (start ? formatRange(addDays(start, di), addDays(start, di), lang).split(' – ')[0] : L(`${di + 1}일차`, `Day ${di + 1}`)) : '';
                            return (
                              <li key={str(x, 'id')}>
                                <Icon name={ITEM_ICON[str(x, 'itemType').toUpperCase()] ?? 'pin'} size={18} style={{ color: 'var(--text-muted)' }} />
                                <span className="small">
                                  <strong>{str(x, 'title', 'productTitle') || L('일정', 'Plan item')}</strong>
                                  <span className="muted" style={{ display: 'block' }}>{[day, str(x, 'startTime').slice(0, 5), str(x, 'note')].filter(Boolean).join(' · ')}</span>
                                </span>
                              </li>
                            );
                          })}
                          {list.length > 5 && <li className="small muted">{L(`외 ${list.length - 5}개`, `+${list.length - 5} more`)}</li>}
                        </ul>
                      ) : (
                        <p className="small muted" style={{ margin: 0 }}>
                          {L('아직 담은 일정이 없어요. ', 'Nothing added yet. ')}
                          <Link href="/travel">{L('투어 찾아보기', 'Find tours')}</Link>
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
            </HeadingLevel>
          )}
        </StateView>
      </Section>
    </>
  );
}

export default function TripPlannerView() {
  const { L } = useI18n();
  const { ready, user } = useAuth();
  return (
    <>
      <PageHeader title={L('여행 플래너', 'Trip planner')} subtitle={L('숙소, 맞교환, 가이드, 투어를 하나의 일정으로 엮어 보세요.', 'Combine stays, exchanges, guides and tours into one plan.')} actions={<ButtonLink href="/assistant" icon="sparkle">{L('AI로 일정 짜기', 'Plan with AI')}</ButtonLink>} />
      {ready && !user ? (
        <AuthTeaser
          title={L('흩어진 여행 계획을 한곳에', 'All your plans in one place')}
          lead={L('로그인하면 마음에 드는 숙소와 투어를 날짜별로 담아 나만의 일정을 만들 수 있어요.', 'Log in to collect stays and tours into a day-by-day plan.')}
          benefits={[
            { icon: 'calendar', title: L('날짜별 일정', 'Day-by-day'), body: L('체크인부터 투어 시간까지 한눈에 봐요.', 'See check-ins and tour times at a glance.') },
            { icon: 'heart', title: L('저장한 곳 담기', 'Add saved places'), body: L('상세 페이지에서 ‘플래너에 담기’ 한 번이면 돼요.', 'One tap “Add to planner” from any listing.') },
            { icon: 'sparkle', title: L('AI 추천과 함께', 'With AI help'), body: L('AI 도우미가 추천한 곳을 바로 일정으로 옮겨요.', 'Turn AI suggestions straight into plans.') },
          ]}
          preview={
            <ul className={s.check}>
              <li>
                <Icon name="home" size={18} />
                <span className="small">
                  <strong>{L('한림 돌담 독채 체크인', 'Check in: Hallim stone house')}</strong>
                  <span className="muted" style={{ display: 'block' }}>{L('11월 7일 · 15:00', 'Nov 7 · 15:00')}</span>
                </span>
              </li>
              <li>
                <Icon name="ticket" size={18} />
                <span className="small">
                  <strong>{L('제주 오름 일출 투어', 'Jeju oreum sunrise tour')}</strong>
                  <span className="muted" style={{ display: 'block' }}>{L('11월 9일 · 05:30', 'Nov 9 · 05:30')}</span>
                </span>
              </li>
              <li>
                <Icon name="compass" size={18} />
                <span className="small">
                  <strong>{L('로컬 프렌드와 동네 산책', 'Neighbourhood walk with a local friend')}</strong>
                  <span className="muted" style={{ display: 'block' }}>{L('11월 10일 · 14:00', 'Nov 10 · 14:00')}</span>
                </span>
              </li>
            </ul>
          }
        />
      ) : (
        <RequireAuth>
          <Planner />
        </RequireAuth>
      )}
    </>
  );
}
