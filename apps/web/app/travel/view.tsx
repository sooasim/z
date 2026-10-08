'use client';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { items } from '@/lib/shape';
import { findPlace, placeLabel } from '@/lib/places';
import { TourCard } from '@/components/public/TourCard';
import { StateView, EmptyState } from '@/components/states';
import { Button, ChipGroup, HeadingLevel, Icon, PageHeader } from '@/components/ui';
import { DateField } from '@/components/public/DateField';
import { useDebounced, useUrlSync } from '@/components/public/hooks';

export default function TravelCatalogView() {
  const { L, lang } = useI18n();
  const sp = useSearchParams();
  const [q, setQ] = useState(() => placeLabel(sp.get('q') ?? '', lang));
  const [kinds, setKinds] = useState<string[]>(sp.getAll('type'));
  const [date, setDate] = useState(sp.get('date') ?? '');
  const dq = useDebounced(q.trim(), 300);
  // A known place searches by canonical city ("제주" → city=Jeju); anything else is a title/keyword search.
  const place = findPlace(dq);
  useUrlSync({ q: place ? place.en : dq, type: kinds, date });
  const st = useApi<any>('/v1/travel-products', { query: { q: place ? undefined : dq || undefined, city: place?.en, type: kinds.length === 1 ? kinds[0] : undefined, from: date || undefined, limit: 50 } });
  const shown = (d: any) => items(d).filter((p: any) => kinds.length <= 1 || kinds.includes(String(p.type ?? '').toUpperCase()));
  const filtered = !!(dq || kinds.length || date);
  return (
    <>
      <PageHeader title={L('투어 · 티켓 · 패키지', 'Tours, tickets & packages')} subtitle={L('검증된 여행 공급사의 상품이에요. 출발일·잔여석·취소 규정을 확인하고 예약하세요.', 'Products from verified suppliers. Check departures, seats and cancellation terms.')} />
      <div className="card stack">
        <div className="form-grid cols-3">
          <label className="field">
            <span>{L('여행지 · 키워드', 'Destination or keyword')}</span>
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('제주, 요트, 야경…', 'Jeju, yacht, night tour…')} enterKeyHint="search" />
          </label>
          <DateField label={L('출발일 이후', 'Departing from')} value={date} onChange={setDate} placeholder={L('언제든', 'Any date')} />
        </div>
        <ChipGroup
          multi
          label={L('유형', 'Type')}
          value={kinds}
          onChange={setKinds}
          options={[
            { value: 'TOUR', label: L('투어', 'Tours'), icon: 'compass' },
            { value: 'TICKET', label: L('티켓', 'Tickets'), icon: 'ticket' },
            { value: 'PACKAGE', label: L('패키지', 'Packages'), icon: 'bag' },
            { value: 'ACTIVITY', label: L('액티비티', 'Activities'), icon: 'sparkle' },
          ]}
        />
      </div>
      <div style={{ marginTop: 24 }}>
        <StateView
          state={st}
          skeleton="cards"
          isEmpty={(d) => shown(d).length === 0}
          empty={
            <EmptyState
              illo="search"
              title={L('조건에 맞는 상품이 없어요', 'No products match')}
              action={
                filtered ? (
                  <Button
                    variant="primary"
                    onClick={() => {
                      setQ('');
                      setKinds([]);
                      setDate('');
                    }}
                  >
                    {L('조건 모두 지우기', 'Clear filters')}
                  </Button>
                ) : undefined
              }
            >
              {L('다른 지역이나 날짜로 찾아보세요. 새 상품은 계속 추가되고 있어요.', 'Try another area or date — new products are added regularly.')}
            </EmptyState>
          }
        >
          {(d) => (
            <HeadingLevel level={2}>
              <p className="small muted" aria-live="polite" style={{ margin: '0 0 12px' }}>
                {L(`${shown(d).length}개 상품`, `${shown(d).length} products`)}
              </p>
              <div className="grid">
                {shown(d).map((p: any, i: number) => (
                  <TourCard key={p.id ?? i} p={p} />
                ))}
              </div>
            </HeadingLevel>
          )}
        </StateView>
      </div>
      <p className="small muted row" style={{ marginTop: 24, gap: 6, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
        <Icon name="shield" size={14} style={{ flex: '0 0 auto', marginTop: 3 }} /> {L('여행 상품의 계약 당사자는 각 공급사이며, JETPOOL은 통신판매중개자로서 결제와 고객 지원을 맡아요. 공급사 정보는 상품 상세에서 확인하세요.', 'Each supplier is the contracting party; JETPOOL acts as the marketplace and handles payment and support. See supplier details on each product.')}
      </p>
    </>
  );
}
