'use client';
import Link from 'next/link';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { post } from '@/lib/api';
import { str, f } from '@/lib/shape';
import { formatRange, parseDateRange } from '@/lib/format';
import { RequireAuth } from '@/components/gate';
import { ResourceTable } from '@/components/table';
import { PageHeader, Tabs, Avatar } from '@/components/ui';

type Tab = 'upcoming' | 'current' | 'completed' | 'cancelled';

export default function HostReservationsView() {
  const { L, lang } = useI18n();
  const [tab, setTab] = useState<Tab>('upcoming');
  const q: Record<Tab, Record<string, string>> = { upcoming: { filter: 'upcoming' }, current: { filter: 'current' }, completed: { filter: 'completed' }, cancelled: { filter: 'cancelled' } };
  return (
    <RequireAuth roles={['HOST']}>
      <PageHeader title={L('예약 관리', 'Reservations')} />
      <Tabs label={L('예약 상태', 'Status')} value={tab} onChange={setTab} tabs={[{ value: 'upcoming', label: L('예정', 'Upcoming') }, { value: 'current', label: L('숙박 중', 'Current') }, { value: 'completed', label: L('완료', 'Completed') }, { value: 'cancelled', label: L('취소', 'Cancelled') }]} />
      <div style={{ marginTop: 16 }}>
        <ResourceTable
          key={tab}
          path="/v1/host/reservations"
          query={q[tab]}
          caption={L('호스트 예약', 'Host reservations')}
          columns={[
            { key: 'guestName', label: L('게스트', 'Guest'), render: (r) => <span className="row nowrap" style={{ gap: 8 }}><Avatar name={str(r, 'guestName', 'guest.displayName') || 'G'} size={30} />{str(r, 'guestName', 'guest.displayName') || '—'}</span> },
            { key: 'propertyTitle|property.title', label: L('숙소', 'Listing') },
            { key: 'dates', label: L('일정', 'Dates'), render: (r) => { const d = parseDateRange(f(r, 'during', 'stayRange')) ?? { start: str(r, 'checkIn', 'startDate'), end: str(r, 'checkOut', 'endDate') }; return d.start && d.end ? formatRange(d.start, d.end, lang) : '—'; } },
            { key: 'guests|guestCount', label: L('인원', 'Guests') },
            { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
            { key: 'hostPayoutMinor|totalMinor', label: L('예상 정산', 'Payout'), kind: 'money' },
          ]}
          actions={[
            { label: L('메시지', 'Message'), run: async (r) => { window.location.href = str(r, 'conversationId') ? `/messages?c=${str(r, 'conversationId')}` : '/messages'; } },
            { label: L('체크인', 'Check in'), when: (r) => str(r, 'status').toUpperCase() === 'CONFIRMED', run: (r) => post(`/v1/reservations/${str(r, 'id')}/check-in`, {}, { idempotencyKey: `checkin-${str(r, 'id')}` }) },
            { label: L('완료', 'Complete'), when: (r) => str(r, 'status').toUpperCase() === 'CHECKED_IN', run: (r) => post(`/v1/reservations/${str(r, 'id')}/complete`, {}, { idempotencyKey: `complete-${str(r, 'id')}` }) },
            { label: L('노쇼', 'No-show'), tone: 'danger', when: (r) => str(r, 'status').toUpperCase() === 'CONFIRMED', reason: L('노쇼 처리 사유를 입력하세요', 'Reason for no-show'), run: (r, reason) => post(`/v1/reservations/${str(r, 'id')}/no-show`, { reason }, { idempotencyKey: `noshow-${str(r, 'id')}` }) },
            { label: L('호스트 취소', 'Cancel'), tone: 'danger', when: (r) => ['CONFIRMED', 'PAYMENT_PENDING'].includes(str(r, 'status').toUpperCase()), reason: L('취소 사유 (게스트에게 전달되며 페널티가 적용될 수 있습니다)', 'Reason (shared with guest; penalties may apply)'), run: (r, reason) => post(`/v1/reservations/${str(r, 'id')}/cancel`, { reason }, { idempotencyKey: `hcancel-${str(r, 'id')}` }) },
          ]}
          empty={<p className="muted">{L('해당하는 예약이 없습니다.', 'No reservations.')} <Link href="/host/listings">{L('숙소 관리', 'Listings')}</Link></p>}
        />
      </div>
    </RequireAuth>
  );
}
