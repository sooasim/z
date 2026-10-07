'use client';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { useI18n } from '@/lib/i18n';
import { str } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { ResourceTable } from '@/components/table';
import { PageHeader, Tabs } from '@/components/ui';
import { formatRange, parseDateRange } from '@/lib/format';

type Tab = 'stays' | 'exchanges' | 'guides' | 'orders';

export default function TripsView() {
  const { L, lang } = useI18n();
  const sp = useSearchParams();
  const router = useRouter();
  const tab = (sp.get('tab') as Tab) || 'stays';
  const range = (r: any) => {
    const dr = parseDateRange(r.during ?? r.stay_range ?? r.range);
    const s = dr?.start ?? str(r, 'checkIn', 'startDate', 'start', 'hostStart');
    const e = dr?.end ?? str(r, 'checkOut', 'endDate', 'end', 'hostEnd');
    return s && e ? formatRange(s, e, lang) : '—';
  };
  return (
    <RequireAuth>
      <PageHeader title={L('내 여행', 'My trips')} />
      <Tabs
        label={L('여행 유형', 'Trip type')}
        value={tab}
        onChange={(v) => router.replace(`/trips?tab=${v}`, { scroll: false })}
        tabs={[
          { value: 'stays', label: L('숙소 예약', 'Stays') },
          { value: 'exchanges', label: L('홈 맞교환', 'Exchanges') },
          { value: 'guides', label: L('가이드', 'Guides') },
          { value: 'orders', label: L('여행 상품', 'Travel orders') },
        ]}
      />
      <div style={{ marginTop: 16 }}>
        {tab === 'stays' && (
          <ResourceTable
            path="/v1/reservations"
            query={{ role: 'guest' }}
            caption={L('숙소 예약', 'Stays')}
            columns={[
              { key: 'propertyTitle', label: L('숙소', 'Stay'), render: (r) => <Link href={`/trips/${str(r, 'id')}`}>{str(r, 'propertyTitle', 'property.title', 'title') || str(r, 'id').slice(0, 8)}</Link> },
              { key: 'dates', label: L('일정', 'Dates'), render: range },
              { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
              { key: 'totalMinor|amountMinor', label: L('금액', 'Total'), kind: 'money' },
            ]}
            empty={<p className="muted">{L('예약이 없습니다.', 'No stays yet.')} <Link href="/stay">{L('숙소 찾기', 'Find a stay')}</Link></p>}
          />
        )}
        {tab === 'exchanges' && (
          <ResourceTable
            path="/v1/exchanges"
            caption={L('홈 맞교환', 'Exchanges')}
            columns={[
              { key: 'id', label: L('맞교환', 'Exchange'), render: (r) => <Link href={`/exchange/${str(r, 'id')}`}>{`${str(r, 'propertyA.title') || 'A'} ⇄ ${str(r, 'propertyB.title') || 'B'}`}</Link> },
              { key: 'dates', label: L('내가 머무는 기간', 'My stay'), render: (r) => { const mine = str(r, 'role') === 'RESPONDER' ? 'datesA' : 'datesB'; const s0 = str(r, `${mine}.start`); const e0 = str(r, `${mine}.end`); return s0 && e0 ? formatRange(s0, e0, lang) : range(r); } },
              { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
              { key: 'nextAction', label: L('다음 할 일', 'Next action') },
              { key: 'currentOfferVersion|version', label: 'v' },
            ]}
            empty={<p className="muted">{L('맞교환이 없습니다.', 'No exchanges.')} <Link href="/exchange">{L('맞교환 둘러보기', 'Explore')}</Link></p>}
          />
        )}
        {tab === 'guides' && (
          <ResourceTable
            path="/v1/guide-bookings"
            caption={L('가이드 예약', 'Guide bookings')}
            columns={[
              { key: 'id', label: L('가이드', 'Guide'), render: (r) => <Link href={`/guide-bookings/${str(r, 'id')}`}>{str(r, 'guideName', 'guide.displayName') || '#' + str(r, 'id').slice(0, 8)}</Link> },
              { key: 'startsAt|startAt|date', label: L('일시', 'When'), kind: 'datetime' },
              { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
              { key: 'amountMinor|priceMinor', label: L('금액', 'Price'), kind: 'money' },
            ]}
            empty={<p className="muted">{L('가이드 예약이 없습니다.', 'No guide bookings.')} <Link href="/guide-friends">{L('가이드 찾기', 'Find a guide')}</Link></p>}
          />
        )}
        {tab === 'orders' && (
          <ResourceTable
            path="/v1/orders"
            caption={L('여행 주문', 'Orders')}
            columns={[
              { key: 'id', label: L('주문', 'Order'), render: (r) => <Link href={`/orders/${str(r, 'id')}`}>{str(r, 'title', 'orderNumber') || '#' + str(r, 'id').slice(0, 8)}</Link> },
              { key: 'createdAt', label: L('주문일', 'Ordered'), kind: 'date' },
              { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
              { key: 'totalMinor|amountMinor', label: L('금액', 'Total'), kind: 'money' },
            ]}
            empty={<p className="muted">{L('주문이 없습니다.', 'No orders.')} <Link href="/travel">{L('여행 상품 보기', 'Browse travel')}</Link></p>}
          />
        )}
      </div>
    </RequireAuth>
  );
}
