'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { post } from '@/lib/api';
import { item, items, str, num, f } from '@/lib/shape';
import { propertyView } from '@/lib/domain';
import { postcardSet, realize } from '@/lib/art';
import { useMediaMap } from '@/lib/media';
import { Photo, PhotoLightbox } from '@/components/media';
import { addDays, eachNight, formatMoney, formatPriceShort, isoDate, nightsBetween } from '@/lib/format';
import { quoteView, stashQuote, type QuoteView } from '@/lib/quote';
import { ApiError, errorMessage } from '@/lib/errors';
import { countryLabel, placeLabel } from '@/lib/places';
import { StateView, NotFoundState } from '@/components/states';
import { QuoteBreakdown } from '@/components/quote';
import { ComplianceBadge, isCompliant } from '@/components/cards';
import { HeartButton } from '@/components/favorites';
import { calendarDays } from '@/components/calendar';
import { MapView } from '@/components/map';
import { Alert, Avatar, Badge, Button, ButtonLink, DateRangeField, GuestsField, Icon, MobileActionBar, Modal, PriceBreakdown, Section, Skeleton, amenityIcon, useMediaQuery, useToast, type Guests, type IconName } from '@/components/ui';
import { Breadcrumbs } from '@/components/public/Breadcrumbs';
import { ReviewsSection } from '@/components/public/Reviews';
import { policyName, propertyTypeLabel, refundLines } from '@/components/public/labels';
import s from '@/components/public/public.module.css';

type View = ReturnType<typeof propertyView>;
const BLOCKED = ['paid', 'exchange', 'block', 'hold', 'unavail'];

function Mosaic({ images, title }: { images: string[]; title: string }) {
  const { L } = useI18n();
  useMediaMap();
  const [open, setOpen] = useState<number | null>(null);
  const shown = images.slice(0, 5);
  return (
    <>
      <div className="mosaic">
        {shown.map((src, i) => (
          <button key={i} className={i === 0 ? 'm0' : 'mx'} onClick={() => setOpen(i)} aria-label={`${L('사진 크게 보기', 'Open photo')} ${i + 1}`}>
            <Photo src={src} seed={`${title}:${i}`} alt={i === 0 ? title : ''} eager={i === 0} sizes={i === 0 ? '(max-width: 900px) 100vw, 600px' : '(max-width: 900px) 50vw, 300px'} onError={(e) => { const el = e.currentTarget; if (!el.dataset.fallback) { el.dataset.fallback = '1'; el.removeAttribute('srcset'); el.src = '/art/postcards/coast.svg'; } }} />
          </button>
        ))}
        {images.length > 1 && (
          <button className="show-all" onClick={() => setOpen(0)}>
            <Icon name="grid" size={16} /> {L(`사진 ${images.length}장 모두 보기`, `Show all ${images.length} photos`)}
          </button>
        )}
      </div>
      {open !== null && <PhotoLightbox items={images.map((src, i) => ({ src: realize(src, `${title}:${i}`), alt: title }))} index={open} onClose={() => setOpen(null)} title={title} />}
    </>
  );
}

