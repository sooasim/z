'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api, post } from '@/lib/api';
import { item, items, str } from '@/lib/shape';
import { productView } from '@/lib/domain';
import { RequireAuth } from '@/components/gate';
import { ResourceTable } from '@/components/table';
import { FormCard } from '@/components/form';
import { Modal, PageHeader, Section, StatusPill, Tabs, Button } from '@/components/ui';
import { useToast } from '@/components/ui/toast';

type Tab = 'products' | 'departures' | 'orders';

function SupplierSignup({ onDone }: { onDone: () => void }) {
  const { L } = useI18n();
  return (
    <div className="card stack" style={{ marginBottom: 20 }}>
      <h2 style={{ margin: 0 }}>{L('공급사 등록', 'Register as a supplier')}</h2>
      <p className="muted small" style={{ margin: 0 }}>{L('여행업 등록증 등 사업자 서류는 본인·사업자 인증 메뉴에서 제출하세요.', 'Submit your travel-agency registration under Verification.')}</p>
      <FormCard
        cols={2}
        fields={[
          { name: 'name', label: L('상호', 'Company name'), required: true },
          { name: 'supplierType', label: L('유형', 'Type'), type: 'select', required: true, options: ['TOUR_OPERATOR', 'TICKET', 'ACTIVITY', 'PACKAGE', 'TRANSPORT'].map((v) => ({ value: v, label: v })) },
        ]}
        submit={async (b) => { await post('/v1/suppliers', b); onDone(); }}
        submitLabel={L('등록 신청', 'Apply')}
      />
    </div>
  );
}

