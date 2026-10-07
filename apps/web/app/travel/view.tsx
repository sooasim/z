'use client';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { items } from '@/lib/shape';
import { ProductCard } from '@/components/cards';
import { StateView, EmptyState } from '@/components/states';
import { ChipGroup, PageHeader, Icon } from '@/components/ui';

export default function TravelCatalogView() {
  const { L } = useI18n();
  const sp = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const [kinds, setKinds] = useState<string[]>(sp.getAll('type'));
  const [date, setDate] = useState(sp.get('date') ?? '');
  const st = useApi<any>('/v1/travel-products', { query: { q: q || undefined, type: kinds.length === 1 ? kinds[0] : undefined, from: date || undefined, limit: 50 } });
  const shown = (d: any) => items(d).filter((p: any) => kinds.length <= 1 || kinds.includes(String(p.type ?? '').toUpperCase()));
  return (
    <>
      <PageHeader title={L('투어 · 티켓 · 패키지', 'Tours, tickets & packages')} subtitle={L('검증된 여행 공급사의 상품. 출발일·잔여석·취소 규정을 확인하고 예약하세요.', 'Products from verified suppliers. Check departures, seats and cancellation terms.')} />
      <div className="card stack">
        <div className="form-grid cols-3">
          <label className="field"><span>{L('검색', 'Search')}</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('제주 요트, 경주 야경…', 'Jeju yacht, Gyeongju night tour…')} /></label>
          <label className="field"><span>{L('출발일 이후', 'Departing from')}</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        </div>
        <ChipGroup multi label={L('유형', 'Type')} value={kinds} onChange={setKinds} options={[{ value: 'TOUR', label: L('🚌 투어', '🚌 Tours') }, { value: 'TICKET', label: L('🎫 티켓', '🎫 Tickets') }, { value: 'PACKAGE', label: L('🧳 패키지', '🧳 Packages') }, { value: 'ACTIVITY', label: L('🏄 액티비티', '🏄 Activities') }]} />
      </div>
      <div style={{ marginTop: 24 }}>
        <StateView state={st} skeleton="cards" isEmpty={(d) => shown(d).length === 0} empty={<EmptyState illo="search" title={L('조건에 맞는 상품이 없어요', 'No products match')} />}>
          {(d) => (
            <div className="grid">
              {shown(d).map((p: any, i: number) => <ProductCard key={p.id ?? i} p={p} />)}
            </div>
          )}
        </StateView>
      </div>
      <p className="small muted" style={{ marginTop: 24 }}><Icon name="shield" size={14} style={{ display: 'inline', verticalAlign: '-2px' }} /> {L('여행 상품의 계약 당사자는 각 공급사이며, JETPOOL은 통신판매중개자입니다. 공급사 정보는 상품 상세에서 확인하세요.', 'Each supplier is the contracting party; JETPOOL acts as the marketplace. See supplier details on each product.')}</p>
    </>
  );
}
