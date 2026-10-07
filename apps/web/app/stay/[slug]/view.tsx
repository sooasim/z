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
import { postcardSet } from '@/lib/art';
import { addDays, isoDate, nightsBetween, formatMoney } from '@/lib/format';
import { quoteView, stashQuote, type QuoteView } from '@/lib/quote';
import { errorMessage } from '@/lib/errors';
import { StateView } from '@/components/states';
import { QuoteBreakdown } from '@/components/quote';
import { ComplianceBadge, isCompliant } from '@/components/cards';
import { HeartButton } from '@/components/favorites';
import { calendarDays } from '@/components/calendar';
import { MapView } from '@/components/map';
import { Alert, Avatar, DateRangeField, DateText, GuestsField, Lightbox, RatingStars, Section, Skeleton, type Guests, Icon, Modal } from '@/components/ui';

const AMENITY_ICON: Record<string, string> = { WIFI: '📶', KITCHEN: '🍳', WASHER: '🧺', AIR_CONDITIONING: '❄️', PARKING: '🅿️', WORKSPACE: '💻', PET_FRIENDLY: '🐾', TV: '📺', HEATING: '🔥', ELEVATOR: '🛗', OCEAN_VIEW: '🌊', POOL: '🏊', DRYER: '🌀', BBQ: '🍖' };

function Mosaic({ images, title }: { images: string[]; title: string }) {
  const { L } = useI18n();
  const [open, setOpen] = useState<number | null>(null);
  const shown = images.slice(0, 5);
  return (
    <>
      <div className="mosaic">
        {shown.map((src, i) => (
          <button key={i} className={i === 0 ? 'm0' : 'mx'} onClick={() => setOpen(i)} aria-label={`${L('사진 크게 보기', 'Open photo')} ${i + 1}`}>
            <img src={src} alt={i === 0 ? title : ''} loading={i ? 'lazy' : 'eager'} onError={(e) => { const el = e.currentTarget; if (!el.dataset.fallback) { el.dataset.fallback = '1'; el.src = '/art/postcards/coast.svg'; } }} />
          </button>
        ))}
        {images.length > 1 && (
          <button className="show-all" onClick={() => setOpen(0)}>
            <Icon name="grid" size={16} /> {L(`사진 ${images.length}장 모두 보기`, `Show all ${images.length} photos`)}
          </button>
        )}
      </div>
      {open !== null && <Lightbox images={images} index={open} onClose={() => setOpen(null)} title={title} />}
    </>
  );
}

function Reviews({ propertyId, rating, count }: { propertyId: string; rating?: number; count: number }) {
  const { L } = useI18n();
  const st = useApi<any>(propertyId ? '/v1/reviews' : null, { query: { targetType: 'PROPERTY', targetId: propertyId, limit: 6 } });
  const rows = items(st.data);
  return (
    <Section title={<span className="row" style={{ gap: 10 }}><RatingStars value={rating} count={count} /> <span>{L('후기', 'Reviews')}</span></span>}>
      {st.loading ? (
        <div className="grid-2 even"><Skeleton h={110} /><Skeleton h={110} /></div>
      ) : st.error || rows.length === 0 ? (
        <p className="muted">{L('아직 후기가 없습니다. 후기는 완료된 숙박에서만 작성할 수 있어요.', 'No reviews yet. Only completed stays can be reviewed.')}</p>
      ) : (
        <div className="grid-2 even">
          {rows.map((r: any, i) => {
            const name = str(r, 'authorName', 'author.displayName', 'reviewerName') || L('게스트', 'Guest');
            return (
              <article key={r.id ?? i} className="stack">
                <div className="row nowrap">
                  <Avatar name={name} size={44} />
                  <div>
                    <strong>{name}</strong>
                    <div className="xs muted"><DateText value={str(r, 'createdAt')} /></div>
                  </div>
                  <span className="grow" />
                  <RatingStars value={num(r, 'rating', 'overallRating')} compact />
                </div>
                <p style={{ margin: 0 }}>{str(r, 'body', 'comment', 'text')}</p>
                {str(r, 'response.body', 'hostResponse') && <p className="small muted" style={{ borderLeft: '3px solid var(--border)', paddingLeft: 10 }}>{L('호스트 답변', 'Host response')}: {str(r, 'response.body', 'hostResponse')}</p>}
              </article>
            );
          })}
        </div>
      )}
    </Section>
  );
}

