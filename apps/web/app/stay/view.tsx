'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { items } from '@/lib/shape';
import { propertyView } from '@/lib/domain';
import { placeLabel } from '@/lib/places';
import { formatMoney, nightsBetween, toMinor, formatRange } from '@/lib/format';
import { StaySearchBar } from '@/components/search/StaySearchBar';
import { PropertyCard } from '@/components/cards';
import { MapView, type Bounds } from '@/components/map';
import { StateView, EmptyState } from '@/components/states';
import { ChipGroup, Modal, Icon, Button, amenityIcon } from '@/components/ui';
import { PROPERTY_TYPES } from '@/components/public/labels';
import s from '@/components/public/public.module.css';
import { pickText } from '@/lib/phrases';

const AMENITIES = [
  { value: 'WIFI', ko: '와이파이', en: 'Wi-Fi' },
  { value: 'KITCHEN', ko: '주방', en: 'Kitchen' },
  { value: 'WASHER', ko: '세탁기', en: 'Washer' },
  { value: 'AIR_CONDITIONING', ko: '에어컨', en: 'A/C' },
  { value: 'PARKING', ko: '무료 주차', en: 'Parking' },
  { value: 'WORKSPACE', ko: '업무 공간', en: 'Workspace' },
  { value: 'PET_FRIENDLY', ko: '반려동물', en: 'Pets' },
];