function HostTrust({ host, pid }: { host: any; pid: string }) {
  const { L, lang } = useI18n();
  if (!host) return null;
  const name = str(host, 'displayName', 'name') || L('호스트', 'Host');
  const verified = Boolean(f(host, 'verified', 'identityVerified', 'isVerified')) || str(host, 'verificationStatus') === 'VERIFIED';
  const reviews = num(host, 'reputation.reviewCount', 'reviewCount') ?? 0;
  const rating = num(host, 'reputation.ratingAvg', 'ratingAvg', 'rating');
  const rr = num(host, 'responseRate');
  const since = str(host, 'memberSince', 'joinedAt', 'createdAt');
  const sinceYear = since ? new Date(since).getFullYear() : undefined;
  const stats: Array<[string, string]> = [];
  if (reviews > 0) stats.push([String(reviews), L('후기', 'Reviews')]);
  if (reviews > 0 && rating !== undefined) stats.push([`★ ${rating.toFixed(2)}`, L('평점', 'Rating')]);
  if (rr !== undefined && rr > 0) stats.push([`${Math.round(rr <= 1 ? rr * 100 : rr)}%`, L('응답률', 'Response rate')]);
  if (sinceYear && Number.isFinite(sinceYear)) stats.push([lang === 'ko' ? `${sinceYear}년` : String(sinceYear), L('부터 호스팅', 'Hosting since')]);
  return (
    <Section title={L('호스트 소개', 'Meet your host')}>
      <div className="card raised row nowrap" style={{ alignItems: 'flex-start', gap: 20, flexWrap: 'wrap' }}>
        <div className="center" style={{ minWidth: 120 }}>
          <Avatar name={name} personId={str(host, 'userId', 'hostId', 'id')} size={84} verified={verified} src={str(host, 'avatarUrl') || undefined} decorative />
          <strong style={{ display: 'block', marginTop: 8 }}>{name}</strong>
          {verified && (
            <span className="badge ok" style={{ marginTop: 4 }}>
              <Icon name="verified" size={14} /> {L('인증 호스트', 'Verified host')}
            </span>
          )}
        </div>
        <div className="grow stack" style={{ minWidth: 240 }}>
          {stats.length > 0 && (
            <div className={s.stats}>
              {stats.map(([v, k]) => (
                <div key={k}>
                  <strong className="tnum">{v}</strong>
                  <span className="xs muted">{k}</span>
                </div>
              ))}
            </div>
          )}
          {str(host, 'about', 'bio') && <p className="small" style={{ margin: 0 }}>{str(host, 'about', 'bio')}</p>}
          {pid && <AskHost propertyId={pid} />}
          <p className="xs muted row" style={{ margin: 0, gap: 6, flexWrap: 'nowrap' }}>
            <Icon name="shield" size={14} style={{ flex: '0 0 auto' }} /> {L('안전한 결제를 위해 JETPOOL 밖에서 송금하지 마세요.', 'To stay protected, never pay outside JETPOOL.')}
          </p>
        </div>
      </div>
    </Section>
  );
}