function HostTrust({ hostId, host, pid }: { hostId: string; host: any; pid: string }) {
  const { L } = useI18n();
  const st = useApi<any>(hostId && !host ? `/v1/hosts/${hostId}` : null);
  const h = host ?? item(st.data);
  if (!h) return null;
  const name = str(h, 'displayName', 'name') || L('호스트', 'Host');
  const verified = Boolean(f(h, 'verified', 'identityVerified', 'isVerified')) || str(h, 'verificationStatus') === 'VERIFIED';
  const propertyId = pid;
  return (
    <Section title={L('호스트 소개', 'Meet your host')}>
      <div className="card raised row nowrap" style={{ alignItems: 'flex-start', gap: 20 }}>
        <div className="center" style={{ minWidth: 120 }}>
          <Avatar name={name} size={84} verified={verified} src={str(h, 'avatarUrl') || undefined} />
          <strong style={{ display: 'block', marginTop: 8 }}>{name}</strong>
          {verified && <span className="badge ok">✓ {L('인증 호스트', 'Verified host')}</span>}
        </div>
        <div className="grow stack">
          <div className="row" style={{ gap: 24 }}>
            {num(h, 'reputation.reviewCount', 'reviewCount') !== undefined && <div><strong style={{ fontSize: 'var(--fs-xl)' }}>{num(h, 'reputation.reviewCount', 'reviewCount')}</strong><div className="xs muted">{L('후기', 'Reviews')}</div></div>}
            {num(h, 'reputation.ratingAvg', 'rating') !== undefined && <div><strong style={{ fontSize: 'var(--fs-xl)' }}>★ {Number(num(h, 'reputation.ratingAvg', 'rating')).toFixed(2)}</strong><div className="xs muted">{L('평점', 'Rating')}</div></div>}
            {num(h, 'responseRate') !== undefined && <div><strong style={{ fontSize: 'var(--fs-xl)' }}>{Math.round((num(h, 'responseRate') ?? 0) <= 1 ? (num(h, 'responseRate') ?? 0) * 100 : num(h, 'responseRate') ?? 0)}%</strong><div className="xs muted">{L('응답률', 'Response rate')}</div></div>}
            {str(h, 'memberSince', 'joinedAt', 'createdAt') && <div><strong><DateText value={str(h, 'memberSince', 'joinedAt', 'createdAt')} /></strong><div className="xs muted">{L('가입', 'Joined')}</div></div>}
          </div>
          {str(h, 'about', 'bio') && <p className="small" style={{ margin: 0 }}>{str(h, 'about', 'bio')}</p>}
          {propertyId && <AskHost propertyId={propertyId} />}
          <p className="xs muted" style={{ margin: 0 }}>🛡 {L('안전한 결제를 위해 JETPOOL 밖에서 송금하지 마세요.', 'To stay protected, never pay outside JETPOOL.')}</p>
        </div>
      </div>
    </Section>
  );
}

function AskHost({ propertyId }: { propertyId: string }) {
  const { L } = useI18n();
  const { user } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button className="btn" style={{ justifySelf: 'start' }} onClick={() => (user ? setOpen(true) : router.push(`/login?next=${encodeURIComponent(window.location.pathname)}`))}>
        <Icon name="chat" size={16} /> {L('호스트에게 문의하기', 'Message the host')}
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={L('호스트에게 문의', 'Message the host')}
        footer={
          <>
            <span className="xs muted">{L('연락처 교환·외부 결제 유도는 제한됩니다.', 'Sharing contacts or off-platform payment is restricted.')}</span>
            <button
              className="btn primary"
              disabled={!msg.trim() || busy}
              data-loading={busy ? 'true' : undefined}
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
            </button>
          </>
        }
      >
        <label className="field">
          <span>{L('메시지', 'Message')}</span>
          <textarea value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={4000} placeholder={L('예: 11월 한 달 머물고 싶은데 업무용 책상이 있나요?', 'e.g. Is there a desk for remote work in November?')} autoFocus />
        </label>
        {err ? <Alert tone="error">{String((err as Error).message)}</Alert> : null}
      </Modal>
    </>
  );
}

