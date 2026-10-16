'use client';
import { useI18n } from '@/lib/i18n';
import { post } from '@/lib/api';
import { str } from '@/lib/shape';
import { AdminListPage } from '@/components/admin/list-page';

/**
 * Stay listing console. Reads come from the admin module's SELECT-only list (exact location is omitted there);
 * blocking and unblocking are the properties module's own endpoints, so the state change stays with its owner.
 */
export default function AdminListingsView() {
  const { L } = useI18n();
  return (
    <AdminListPage
      title={L('숙소 관리', 'Stay listings')}
      subtitle={L('등록된 숙소를 조회하고, 문제가 있는 숙소를 공개 차단합니다. 차단·해제는 사유와 함께 감사 기록됩니다.', 'Browse listings and block problematic ones from public visibility. Blocks and unblocks are audited with a reason.')}
      path="/v1/admin/listings"
      searchParam="q"
      searchPlaceholder={L('숙소명 또는 slug로 검색', 'Search by title or slug')}
      tabs={[
        { value: 'all', label: L('전체', 'All') },
        { value: 'IN_REVIEW', label: L('심사 중', 'In review'), query: { status: 'IN_REVIEW' } },
        { value: 'PUBLISHED', label: L('공개', 'Published'), query: { status: 'PUBLISHED' } },
        { value: 'DRAFT', label: L('임시저장', 'Draft'), query: { status: 'DRAFT' } },
        { value: 'BLOCKED', label: L('차단', 'Blocked'), query: { status: 'BLOCKED' } },
        { value: 'exchange', label: L('맞교환 가능', 'Exchange'), query: { exchangeEnabled: 'true' } },
      ]}
      columns={[
        { key: 'title', label: L('숙소명', 'Listing'), primary: true },
        { key: 'hostName', label: L('호스트', 'Host') },
        { key: 'city', label: L('도시', 'City') },
        { key: 'propertyType', label: L('유형', 'Type'), kind: 'enum', hideOnMobile: true },
        { key: 'basePriceMinor', label: L('기본 요금', 'Nightly'), kind: 'money', align: 'right' },
        { key: 'maxGuests', label: L('인원', 'Guests'), align: 'right', hideOnMobile: true },
        {
          key: 'rentalEnabled',
          label: L('판매 채널', 'Channels'),
          render: (r) => (
            <span className="row" style={{ gap: 4 }}>
              {r.rentalEnabled && <span className="badge">{L('숙박', 'Rental')}</span>}
              {r.exchangeEnabled && <span className="badge">{L('맞교환', 'Exchange')}</span>}
              {r.instantBook && <span className="badge ok">{L('즉시예약', 'Instant')}</span>}
            </span>
          ),
        },
        { key: 'status', label: L('상태', 'Status'), kind: 'status', badge: true },
        { key: 'publishedAt', label: L('공개일', 'Published'), kind: 'date', hideOnMobile: true },
      ]}
      actions={[
        {
          label: L('공개 차단', 'Block'),
          tone: 'danger',
          when: (r) => str(r, 'status') !== 'BLOCKED',
          reason: L('차단 사유', 'Reason for blocking'),
          confirm: L('차단하면 숙소가 검색과 공개 페이지에서 즉시 사라집니다. 기존 확정 예약은 유지됩니다.', 'Blocking removes the listing from search and its public page at once. Confirmed reservations are kept.'),
          run: (r, reason) => post(`/v1/admin/properties/${str(r, 'id')}/block`, { reason }),
        },
        {
          label: L('차단 해제', 'Unblock'),
          when: (r) => str(r, 'status') === 'BLOCKED',
          reason: L('해제 사유', 'Reason for unblocking'),
          run: (r, reason) => post(`/v1/admin/properties/${str(r, 'id')}/unblock`, { reason }),
        },
      ]}
      empty={<p className="muted">{L('조건에 맞는 숙소가 없습니다.', 'No listings match.')}</p>}
    />
  );
}
