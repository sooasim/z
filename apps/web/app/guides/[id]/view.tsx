'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, item, items, num, str } from '@/lib/shape';
import { GUIDE_TYPE_LABEL, guideView } from '@/lib/domain';
import { addDays, formatDateLong, isoDate, toMinor } from '@/lib/format';
import { flagFor, langName, postcardFor } from '@/lib/art';
import { placeLabel } from '@/lib/places';
import { ApiError } from '@/lib/errors';
import { StateView, NotFoundState } from '@/components/states';
import { MonthCalendar, type DayInfo } from '@/components/calendar';
import { FavoriteButton, guideCoverUrl } from '@/components/cards';
import { Photo, PhotoCredit } from '@/components/media';
import { useMediaMap } from '@/lib/media';
import { Alert, Avatar, Badge, Button, ButtonLink, ErrorText, Icon, Money, Qty, Section, Select, Textarea, MobileActionBar } from '@/components/ui';
import { Breadcrumbs } from '@/components/public/Breadcrumbs';
import { ReviewsSection } from '@/components/public/Reviews';
import { interestLabel } from '@/components/public/labels';
import s from '@/components/public/public.module.css';
import { pickText } from '@/lib/phrases';

/** Guides work in Korea: availability intervals (UTC) are bucketed into Asia/Seoul calendar days. */
const KST = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const KST_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const kstDay = (iso: string) => KST.format(new Date(iso));
const kstMinutes = (iso: string) => {
  const [h, m] = KST_TIME.format(new Date(iso)).split(':').map(Number);
  return h * 60 + m;
};
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

