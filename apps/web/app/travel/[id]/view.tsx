'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useRef, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, f, item, items, str, num } from '@/lib/shape';
import { productView } from '@/lib/domain';
import { postcardSet } from '@/lib/art';
import { formatMoney, formatTimeRange } from '@/lib/format';
import { placeLabel } from '@/lib/places';
import { ApiError } from '@/lib/errors';
import { StateView, NotFoundState } from '@/components/states';
import { HeartButton } from '@/components/favorites';
import { realImages } from '@/components/cards';
import { Alert, Badge, Button, ButtonLink, ErrorText, Icon, Kv, Lightbox, MobileActionBar, PriceBreakdown, Qty, Section, Skeleton } from '@/components/ui';
import { Breadcrumbs } from '@/components/public/Breadcrumbs';
import { productKindLabel, refundLines } from '@/components/public/labels';
import s from '@/components/public/public.module.css';

export default function TravelDetailView() {
  const { id } = useParams<{ id: string }>();
  const { L, lang } = useI18n();
  const { user } = useAuth();
  const router = useRouter();
  const st = useApi<any>(`/v1/travel-products/${id}`);
  const deps = useApi<any>(`/v1/travel-products/${id}/departures`, { query: { limit: 30 } });
  const [dep, setDep] = useState('');
  const [qty, setQty] = useState(2);
  const [err, setErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [lb, setLb] = useState<number | null>(null);
  const [allDeps, setAllDeps] = useState(false);
  const cardRef = useRef<HTMLElement>(null);
  if (st.error instanceof ApiError && (st.error.kind === 'not_found' || st.error.kind === 'validation'))
    return <NotFoundState as="h1" title={L('여행 상품을 찾을 수 없어요', 'We can’t find that trip')} body={L('판매가 끝났거나 공급사가 상품을 내렸을 수 있어요.', 'It may have sold out or been withdrawn by the supplier.')} back={{ href: '/travel', label: L('다른 투어·티켓 보기', 'See other tours') }} />;
  return (
    <StateView state={st} skeleton="detail" back={{ href: '/travel', label: L('여행 상품 목록', 'All tours') }}>
      {(d) => {
        const p = item(d);
        const v = productView(p);
        const images = realImages([...arr<any>(p, 'media', 'images').map((m) => (typeof m === 'string' ? m : str(m, 'url'))), v.cover]);
        const gallery = images.length ? images : postcardSet(v.city || v.title, v.id, 3);
        const departures = items(deps.data);
        const sel = departures.find((x: any) => str(x, 'id') === dep);
        const unit = num(sel, 'priceMinor', 'unitPriceMinor') ?? v.priceMinor ?? 0;
        const remaining = num(sel, 'remaining', 'seatsRemaining', 'availableSeats', 'capacityRemaining');
        const city = placeLabel(v.city, lang);
        const kind = productKindLabel(v.kind, lang);
        const terms = f<any>(p, 'cancellationTerms');
        const refund = refundLines(terms, lang);
        const note = typeof terms === 'string' ? terms : str(terms, 'note');
        const mor = (v.merchantOfRecord || '').toUpperCase();
        const platformMoR = mor === 'PLATFORM' || mor === 'JETPOOL';
        const options = arr<any>(p, 'options').filter((o) => o.active !== false).map((o) => str(o, 'name')).filter(Boolean);
        const duration = v.durationDays ? L(`${v.durationDays}일`, `${v.durationDays} days`) : v.durationMinutes ? L(`${Math.round((v.durationMinutes / 60) * 10) / 10}시간`, `${Math.round((v.durationMinutes / 60) * 10) / 10} h`) : '';
        const facts: Array<[string, React.ReactNode]> = [];
        if (duration) facts.push([L('소요 시간', 'Duration'), duration]);
        if (v.supplier && !platformMoR) facts.push([L('판매자 · 계약 당사자', 'Seller & contracting party'), v.supplier]);
        if (v.supplier && platformMoR) {
          facts.push([L('여행 공급사', 'Supplier'), v.supplier]);
          facts.push([L('결제 · 고객 지원', 'Payment & support'), 'JETPOOL']);
        }
        if (num(p, 'maxGroupSize', 'capacity') !== undefined) facts.push([L('최대 인원', 'Group size'), L(`${num(p, 'maxGroupSize', 'capacity')}명`, `${num(p, 'maxGroupSize', 'capacity')} people`)]);
        if (options.length) facts.push([L('선택 옵션', 'Options'), options.join(', ')]);
        const startAt = (x: any) => str(x, 'startsAt', 'departureDate', 'date');
        const book = async () => {
          if (!dep) {
            cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            return;
          }
          if (!user) return router.push(`/login?next=${encodeURIComponent(`/travel/${id}`)}`);
          setBusy(true);
          setErr(null);
          try {
            const res = await post('/v1/orders', { items: [{ departureId: dep, qty }] }, { idempotencyKey: `order-${dep}-${qty}-${user.id}-${Math.floor(Date.now() / 60000)}` });
            router.push(`/checkout?type=ORDER&id=${str(item(res), 'id', 'orderId')}`);
          } catch (e) {
            setErr(e);
          } finally {
            setBusy(false);
          }
        };
        const ctaLabel = !dep ? L('출발일을 선택하세요', 'Choose a departure') : user ? L('예약하기', 'Book now') : L('로그인하고 예약하기', 'Log in to book');
        return (
          <article>
            <Breadcrumbs items={[{ href: '/travel', label: L('투어·티켓', 'Tours & tickets') }, ...(city ? [{ href: `/travel?q=${encodeURIComponent(v.city)}`, label: city }] : []), { label: v.title }]} />
            <div className={s.titleRow}>
              <div style={{ minWidth: 0 }}>
                <Badge tone="info">{kind}</Badge>
                <h1 style={{ margin: '8px 0 4px' }}>{v.title}</h1>
                <p className="muted" style={{ margin: 0 }}>
                  {[city, duration, v.supplier && L(`${v.supplier} 제공`, `by ${v.supplier}`)].filter(Boolean).join(' · ')}
                </p>
              </div>
              {v.id && (
                <span style={{ display: 'inline-grid', background: 'var(--surface-3)', borderRadius: 999, flex: '0 0 auto' }}>
                  <HeartButton targetType="TRAVEL_PRODUCT" targetId={v.id} />
                </span>
              )}
            </div>
            <div className="mosaic" style={{ marginTop: 20 }}>
              {gallery.slice(0, 3).map((src, i) => (
                <button key={i} className={i === 0 ? 'm0' : 'mx'} onClick={() => setLb(i)} aria-label={`${L('사진 크게 보기', 'Open photo')} ${i + 1}`}>
                  <img src={src} alt={i === 0 ? v.title : ''} />
                </button>
              ))}
            </div>
            {lb !== null && <Lightbox images={gallery} index={lb} onClose={() => setLb(null)} title={v.title} />}
            <div className="grid-2" style={{ marginTop: 32 }}>
              <div>
                {v.description && <p style={{ whiteSpace: 'pre-line', fontSize: 'var(--fs-lg)', lineHeight: 1.7 }}>{v.description}</p>}
                {facts.length > 0 && (
                  <Section title={L('상품 정보', 'Details')}>
                    <Kv rows={facts} />
                  </Section>
                )}
                <Section title={L('취소 · 환불 규정', 'Cancellation terms')}>
                  {refund.length > 0 ? (
                    <ul className={s.check}>
                      {refund.map((l, i) => (
                        <li key={i}>
                          <Icon name={i === 0 ? 'check-circle' : 'info'} size={18} style={{ color: i === 0 ? 'var(--success)' : 'var(--text-muted)' }} /> <span>{l}</span>
                        </li>
                      ))}
                    </ul>
                  ) : note ? (
                    <p>{note}</p>
                  ) : (
                    <Alert tone="warn">{L('공급사가 아직 환불 규정을 등록하지 않았어요. 결제 전에 고객센터로 문의해 주세요.', 'The supplier has not published refund terms yet. Please contact support before paying.')}</Alert>
                  )}
                  {refund.length > 0 && note && lang === 'ko' && <p className="small muted" style={{ marginTop: 10 }}>{note}</p>}
                </Section>
                <Section title={L('여행 일정', 'Itinerary')}>
                  <ButtonLink href={`/travel/${id}/itinerary`} icon="calendar">
                    {L('일정표 보기 · 내 여행 플래너에 담기', 'View itinerary · add to planner')}
                  </ButtonLink>
                </Section>
              </div>
              <aside ref={cardRef} className={`card booking-card sticky-cta stack ${s.aside}`} aria-label={L('예약', 'Booking')}>
                <div className="price-head">
                  <strong className="tnum">{formatMoney(unit, v.currency, lang)}</strong>
                  <span className="muted">/ {L('1인', 'person')}</span>
                </div>
                <fieldset style={{ border: 0, padding: 0 }}>
                  <legend className="small" style={{ padding: 0, marginBottom: 8 }}>{L('출발일 선택', 'Choose a departure')}</legend>
                  {deps.loading ? (
                    <div className="stack">
                      <Skeleton h={56} />
                      <Skeleton h={56} />
                    </div>
                  ) : departures.length === 0 ? (
                    <p className="muted small">{L('예정된 출발일이 없어요. 새 일정이 열리면 알려드릴게요.', 'No upcoming departures yet.')}</p>
                  ) : (
                    <div className="stack" role="radiogroup" aria-label={L('출발일', 'Departures')}>
                      {departures.slice(0, allDeps ? departures.length : 4).map((x: any) => {
                        const did = str(x, 'id');
                        const left = num(x, 'remaining', 'seatsRemaining', 'availableSeats', 'capacityRemaining');
                        const soldOut = (left !== undefined && left <= 0) || ['CLOSED', 'SOLD_OUT', 'CANCELLED'].includes(str(x, 'status').toUpperCase());
                        return (
                          <label key={did} className={s.dep} data-on={dep === did ? 'true' : undefined} data-disabled={soldOut ? 'true' : undefined}>
                            <input type="radio" name="dep" value={did} checked={dep === did} disabled={soldOut} onChange={() => setDep(did)} />
                            <span className={s.when}>
                              <strong>{formatTimeRange(startAt(x), str(x, 'endsAt') || null, lang)}</strong>
                              <span className="row" style={{ gap: 6 }}>
                                {f(x, 'guaranteed') ? <span className="badge ok">{L('출발 확정', 'Guaranteed')}</span> : num(x, 'minParticipants') ? <span className="badge">{L(`${num(x, 'minParticipants')}명 이상 출발`, `Min. ${num(x, 'minParticipants')}`)}</span> : null}
                                {left !== undefined && <span className={`badge ${soldOut ? 'danger' : left < 5 ? 'warn' : ''}`}>{soldOut ? L('마감', 'Sold out') : L(`잔여 ${left}석`, `${left} left`)}</span>}
                              </span>
                            </span>
                            <span className={s.price}>{formatMoney(num(x, 'priceMinor', 'unitPriceMinor') ?? v.priceMinor, v.currency, lang)}</span>
                          </label>
                        );
                      })}
                      {departures.length > 4 && (
                        <button type="button" className="btn link sm" onClick={() => setAllDeps(!allDeps)} aria-expanded={allDeps}>
                          {allDeps ? L('접기', 'Show fewer') : L(`출발일 ${departures.length - 4}개 더 보기`, `${departures.length - 4} more dates`)}
                        </button>
                      )}
                    </div>
                  )}
                </fieldset>
                <div className="guest-row">
                  <strong>{L('인원', 'Travellers')}</strong>
                  <Qty label={L('인원', 'Travellers')} value={qty} min={1} max={remaining ?? 20} onChange={setQty} />
                </div>
                {sel && <PriceBreakdown currency={v.currency} totalMinor={unit * qty} lines={[{ label: L(`${formatMoney(unit, v.currency, lang)} × ${qty}명`, `${formatMoney(unit, v.currency, lang)} × ${qty}`), amountMinor: unit * qty }]} />}
                <Button variant="accent" size="lg" block onClick={book} loading={busy}>
                  {ctaLabel}
                </Button>
                <ErrorText error={err} />
                <p className="xs muted row" style={{ margin: 0, gap: 6, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                  <Icon name="shield" size={14} style={{ flex: '0 0 auto', marginTop: 2 }} /> {L('결제 시 잔여석을 다시 확인하며, 결제 승인 후 주문이 확정돼요.', 'Seats are re-checked at payment; the order is confirmed after approval.')}
                </p>
              </aside>
            </div>
            <MobileActionBar label={L('예약', 'Booking')}>
              <div className={s.mobileBarPrice}>
                <strong>{formatMoney(sel ? unit * qty : unit, v.currency, lang)}</strong>
                <span>{sel ? L(`${qty}명 · ${formatTimeRange(startAt(sel), null, lang)}`, `${qty} · ${formatTimeRange(startAt(sel), null, lang)}`) : L('1인 기준 · 출발일을 골라 주세요', 'per person · choose a date')}</span>
              </div>
              <Button variant="accent" onClick={book} loading={busy}>
                {!dep ? L('출발일 선택', 'Choose date') : user ? L('예약하기', 'Book') : L('로그인하고 예약', 'Log in to book')}
              </Button>
            </MobileActionBar>
            <p className="small muted" style={{ marginTop: 'var(--sp-8)' }}>
              <Link href="/travel">{L('← 다른 투어·티켓 보기', '← See other tours')}</Link>
            </p>
          </article>
        );
      }}
    </StateView>
  );
}
