'use client';
import { useI18n } from '@/lib/i18n';
import { AdminListPage } from '@/components/admin/list-page';
import { Alert } from '@/components/ui';

/**
 * Read-only booking console across the three booking domains. The admin module deliberately exposes these as
 * SELECT-only lists — a state change belongs to the owning domain, so cancellations and refunds are done from
 * Payments / Refunds / Disputes rather than here.
 */
export default function AdminBookingsView() {
  const { L } = useI18n();
  return (
    <AdminListPage
      title={L('예약 관리', 'Bookings')}
      subtitle={L('숙소 예약, 홈 맞교환, 가이드 예약을 한 화면에서 조회합니다. 조회 전용이며 상태 변경은 해당 도메인 화면에서 처리합니다.', 'Stay reservations, home exchanges and guide bookings in one place. Read-only — state changes happen in the owning domain.')}
      path="/v1/admin/reservations"
      search={false}
      aside={<Alert tone="info">{L('기간 필터는 한국 시간 기준 영업일입니다.', 'Date filters are business days in Korea.')}</Alert>}
      tabs={[
        {
          value: 'reservations',
          label: L('숙소 예약', 'Stays'),
          path: '/v1/admin/reservations',
          columns: [
            { key: 'code', label: L('예약번호', 'Code'), primary: true, className: 'mono' },
            { key: 'propertyTitle', label: L('숙소', 'Listing') },
            { key: 'guestName', label: L('게스트', 'Guest') },
            { key: 'hostName', label: L('호스트', 'Host'), hideOnMobile: true },
            { key: 'checkIn', label: L('체크인', 'Check-in'), kind: 'date' },
            { key: 'checkOut', label: L('체크아웃', 'Check-out'), kind: 'date', hideOnMobile: true },
            { key: 'totalMinor', label: L('결제 금액', 'Total'), kind: 'money', align: 'right' },
            { key: 'status', label: L('상태', 'Status'), kind: 'status', badge: true },
          ],
        },
        {
          value: 'exchanges',
          label: L('홈 맞교환', 'Exchanges'),
          path: '/v1/admin/exchanges',
          columns: [
            { key: 'propertyATitle', label: L('숙소 A', 'Listing A'), primary: true },
            { key: 'propertyBTitle', label: L('숙소 B', 'Listing B') },
            { key: 'requesterName', label: L('요청자', 'Requester'), hideOnMobile: true },
            { key: 'responderName', label: L('상대방', 'Responder'), hideOnMobile: true },
            { key: 'datesA.start', label: L('A 시작', 'A from'), kind: 'date' },
            { key: 'datesB.start', label: L('B 시작', 'B from'), kind: 'date' },
            { key: 'status', label: L('상태', 'Status'), kind: 'status', badge: true },
            { key: 'createdAt', label: L('신청일', 'Created'), kind: 'date', hideOnMobile: true },
          ],
        },
        {
          value: 'guide',
          label: L('가이드 예약', 'Guide bookings'),
          path: '/v1/admin/guide-bookings',
          columns: [
            { key: 'guideName', label: L('가이드', 'Guide'), primary: true },
            { key: 'travelerName', label: L('여행자', 'Traveler') },
            { key: 'guideType', label: L('유형', 'Type'), hideOnMobile: true },
            { key: 'startAt', label: L('시작', 'Starts'), kind: 'datetime' },
            { key: 'paid', label: L('유료', 'Paid'), render: (r) => (r.paid ? L('유료', 'Paid') : L('프렌즈', 'Friends')) },
            { key: 'priceMinor', label: L('금액', 'Price'), kind: 'money', align: 'right' },
            { key: 'status', label: L('상태', 'Status'), kind: 'status', badge: true },
          ],
        },
      ]}
      columns={[{ key: 'code', label: L('예약번호', 'Code') }]}
      empty={<p className="muted">{L('조건에 맞는 예약이 없습니다.', 'No bookings match.')}</p>}
    />
  );
}
