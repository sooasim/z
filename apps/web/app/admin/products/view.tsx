'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api, post } from '@/lib/api';
import { items, str } from '@/lib/shape';
import { productView } from '@/lib/domain';
import { ResourceTable } from '@/components/table';
import { FormCard } from '@/components/form';
import { Modal, PageHeader, Section, Tabs, Button } from '@/components/ui';
import { useToast } from '@/components/ui/toast';

/**
 * ADMIN · travel products (`/admin/products`).
 *
 * Head office authors its own products here — the console used to be review-only, because a product hangs off
 * a supplier and there was no supplier row for the platform itself. Creating one lands on the in-house supplier
 * (`suppliers.is_house`, created on the first save) and runs the same draft → review → published path as a
 * third-party product, so the catalogue, orders and the ledger stay one code path.
 *
 * Third-party products appear in the same list but are review-only: editing another company's product content
 * is theirs to do, not ours, so those rows offer publish / pause / reject and nothing else.
 */

type Tab = 'products' | 'departures' | 'orders';

const PRODUCT_FIELDS = (L: (ko: string, en: string) => string) => [
  { name: 'title', label: L('상품명', 'Title'), required: true },
  { name: 'city', label: L('지역', 'Area'), required: true },
  { name: 'country', label: L('국가 코드', 'Country'), placeholder: 'KR' },
  { name: 'durationMinutes', label: L('소요 시간(분)', 'Duration (minutes)'), type: 'number' as const, min: 1 },
  { name: 'basePriceMinor', label: L('기본가 (원)', 'Base price (KRW)'), type: 'money' as const, required: true },
  { name: 'summary', label: L('요약', 'Summary') },
  { name: 'description', label: L('상품 설명', 'Description'), type: 'textarea' as const },
  { name: 'cancellationTerms.note', label: L('취소·환불 규정', 'Cancellation terms'), type: 'textarea' as const, required: true },
];

/**
 * Only the in-house rows are ours to edit; everything else is a supplier's own content. The flag rides on the
 * admin list row (`isHouse`) — the public product DTO does not carry it, so this never reads from one.
 */
const isHouse = (r: any) => !!r?.isHouse;
const status = (r: any) => str(r, 'status').toUpperCase();