function BookingCard({ v }: { v: ReturnType<typeof propertyView> }) {
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const sp = useSearchParams();
  const router = useRouter();
  const [range, setRange] = useState({ start: sp.get('checkIn') ?? '', end: sp.get('checkOut') ?? '' });
  const [guests, setGuests] = useState<Guests>({ adults: Math.max(1, Number(sp.get('guests') ?? 2) || 2), children: 0, infants: 0, pets: 0 });
  const [q, setQ] = useState<QuoteView | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const today = isoDate(new Date());
  const cal = useApi<any>(v.id ? `/v1/properties/${v.id}/calendar` : null, { query: { from: today, to: addDays(today, 365) } });
  const days = calendarDays(items(cal.data).length ? items(cal.data) : (f<any[]>(item(cal.data), 'days', 'blocks') ?? []));
  const bookable = !v.compliance || isCompliant(v.compliance);
  const nights = nightsBetween(range.start, range.end);
  const total = guests.adults + guests.children;
  const reqId = useRef(0);

  // Live quote: re-price whenever dates/guests change (debounced). The quote is authoritative server-side.
  useEffect(() => {
    setQ(null);
    setErr(null);
    if (!v.id || !bookable || nights <= 0) return;
    const id = ++reqId.current;
    setBusy(true);
    const t = setTimeout(async () => {
      try {
        const res = await post('/v1/booking/quotes', { propertyId: v.id, checkIn: range.start, checkOut: range.end, guests: total, pets: guests.pets || undefined });
        if (id !== reqId.current) return;
        stashQuote(res);
        setQ(quoteView(res));
      } catch (e) {
        if (id === reqId.current) setErr(e);
      } finally {
        if (id === reqId.current) setBusy(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [v.id, range.start, range.end, total, guests.pets, bookable, nights]);

  const reserve = () => {
    if (!q) return;
    const qs = `quoteId=${encodeURIComponent(q.id)}&checkIn=${range.start}&checkOut=${range.end}&guests=${total}`;
    if (!user) router.push(`/login?next=${encodeURIComponent(`/stay/${v.slug}/checkout?${qs}`)}`);
    else router.push(`/stay/${encodeURIComponent(v.slug)}/checkout?${qs}`);
  };

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
        <RatingStars value={v.rating} count={v.reviewCount} compact />
      </div>
      <div className="date-box">
        <div style={{ gridColumn: '1 / -1' }}>
          <DateRangeField start={range.start} end={range.end} onChange={setRange} isBlocked={(d) => ['paid', 'exchange', 'block', 'hold', 'unavail'].includes(days[d]?.kind ?? '')} />
        </div>
        <div className="full">
          <GuestsField value={guests} onChange={setGuests} max={v.maxGuests ?? 16} />
        </div>
      </div>
      {!bookable && <Alert tone="warn">{L('인허가/준수 요건 확인 전이라 유료 예약이 불가합니다.', 'Paid booking is blocked until compliance passes.')}</Alert>}
      <button className="btn accent lg block" onClick={reserve} disabled={!q || busy || !bookable} data-loading={busy ? 'true' : undefined}>
        {nights <= 0 ? L('날짜를 선택하세요', 'Select dates') : q ? L('예약하기', 'Reserve') : L('요금 확인 중', 'Checking price')}
      </button>
      {q && <p className="xs muted center" style={{ margin: 0 }}>{L('아직 결제되지 않습니다', "You won't be charged yet")}</p>}
      {busy && !q && (
        <div className="stack" aria-hidden="true"><Skeleton w="100%" /><Skeleton w="80%" /><Skeleton w="90%" /></div>
      )}
      {q && <QuoteBreakdown q={q} />}
      {err ? <Alert tone="error">{errorMessage(err, lang)}</Alert> : null}
      <p className="xs muted" style={{ margin: 0 }}>🛡 {L('결제 승인 후에만 예약이 확정되며, 날짜는 결제 전 서버에서 다시 확인됩니다.', 'Confirmed only after payment approval; dates are re-checked before payment.')}</p>
    </aside>
  );
}

export default function StayDetailView() {
  const { slug } = useParams<{ slug: string }>();
  const { L, lang } = useI18n();
  const st = useApi<any>(slug ? `/v1/properties/by-slug/${encodeURIComponent(slug)}` : null);
  const [descOpen, setDescOpen] = useState(false);
  return (
    <StateView state={st} skeleton="detail">
      {(d) => {
        const p = item(d);
        const v = propertyView(p);
        const images = v.media.length ? v.media : postcardSet(v.city || v.title, v.id || v.slug, 5);
        const rules = v.houseRules;
        const ruleList: string[] = Array.isArray(rules)
          ? rules.map((r: any) => (typeof r === 'string' ? r : str(r, 'text', 'label', 'rule')))
          : rules && typeof rules === 'object'
            ? [
                f(rules, 'smokingAllowed') !== undefined ? (f(rules, 'smokingAllowed') ? L('흡연 가능', 'Smoking allowed') : L('실내 금연', 'No smoking')) : '',
                f(rules, 'petsAllowed') !== undefined ? (f(rules, 'petsAllowed') ? L('반려동물 동반 가능', 'Pets allowed') : L('반려동물 불가', 'No pets')) : '',
                f(rules, 'eventsAllowed') !== undefined ? (f(rules, 'eventsAllowed') ? L('파티·행사 가능', 'Events allowed') : L('파티·행사 불가', 'No parties or events')) : '',
                str(rules, 'quietHours') ? `${L('정숙 시간', 'Quiet hours')}: ${str(rules, 'quietHours')}` : '',
                str(rules, 'extraRules'),
              ].filter(Boolean)
            : typeof rules === 'string'
              ? [rules]
              : [];
        const checkTimes = [str(p, 'checkInTime') && `${L('체크인', 'Check-in')} ${str(p, 'checkInTime')}`, str(p, 'checkOutTime') && `${L('체크아웃', 'Check-out')} ${str(p, 'checkOutTime')}`].filter(Boolean).join(' · ');
        return (
          <article>
            <header className="stack" style={{ marginBottom: 'var(--sp-5)' }}>
              <h1 style={{ margin: 0 }}>{v.title}</h1>
              <div className="row between">
                <div className="row" style={{ gap: 10 }}>
                  <RatingStars value={v.rating} count={v.reviewCount} compact />
                  <span className="muted small"><Icon name="pin" size={14} style={{ display: 'inline', verticalAlign: '-2px' }} /> {[v.city, v.country].filter(Boolean).join(', ')}</span>
                  <ComplianceBadge status={v.compliance} />
                  {v.exchangeEnabled && <span className="badge exchange">⇄ {L('홈 맞교환 가능', 'Open to exchange')}</span>}
                </div>
                <div className="row" style={{ gap: 6 }}>
                  <button className="btn ghost sm" onClick={() => navigator.share?.({ title: v.title, url: window.location.href }).catch(() => {}) ?? navigator.clipboard?.writeText(window.location.href)}>
                    ↗ {L('공유', 'Share')}
                  </button>
                  {v.id && <span style={{ display: 'inline-grid', background: 'var(--surface-3)', borderRadius: 999 }}><HeartButton targetType="PROPERTY" targetId={v.id} /></span>}
                </div>
              </div>
            </header>
            <Mosaic images={images} title={v.title} />
            <div className="grid-2" style={{ marginTop: 'var(--sp-8)' }}>
              <div>
                <div className="row between" style={{ paddingBottom: 'var(--sp-5)', borderBottom: '1px solid var(--border)' }}>
                  <div>
                    <h2 style={{ margin: 0 }}>{v.propertyType ? `${v.propertyType} · ` : ''}{v.city}</h2>
                    <p className="muted" style={{ margin: '4px 0 0' }}>
                      {[v.maxGuests && `${L('최대 인원', 'Guests')} ${v.maxGuests}`, v.bedrooms !== undefined && `${L('침실', 'Bedrooms')} ${v.bedrooms}`, v.bathrooms !== undefined && `${L('욕실', 'Baths')} ${v.bathrooms}`].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                  <Link href={`/stay/${encodeURIComponent(v.slug)}/calendar`} className="btn sm"><Icon name="calendar" size={16} /> {L('전체 일정', 'Full calendar')}</Link>
                </div>
                <div className="trust-row" style={{ padding: 'var(--sp-6) 0', borderBottom: '1px solid var(--border)' }}>
                  {isCompliant(v.compliance) && <div className="trust-item"><span className="ico">🛡</span><div><strong>{L('인허가 확인 숙소', 'Permit verified')}</strong><p className="small muted" style={{ margin: 0 }}>{L('필수 신고·안전 요건을 JETPOOL이 확인했어요.', 'Required permits checked by JETPOOL.')}</p></div></div>}
                  {v.cancellationPolicy && <div className="trust-item"><span className="ico">📅</span><div><strong>{L('환불 정책', 'Cancellation')}: {v.cancellationPolicy}</strong><p className="small muted" style={{ margin: 0 }}>{L('예약 관리에서 환불 예상액을 미리 볼 수 있어요.', 'Preview your refund before cancelling.')}</p></div></div>}
                  <div className="trust-item"><span className="ico">🔑</span><div><strong>{L('주소는 확정 후 공개', 'Address after confirmation')}</strong><p className="small muted" style={{ margin: 0 }}>{L('호스트와 게스트 모두의 안전을 위해서예요.', 'For everyone’s safety.')}</p></div></div>
                </div>
                {v.description && (
                  <Section>
                    <p style={{ whiteSpace: 'pre-line', margin: 0, display: descOpen ? 'block' : '-webkit-box', WebkitLineClamp: descOpen ? 'unset' : 6, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{v.description}</p>
                    {v.description.length > 300 && <button className="btn link" onClick={() => setDescOpen(!descOpen)}>{descOpen ? L('접기', 'Show less') : L('더 보기', 'Show more')}</button>}
                  </Section>
                )}
                <Section title={L('숙소 편의시설', 'What this place offers')}>
                  {v.amenityItems.length ? (
                    <ul className="amenity-list">
                      {v.amenityItems.map((a) => (
                        <li key={a.code}><span aria-hidden="true" style={{ fontSize: 22 }}>{AMENITY_ICON[a.code.toUpperCase()] ?? '✔︎'}</span> {(lang === 'ko' ? a.ko : a.en).replace(/_/g, ' ')}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">—</p>
                  )}
                </Section>
                <Section title={L('숙소 이용 규칙', 'House rules')}>
                  {checkTimes && <p style={{ fontWeight: 600 }}>🕒 {checkTimes}</p>}
                  {ruleList.length ? (
                    <ul className="stack" style={{ paddingLeft: 18 }}>
                      {ruleList.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>
                  ) : (
                    <p className="muted">{L('호스트가 별도 규칙을 등록하지 않았습니다.', 'No additional rules.')}</p>
                  )}
                </Section>
                {v.lat !== undefined && v.lng !== undefined && (
                  <Section title={L('위치 (대략적)', 'Where you’ll be (approximate)')}>
                    <MapView points={[{ id: v.id, lat: v.lat, lng: v.lng, label: v.city || '📍' }]} height={320} />
                  </Section>
                )}
              </div>
              <div>{v.rentalEnabled !== false ? <BookingCard v={v} /> : <Alert>{L('이 집은 맞교환 전용입니다.', 'Exchange only.')} <Link href={`/exchange?home=${v.id}`}>{L('맞교환 제안', 'Propose exchange')}</Link></Alert>}</div>
            </div>
            <Reviews propertyId={v.id} rating={v.rating} count={v.reviewCount} />
            <HostTrust hostId={v.hostId} host={v.host} pid={v.id} />
          </article>
        );
      }}
    </StateView>
  );
}

