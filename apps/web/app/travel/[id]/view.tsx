'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useAuth } from '@/lib/auth';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, f, item, items, str, num } from '@/lib/shape';
import { productView } from '@/lib/domain';
import { postcardSet } from '@/lib/art';
import { formatMoney } from '@/lib/format';
import { StateView } from '@/components/states';
import { HeartButton } from '@/components/favorites';
import { Alert, DateText, ErrorText, Kv, PriceBreakdown, Qty, Section, Lightbox, Icon } from '@/components/ui';

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
  return (
    <StateView state={st} skeleton="detail">
      {(d) => {
        const p = item(d);
        const v = productView(p);
        const images = arr<any>(p, 'media', 'images').map((m) => (typeof m === 'string' ? m : str(m, 'url'))).filter(Boolean);
        const gallery = images.length ? images : v.cover ? [v.cover] : postcardSet(v.city || v.title, v.id, 3);
        const departures = items(deps.data);
        const sel = departures.find((x: any) => str(x, 'id') === dep);
        const unit = num(sel, 'priceMinor', 'unitPriceMinor') ?? v.priceMinor ?? 0;
        const remaining = num(sel, 'remaining', 'seatsRemaining', 'availableSeats', 'capacityRemaining');
        return (
          <article>
            <div className="row between">
              <div>
                <span className="badge info">{v.kind}</span>
                <h1 style={{ margin: '8px 0 4px' }}>{v.title}</h1>
                <p className="muted" style={{ margin: 0 }}>{v.city} {v.supplier && <>· {L('공급사', 'Supplier')}: <strong>{v.supplier}</strong></>}</p>
              </div>
              {v.id && <span style={{ display: 'inline-grid', background: 'var(--surface-3)', borderRadius: 999 }}><HeartButton targetType="TRAVEL_PRODUCT" targetId={v.id} /></span>}
            </div>
            <div className="mosaic" style={{ marginTop: 20 }}>
              {gallery.slice(0, 3).map((src, i) => (
                <button key={i} className={i === 0 ? 'm0' : 'mx'} onClick={() => setLb(i)} aria-label={`${L('사진', 'Photo')} ${i + 1}`}><img src={src} alt={i === 0 ? v.title : ''} /></button>
              ))}
            </div>
            {lb !== null && <Lightbox images={gallery} index={lb} onClose={() => setLb(null)} title={v.title} />}
            <div className="grid-2" style={{ marginTop: 32 }}>
              <div>
                {v.description && <p style={{ whiteSpace: 'pre-line' }}>{v.description}</p>}
                <Section title={L('포함 사항 · 안내', 'What’s included')}>
                  <Kv rows={[[L('소요 시간', 'Duration'), v.durationDays ? `${v.durationDays}${L('일', ' days')}` : v.durationMinutes ? `${Math.round(v.durationMinutes / 60 * 10) / 10}${L('시간', ' h')}` : '—'], [L('판매자', 'Seller'), v.supplier || '—'], [L('계약 당사자', 'Merchant of record'), v.merchantOfRecord === 'PLATFORM' ? 'JETPOOL' : v.supplier || '—'], [L('옵션', 'Options'), arr<any>(p, 'options').filter((o) => o.active !== false).map((o) => str(o, 'name')).join(', ') || '—']]} />
                </Section>
                <Section title={L('취소 · 환불 규정', 'Cancellation terms')}>
                  {v.cancellationTiers.length > 0 && (
                    <ul className="stack small" style={{ paddingLeft: 18 }}>
                      {v.cancellationTiers.map((t: any, i: number) => <li key={i}>{L(`출발 ${Math.round((num(t, 'minHoursBefore') ?? 0) / 24)}일 전까지: ${num(t, 'refundPct')}% 환불`, `Up to ${Math.round((num(t, 'minHoursBefore') ?? 0) / 24)} days before: ${num(t, 'refundPct')}% refund`)}</li>)}
                    </ul>
                  )}
                  <p>{v.cancellation || (v.cancellationTiers.length ? '' : L('공급사 규정에 따릅니다. 결제 전 상세 약관을 확인하세요.', 'Per supplier policy; review before paying.'))}</p>
                </Section>
                <Section title={L('여행 일정', 'Itinerary')}>
                  <Link className="btn" href={`/travel/${id}/itinerary`}><Icon name="calendar" size={16} /> {L('일정표 보기 · 내 일정에 담기', 'View itinerary · add to planner')}</Link>
                </Section>
              </div>
              <aside className="card booking-card sticky-cta stack">
                <div className="price-head">
                  <strong className="tnum">{formatMoney(unit, v.currency, lang)}</strong>
                  <span className="muted">/ {L('1인', 'person')}</span>
                </div>
                <fieldset>
                  <legend>{L('출발일 선택', 'Choose a departure')}</legend>
                  {deps.loading ? <p className="muted small">{L('불러오는 중…', 'Loading…')}</p> : departures.length === 0 ? <p className="muted small">{L('예정된 출발일이 없습니다.', 'No upcoming departures.')}</p> : (
                    <div className="stack" role="radiogroup">
                      {departures.map((x: any) => {
                        const left = num(x, 'remaining', 'seatsRemaining', 'availableSeats', 'capacityRemaining');
                        const soldOut = left !== undefined && left <= 0;
                        return (
                          <label key={str(x, 'id')} className="check card flat" style={{ padding: 12, alignItems: 'center', opacity: soldOut ? 0.5 : 1, borderColor: dep === str(x, 'id') ? 'var(--brand)' : undefined }}>
                            <input type="radio" name="dep" value={str(x, 'id')} checked={dep === str(x, 'id')} disabled={soldOut} onChange={() => setDep(str(x, 'id'))} />
                            <span className="grow"><strong><DateText value={str(x, 'startsAt', 'departureDate', 'date')} time /></strong> {f(x, 'guaranteed') ? <span className="badge ok">{L('출발 확정', 'Guaranteed')}</span> : null}{left !== undefined && <span className={`badge ${left < 5 ? 'warn' : ''}`} style={{ marginLeft: 8 }}>{soldOut ? L('마감', 'Sold out') : `${L('잔여', 'Left')} ${left}`}</span>}</span>
                            <span className="small tnum">{formatMoney(num(x, 'priceMinor', 'unitPriceMinor') ?? v.priceMinor, v.currency, lang)}</span>
                          </label>
                        );
                      })}
                    </div>
                  )}
                </fieldset>
                <div className="guest-row"><strong>{L('인원', 'Travellers')}</strong><Qty label={L('인원', 'Travellers')} value={qty} min={1} max={remaining ?? 20} onChange={setQty} /></div>
                {sel && <PriceBreakdown currency={v.currency} totalMinor={unit * qty} lines={[{ label: `${formatMoney(unit, v.currency, lang)} × ${qty}`, amountMinor: unit * qty }]} />}
                <button
                  className="btn accent lg block"
                  disabled={!dep || busy}
                  data-loading={busy ? 'true' : undefined}
                  onClick={async () => {
                    if (!user) return router.push(`/login?next=/travel/${id}`);
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
                  }}
                >
                  {L('예약하기', 'Book now')}
                </button>
                <ErrorText error={err} />
                <Alert tone="info">{L('결제 시 잔여석을 다시 확인하며, 결제 승인 후 주문이 확정됩니다.', 'Seats are re-checked at payment; the order is confirmed after approval.')}</Alert>
              </aside>
            </div>
          </article>
        );
      }}
    </StateView>
  );
}
