'use client';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { post } from '@/lib/api';
import { num, str } from '@/lib/shape';
import { AdminListPage } from '@/components/admin/list-page';
import { Alert } from '@/components/ui';

export default function AdminSuppliersView() {
  const { L } = useI18n();
  return (
    <AdminListPage
      title={L('공급사 관리', 'Travel suppliers')}
      subtitle={L('여행 상품 공급사를 심사하고, 승인 시 판매 주체(MoR)와 수수료율을 확정합니다. 승인된 소유자에게 SUPPLIER 역할이 부여됩니다.', 'Review travel suppliers; approving fixes the merchant of record and the commission, and grants the owner the SUPPLIER role.')}
      path="/v1/admin/suppliers"
      search={false}
      aside={
        <Alert tone="info">
          {L('승인된 공급사의 상품은', 'Products of approved suppliers are managed in')}{' '}
          <Link href="/admin/travel/products">{L('여행 상품 관리', 'Travel products')}</Link>
          {L('에서 등록·심사합니다.', '.')}
        </Alert>
      }
      tabs={[
        { value: 'all', label: L('전체', 'All') },
        { value: 'PENDING', label: L('심사 대기', 'Pending'), query: { status: 'PENDING' } },
        { value: 'APPROVED', label: L('승인', 'Approved'), query: { status: 'APPROVED' } },
        { value: 'SUSPENDED', label: L('정지', 'Suspended'), query: { status: 'SUSPENDED' } },
        { value: 'REJECTED', label: L('반려', 'Rejected'), query: { status: 'REJECTED' } },
      ]}
      columns={[
        { key: 'name', label: L('공급사명', 'Supplier'), primary: true },
        { key: 'supplierType', label: L('유형', 'Type') },
        { key: 'merchantOfRecord', label: L('판매 주체 (MoR)', 'Merchant of record'), render: (r) => str(r, 'merchantOfRecord') || '—' },
        {
          key: 'commissionBps',
          label: L('수수료', 'Commission'),
          align: 'right',
          render: (r) => (num(r, 'commissionBps') == null ? '—' : `${((num(r, 'commissionBps') ?? 0) / 100).toFixed(2)}%`),
        },
        { key: 'status', label: L('상태', 'Status'), kind: 'status', badge: true },
        { key: 'createdAt', label: L('신청일', 'Applied'), kind: 'date', hideOnMobile: true },
      ]}
      actions={[
        {
          label: L('승인', 'Approve'),
          tone: 'primary',
          when: (r) => ['PENDING', 'SUSPENDED'].includes(str(r, 'status')),
          title: L('공급사 승인', 'Approve supplier'),
          confirm: L('승인하면 소유자에게 SUPPLIER 역할이 부여되고 상품 게시가 가능해집니다.', 'Approving grants the owner the SUPPLIER role and allows their products to be published.'),
          fields: [
            {
              name: 'merchantOfRecord',
              label: L('판매 주체 (MoR)', 'Merchant of record'),
              type: 'select',
              options: [
                { value: 'JETPOOL', label: L('젯풀 (JETPOOL)', 'JETPOOL') },
                { value: 'SUPPLIER', label: L('공급사 (SUPPLIER)', 'SUPPLIER') },
              ],
              defaultValue: 'JETPOOL',
              required: true,
            },
            { name: 'commissionBps', label: L('수수료 (bps, 1500 = 15%)', 'Commission (bps, 1500 = 15%)'), type: 'number', min: 0, max: 10000, defaultValue: 1500, required: true },
            { name: 'note', label: L('메모', 'Note') },
          ],
          run: (r, _reason, values) =>
            post(`/v1/admin/suppliers/${str(r, 'id')}/approve`, {
              merchantOfRecord: values?.merchantOfRecord ?? 'JETPOOL',
              commissionBps: Number(values?.commissionBps ?? 1500),
              reason: values?.note || undefined,
            }),
        },
        {
          label: L('판매 정지', 'Suspend'),
          tone: 'danger',
          menu: true,
          when: (r) => str(r, 'status') === 'APPROVED',
          reason: L('정지 사유', 'Suspension reason'),
          confirm: L('정지하면 이 공급사의 판매 중인 상품이 모두 판매 중지(PAUSED)됩니다.', 'Suspending pauses every published product of this supplier.'),
          run: (r, reason) => post(`/v1/admin/suppliers/${str(r, 'id')}/decision`, { decision: 'SUSPENDED', reason }),
        },
        {
          label: L('반려', 'Reject'),
          tone: 'danger',
          menu: true,
          when: (r) => str(r, 'status') === 'PENDING',
          reason: L('반려 사유', 'Rejection reason'),
          run: (r, reason) => post(`/v1/admin/suppliers/${str(r, 'id')}/decision`, { decision: 'REJECTED', reason }),
        },
      ]}
      empty={<p className="muted">{L('해당 상태의 공급사가 없습니다.', 'No suppliers in this state.')}</p>}
    />
  );
}