export default function GuideProfileView() {
  useMediaMap();
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const router = useRouter();
  const st = useApi<any>(`/v1/guides/${id}`);
  const today = isoDate(new Date());
  const av = useApi<any>(`/v1/guides/${id}/availability`, { query: { from: `${today}T00:00:00Z`, to: `${addDays(today, 90)}T00:00:00Z` } });
  const [date, setDate] = useState('');
  const [start, setStart] = useState('');
  const [hours, setHours] = useState('3');
  const [people, setPeople] = useState(2);
  const [interests, setInterests] = useState('');
  const [budget, setBudget] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [fieldErr, setFieldErr] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  // Available windows per KST day: { '2026-10-09': [[420, 1020]] } (minutes from midnight).
  const windows = useMemo(() => {
    const out: Record<string, Array<[number, number]>> = {};
    for (const iv of items(av.data)) {
      const a = str(iv, 'startAt', 'start');
      const b = str(iv, 'endAt', 'end');
      if (!a || !b) continue;
      const da = kstDay(a);
      const db = kstDay(b);
      if (da === db) (out[da] ??= []).push([kstMinutes(a), kstMinutes(b)]);
      else {
        (out[da] ??= []).push([kstMinutes(a), 24 * 60]);
        for (let d = addDays(da, 1); d < db; d = addDays(d, 1)) (out[d] ??= []).push([0, 24 * 60]);
        (out[db] ??= []).push([0, kstMinutes(b)]);
      }
    }
    return out;
  }, [av.data]);

  if (st.error instanceof ApiError && (st.error.kind === 'not_found' || st.error.kind === 'validation'))
    return <NotFoundState as="h1" title={L('가이드를 찾을 수 없어요', 'We can’t find that guide')} body={L('활동을 쉬고 있거나 프로필이 비공개로 바뀌었을 수 있어요.', 'They may be taking a break or have made their profile private.')} back={{ href: '/guide-friends', label: L('다른 가이드 찾기', 'Find other guides') }} />;

  return (
    <StateView state={st} skeleton="detail" back={{ href: '/guide-friends', label: L('가이드 목록으로', 'All guides') }}>
      {(d) => {
        const raw = item(d);
        const g = guideView(raw);
        const tl = GUIDE_TYPE_LABEL[g.type] ?? { ko: g.type, en: g.type, paid: false };
        const city = placeLabel(g.city, lang);
        const specialties = arr<string>(raw, 'specialties').map(String);
        const interestsList = arr<string>(raw, 'interests').map(String);
        const maxGroup = num(raw, 'maxGroupSize');
        const days: Record<string, DayInfo> = {};
        for (const k of Object.keys(windows)) if (k >= today) days[k] = { kind: 'paid', label: L('가능', 'Open') };
        const openDays = Object.keys(days).length;
        const slots = (() => {
          const w = windows[date] ?? [];
          const len = (Number(hours) || 1) * 60;
          const out: string[] = [];
          const ranges = w.length ? w : [[8 * 60, 21 * 60] as [number, number]];
          for (const [a, b] of ranges) for (let t = Math.ceil(a / 30) * 30; t + len <= b; t += 30) out.push(hhmm(t));
          return [...new Set(out)];
        })();
        const pickDay = (d0: string) => {
          setDate(d0);
          setStart('');
          setFieldErr((e) => ({ ...e, date: '' }));
        };
        const submit = async (e: React.FormEvent) => {
          e.preventDefault();
          const fe: Record<string, string> = {};
          if (!date) fe.date = L('달력에서 날짜를 골라 주세요.', 'Pick a date on the calendar.');
          if (!start) fe.start = L('시작 시간을 골라 주세요.', 'Choose a start time.');
          if (maxGroup && people > maxGroup) fe.people = L(`최대 ${maxGroup}명까지 함께할 수 있어요.`, `Up to ${maxGroup} people.`);
          setFieldErr(fe);
          if (Object.values(fe).some(Boolean)) {
            requestAnimationFrame(() => document.querySelector<HTMLElement>('#guide-request [aria-invalid="true"]')?.focus());
            return;
          }
          setBusy(true);
          setErr(null);
          try {
            const startD = new Date(`${date}T${start}:00+09:00`);
            const endD = new Date(startD.getTime() + (Number(hours) || 1) * 3600000);
            const res = await post(
              '/v1/guide-requests',
              { guideId: g.id, startAt: startD.toISOString(), endAt: endD.toISOString(), partySize: people, city: g.city || undefined, interests: interests.split(',').map((x) => x.trim()).filter(Boolean), message: msg || undefined, scope: tl.paid && budget ? { budgetMinor: toMinor(budget) } : {} },
              { idempotencyKey: true },
            );
            router.push(`/guide-requests/${str(item(res), 'id')}`);
          } catch (x) {
            setErr(x);
          } finally {
            setBusy(false);
          }
        };
        return (
          <>
            <Breadcrumbs items={[{ href: '/guide-friends', label: L('가이드 프렌드', 'Guide friends') }, ...(city ? [{ href: `/guide-friends?q=${encodeURIComponent(g.city)}`, label: city }] : []), { label: g.name }]} />
            <header className="card flat" style={{ padding: 0, overflow: 'hidden', marginBottom: 'var(--sp-6)' }}>
              <div style={{ height: 180, position: 'relative', background: 'var(--surface-3)' }} aria-hidden="true">
                <Photo src={guideCoverUrl(raw) || postcardFor(g.city, g.id)} seed={g.id} alt="" eager sizes="(max-width: 1100px) 100vw, 1100px" style={{ display: 'block', width: '100%', height: '100%' }} />
                <PhotoCredit src={guideCoverUrl(raw) || postcardFor(g.city, g.id)} seed={g.id} style={{ top: 8, bottom: 'auto' }} />
              </div>
              <div className="row" style={{ padding: '0 var(--sp-5) var(--sp-5)', alignItems: 'flex-end', gap: 16, marginTop: -44 }}>
                <span style={{ borderRadius: '50%', boxShadow: '0 0 0 4px var(--surface)' }}>
                  <Avatar name={g.name} src={g.avatar || undefined} size={96} verified={g.verified} decorative />
                </span>
                <div className="grow" style={{ minWidth: 220, paddingTop: 48 }}>
                  <div className={s.titleRow}>
                    <h1 style={{ fontSize: 'clamp(var(--fs-2xl), 1.1rem + 1.4vw, var(--fs-3xl))' }}>{g.name}</h1>
                    <FavoriteButton targetType="GUIDE" targetId={g.id} />
                  </div>
                  {g.headline && <p style={{ margin: '4px 0 0', fontWeight: 600 }}>{g.headline}</p>}
                  <div className={s.metaRow}>
                    <span className={`badge ${tl.paid ? 'info' : 'ok'}`}>{pickText(tl, lang)}</span>
                    {g.verified && (
                      <span className="badge ok">
                        <Icon name="verified" size={14} /> {L('본인 확인', 'Verified')}
                      </span>
                    )}
                    {g.reviewCount > 0 && g.rating !== undefined ? (
                      <a href="#reviews" className="small row" style={{ gap: 4, color: 'var(--text)', fontWeight: 700 }}>
                        <Icon name="star" size={14} filled /> {g.rating.toFixed(2)} <span className="muted" style={{ fontWeight: 500 }}>· {L(`후기 ${g.reviewCount}개`, `${g.reviewCount} reviews`)}</span>
                      </a>
                    ) : (
                      <span className="badge accent">{L('새 가이드', 'New guide')}</span>
                    )}
                    {city && (
                      <span className="small muted row" style={{ gap: 4 }}>
                        <Icon name="pin" size={14} /> {city}
                      </span>
                    )}
                    {tl.paid && g.rateMinor !== undefined && (
                      <span className="small">
                        <strong>
                          <Money minor={g.rateMinor} currency={g.currency} />
                        </strong>{' '}
                        <span className="muted">/ {L('시간', 'hr')}</span>
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </header>
            <div className="grid-2">
              <div>
                {g.languages.length > 0 && (
                  <div className="row" style={{ gap: 6, marginBottom: 'var(--sp-4)' }} aria-label={L('사용 언어', 'Languages')}>
                    {g.languages.map((l) => (
                      <span key={l} className="lang-chip">
                        <span className="flag" aria-hidden="true">{flagFor(l)}</span>
                        {langName(l, lang)}
                      </span>
                    ))}
                  </div>
                )}
                {g.bio && <p style={{ whiteSpace: 'pre-line', fontSize: 'var(--fs-lg)', lineHeight: 1.7 }}>{g.bio}</p>}
                {(interestsList.length > 0 || specialties.length > 0) && (
                  <Section title={L('관심사 · 전문 분야', 'Interests & specialties')}>
                    <div className="chip-group">
                      {interestsList.map((i) => (
                        <span key={i} className="badge">{interestLabel(i, lang)}</span>
                      ))}
                      {specialties.map((i) => (
                        <span key={i} className="badge info">{i}</span>
                      ))}
                    </div>
                  </Section>
                )}
                <Section title={L('가능 일정', 'Availability')}>
                  {av.loading ? (
                    <p className="muted small">{L('일정을 불러오는 중…', 'Loading availability…')}</p>
                  ) : (
                    <>
                      <MonthCalendar days={days} selected={{ start: date }} onSelect={pickDay} legend={false} showPrices={false} />
                      <div className="legend" aria-hidden="true" style={{ marginTop: 8 }}>
                        <span>
                          <i style={{ background: 'color-mix(in srgb, var(--cal-paid) 35%, transparent)', boxShadow: 'inset 3px 0 0 var(--cal-paid)' }} />
                          {L('예약 가능', 'Available')}
                        </span>
                        <span>
                          <i style={{ background: 'var(--brand)' }} />
                          {L('선택한 날짜', 'Selected')}
                        </span>
                      </div>
                      {openDays === 0 && <Alert>{L('가이드가 아직 일정을 공개하지 않았어요. 원하는 날짜로 요청을 보내면 가이드가 확인 후 답해요.', 'This guide has not published availability yet. Send a request for your date and they will reply.')}</Alert>}
                    </>
                  )}
                </Section>
                <div id="reviews">
                  <ReviewsSection targetType="GUIDE" targetId={g.id} rating={g.rating} count={g.reviewCount} emptyHint={L('후기는 가이드와 만남을 마친 회원만 남길 수 있어요.', 'Only members who met this guide can leave a review.')} />
                </div>
              </div>
              <aside className={`card sticky-cta stack ${s.aside}`} id="request" aria-labelledby="req-h">
                <h2 id="req-h" style={{ margin: 0 }}>{L('요청 보내기', 'Send a request')}</h2>
                {!tl.paid && <Alert tone="info">{L('무료 교류예요. 금전을 요구받으면 신고해 주세요.', 'This is a free meetup. Report any request for money.')}</Alert>}
                {user ? (
                  <form className="stack" id="guide-request" noValidate onSubmit={submit}>
                    <div className="field">
                      <span>
                        {L('날짜', 'Date')} <span aria-hidden="true">*</span>
                      </span>
                      <div className="row between" style={{ minHeight: 46, padding: '0 14px', border: `1px solid ${fieldErr.date ? 'var(--danger)' : 'var(--border-strong)'}`, borderRadius: 'var(--r-md)' }} tabIndex={-1} aria-invalid={fieldErr.date ? true : undefined}>
                        <span className={date ? '' : 'muted'}>{date ? formatDateLong(date, lang) : L('왼쪽 달력에서 선택', 'Pick on the calendar')}</span>
                        <Icon name="calendar" size={18} style={{ color: 'var(--text-muted)' }} />
                      </div>
                      {fieldErr.date && <small className="err">{fieldErr.date}</small>}
                    </div>
                    <div className="form-grid cols-2">
                      <Select label={L('이용 시간', 'Duration')} value={hours} onChange={(e) => { setHours(e.target.value); setStart(''); }} options={['1', '2', '3', '4', '6', '8'].map((h) => ({ value: h, label: L(`${h}시간`, `${h} h`) }))} />
                      <label className="field">
                        <span>
                          {L('시작 시간', 'Start')} <span aria-hidden="true">*</span>
                        </span>
                        <select value={start} onChange={(e) => { setStart(e.target.value); setFieldErr((x) => ({ ...x, start: '' })); }} aria-invalid={fieldErr.start ? true : undefined} aria-describedby={fieldErr.start ? 'start-e' : undefined} disabled={!date}>
                          <option value="">{date ? L('선택', 'Choose') : L('날짜 먼저', 'Pick a date')}</option>
                          {slots.map((t) => (
                            <option key={t} value={t}>{t}</option>
                          ))}
                        </select>
                        {fieldErr.start && <small className="err" id="start-e">{fieldErr.start}</small>}
                      </label>
                    </div>
                    <div className="guest-row" style={{ paddingTop: 4 }}>
                      <span>
                        <strong>{L('인원', 'People')}</strong>
                        {maxGroup && <span className="xs muted" style={{ display: 'block' }}>{L(`최대 ${maxGroup}명`, `Up to ${maxGroup}`)}</span>}
                      </span>
                      <Qty label={L('인원', 'People')} value={people} min={1} max={maxGroup ?? 20} onChange={setPeople} />
                    </div>
                    <label className="field">
                      <span>{L('관심사 (쉼표로 구분)', 'Interests (comma separated)')}</span>
                      <input value={interests} onChange={(e) => setInterests(e.target.value)} placeholder={L('카페, 시장, 사진', 'cafés, markets, photography')} />
                    </label>
                    {tl.paid && (
                      <label className="field">
                        <span>{L('예산 (선택)', 'Budget (optional)')}</span>
                        <span className="input-affix">
                          <span className="affix" aria-hidden="true">₩</span>
                          <input inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="100,000" />
                        </span>
                      </label>
                    )}
                    <Textarea label={L('메시지', 'Message')} value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={2000} placeholder={L('가고 싶은 곳, 함께하는 분, 궁금한 점을 적어 주세요.', 'Where you’d like to go, who’s coming, any questions.')} />
                    <Button type="submit" variant="primary" block loading={busy}>
                      {L('요청 보내기', 'Send request')}
                    </Button>
                    <p className="xs muted" style={{ margin: 0 }}>{tl.paid ? L('가이드가 수락하면 결제 후 확정돼요. 요청만으로는 결제되지 않아요.', 'If the guide accepts, you pay to confirm. Sending a request is free.') : L('가이드가 수락하면 메시지로 만날 곳을 정해요.', 'If the guide accepts, you agree on a meeting point in messages.')}</p>
                    <ErrorText error={err} />
                  </form>
                ) : (
                  <ButtonLink href={`/login?next=${encodeURIComponent(`/guides/${id}`)}`} variant="primary" block>
                    {L('로그인하고 요청하기', 'Log in to request')}
                  </ButtonLink>
                )}
                <div className={`row ${s.gap12}`} style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
                  <Link href={`/support/disputes?subjectType=USER&subjectId=${encodeURIComponent(g.id)}`} className="small row" style={{ gap: 4 }}>
                    <Icon name="flag" size={14} /> {L('이 가이드 신고', 'Report this guide')}
                  </Link>
                  <span className="xs muted">{L('만남은 공공장소에서 시작하세요.', 'Meet in a public place first.')}</span>
                </div>
              </aside>
            </div>
            <MobileActionBar label={L('가이드 요청', 'Guide request')}>
              <div className={s.mobileBarPrice}>
                <strong>{tl.paid && g.rateMinor !== undefined ? <><Money minor={g.rateMinor} currency={g.currency} /> <span className="xs muted" style={{ fontWeight: 500 }}>/ {L('시간', 'hr')}</span></> : L('무료 교류', 'Free meetup')}</strong>
                <span>{date ? formatDateLong(date, lang) : L(`가능한 날 ${openDays}일`, `${openDays} open days`)}</span>
              </div>
              <ButtonLink href={user ? '#request' : `/login?next=${encodeURIComponent(`/guides/${id}`)}`} variant="accent">
                {user ? L('요청 보내기', 'Send request') : L('로그인하고 요청', 'Log in')}
              </ButtonLink>
            </MobileActionBar>
          </>
        );
      }}
    </StateView>
  );
}