function AskHost({ propertyId }: { propertyId: string }) {
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button icon="chat" style={{ justifySelf: 'start' }} onClick={() => (user ? setOpen(true) : router.push(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`))}>
        {L('호스트에게 문의하기', 'Message the host')}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={L('호스트에게 문의', 'Message the host')}
        footer={
          <>
            <span className="xs muted">{L('연락처 교환·외부 결제 유도는 제한됩니다.', 'Sharing contacts or off-platform payment is restricted.')}</span>
            <Button
              variant="primary"
              disabled={!msg.trim()}
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const r = await post('/v1/conversations', { contextType: 'INQUIRY', targetType: 'PROPERTY', targetId: propertyId, message: msg.trim(), clientMessageId: `inq-${propertyId}-${Date.now()}` });
                  router.push(`/messages?c=${str(item(r), 'id')}`);
                } catch (e) {
                  setErr(e);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {L('보내기', 'Send')}
            </Button>
          </>
        }
      >
        <label className="field">
          <span>{L('메시지', 'Message')}</span>
          <textarea value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={4000} placeholder={L('예: 11월 한 달 머물고 싶은데 업무용 책상이 있나요?', 'e.g. Is there a desk for remote work in November?')} autoFocus />
        </label>
        {err ? <Alert tone="error">{errorMessage(err, lang)}</Alert> : null}
      </Modal>
    </>
  );
}

function useCalendar(id: string) {
  const today = isoDate(new Date());
  const cal = useApi<any>(id ? `/v1/properties/${id}/calendar` : null, { query: { from: today, to: addDays(today, 365) } });
  const rows = items(cal.data).length ? items(cal.data) : (f<any[]>(item(cal.data), 'days', 'blocks') ?? []);
  return { days: calendarDays(rows), loading: cal.loading };
}

/** Paid-stay booking card + phone sticky bar. The live quote is authoritative; anonymous visitors see an estimate. */
function BookingCard({ v, p }: { v: View; p: any }) {
  const { L, lang } = useI18n();
  const { user, ready } = useAuth();
  const sp = useSearchParams();
  const router = useRouter();
  const phone = useMediaQuery('(max-width: 639px)');
  const [range, setRange] = useState({ start: sp.get('checkIn') ?? '', end: sp.get('checkOut') ?? '' });
  const [guests, setGuests] = useState<Guests>({ adults: Math.max(1, Number(sp.get('guests') ?? 2) || 2), children: 0, infants: 0, pets: 0 });
  const [q, setQ] = useState<QuoteView | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const { days } = useCalendar(v.id);
  const boxRef = useRef<HTMLDivElement>(null);
  const bookable = !v.compliance || isCompliant(v.compliance);
  const nights = nightsBetween(range.start, range.end);
  const total = guests.adults + guests.children;
  const minNights = num(p, 'minNights') ?? 1;
  const maxNights = num(p, 'maxNights');
  const cleaning = num(p, 'cleaningFeeMinor') ?? 0;
  const reqId = useRef(0);
  const anon = ready && !user;
  const tooShort = nights > 0 && nights < minNights;
  const tooLong = nights > 0 && maxNights !== undefined && nights > maxNights;
  const needLogin = anon || (err instanceof ApiError && err.kind === 'unauthenticated');
  const openDates = () => {
    boxRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    boxRef.current?.querySelector<HTMLButtonElement>('button.search-slot')?.click();
  };

  // Live quote: re-price whenever dates/guests change (debounced). Anonymous visitors get a client-side estimate.
  useEffect(() => {
    setQ(null);
    setErr(null);
    setBusy(false);
    if (!v.id || !bookable || nights <= 0 || tooShort || tooLong || !ready || !user) return;
    const id = ++reqId.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const res = await post('/v1/booking/quotes', { propertyId: v.id, checkIn: range.start, checkOut: range.end, guests: total, pets: guests.pets || undefined });
        if (id !== reqId.current) return;
        stashQuote(res);
        setQ(quoteView(res));
      } catch (e) {
        if (id !== reqId.current) return;
        setErr(e);
        if (!(e instanceof ApiError && e.kind === 'unauthenticated') && !phone) setTimeout(openDates, 50);
      } finally {
        if (id === reqId.current) setBusy(false);
      }
    }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.id, range.start, range.end, total, guests.pets, bookable, nights, ready, user?.id]);

  // Estimate from the calendar's nightly prices (falls back to the base rate) + cleaning fee.
  const nightly = eachNight(range.start, range.end).reduce((sum, d) => sum + (days[d]?.price ?? v.priceMinor ?? 0), 0);
  const estimate = nights > 0 && v.priceMinor !== undefined ? nightly + cleaning : undefined;
  const qs = `checkIn=${range.start}&checkOut=${range.end}&guests=${total}`;
  const here = `/stay/${encodeURIComponent(v.slug)}${nights > 0 ? `?${qs}` : ''}`;
  const reserve = () => {
    if (!q) return;
    router.push(`/stay/${encodeURIComponent(v.slug)}/checkout?quoteId=${encodeURIComponent(q.id)}&${qs}`);
  };

  type Cta = { label: string; onClick?: () => void; href?: string; disabled?: boolean; loading?: boolean };
  const cta: Cta = !bookable
    ? { label: L('지금은 예약할 수 없어요', 'Not bookable yet'), disabled: true }
    : nights <= 0 || tooShort || tooLong
      ? { label: nights <= 0 ? L('날짜 선택', 'Choose dates') : L('다른 날짜 선택', 'Choose other dates'), onClick: openDates }
      : needLogin
        ? { label: L('로그인하고 예약하기', 'Log in to reserve'), href: `/login?next=${encodeURIComponent(here)}` }
        : busy
          ? { label: L('요금 확인 중', 'Checking price'), loading: true }
          : err
            ? { label: L('다른 날짜 선택', 'Choose other dates'), onClick: openDates }
            : q
              ? { label: L('예약하기', 'Reserve'), onClick: reserve }
              : { label: L('날짜 선택', 'Choose dates'), onClick: openDates };
  const ctaButton = (block: boolean, size: 'md' | 'lg') =>
    cta.href ? (
      <ButtonLink href={cta.href} variant="accent" size={size} block={block}>
        {cta.label}
      </ButtonLink>
    ) : (
      <Button variant="accent" size={size} block={block} onClick={cta.onClick} disabled={cta.disabled} loading={cta.loading}>
        {cta.label}
      </Button>
    );
  const blockedMsg = tooShort ? L(`이 숙소는 최소 ${minNights}박부터 예약할 수 있어요.`, `This stay has a ${minNights}-night minimum.`) : tooLong ? L(`최대 ${maxNights}박까지 예약할 수 있어요.`, `Up to ${maxNights} nights.`) : '';
  const shownTotal = q?.totalMinor ?? (needLogin ? estimate : undefined);

  return (
    <aside className="card booking-card sticky-cta stack" aria-label={L('예약', 'Booking')}>
      <div className="price-head">
        {v.priceMinor !== undefined ? (
          <>
            <strong className="tnum">{formatMoney(v.priceMinor, v.currency, lang)}</strong>
            <span className="muted">/ {L('박', 'night')}</span>
          </>
        ) : (
          <strong>{L('요금 문의', 'Price on request')}</strong>
        )}
        <span className="grow" />
        {v.reviewCount > 0 && v.rating !== undefined && (
          <span className="small row" style={{ gap: 4 }}>
            <Icon name="star" size={14} filled /> {v.rating.toFixed(2)} <span className="muted">({v.reviewCount})</span>
          </span>
        )}
      </div>
      <div className="date-box" ref={boxRef}>
        <div style={{ gridColumn: '1 / -1' }}>
          <DateRangeField
            start={range.start}
            end={range.end}
            onChange={setRange}
            isBlocked={(d) => BLOCKED.includes(days[d]?.kind ?? '')}
            priceFor={(d) => (days[d]?.price ? formatPriceShort(days[d].price, v.currency, lang) : undefined)}
          />
        </div>
        <div className="full">
          <GuestsField value={guests} onChange={setGuests} max={v.maxGuests ?? 16} />
        </div>
      </div>
      {!bookable && <Alert tone="warn">{L('인허가·안전 요건 확인이 끝나면 예약이 열려요. 마음에 드시면 저장해 두세요.', 'Booking opens once permits and safety checks pass. Save it for later.')}</Alert>}
      {blockedMsg && <Alert tone="info">{blockedMsg}</Alert>}
      {ctaButton(true, 'lg')}
      {q && <p className="xs muted center" style={{ margin: 0 }}>{L('아직 결제되지 않아요', "You won't be charged yet")}</p>}
      {busy && !q && (
        <div className="stack" aria-hidden="true">
          <Skeleton w="100%" />
          <Skeleton w="80%" />
          <Skeleton w="90%" />
        </div>
      )}
      {q && <QuoteBreakdown q={q} />}
      {!q && needLogin && estimate !== undefined && !blockedMsg && (
        <PriceBreakdown
          currency={v.currency}
          totalMinor={estimate}
          totalLabel={L('예상 요금', 'Estimated total')}
          lines={[
            { label: L(`숙박 ${nights}박`, `${nights} night${nights === 1 ? '' : 's'}`), amountMinor: nightly },
            ...(cleaning ? [{ label: L('청소비', 'Cleaning fee'), amountMinor: cleaning }] : []),
          ]}
          footnote={L('서비스 수수료와 최종 금액은 로그인 후 확정돼요.', 'Service fees and the final price are confirmed after you log in.')}
        />
      )}
      {err && !needLogin ? <Alert tone="error">{errorMessage(err, lang)}</Alert> : null}
      <p className="xs muted row" style={{ margin: 0, gap: 6, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <Icon name="shield" size={14} style={{ flex: '0 0 auto', marginTop: 2 }} /> {L('결제 승인 후에만 예약이 확정되며, 날짜는 결제 전 서버에서 다시 확인돼요.', 'Confirmed only after payment approval; dates are re-checked before payment.')}
      </p>
      <MobileActionBar label={L('예약', 'Booking')}>
        <div className={s.mobileBarPrice}>
          {shownTotal !== undefined ? (
            <>
              <strong>{formatMoney(shownTotal, v.currency, lang)}</strong>
              <span>{q ? L(`총액 · ${nights}박`, `Total · ${nights} nights`) : L(`예상 요금 · ${nights}박`, `Estimate · ${nights} nights`)}</span>
            </>
          ) : v.priceMinor !== undefined ? (
            <>
              <strong>
                {formatMoney(v.priceMinor, v.currency, lang)} <span className="xs muted" style={{ fontWeight: 500 }}>/ {L('박', 'night')}</span>
              </strong>
              <span>{err && !needLogin ? errorMessage(err, lang) : nights > 0 ? L(`${nights}박 선택됨`, `${nights} nights selected`) : L('날짜를 선택하면 총액을 알려드려요', 'Add dates for the total')}</span>
            </>
          ) : (
            <strong>{L('요금 문의', 'Price on request')}</strong>
          )}
        </div>
        {ctaButton(false, 'md')}
      </MobileActionBar>
    </aside>
  );
}

/** Exchange-only homes: what you need and a clear primary action instead of a lonely info alert. */
function ExchangeCard({ v }: { v: View }) {
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const { days, loading } = useCalendar(v.id);
  const elig = useApi<any>(user ? '/v1/exchange/eligibility' : null);
  const unmet: string[] = (f<string[]>(item(elig.data), 'unmet') ?? []).map(String);
  const known = !!elig.data;
  // Months (next 6) with at least ~3 free weeks → "available months".
  const now = new Date();
  const months = Array.from({ length: 6 }, (_, i) => new Date(now.getFullYear(), now.getMonth() + i, 1)).filter((m) => {
    let free = 0;
    const y = m.getFullYear();
    const mo = m.getMonth();
    for (let d = new Date(y, mo, 1); d.getMonth() === mo; d.setDate(d.getDate() + 1)) {
      const k = isoDate(d);
      if (k >= isoDate(now) && !BLOCKED.includes(days[k]?.kind ?? '')) free++;
    }
    return free >= 21;
  });
  const fmt = new Intl.DateTimeFormat(lang === 'ko' ? 'ko-KR' : 'en-US', { month: 'short' });
  const reqs: Array<{ code: string; label: string; href: string }> = [
    { code: 'IDENTITY_NOT_VERIFIED', label: L('본인 인증 완료', 'Identity verified'), href: '/verification' },
    { code: 'NO_EXCHANGE_HOME', label: L('내 집을 맞교환용으로 등록', 'Your own home listed for exchange'), href: '/exchange/onboarding' },
    { code: 'PROFILE_INCOMPLETE', label: L('맞교환 프로필 작성', 'Exchange profile completed'), href: '/exchange/onboarding#profile' },
  ];
  const href = `/exchange?home=${encodeURIComponent(v.id)}`;
  const ctaHref = user ? href : `/login?next=${encodeURIComponent(href)}`;
  return (
    <aside className="card booking-card sticky-cta stack" aria-label={L('홈 맞교환', 'Home exchange')}>
      <div className="row between">
        <Badge tone="exchange" icon={<Icon name="swap" size={14} />}>
          {L('홈 맞교환 전용', 'Home exchange only')}
        </Badge>
        <span className="xs muted">{L('숙박비 없음', 'No rent')}</span>
      </div>
      <h2 style={{ margin: 0, fontSize: 'var(--fs-xl)' }}>{L('이 집과 한 달 바꿔 살아보기', 'Swap homes with this host')}</h2>
      <p className="small muted" style={{ margin: 0 }}>{L('돈을 주고받지 않고, 같은 기간(또는 다른 기간)에 서로의 집에 머물러요.', 'No money changes hands — you stay in each other’s homes, at the same time or different times.')}</p>
      <div>
        <strong className="small">{L('맞교환 가능한 달', 'Available months')}</strong>
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          {loading ? <Skeleton w={160} h={24} /> : months.length ? months.map((m) => <span key={m.toISOString()} className="badge">{fmt.format(m)}</span>) : <span className="small muted">{L('호스트와 일정을 조율해 주세요', 'Discuss dates with the host')}</span>}
        </div>
      </div>
      <div>
        <strong className="small">{L('제안하려면 필요해요', 'What you need')}</strong>
        <ul className={s.check} style={{ marginTop: 8 }}>
          {reqs.map((it) => {
            const ok = known && !unmet.includes(it.code);
            return (
              <li key={it.code} className={ok ? s.ok : s.todo}>
                <Icon name={ok ? 'check-circle' : 'circle'} size={18} />
                <span className="small grow">
                  {it.label}
                  <span className="sr-only">{ok ? L(' (완료)', ' (done)') : L(' (필요)', ' (needed)')}</span>
                </span>
                {user && known && !ok && (
                  <Link className="xs" href={it.href}>
                    {L('하러 가기', 'Do it')}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <ButtonLink href={ctaHref} variant="accent" size="lg" block icon="swap">
        {user ? L('맞교환 제안하기', 'Propose an exchange') : L('로그인하고 맞교환 제안하기', 'Log in to propose')}
      </ButtonLink>
      <p className="xs muted" style={{ margin: 0 }}>{L('제안 → 조건 합의 → 양측 검증 → 계약서 서명 순서로 진행돼요. 서명 전까지는 언제든 철회할 수 있어요.', 'Proposal → agree terms → both verified → sign the agreement. You can withdraw any time before signing.')}</p>
      <MobileActionBar label={L('홈 맞교환', 'Home exchange')}>
        <div className={s.mobileBarPrice}>
          <strong>{L('홈 맞교환', 'Home exchange')}</strong>
          <span>{months.length ? months.map((m) => fmt.format(m)).slice(0, 3).join(' · ') : L('숙박비 없이 집을 바꿔 살기', 'Swap homes, no rent')}</span>
        </div>
        <ButtonLink href={ctaHref} variant="accent">
          {L('맞교환 제안', 'Propose')}
        </ButtonLink>
      </MobileActionBar>
    </aside>
  );
}

function TrustItem({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <div className="trust-item">
      <span className="ico" aria-hidden="true">
        <Icon name={icon} size={20} />
      </span>
      <div>
        <strong>{title}</strong>
        <p className="small muted" style={{ margin: 0 }}>{body}</p>
      </div>
    </div>
  );
}

function houseRuleItems(rules: any, L: (ko: string, en: string) => string): Array<{ icon: IconName; text: string }> {
  if (Array.isArray(rules)) return rules.map((r: any) => ({ icon: 'check' as IconName, text: typeof r === 'string' ? r : str(r, 'text', 'label', 'rule') })).filter((r) => r.text);
  if (typeof rules === 'string') return [{ icon: 'check', text: rules }];
  if (!rules || typeof rules !== 'object') return [];
  const out: Array<{ icon: IconName; text: string }> = [];
  if (f(rules, 'smokingAllowed') !== undefined) out.push({ icon: f(rules, 'smokingAllowed') ? 'check' : 'ban', text: f(rules, 'smokingAllowed') ? L('흡연 가능', 'Smoking allowed') : L('실내 금연', 'No smoking') });
  if (f(rules, 'petsAllowed') !== undefined) out.push({ icon: 'paw', text: f(rules, 'petsAllowed') ? L('반려동물 동반 가능', 'Pets allowed') : L('반려동물 동반 불가', 'No pets') });
  if (f(rules, 'eventsAllowed') !== undefined) out.push({ icon: f(rules, 'eventsAllowed') ? 'check' : 'ban', text: f(rules, 'eventsAllowed') ? L('파티·행사 가능', 'Events allowed') : L('파티·행사 불가', 'No parties or events') });
  if (str(rules, 'quietHours')) out.push({ icon: 'moon', text: `${L('정숙 시간', 'Quiet hours')} ${str(rules, 'quietHours').replace('-', '–')}` });
  if (str(rules, 'extraRules')) out.push({ icon: 'info', text: str(rules, 'extraRules') });
  return out;
}

export default function StayDetailView() {
  const { slug } = useParams<{ slug: string }>();
  const { L, lang } = useI18n();
  const toast = useToast();
  const st = useApi<any>(slug ? `/v1/properties/by-slug/${encodeURIComponent(slug)}` : null);
  const [descOpen, setDescOpen] = useState(false);
  if (st.error instanceof ApiError && st.error.kind === 'not_found')
    return <NotFoundState as="h1" title={L('숙소를 찾을 수 없어요', 'We can’t find that stay')} body={L('호스트가 숙소를 내렸거나 주소가 바뀌었을 수 있어요.', 'The host may have unlisted it, or the link changed.')} back={{ href: '/stay', label: L('다른 숙소 둘러보기', 'Browse other stays') }} />;
  return (
    <StateView state={st} skeleton="detail" back={{ href: '/stay', label: L('숙소 목록으로', 'Back to stays') }}>
      {(d) => {
        const p = item(d);
        const v = propertyView(p);
        const images = v.media.length ? v.media : postcardSet(v.city || v.title, v.id || v.slug, 5);
        const exchangeOnly = v.rentalEnabled === false;
        const city = placeLabel(v.city, lang);
        const area = str(p, 'location.areaLabel', 'areaLabel');
        const where = lang === 'ko' && area ? area : [city, v.country ? countryLabel(v.country, lang) : ''].filter(Boolean).join(', ');
        const typeLabel = propertyTypeLabel(v.propertyType, lang);
        const roomType = str(p, 'roomType');
        const rules = houseRuleItems(v.houseRules, L);
        const policy = f<any>(p, 'cancellationPolicy');
        const policyLines = refundLines(policy, lang, ['체크인', 'check-in']);
        const checkIn = str(p, 'checkInTime');
        const checkOut = str(p, 'checkOutTime');
        const hasReviews = v.reviewCount > 0 && v.rating !== undefined;
        const share = async () => {
          const url = window.location.href;
          try {
            if (navigator.share) await navigator.share({ title: v.title, url });
            else {
              await navigator.clipboard?.writeText(url);
              toast.show(L('링크를 복사했어요', 'Link copied'));
            }
          } catch {
            /* dismissed */
          }
        };
        return (
          <article>
            <Breadcrumbs items={[{ href: '/stay', label: L('숙소', 'Stays') }, ...(city ? [{ href: `/stay?q=${encodeURIComponent(v.city)}`, label: city }] : []), { label: v.title }]} />
            <header style={{ marginBottom: 'var(--sp-5)' }}>
              <div className={s.titleRow}>
                <h1>{v.title}</h1>
                <div className={s.titleActions}>
                  <Button variant="ghost" size="sm" icon="upload" onClick={share}>
                    <span className={s.shareLabel}>{L('공유', 'Share')}</span>
                  </Button>
                  {v.id && (
                    <span style={{ display: 'inline-grid', background: 'var(--surface-3)', borderRadius: 999 }}>
                      <HeartButton targetType="PROPERTY" targetId={v.id} />
                    </span>
                  )}
                </div>
              </div>
              <div className={s.metaRow}>
                {hasReviews ? (
                  <a href="#reviews" className="small row" style={{ gap: 4, color: 'var(--text)', fontWeight: 700 }}>
                    <Icon name="star" size={14} filled /> {v.rating!.toFixed(2)} <span className="muted" style={{ fontWeight: 500 }}>· {L(`후기 ${v.reviewCount}개`, `${v.reviewCount} reviews`)}</span>
                  </a>
                ) : (
                  <span className="badge accent">{L('신규 숙소', 'New listing')}</span>
                )}
                <span className="muted small row" style={{ gap: 4 }}>
                  <Icon name="pin" size={14} /> {where}
                </span>
                {!exchangeOnly && <ComplianceBadge status={v.compliance} />}
                {v.exchangeEnabled && (
                  <span className="badge exchange">
                    <Icon name="swap" size={14} /> {exchangeOnly ? L('맞교환 전용', 'Exchange only') : L('홈 맞교환 가능', 'Open to exchange')}
                  </span>
                )}
              </div>
            </header>
            <Mosaic images={images} title={v.title} />
            <div className="grid-2" style={{ marginTop: 'var(--sp-8)' }}>
              <div>
                <div className="row between" style={{ paddingBottom: 'var(--sp-5)', borderBottom: '1px solid var(--border)', alignItems: 'flex-start' }}>
                  <div>
                    <h2 style={{ margin: 0 }}>{[city, typeLabel].filter(Boolean).join(' · ') || v.title}</h2>
                    <p className="muted" style={{ margin: '4px 0 0' }}>
                      {[roomType && propertyTypeLabel(roomType, lang), v.maxGuests && L(`최대 ${v.maxGuests}명`, `Up to ${v.maxGuests} guests`), v.bedrooms !== undefined && L(`침실 ${v.bedrooms}`, `${v.bedrooms} bedroom${v.bedrooms === 1 ? '' : 's'}`), v.bathrooms !== undefined && L(`욕실 ${v.bathrooms}`, `${v.bathrooms} bath${v.bathrooms === 1 ? '' : 's'}`)].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  {!exchangeOnly && (
                    <ButtonLink href={`/stay/${encodeURIComponent(v.slug)}/calendar`} size="sm" icon="calendar">
                      {L('전체 일정', 'Full calendar')}
                    </ButtonLink>
                  )}
                </div>
                <div className="trust-row" style={{ padding: 'var(--sp-6) 0', borderBottom: '1px solid var(--border)' }}>
                  {exchangeOnly ? (
                    <>
                      <TrustItem icon="verified" title={L('검증된 회원끼리', 'Verified members only')} body={L('양측 모두 본인 인증과 집 등록을 마친 회원이에요.', 'Both sides have verified their identity and listed a home.')} />
                      <TrustItem icon="swap" title={L('두 집이 함께 확정', 'Both homes confirmed together')} body={L('한쪽이 취소되면 두 집 일정이 모두 취소돼요.', 'If one side cancels, both stays are cancelled.')} />
                      <TrustItem icon="key" title={L('주소는 확정 후 공개', 'Address after confirmation')} body={L('맞교환이 확정되면 정확한 주소를 알려드려요.', 'The exact address is shared once confirmed.')} />
                    </>
                  ) : (
                    <>
                      {isCompliant(v.compliance) && <TrustItem icon="shield" title={L('인허가 확인 숙소', 'Permit verified')} body={L('필수 신고·안전 요건을 JETPOOL이 확인했어요.', 'Required permits checked by JETPOOL.')} />}
                      {(policyLines.length > 0 || v.cancellationPolicy) && <TrustItem icon="calendar" title={`${L('환불 정책', 'Cancellation')} · ${policyName(str(policy, 'name') || v.cancellationPolicy, lang)}`} body={policyLines[0] ?? L('예약 관리에서 환불 예상액을 미리 볼 수 있어요.', 'Preview your refund before cancelling.')} />}
                      <TrustItem icon="key" title={L('주소는 확정 후 공개', 'Address after confirmation')} body={L('호스트와 게스트 모두의 안전을 위해서예요.', 'For everyone’s safety.')} />
                    </>
                  )}
                </div>
                {v.description && (
                  <Section>
                    <p style={{ whiteSpace: 'pre-line', margin: 0, display: descOpen ? 'block' : '-webkit-box', WebkitLineClamp: descOpen ? 'unset' : 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{v.description}</p>
                    {v.description.length > 300 && (
                      <button className="btn link" onClick={() => setDescOpen(!descOpen)} aria-expanded={descOpen}>
                        {descOpen ? L('접기', 'Show less') : L('더 보기', 'Show more')}
                      </button>
                    )}
                  </Section>
                )}
                <Section title={L('숙소 편의시설', 'What this place offers')}>
                  {v.amenityItems.length ? (
                    <ul className="amenity-list">
                      {v.amenityItems.map((a) => (
                        <li key={a.code} className={s.amenity}>
                          <Icon name={amenityIcon(a.code)} size={22} /> {(lang === 'ko' ? a.ko : a.en).replace(/_/g, ' ')}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">{L('호스트가 아직 편의시설을 등록하지 않았어요.', 'The host has not listed amenities yet.')}</p>
                  )}
                </Section>
                <Section title={L('숙소 이용 규칙', 'House rules')}>
                  {(checkIn || checkOut) && (
                    <p className="row" style={{ fontWeight: 600, gap: 8 }}>
                      <Icon name="clock" size={18} /> {[checkIn && `${L('체크인', 'Check-in')} ${checkIn.slice(0, 5)} ${L('이후', 'or later')}`, checkOut && `${L('체크아웃', 'Check-out')} ${checkOut.slice(0, 5)} ${L('이전', 'or earlier')}`].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {rules.length ? (
                    <ul className={s.check}>
                      {rules.map((r, i) => (
                        <li key={i}>
                          <Icon name={r.icon} size={18} style={{ color: 'var(--text-muted)' }} /> <span>{r.text}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">{L('호스트가 별도 규칙을 등록하지 않았어요.', 'No additional rules.')}</p>
                  )}
                </Section>
                {!exchangeOnly && policyLines.length > 0 && (
                  <Section title={L('취소 및 환불', 'Cancellation & refunds')}>
                    <ul className={s.check}>
                      {policyLines.map((l, i) => (
                        <li key={i}>
                          <Icon name={i === 0 ? 'check-circle' : 'info'} size={18} style={{ color: i === 0 ? 'var(--success)' : 'var(--text-muted)' }} /> <span>{l}</span>
                        </li>
                      ))}
                    </ul>
                  </Section>
                )}
                {v.lat !== undefined && v.lng !== undefined && (
                  <Section title={L('위치 (대략적)', 'Where you’ll be (approximate)')}>
                    <MapView points={[{ id: v.id, lat: v.lat, lng: v.lng, label: L('대략적 위치', 'Approx. area'), title: v.title }]} center={[v.lng, v.lat]} zoom={12} height={320} />
                    <p className="small muted" style={{ marginTop: 8 }}>{L(`${where} 인근 · 정확한 주소는 예약 확정 후 알려드려요.`, `Near ${where} · The exact address is shared after confirmation.`)}</p>
                  </Section>
                )}
              </div>
              <div className={s.aside}>{exchangeOnly ? <ExchangeCard v={v} /> : <BookingCard v={v} p={p} />}</div>
            </div>
            <div id="reviews">
              <ReviewsSection targetType="PROPERTY" targetId={v.id} rating={v.rating} count={v.reviewCount} emptyHint={exchangeOnly ? L('맞교환을 마친 회원만 후기를 남길 수 있어요.', 'Only members who completed an exchange can review.') : L('후기는 숙박을 마친 게스트만 남길 수 있어요.', 'Only guests who completed a stay can review.')} />
            </div>
            <HostTrust host={v.host} pid={v.id} />
          </article>
        );
      }}
    </StateView>
  );
}