export default function StaySearchView({ mapOnly = false }: { mapOnly?: boolean }) {
  const { L, lang } = useI18n();
  const sp = useSearchParams();
  const router = useRouter();
  const [showMap, setShowMap] = useState(mapOnly || sp.get('view') === 'map');
  const [amen, setAmen] = useState<string[]>(sp.getAll('amenities'));
  const [types, setTypes] = useState<string[]>(sp.getAll('type'));
  const [minP, setMinP] = useState(sp.get('priceMin') ?? '');
  const [maxP, setMaxP] = useState(sp.get('priceMax') ?? '');
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [bbox, setBbox] = useState<string>(sp.get('bbox') ?? '');
  const [sort, setSort] = useState(sp.get('sort') ?? 'recommended');
  const [compliantOnly, setCompliantOnly] = useState(sp.get('compliant') === '1');
  const [exchangeOnly, setExchangeOnly] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const q = sp.get('q') ?? '';
  const checkIn = sp.get('checkIn') ?? '';
  const checkOut = sp.get('checkOut') ?? '';
  const guests = sp.get('guests') ?? '';
  const nights = nightsBetween(checkIn, checkOut);
  const activeFilters = amen.length + types.length + (minP ? 1 : 0) + (maxP ? 1 : 0) + (exchangeOnly ? 1 : 0);

  const query = useMemo(
    () => ({
      q: q || undefined,
      checkIn: checkIn || undefined,
      checkOut: checkOut || undefined,
      guests: guests || undefined,
      amenities: amen.join(',') || undefined,
      propertyType: types.join(',') || undefined,
      priceMin: minP ? String(toMinor(minP)) : undefined,
      priceMax: maxP ? String(toMinor(maxP)) : undefined,
      bbox: bbox || undefined,
      sort: sort === 'recommended' ? 'relevance' : sort,
      mode: exchangeOnly ? 'exchange' : compliantOnly ? 'rental' : undefined,
      page: String(page),
      limit: 24,
    }),
    [q, checkIn, checkOut, guests, amen, types, minP, maxP, bbox, sort, compliantOnly, exchangeOnly, page],
  );
  const st = useApi<any>('/v1/search/properties', { query });
  const rows = items(st.data).filter((r: any) => !compliantOnly || propertyView(r).paidBookingEnabled || propertyView(r).compliance === 'ALLOW');
  const total = Number((st.data as any)?.total ?? rows.length);
  const passQs = new URLSearchParams(Object.entries({ checkIn, checkOut, guests }).filter(([, v]) => v) as [string, string][]).toString();
  const points = rows
    .map((r) => propertyView(r))
    .filter((v) => v.lat !== undefined && v.lng !== undefined)
    .map((v) => ({ id: v.id, lat: v.lat!, lng: v.lng!, label: v.priceMinor !== undefined ? formatMoney(v.priceMinor, v.currency, lang) : v.title.slice(0, 10), href: `/stay/${encodeURIComponent(v.slug)}${passQs ? '?' + passQs : ''}` }));

  const toggleMap = (on: boolean) => {
    setShowMap(on);
    if (mapOnly) return;
    const p = new URLSearchParams(sp.toString());
    if (on) p.set('view', 'map');
    else p.delete('view');
    router.replace(`/stay?${p}`, { scroll: false });
  };

  /** Reset everything — including the text query and map area, which usually cause the empty result. */
  const clearAll = () => {
    setAmen([]);
    setTypes([]);
    setMinP('');
    setMaxP('');
    setBbox('');
    setBounds(null);
    setExchangeOnly(false);
    setCompliantOnly(false);
    setPage(1);
    router.replace(mapOnly ? '/map' : '/stay', { scroll: false });
  };
  const listQs = new URLSearchParams(Object.entries({ q, checkIn, checkOut, guests }).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <>
      <div className="sticky-search full-bleed">
        <div className="container">
          <StaySearchBar key={`${q}|${checkIn}|${checkOut}|${guests}`} initial={{ q, checkIn, checkOut, guests }} modes={false} compact />
          <div className="filter-bar" role="toolbar" aria-label={L('필터', 'Filters')}>
            <button className="chip" onClick={() => setFiltersOpen(true)} aria-haspopup="dialog">
              <Icon name="filter" size={16} /> {L('필터', 'Filters')} {activeFilters > 0 && <span className="badge accent">{activeFilters}</span>}
            </button>
            <button className="chip" aria-pressed={compliantOnly} onClick={() => setCompliantOnly(!compliantOnly)}><Icon name="shield" size={16} /> {L('인허가 확인 숙소', 'Permit verified')}</button>
            <button className="chip" aria-pressed={exchangeOnly} onClick={() => setExchangeOnly(!exchangeOnly)}><Icon name="swap" size={16} /> {L('맞교환 가능', 'Exchange')}</button>
            {AMENITIES.slice(0, 5).map((a) => (
              <button key={a.value} className="chip" aria-pressed={amen.includes(a.value)} onClick={() => setAmen(amen.includes(a.value) ? amen.filter((x) => x !== a.value) : [...amen, a.value])}>
                <Icon name={amenityIcon(a.value)} size={16} /> {pickText(a, lang)}
              </button>
            ))}
            <label className="sr-only" htmlFor="sort">{L('정렬', 'Sort')}</label>
            <select id="sort" value={sort} onChange={(e) => setSort(e.target.value)} style={{ width: 'auto', minHeight: 38, borderRadius: 999, fontSize: 'var(--fs-sm)', fontWeight: 600 }}>
              <option value="recommended">{L('추천순', 'Recommended')}</option>
              <option value="price_asc">{L('낮은 가격순', 'Price ↑')}</option>
              <option value="price_desc">{L('높은 가격순', 'Price ↓')}</option>
              <option value="rating">{L('평점순', 'Top rated')}</option>
            </select>
            {!mapOnly && (
              <button className="chip hide-mobile" aria-pressed={showMap} onClick={() => toggleMap(!showMap)} style={{ marginLeft: 'auto' }}>
                <Icon name={showMap ? 'list' : 'map'} size={16} /> {showMap ? L('지도 숨기기', 'Hide map') : L('지도 보기', 'Show map')}
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="row between" style={{ margin: '20px 0 12px' }}>
        <div>
          <h1 style={{ fontSize: 'var(--fs-2xl)', margin: 0 }}>{mapOnly ? (q ? L(`지도에서 찾기 · ${placeLabel(q, 'ko')}`, `Map · ${placeLabel(q, 'en')}`) : L('지도에서 찾기', 'Explore on the map')) : q ? L(`${placeLabel(q, 'ko')} 숙소`, `Stays in ${placeLabel(q, 'en')}`) : L('모든 숙소', 'All stays')}</h1>
          {!st.error && (
            <p className="small muted" aria-live="polite" style={{ margin: '4px 0 0' }}>
              {st.loading ? L('검색 중…', 'Searching…') : `${total.toLocaleString()}${L('개 숙소', total === 1 ? ' stay' : ' stays')}`}
              {nights > 0 && ` · ${formatRange(checkIn, checkOut, lang)} (${nights}${L('박', nights === 1 ? ' night' : ' nights')})`}
              {nights === 0 && ` · ${L('날짜를 입력하면 총 요금을 볼 수 있어요', 'Add dates to see total prices')}`}
            </p>
          )}
        </div>
      </div>

      <div className={`split ${showMap ? 'with-map' : ''} ${mapOnly ? s.mapSplit : ''}`}>
        <div>
          <StateView
            state={st}
            skeleton="cards"
            isEmpty={(d) => items(d).length === 0}
            empty={
              <EmptyState
                illo="search"
                title={q ? L(`‘${placeLabel(q, 'ko')}’에 맞는 숙소가 없어요`, `No stays match “${placeLabel(q, 'en')}”`) : L('조건에 맞는 숙소가 없어요', 'No stays match')}
                action={
                  <>
                    <Button variant="primary" onClick={clearAll}>{L('검색 조건 모두 지우기', 'Clear search & filters')}</Button>
                    <Button onClick={() => { clearAll(); setSort('rating'); }}>{L('인기 숙소 보기', 'See popular stays')}</Button>
                  </>
                }
              >
                <p className="muted">{L('다른 지역이나 날짜로 검색하거나, 필터를 줄여 보세요.', 'Try another area or dates, or remove some filters.')}</p>
              </EmptyState>
            }
          >
            {() => (
              <>
                <div className="grid">
                  {rows.map((p, i) => (
                    <PropertyCard key={p.id ?? i} p={p} query={passQs} active={hoverId === propertyView(p).id} onHover={(on) => setHoverId(on ? propertyView(p).id : null)} />
                  ))}
                </div>
                {total > 24 && (
                  <div className="pager" style={{ justifyContent: 'center', marginTop: 24 }}>
                    <button className="btn" disabled={page <= 1} onClick={() => { setPage(page - 1); window.scrollTo({ top: 0 }); }}>‹ {L('이전', 'Prev')}</button>
                    <span>{page} / {Math.ceil(total / 24)}</span>
                    <button className="btn" disabled={page >= Math.ceil(total / 24)} onClick={() => { setPage(page + 1); window.scrollTo({ top: 0 }); }}>{L('다음', 'Next')} ›</button>
                  </div>
                )}
              </>
            )}
          </StateView>
        </div>
        <div className="map-col">
          <div style={{ position: 'relative', height: '100%', minHeight: 420 }}>
            <MapView points={points} onMove={setBounds} activeId={hoverId} onPinHover={setHoverId} fill height={480} />
            {bounds && (
              <button className="btn sm" style={{ position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)', boxShadow: 'var(--e3)' }} onClick={() => setBbox([bounds.west, bounds.south, bounds.east, bounds.north].map((n) => n.toFixed(4)).join(','))}>
                <Icon name="search" size={14} /> {L('이 지역 검색', 'Search this area')}
              </button>
            )}
          </div>
        </div>
      </div>

      {mapOnly ? (
        <Link className="btn primary map-fab" href={`/stay${listQs ? `?${listQs}` : ''}`}>
          <Icon name="list" size={18} /> {L('목록으로 보기', 'Show list')}
        </Link>
      ) : (
        <button className="btn primary map-fab" onClick={() => toggleMap(!showMap)}>
          <Icon name={showMap ? 'list' : 'map'} size={18} /> {showMap ? L('목록 보기', 'Show list') : L('지도 보기', 'Show map')}
        </button>
      )}

      <Modal
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        title={L('필터', 'Filters')}
        footer={
          <>
            <button className="btn link" onClick={() => { setAmen([]); setTypes([]); setMinP(''); setMaxP(''); setExchangeOnly(false); }}>{L('모두 지우기', 'Clear all')}</button>
            <button className="btn primary" onClick={() => setFiltersOpen(false)}>{L('숙소 보기', 'Show stays')}</button>
          </>
        }
      >
        <div className="stack-lg">
          <fieldset>
            <legend>{L('1박 요금 (원)', 'Price per night (KRW)')}</legend>
            <div className="form-grid cols-2">
              <label className="field"><span>{L('최소', 'Min')}</span><input inputMode="numeric" value={minP} onChange={(e) => setMinP(e.target.value)} placeholder="50,000" /></label>
              <label className="field"><span>{L('최대', 'Max')}</span><input inputMode="numeric" value={maxP} onChange={(e) => setMaxP(e.target.value)} placeholder="300,000" /></label>
            </div>
          </fieldset>
          <div className="stack">
            <h3>{L('숙소 유형', 'Property type')}</h3>
            <ChipGroup multi label={L('숙소 유형', 'Property type')} value={types} onChange={setTypes} options={PROPERTY_TYPES.map((t) => ({ value: t.value, label: pickText(t, lang) }))} />
          </div>
          <div className="stack">
            <h3>{L('편의시설', 'Amenities')}</h3>
            <ChipGroup multi label={L('편의시설', 'Amenities')} value={amen} onChange={setAmen} options={AMENITIES.map((a) => ({ value: a.value, label: pickText(a, lang), icon: amenityIcon(a.value) }))} />
          </div>
          <label className="check"><input type="checkbox" checked={compliantOnly} onChange={(e) => setCompliantOnly(e.target.checked)} /><span>{L('인허가 확인을 마친 숙소만 보기 (유료 예약 가능)', 'Only permit-verified stays (bookable)')}</span></label>
          <label className="check"><input type="checkbox" checked={exchangeOnly} onChange={(e) => setExchangeOnly(e.target.checked)} /><span>{L('홈 맞교환 가능한 집만', 'Only homes open to exchange')}</span></label>
        </div>
      </Modal>
    </>
  );
}