export default function SupplierProductsView() {
  const { L } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('products');
  const [creating, setCreating] = useState(false);
  const [k, setK] = useState(0);
  const sup = useApi<any>('/v1/suppliers/me', { auth: true });
  const mine = useApi<any>('/v1/supplier/products', { auth: true });
  const [pid, setPid] = useState('');
  const products = items(mine.data);
  const productId = pid || str(products[0], 'id');
  return (
    <RequireAuth roles={['SUPPLIER']}>
      <PageHeader title={L('공급사 센터', 'Supplier extranet')} subtitle={L('상품, 출발일·잔여석, 주문을 관리하세요. 상품은 검수 후 판매됩니다.', 'Manage products, departures & inventory, and orders. Products go live after review.')} actions={<Button variant="primary" icon="plus" onClick={() => setCreating(true)}>{L('상품 등록', 'New product')}</Button>} />
      {sup.error && (sup.error as any).status === 404 ? (
        <SupplierSignup onDone={() => sup.reload()} />
      ) : sup.data && str(item(sup.data), 'status') && str(item(sup.data), 'status').toUpperCase() !== 'APPROVED' ? (
        <div style={{ marginBottom: 16 }}><StatusPill status={str(item(sup.data), 'status')} /> <span className="small muted">{L('공급사 승인 후 상품이 판매됩니다. 상품 초안은 미리 작성할 수 있어요.', 'Products go on sale after supplier approval; you can draft now.')}</span></div>
      ) : null}
      <Tabs label={L('메뉴', 'Sections')} value={tab} onChange={setTab} tabs={[{ value: 'products', label: L('상품', 'Products') }, { value: 'departures', label: L('출발일·재고', 'Departures & inventory') }, { value: 'orders', label: L('주문', 'Orders') }]} />
      <div style={{ marginTop: 16 }}>
        {tab === 'products' && (
          <ResourceTable
            key={k}
            path="/v1/supplier/products"
            columns={[
              { key: 'title', label: L('상품명', 'Title') },
              { key: 'type', label: L('유형', 'Type') },
              { key: 'city', label: L('지역', 'Area') },
              { key: 'basePriceMinor', label: L('기본가', 'Base price'), kind: 'money' },
              { key: 'status', label: L('상태', 'Status'), kind: 'status' },
              { key: 'updatedAt', label: L('수정일', 'Updated'), kind: 'date' },
            ]}
            actions={[
              { label: L('검수 요청', 'Submit for review'), tone: 'primary', when: (r) => ['DRAFT'].includes(str(r, 'status').toUpperCase()), run: (r) => post(`/v1/supplier/products/${str(r, 'id')}/submit`, {}) },
            ]}
            empty={<p className="muted">{L('등록된 상품이 없습니다.', 'No products yet.')}</p>}
          />
        )}
        {tab === 'departures' && (
          <>
            <label className="field" style={{ maxWidth: 420 }}>
              <span>{L('상품', 'Product')}</span>
              <select value={productId} onChange={(e) => setPid(e.target.value)}>{products.map((p: any) => { const v = productView(p); return <option key={v.id} value={v.id}>{v.title}</option>; })}</select>
            </label>
            {productId && (
              <div className="grid-2" style={{ marginTop: 16 }}>
                <ResourceTable
                  key={productId + k}
                  path={`/v1/travel-products/${productId}/departures`}
                  query={{ includePast: 'true' }}
                  columns={[
                    { key: 'startsAt', label: L('출발', 'Departure'), kind: 'datetime' },
                    { key: 'capacity', label: L('정원', 'Capacity') },
                    { key: 'booked', label: L('예약', 'Booked') },
                    { key: 'remaining', label: L('잔여', 'Left') },
                    { key: 'priceMinor', label: L('가격', 'Price'), kind: 'money' },
                    { key: 'status', label: L('상태', 'Status'), kind: 'status' },
                  ]}
                  actions={[
                    { label: L('마감', 'Close'), when: (r) => ['OPEN', 'GUARANTEED'].includes(str(r, 'status').toUpperCase()), confirm: L('이 출발일 판매를 마감할까요?', 'Close sales for this departure?'), run: (r) => api(`/v1/supplier/departures/${str(r, 'id')}`, { method: 'PATCH', body: { status: 'CLOSED' } }) },
                    { label: L('재오픈', 'Reopen'), when: (r) => str(r, 'status').toUpperCase() === 'CLOSED', run: (r) => api(`/v1/supplier/departures/${str(r, 'id')}`, { method: 'PATCH', body: { status: 'OPEN' } }) },
                    { label: L('출발 취소', 'Cancel'), tone: 'danger', when: (r) => str(r, 'status').toUpperCase() !== 'CANCELLED', reason: L('취소 사유 (예약자 전원에게 환불·통지됩니다)', 'Reason (all bookers are refunded and notified)'), run: (r, reason) => post(`/v1/supplier/departures/${str(r, 'id')}/cancel`, { reason }) },
                  ]}
                  empty={<p className="muted">{L('등록된 출발일이 없습니다.', 'No departures.')}</p>}
                />
                <FormCard
                  title={L('출발일 추가', 'Add departure')}
                  resetOnSuccess
                  fields={[
                    { name: 'startsAt', label: L('출발 일시', 'Departure'), type: 'datetime-local', required: true },
                    { name: 'capacity', label: L('정원', 'Capacity'), type: 'number', required: true, min: 1 },
                    { name: 'minParticipants', label: L('최소 출발 인원', 'Min participants'), type: 'number', min: 1 },
                    { name: 'priceMinor', label: L('1인 가격 (원, 비우면 기본가)', 'Price per person (blank = base)'), type: 'money' },
                  ]}
                  submit={async (b) => {
                    await post(`/v1/travel-products/${productId}/departures`, { ...b, startsAt: new Date(String(b.startsAt)).toISOString() });
                    setK(k + 1);
                    toast.show(L('출발일을 추가했어요', 'Departure added'));
                  }}
                />
              </div>
            )}
          </>
        )}
        {tab === 'orders' && (
          <ResourceTable
            path="/v1/supplier/orders"
            columns={[
              { key: 'code|id', label: L('주문번호', 'Order') },
              { key: 'title|productTitle', label: L('상품', 'Product') },
              { key: 'qty|quantity', label: L('인원', 'Qty') },
              { key: 'amountMinor|totalMinor', label: L('금액', 'Total'), kind: 'money' },
              { key: 'status|state', label: L('상태', 'Status'), kind: 'status' },
              { key: 'createdAt', label: L('주문일', 'Ordered'), kind: 'datetime' },
            ]}
            empty={<p className="muted">{L('주문이 없습니다.', 'No orders.')}</p>}
          />
        )}
      </div>
      <Modal open={creating} onClose={() => setCreating(false)} title={L('새 여행 상품', 'New travel product')} wide>
        <FormCard
          cols={2}
          fields={[
            { name: 'title', label: L('상품명', 'Title'), required: true },
            { name: 'type', label: L('유형', 'Type'), type: 'select', required: true, options: ['TOUR', 'TICKET', 'PACKAGE', 'ACTIVITY'].map((t) => ({ value: t, label: t })) },
            { name: 'city', label: L('지역', 'Area'), required: true },
            { name: 'country', label: L('국가 코드', 'Country'), placeholder: 'KR' },
            { name: 'durationMinutes', label: L('소요 시간(분)', 'Duration (minutes)'), type: 'number', min: 1 },
            { name: 'basePriceMinor', label: L('기본가 (원)', 'Base price (KRW)'), type: 'money', required: true },
            { name: 'summary', label: L('요약', 'Summary') },
            { name: 'description', label: L('상품 설명', 'Description'), type: 'textarea' },
            { name: 'cancellationTerms.note', label: L('취소·환불 규정', 'Cancellation terms'), type: 'textarea', required: true },
          ]}
          submit={async (b) => {
            await post('/v1/supplier/products', b);
            setCreating(false);
            setK(k + 1);
            mine.reload();
            toast.show(L('초안으로 저장했어요', 'Saved as draft'));
          }}
          submitLabel={L('초안 저장', 'Save draft')}
        />
      </Modal>
      <Section title={L('안내', 'Notes')}>
        <p className="small muted">{L('공급사는 여행 상품의 계약 당사자로서 상품 정보·취소 규정의 정확성에 책임이 있으며, 결제·정산은 JETPOOL 원장을 통해 처리됩니다.', 'As the contracting party you are responsible for product details and terms; payments and payouts run through the JETPOOL ledger.')}</p>
      </Section>
    </RequireAuth>
  );
}
