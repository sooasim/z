'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { items, nextCursor } from '@/lib/shape';
import { propertyView } from '@/lib/domain';
import { formatMoney, nightsBetween, toMinor } from '@/lib/format';
import { StaySearchBar } from '@/components/search/StaySearchBar';
import { PropertyCard } from '@/components/cards';
import { MapView, type Bounds } from '@/components/map';
import { StateView, EmptyState } from '@/components/states';
import { ChipGroup, PageHeader, Tabs } from '@/components/ui';

const AMENITIES = [
  { value: 'WIFI', ko: '와이파이', en: 'Wi-Fi' },
  { value: 'KITCHEN', ko: '주방', en: 'Kitchen' },
  { value: 'WASHER', ko: '세탁기', en: 'Washer' },
  { value: 'AIR_CONDITIONING', ko: '에어컨', en: 'A/C' },
  { value: 'PARKING', ko: '주차', en: 'Parking' },
  { value: 'WORKSPACE', ko: '업무 공간', en: 'Workspace' },
  { value: 'PET_FRIENDLY', ko: '반려동물', en: 'Pets' },
];

export default function StaySearchView({ mapOnly = false }: { mapOnly?: boolean }) {
  const { L, lang } = useI18n();
  const sp = useSearchParams();
  const router = useRouter();
  const [view, setView] = useState<'list' | 'map'>(mapOnly || sp.get('view') === 'map' ? 'map' : 'list');
  const [amen, setAmen] = useState<string[]>(sp.getAll('amenities'));
  const [minP, setMinP] = useState(sp.get('priceMin') ?? '');
  const [maxP, setMaxP] = useState(sp.get('priceMax') ?? '');
  const [bounds, setBounds] = useState<Bounds | null>(null);
  const [bbox, setBbox] = useState<string>(sp.get('bbox') ?? '');
  const [sort, setSort] = useState(sp.get('sort') ?? 'recommended');
  const [compliantOnly, setCompliantOnly] = useState(sp.get('compliant') === '1');

  const q = sp.get('q') ?? '';
  const checkIn = sp.get('checkIn') ?? '';
  const checkOut = sp.get('checkOut') ?? '';
  const guests = sp.get('guests') ?? '';
  const nights = nightsBetween(checkIn, checkOut);

  const query = useMemo(
    () => ({
      q,
      checkIn,
      checkOut,
      guests,
      amenities: amen,
      priceMinMinor: minP ? String(toMinor(minP)) : undefined,
      priceMaxMinor: maxP ? String(toMinor(maxP)) : undefined,
      bbox: bbox || undefined,
      sort,
      bookable: compliantOnly ? 'true' : undefined,
      limit: 24,
    }),
    [q, checkIn, checkOut, guests, amen, minP, maxP, bbox, sort, compliantOnly],
  );
  const st = useApi<any>('/v1/search/properties', { query });
  const rows = items(st.data);
  const passQs = new URLSearchParams(Object.entries({ checkIn, checkOut, guests }).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <>
      {!mapOnly && <PageHeader title={L('숙소 검색', 'Find a stay')} subtitle={q ? `“${q}”` + (nights ? ` · ${nights}${L('박', ' nights')}` : '') : L('검증된 숙소만 예약할 수 있어요.', 'Only compliant stays can be booked.')} />}
      {mapOnly && <PageHeader title={L('지도에서 찾기', 'Explore on the map')} subtitle={L('지도를 움직이고 “이 지역 검색”을 누르세요. 위치는 대략적으로 표시됩니다.', 'Move the map and tap “Search this area”. Locations are approximate.')} />}
      <StaySearchBar initial={{ q, checkIn, checkOut, guests }} />
      <details className="card flat" style={{ marginTop: 12 }} open={amen.length > 0 || !!minP || !!maxP}>
        <summary style={{ cursor: 'pointer', fontWeight: 700 }}>{L('필터', 'Filters')}</summary>
        <div className="stack" style={{ marginTop: 12 }}>
          <div className="form-grid cols-4">
            <label className="field">
              <span>{L('최소 1박 요금(원)', 'Min price / night')}</span>
              <input inputMode="numeric" value={minP} onChange={(e) => setMinP(e.target.value)} placeholder="50,000" />
            </label>
            <label className="field">
              <span>{L('최대 1박 요금(원)', 'Max price / night')}</span>
              <input inputMode="numeric" value={maxP} onChange={(e) => setMaxP(e.target.value)} placeholder="300,000" />
            </label>
            <label className="field">
              <span>{L('정렬', 'Sort')}</span>
              <select value={sort} onChange={(e) => setSort(e.target.value)}>
                <option value="recommended">{L('추천순', 'Recommended')}</option>
                <option value="price_asc">{L('낮은 가격순', 'Price: low to high')}</option>
                <option value="price_desc">{L('높은 가격순', 'Price: high to low')}</option>
                <option value="rating">{L('평점순', 'Top rated')}</option>
              </select>
            </label>
            <label className="check" style={{ alignSelf: 'end' }}>
              <input type="checkbox" checked={compliantOnly} onChange={(e) => setCompliantOnly(e.target.checked)} />
              <span>{L('인허가 확인 숙소만', 'Permit-verified only')}</span>
            </label>
          </div>
          <ChipGroup multi label={L('편의시설', 'Amenities')} value={amen} onChange={setAmen} options={AMENITIES.map((a) => ({ value: a.value, label: a[lang] }))} />
          {(minP || maxP) && (
            <p className="small muted">
              {minP && formatMoney(toMinor(minP), 'KRW', lang)} ~ {maxP && formatMoney(toMinor(maxP), 'KRW', lang)}
            </p>
          )}
        </div>
      </details>
      <div className="row between" style={{ marginTop: 16 }}>
        {!mapOnly ? (
          <Tabs
            label={L('보기 방식', 'View')}
            value={view}
            onChange={(v) => {
              setView(v);
              const p = new URLSearchParams(sp.toString());
              p.set('view', v);
              router.replace(`/stay?${p}`, { scroll: false });
            }}
            tabs={[
              { value: 'list', label: L('목록', 'List') },
              { value: 'map', label: L('지도', 'Map') },
            ]}
          />
        ) : (
          <span />
        )}
        <span className="muted small" aria-live="polite">
          {st.loading ? L('검색 중…', 'Searching…') : `${rows.length}${nextCursor(st.data) ? '+' : ''} ${L('개 숙소', 'stays')}`}
        </span>
      </div>
      {view === 'map' && (
        <div className="stack" style={{ marginTop: 12 }}>
          <MapView
            points={rows
              .map((r) => propertyView(r))
              .filter((v) => v.lat !== undefined && v.lng !== undefined)
              .map((v) => ({ id: v.id, lat: v.lat!, lng: v.lng!, label: v.priceMinor !== undefined ? formatMoney(v.priceMinor, v.currency, lang) : v.title.slice(0, 10), href: `/stay/${encodeURIComponent(v.slug)}${passQs ? '?' + passQs : ''}` }))}
            onMove={setBounds}
          />
          {bounds && (
            <button className="btn" onClick={() => setBbox([bounds.west, bounds.south, bounds.east, bounds.north].map((n) => n.toFixed(4)).join(','))}>
              🔍 {L('이 지역 검색', 'Search this area')}
            </button>
          )}
        </div>
      )}
      <div style={{ marginTop: 16 }}>
        <StateView
          state={st}
          isEmpty={(d) => items(d).length === 0}
          empty={
            <EmptyState title={L('조건에 맞는 숙소가 없습니다.', 'No stays match.')}>
              <p className="muted">{L('날짜나 필터를 바꿔 보세요.', 'Try other dates or filters.')}</p>
            </EmptyState>
          }
        >
          {() => (
            <div className="grid">
              {rows.map((p, i) => (
                <PropertyCard key={p.id ?? i} p={p} query={passQs} />
              ))}
            </div>
          )}
        </StateView>
      </div>
    </>
  );
}
