'use client';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { useAuth } from '@/lib/auth';
import { post } from '@/lib/api';
import { item, items, str, num, f } from '@/lib/shape';
import { propertyView } from '@/lib/domain';
import { addDays, isoDate, nightsBetween, validRange } from '@/lib/format';
import { quoteView, stashQuote, type QuoteView } from '@/lib/quote';
import { StateView } from '@/components/states';
import { ComplianceBadge, FavoriteButton } from '@/components/cards';
import { MonthCalendar, calendarDays } from '@/components/calendar';
import { QuoteBreakdown } from '@/components/quote';
import { Alert, DateText, ErrorText, Section } from '@/components/ui';

function Reviews({ propertyId }: { propertyId: string }) {
  const { L } = useI18n();
  const st = useApi<any>(propertyId ? '/v1/reviews' : null, { query: { targetType: 'PROPERTY', targetId: propertyId, limit: 10 } });
  return (
    <Section title={L('후기', 'Reviews')}>
      {st.loading ? (
        <div className="skeleton" style={{ height: 80 }} />
      ) : st.error || items(st.data).length === 0 ? (
        <p className="muted">{L('아직 후기가 없습니다. 후기는 완료된 숙박에서만 작성할 수 있어요.', 'No reviews yet. Only completed stays can be reviewed.')}</p>
      ) : (
        <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
          {items(st.data).map((r: any, i) => (
            <li key={r.id ?? i} className="card flat">
              <div className="row between">
                <strong>{str(r, 'authorName', 'author.displayName', 'reviewerName') || L('게스트', 'Guest')}</strong>
                <span>★ {num(r, 'rating', 'overallRating') ?? '-'}</span>
              </div>
              <p style={{ margin: '6px 0 0' }}>{str(r, 'body', 'comment', 'text')}</p>
              {str(r, 'response.body', 'hostResponse') && <p className="small muted">↳ {str(r, 'response.body', 'hostResponse')}</p>}
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function HostTrust({ hostId, host }: { hostId: string; host: any }) {
  const { L } = useI18n();
  const st = useApi<any>(hostId && !host ? `/v1/hosts/${hostId}` : null);
  const h = host ?? item(st.data);
  if (!h) return null;
  const verified = f(h, 'verified', 'identityVerified', 'isVerified') || str(h, 'verificationStatus') === 'VERIFIED';
  return (
    <Section title={L('호스트 신뢰 정보', 'Host trust')}>
      <div className="card flat row">
        <div aria-hidden="true" style={{ width: 52, height: 52, borderRadius: '50%', background: 'var(--c-primary-soft)', display: 'grid', placeItems: 'center', fontWeight: 800 }}>
          {str(h, 'displayName', 'name').slice(0, 1) || 'H'}
        </div>
        <div className="grow">
          <strong>{str(h, 'displayName', 'name') || L('호스트', 'Host')}</strong>
          <div className="row" style={{ gap: 6, marginTop: 4 }}>
            {verified && <span className="badge ok">✓ {L('본인/사업자 확인', 'ID verified')}</span>}
            {num(h, 'responseRate') !== undefined && <span className="badge">{L('응답률', 'Response')} {num(h, 'responseRate')}%</span>}
            {num(h, 'rating', 'reputation.score') !== undefined && <span className="badge">★ {num(h, 'rating', 'reputation.score')}</span>}
            {str(h, 'joinedAt', 'createdAt') && (
              <span className="small muted">
                {L('가입', 'Joined')} <DateText value={str(h, 'joinedAt', 'createdAt')} />
              </span>
            )}
          </div>
        </div>
      </div>
    </Section>
  );
}

function QuoteBox({ v }: { v: ReturnType<typeof propertyView> }) {
  const { L, t } = useI18n();
  const { user } = useAuth();
  const sp = useSearchParams();
  const router = useRouter();
  const [checkIn, setIn] = useState(sp.get('checkIn') ?? '');
  const [checkOut, setOut] = useState(sp.get('checkOut') ?? '');
  const [guests, setGuests] = useState(sp.get('guests') ?? '2');
  const [q, setQ] = useState<QuoteView | null>(null);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const today = isoDate(new Date());
  const cal = useApi<any>(v.id ? `/v1/properties/${v.id}/calendar` : null, { query: { from: today, to: addDays(today, 120) } });
  const days = calendarDays(items(cal.data).length ? items(cal.data) : (f<any[]>(item(cal.data), 'days', 'blocks') ?? []));
  const bookable = !v.compliance || ['PASS', 'PASSED', 'COMPLIANT', 'APPROVED', 'ELIGIBLE', 'OK', 'VERIFIED'].includes(v.compliance.toUpperCase());

  const pick = (d: string) => {
    setQ(null);
    if (!checkIn || (checkIn && checkOut) || d <= checkIn) {
      setIn(d);
      setOut('');
    } else setOut(d);
  };

  const getQuote = async () => {
    setErr(null);
    if (!validRange(checkIn, checkOut)) {
      setErr(new Error(L('체크인/체크아웃 날짜를 선택하세요.', 'Select check-in and check-out dates.')));
      return;
    }
    setBusy(true);
    try {
      const res = await post('/v1/booking/quotes', { propertyId: v.id, checkIn, checkOut, guests: Number(guests) || 1 });
      stashQuote(res);
      setQ(quoteView(res));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className="card sticky-cta stack" aria-label={L('예약', 'Booking')}>
      <MonthCalendar days={days} selected={{ start: checkIn, end: checkOut || undefined }} onSelect={pick} legend={false} />
      <div className="form-grid cols-2">
        <label className="field">
          <span>{t('common.checkin')}</span>
          <input type="date" min={today} value={checkIn} onChange={(e) => { setIn(e.target.value); setQ(null); }} />
        </label>
        <label className="field">
          <span>{t('common.checkout')}</span>
          <input type="date" min={checkIn ? addDays(checkIn, 1) : today} value={checkOut} onChange={(e) => { setOut(e.target.value); setQ(null); }} />
        </label>
      </div>
      <label className="field">
        <span>{t('common.guests')}</span>
        <input type="number" min={1} max={v.maxGuests ?? 20} value={guests} onChange={(e) => { setGuests(e.target.value); setQ(null); }} />
      </label>
      {!bookable && <Alert tone="warn">{L('이 숙소는 인허가/준수 요건 확인 전이라 유료 예약이 불가합니다.', 'Paid booking is blocked until compliance passes.')}</Alert>}
      {q ? (
        <>
          <QuoteBreakdown q={q} />
          {user ? (
            <button className="btn primary block" onClick={() => router.push(`/stay/${encodeURIComponent(v.slug)}/checkout?quoteId=${encodeURIComponent(q.id)}&checkIn=${checkIn}&checkOut=${checkOut}&guests=${guests}`)}>
              {L('예약하기', 'Reserve')}
            </button>
          ) : (
            <Link className="btn primary block" href={`/login?next=${encodeURIComponent(`/stay/${v.slug}?checkIn=${checkIn}&checkOut=${checkOut}&guests=${guests}`)}`}>
              {L('로그인하고 예약하기', 'Log in to reserve')}
            </Link>
          )}
        </>
      ) : (
        <button className="btn primary block" onClick={getQuote} disabled={busy || !bookable}>
          {busy ? L('견적 계산 중…', 'Quoting…') : checkIn && checkOut ? `${L('요금 확인', 'Get quote')} · ${nightsBetween(checkIn, checkOut)}${L('박', ' nights')}` : L('날짜 선택 후 요금 확인', 'Pick dates to see price')}
        </button>
      )}
      <ErrorText error={err} />
      <p className="small muted" style={{ margin: 0 }}>
        {L('결제 완료 전에는 예약이 확정되지 않습니다.', 'Not confirmed until payment is approved.')}
      </p>
    </aside>
  );
}

export default function StayDetailView() {
  const { slug } = useParams<{ slug: string }>();
  const { L } = useI18n();
  const st = useApi<any>(slug ? `/v1/properties/by-slug/${encodeURIComponent(slug)}` : null);
  return (
    <StateView state={st}>
      {(d) => {
        const p = item(d);
        const v = propertyView(p);
        const rules = v.houseRules;
        const ruleList: string[] = Array.isArray(rules) ? rules.map((r: any) => (typeof r === 'string' ? r : str(r, 'text', 'label', 'rule'))) : rules && typeof rules === 'object' ? Object.entries(rules).map(([k, val]) => `${k}: ${String(val)}`) : typeof rules === 'string' ? [rules] : [];
        return (
          <article>
            <header className="stack" style={{ marginBottom: 16 }}>
              <div className="row between">
                <h1 style={{ margin: 0 }}>{v.title}</h1>
                <div className="row">
                  <FavoriteButton targetType="PROPERTY" targetId={v.id} />
                  <Link className="btn sm" href={`/stay/${encodeURIComponent(v.slug)}/calendar`}>
                    📅 {L('달력', 'Calendar')}
                  </Link>
                </div>
              </div>
              <div className="row" style={{ gap: 8 }}>
                <span className="muted">{[v.city, v.country].filter(Boolean).join(', ')}</span>
                {v.rating !== undefined && <span>★ {v.rating.toFixed(1)} ({v.reviewCount})</span>}
                <ComplianceBadge status={v.compliance} />
                {v.exchangeEnabled && <span className="badge exchange">{L('홈 맞교환 가능', 'Open to exchange')}</span>}
              </div>
            </header>
            <div className="gallery" aria-label={L('사진', 'Photos')}>
              {(v.media.length ? v.media.slice(0, 3) : ['', '', '']).map((src, i) => (
                <div key={i} className={i === 0 ? 'main' : ''}>
                  {src ? <img src={src} alt={`${v.title} ${i + 1}`} loading={i ? 'lazy' : 'eager'} /> : null}
                </div>
              ))}
            </div>
            <div className="grid-2" style={{ marginTop: 24 }}>
              <div>
                <p className="muted">
                  {[v.propertyType, v.maxGuests && `${L('최대', 'Up to')} ${v.maxGuests}${L('명', ' guests')}`, v.bedrooms !== undefined && `${L('침실', 'Bedrooms')} ${v.bedrooms}`, v.bathrooms !== undefined && `${L('욕실', 'Baths')} ${v.bathrooms}`].filter(Boolean).join(' · ')}
                </p>
                {v.description && <p style={{ whiteSpace: 'pre-line' }}>{v.description}</p>}
                <Section title={L('편의시설', 'Amenities')}>
                  {v.amenities.length ? (
                    <ul className="chip-group" style={{ listStyle: 'none', padding: 0 }}>
                      {v.amenities.map((a) => (
                        <li key={a} className="badge">
                          {a}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">—</p>
                  )}
                </Section>
                <Section title={L('숙소 이용 규칙', 'House rules')}>
                  {ruleList.length ? (
                    <ul>
                      {ruleList.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted">{L('호스트가 별도 규칙을 등록하지 않았습니다.', 'No additional rules.')}</p>
                  )}
                  {v.cancellationPolicy && (
                    <p>
                      <strong>{L('환불 정책', 'Cancellation')}:</strong> {v.cancellationPolicy}
                    </p>
                  )}
                  <p className="small muted">{L('정확한 주소는 예약 확정 후 공개됩니다.', 'Exact address is shared after confirmation.')}</p>
                </Section>
                <HostTrust hostId={v.hostId} host={v.host} />
                <Reviews propertyId={v.id} />
              </div>
              <div>{v.rentalEnabled !== false ? <QuoteBox v={v} /> : <Alert>{L('이 집은 맞교환 전용입니다.', 'Exchange only.')}</Alert>}</div>
            </div>
          </article>
        );
      }}
    </StateView>
  );
}