export default function AdminProductsView() {
  const { L } = useI18n();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('products');
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<any>(null);
  const [k, setK] = useState(0);
  const [pid, setPid] = useState('');
  // The in-house products, for the departure picker: inventory is only ours to set on our own products.
  const house = useApi<any>('/v1/supplier/products', { auth: true });
  const houseProducts = items(house.data);
  const productId = pid || str(houseProducts[0], 'id');
  const bump = () => {
    setK(k + 1);
    house.reload();
  };

  return (
    <>
      <PageHeader
        title={L('관광 상품', 'Travel products')}
        subtitle={L('본사 직영 상품을 직접 등록·수정하고 공개합니다. 외부 공급사 상품은 같은 목록에서 검수·공개·중지만 합니다.', 'Author and publish in-house products here; third-party products are listed for review only.')}
        actions={
          <Button variant="primary" icon="plus" onClick={() => setCreating(true)}>
            {L('상품 등록', 'New product')}
          </Button>
        }
      />
      <Tabs
        label={L('메뉴', 'Sections')}
        value={tab}
        onChange={(v) => { setTab(v); setK(k + 1); }}
        tabs={[
          { value: 'products', label: L('상품', 'Products') },
          { value: 'departures', label: L('출발일·재고', 'Departures & inventory') },
          { value: 'orders', label: L('주문', 'Orders') },
        ]}
      />
      <Section>
        {tab === 'products' && (
          <ResourceTable
            key={k}
            path="/v1/admin/travel-products"
            columns={[
              { key: 'title', label: L('상품명', 'Title'), primary: true },
              { key: 'seller.name', label: L('공급사', 'Supplier'), render: (r) => <>{str(r, 'seller.name') || '—'}{isHouse(r) ? <> · <span className="badge accent">{L('직영', 'In-house')}</span></> : null}</> },
              { key: 'type', label: L('유형', 'Type') },
              { key: 'city', label: L('지역', 'Area') },
              { key: 'basePriceMinor', label: L('기본가', 'Base price'), kind: 'money' },
              { key: 'status', label: L('상태', 'Status'), kind: 'status', badge: true },
              { key: 'updatedAt', label: L('수정일', 'Updated'), kind: 'date', hideOnMobile: true },
            ]}
            actions={[
              {
                label: L('수정', 'Edit'),
                when: (r) => isHouse(r) && status(r) !== 'ARCHIVED',
                run: async (r) => {
                  // The list has no options, so load the full row before filling the form.
                  const one = await api(`/v1/supplier/products/${str(r, 'id')}`);
                  setEditing((one as any)?.item ?? r);
                },
              },
              {
                label: L('바로 공개', 'Publish now'),
                tone: 'primary',
                when: (r) => isHouse(r) && ['DRAFT', 'PAUSED'].includes(status(r)),
                confirm: L('이 상품을 지금 공개할까요? 검수 요청과 공개를 한 번에 처리합니다.', 'Publish this product now? This submits it for review and publishes it in one step.'),
                run: async (r) => {
                  // Our own product, reviewed by the person writing it: the FSM still wants IN_REVIEW first, so
                  // this walks both steps rather than skipping the state the publish route expects.
                  await post(`/v1/supplier/products/${str(r, 'id')}/submit`, {});
                  return post(`/v1/admin/travel-products/${str(r, 'id')}/publish`, { note: 'in-house' });
                },
              },
              { label: L('검수 요청', 'Submit for review'), when: (r) => isHouse(r) && status(r) === 'DRAFT', run: (r) => post(`/v1/supplier/products/${str(r, 'id')}/submit`, {}) },
              { label: L('공개', 'Publish'), tone: 'primary', when: (r) => ['IN_REVIEW', 'PAUSED'].includes(status(r)), fields: () => [{ name: 'note', label: L('검수 메모 (선택)', 'Review note (optional)') }], run: (r, _reason, v) => post(`/v1/admin/travel-products/${str(r, 'id')}/publish`, { note: v?.note || undefined }) },
              { label: L('반려', 'Reject'), when: (r) => status(r) === 'IN_REVIEW', reason: L('반려 사유 (공급사에 전달됩니다)', 'Reason (shared with the supplier)'), run: (r, reason) => post(`/v1/admin/travel-products/${str(r, 'id')}/reject`, { reason, to: 'DRAFT' }) },
              { label: L('판매 중지', 'Pause'), tone: 'danger', when: (r) => status(r) === 'PUBLISHED', reason: L('중지 사유', 'Reason'), run: (r, reason) => post(`/v1/admin/travel-products/${str(r, 'id')}/reject`, { reason, to: 'PAUSED' }) },
              { label: L('보관', 'Archive'), tone: 'danger', menu: true, when: (r) => status(r) !== 'ARCHIVED', reason: L('보관 사유', 'Reason'), run: (r, reason) => post(`/v1/admin/travel-products/${str(r, 'id')}/reject`, { reason, to: 'ARCHIVED' }) },
            ]}
            empty={<p className="muted">{L('등록된 상품이 없습니다. 오른쪽 위 ‘상품 등록’으로 직영 상품을 만들 수 있습니다.', 'No products yet — use “New product” to author one in-house.')}</p>}
          />
        )}

        {tab === 'departures' && (
          <>
            {houseProducts.length === 0 ? (
              <p className="muted">{L('직영 상품을 먼저 등록하세요. 출발일·재고는 직영 상품에만 설정합니다 — 외부 공급사 재고는 공급사가 관리합니다.', 'Author an in-house product first. Departures are set on in-house products only; a supplier manages its own.')}</p>
            ) : (
              <>
                <label className="field" style={{ maxWidth: 420 }}>
                  <span>{L('상품', 'Product')}</span>
                  <select value={productId} onChange={(e) => setPid(e.target.value)}>
                    {houseProducts.map((p: any) => {
                      const v = productView(p);
                      return (
                        <option key={v.id} value={v.id}>
                          {v.title}
                        </option>
                      );
                    })}
                  </select>
                </label>
                {productId && (
                  <div className="grid-2" style={{ marginTop: 16 }}>
                    <ResourceTable
                      key={productId + k}
                      path={`/v1/travel-products/${productId}/departures`}
                      query={{ includePast: 'true' }}
                      columns={[
                        { key: 'startsAt', label: L('출발', 'Departure'), kind: 'datetime', primary: true },
                        { key: 'capacity', label: L('정원', 'Capacity') },
                        { key: 'booked', label: L('예약', 'Booked') },
                        { key: 'remaining', label: L('잔여', 'Left') },
                        { key: 'priceMinor', label: L('가격', 'Price'), kind: 'money' },
                        { key: 'status', label: L('상태', 'Status'), kind: 'status', badge: true },
                      ]}
                      actions={[
                        { label: L('정원 변경', 'Capacity'), fields: () => [{ name: 'capacity', label: L('정원', 'Capacity'), type: 'number', min: 0 }], run: (r, _reason, v) => api(`/v1/supplier/departures/${str(r, 'id')}`, { method: 'PATCH', body: { capacity: Number(v?.capacity) } }) },
                        { label: L('마감', 'Close'), when: (r) => ['OPEN', 'GUARANTEED'].includes(str(r, 'status').toUpperCase()), run: (r) => api(`/v1/supplier/departures/${str(r, 'id')}`, { method: 'PATCH', body: { status: 'CLOSED' } }) },
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
                        bump();
                        toast.show(L('출발일을 추가했어요', 'Departure added'));
                      }}
                    />
                  </div>
                )}
              </>
            )}
          </>
        )}

        {tab === 'orders' && (
          <>
            <p className="muted small">{L('직영 상품의 주문입니다. 전체 결제·환불은 결제 메뉴에서 봅니다.', 'Orders for in-house products. All payments and refunds live under Payments.')}</p>
            <ResourceTable
              key={k}
              path="/v1/supplier/orders"
              columns={[
                { key: 'code|id', label: L('주문번호', 'Order'), primary: true },
                { key: 'title|productTitle', label: L('상품', 'Product') },
                { key: 'qty|quantity', label: L('인원', 'Qty') },
                { key: 'amountMinor|totalMinor', label: L('금액', 'Total'), kind: 'money' },
                { key: 'status|state', label: L('상태', 'Status'), kind: 'status', badge: true },
                { key: 'createdAt', label: L('주문일', 'Ordered'), kind: 'datetime', hideOnMobile: true },
              ]}
              empty={<p className="muted">{L('주문이 없습니다.', 'No orders.')}</p>}
            />
          </>
        )}
      </Section>

      <Modal open={creating} onClose={() => setCreating(false)} title={L('새 여행 상품', 'New travel product')} wide>
        <FormCard
          cols={2}
          fields={[
            { name: 'type', label: L('유형', 'Type'), type: 'select', required: true, options: ['TOUR', 'TICKET', 'PACKAGE', 'ACTIVITY'].map((v) => ({ value: v, label: v })) },
            ...PRODUCT_FIELDS(L),
          ]}
          submit={async (b) => {
            await post('/v1/supplier/products', b);
            setCreating(false);
            bump();
            toast.show(L('직영 상품 초안으로 저장했어요', 'Saved as an in-house draft'));
          }}
          submitLabel={L('초안 저장', 'Save draft')}
        />
      </Modal>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={L('상품 수정', 'Edit product')} wide>
        {editing && (
          <FormCard
            cols={2}
            initial={editing}
            fields={PRODUCT_FIELDS(L)}
            submit={async (b) => {
              await api(`/v1/supplier/products/${str(editing, 'id')}`, { method: 'PATCH', body: b });
              setEditing(null);
              bump();
              toast.show(L('저장했어요', 'Saved'));
            }}
            submitLabel={L('저장', 'Save')}
            after={
              <p className="small muted" style={{ margin: 0 }}>
                {L('공개 중인 상품의 내용을 바꾸면 다시 검수 대기(IN_REVIEW)로 내려가고, 목록에서 ‘공개’를 눌러야 다시 판매됩니다.', 'Editing a published product sends it back to review; press Publish in the list to put it back on sale.')}
              </p>
            }
          />
        )}
      </Modal>

      <Section title={L('안내', 'Notes')}>
        <p className="small muted">
          {L(
            '직영 상품의 판매자·결제 책임 주체는 JETPOOL입니다. 외부 공급사 상품은 공급사가 계약 당사자이므로, 상품 내용은 공급사 센터에서 공급사가 수정합니다 — 본사는 검수·공개·중지로 관여합니다. 모든 등록·수정·공개는 감사 로그에 남습니다.',
            'JETPOOL is the seller of record for in-house products. A third-party product belongs to its supplier, who edits its content in the supplier extranet; head office publishes, pauses or rejects it. Every change here is audit-logged.',
          )}
        </p>
      </Section>
    </>
  );
}
