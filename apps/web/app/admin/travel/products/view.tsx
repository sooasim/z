'use client';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { api, patch, post } from '@/lib/api';
import { arr, item, num, str } from '@/lib/shape';
import { StateView } from '@/components/states';
import { DataTable, ResourceTable, type Column, type RowAction } from '@/components/table';
import { FormCard, type FieldSpec } from '@/components/form';
import { Alert, Button, DateText, Drawer, Kv, Modal, Money, PageHeader, Section, StatusBadge, Tabs } from '@/components/ui';

const TYPES = ['TOUR', 'TICKET', 'ACTIVITY', 'PACKAGE'] as const;
const CURRENCIES = ['KRW', 'USD', 'JPY', 'EUR'] as const;

/** Approved suppliers, for the "register on behalf of" picker. */
function useSupplierOptions() {
  const st = useApi<any>('/v1/admin/suppliers', { query: { status: 'APPROVED' }, auth: true });
  return arr<any>(st.data, 'items').map((s) => ({ value: str(s, 'id'), label: `${str(s, 'name')} · ${str(s, 'merchantOfRecord')}` }));
}

function productFields(L: (ko: string, en: string) => string, supplierOptions: Array<{ value: string; label: string }>, mode: 'create' | 'edit'): FieldSpec[] {
  return [
    ...(mode === 'create'
      ? ([
          { name: 'supplierId', label: L('공급사', 'Supplier'), type: 'select', options: supplierOptions, required: true, hint: L('승인된 공급사만 상품을 소유할 수 있습니다.', 'Only approved suppliers can own a product.') },
          { name: 'type', label: L('상품 유형', 'Product type'), type: 'select', options: TYPES.map((x) => ({ value: x, label: x })), required: true },
        ] as FieldSpec[])
      : []),
    { name: 'title', label: L('상품명', 'Title'), required: true },
    { name: 'city', label: L('도시', 'City') },
    { name: 'country', label: L('국가 코드 (예: KR)', 'Country code'), placeholder: 'KR' },
    { name: 'durationMinutes', label: L('소요 시간', 'Duration'), type: 'number', min: 1, suffix: L('분', 'min') },
    { name: 'basePriceMinor', label: L('기본 가격', 'Base price'), type: 'money' },
    { name: 'currency', label: L('통화', 'Currency'), type: 'select', options: CURRENCIES.map((x) => ({ value: x, label: x })) },
    { name: 'summary', label: L('요약', 'Summary') },
    { name: 'description', label: L('상세 설명', 'Description'), type: 'textarea' },
    { name: 'cancellationTerms', label: L('취소 규정 (JSON)', 'Cancellation terms (JSON)'), type: 'json', placeholder: '{"tiers":[{"min_hours_before":72,"refund_pct":100}]}' },
    ...(mode === 'edit' ? ([{ name: 'reason', label: L('수정 사유 (감사 기록)', 'Reason for the edit (audited)'), required: true }] as FieldSpec[]) : []),
  ];
}

/** Product workspace: staff edit, option list and the departure inventory for one product. */
function ProductDetail({ id, onChanged }: { id: string; onChanged: () => void }) {
  const { L } = useI18n();
  const st = useApi<any>(`/v1/admin/travel-products/${id}`, { auth: true });
  const supplierOptions = useSupplierOptions();
  const [addDeparture, setAddDeparture] = useState(false);
  const reload = () => {
    st.reload();
    onChanged();
  };
  return (
    <StateView state={st}>
      {(d) => {
        const p = item<any>(d) ?? {};
        const status = str(p, 'status');
        const cur = str(p, 'currency') || 'KRW';
        const departures = arr<any>(p, 'departures');
        const options = arr<any>(p, 'options');
        return (
          <div className="stack">
            <Kv
              rows={[
                [L('상태', 'Status'), <StatusBadge key="s" status={status} />],
                [L('공급사', 'Supplier'), `${str(p, 'supplierName') || '—'} (${str(p, 'supplierStatus') || '—'})`],
                [L('유형', 'Type'), str(p, 'type')],
                [L('기본 가격', 'Base price'), num(p, 'basePriceMinor') == null ? '—' : <Money key="m" minor={num(p, 'basePriceMinor')} currency={cur} />],
                ['Slug', str(p, 'slug') || '—'],
                [L('최근 수정', 'Updated'), <DateText key="u" value={str(p, 'updatedAt')} time />],
              ]}
            />
            {str(p, 'supplierStatus') && str(p, 'supplierStatus') !== 'APPROVED' && (
              <Alert tone="warn">{L('공급사가 승인 상태가 아니므로 이 상품은 게시할 수 없습니다.', 'The supplier is not approved, so this product cannot be published.')}</Alert>
            )}

            <Section title={L('출발일 · 재고', 'Departures & inventory')} actions={<Button icon="plus" onClick={() => setAddDeparture(true)}>{L('출발일 추가', 'Add departure')}</Button>}>
              {departures.length === 0 ? (
                <p className="muted">{L('등록된 출발일이 없습니다. 최소 한 개의 가격이 있는 출발일이나 기본 가격이 있어야 게시할 수 있습니다.', 'No departures yet. Publishing needs a base price or at least one priced departure.')}</p>
              ) : (
                <DataTable
                  rows={departures}
                  caption={L('출발일 · 재고', 'Departures & inventory')}
                  onChanged={reload}
                  // the drawer is narrow, so seats are one "booked / capacity" cell rather than three columns
                  columns={[
                    { key: 'startsAt', label: L('출발', 'Departs'), kind: 'datetime', primary: true },
                    { key: 'booked', label: L('예약 / 정원', 'Seats'), align: 'right', render: (r) => `${num(r, 'booked') ?? 0} / ${num(r, 'capacity') ?? 0}` },
                    // a departure with no price of its own inherits the product's base price
                    { key: 'priceMinor', label: L('가격', 'Price'), align: 'right', render: (r) => (num(r, 'priceMinor') == null ? <span className="muted">{L('기본가', 'Base')}</span> : <Money minor={num(r, 'priceMinor')} currency={cur} />) },
                    { key: 'status', label: L('상태', 'Status'), kind: 'status', badge: true },
                  ]}
                  actions={[
                    {
                      label: L('정원·판매 상태', 'Capacity & status'),
                      tone: 'primary',
                      title: L('출발일 수정', 'Update departure'),
                      reason: L('수정 사유', 'Reason'),
                      when: (r) => ['OPEN', 'CLOSED', 'GUARANTEED'].includes(str(r, 'status')),
                      fields: (r) => [
                        { name: 'capacity', label: L('정원', 'Capacity'), type: 'number', min: num(r, 'booked') ?? 0, defaultValue: num(r, 'capacity') ?? 0, hint: L('이미 예약된 좌석 수보다 적게 줄일 수 없습니다.', 'Cannot go below the seats already booked.') },
                        { name: 'status', label: L('판매 상태', 'Sales status'), type: 'select', options: [{ value: 'OPEN', label: L('판매 중 (OPEN)', 'Open') }, { value: 'CLOSED', label: L('판매 중지 (CLOSED)', 'Closed') }], defaultValue: str(r, 'status') === 'CLOSED' ? 'CLOSED' : 'OPEN' },
                      ],
                      run: (r, reason, values) =>
                        patch(`/v1/admin/departures/${str(r, 'id')}`, {
                          reason,
                          ...(values?.capacity === '' || values?.capacity === undefined ? {} : { capacity: Number(values.capacity) }),
                          ...(values?.status ? { status: values.status } : {}),
                        }),
                    },
                    {
                      label: L('출발 취소', 'Cancel departure'),
                      tone: 'danger',
                      menu: true,
                      when: (r) => !['CANCELLED', 'DEPARTED'].includes(str(r, 'status')),
                      reason: L('취소 사유', 'Cancellation reason'),
                      confirm: L('이 출발일의 모든 주문이 취소되고 환불 규정에 따라 환불됩니다. 되돌릴 수 없습니다.', 'Every order on this departure is cancelled and refunded per its terms. This cannot be undone.'),
                      run: (r, reason) => post(`/v1/admin/departures/${str(r, 'id')}/cancel`, { reason }),
                    },
                  ]}
                />
              )}
            </Section>

            <Section title={L('옵션', 'Options')}>
              {options.length === 0 ? (
                <p className="muted">{L('옵션이 없습니다.', 'No options.')}</p>
              ) : (
                <ul className="stack small" style={{ listStyle: 'none', padding: 0 }}>
                  {options.map((o) => (
                    <li key={str(o, 'id')} className="card flat row between">
                      <span>{str(o, 'name')} {!o.active && <span className="badge">{L('비활성', 'Inactive')}</span>}</span>
                      <Money minor={num(o, 'priceMinor')} currency={cur} />
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            <Section title={L('상품 정보 수정', 'Edit product')}>
              <FormCard
                cols={2}
                initial={p}
                fields={productFields(L, supplierOptions, 'edit')}
                submitLabel={L('수정 저장', 'Save changes')}
                submit={async (b) => {
                  await patch(`/v1/admin/travel-products/${id}`, b);
                  reload();
                }}
              />
            </Section>

            <Modal open={addDeparture} onClose={() => setAddDeparture(false)} title={L('출발일 추가', 'Add departure')}>
              <FormCard
                cols={2}
                fields={[
                  { name: 'startsAt', label: L('출발 일시', 'Departs at'), type: 'datetime-local', required: true },
                  { name: 'endsAt', label: L('종료 일시', 'Ends at'), type: 'datetime-local' },
                  { name: 'capacity', label: L('정원', 'Capacity'), type: 'number', min: 1, required: true },
                  { name: 'minParticipants', label: L('최소 인원', 'Min participants'), type: 'number', min: 1, hint: L('최소 인원을 못 채우면 마감 시각에 자동 취소됩니다.', 'Cancelled automatically at the cutoff if unmet.') },
                  { name: 'priceMinor', label: L('출발일 가격 (비우면 기본가)', 'Departure price (blank = base price)'), type: 'money' },
                  { name: 'cutoffAt', label: L('마감 일시', 'Cutoff at'), type: 'datetime-local' },
                ]}
                submitLabel={L('추가', 'Add')}
                submit={async (b) => {
                  const iso = (v: unknown) => (typeof v === 'string' && v ? new Date(v).toISOString() : undefined);
                  await post(`/v1/admin/travel-products/${id}/departures`, { ...b, startsAt: iso(b.startsAt), endsAt: iso(b.endsAt), cutoffAt: iso(b.cutoffAt) });
                  setAddDeparture(false);
                  reload();
                }}
              />
            </Modal>
          </div>
        );
      }}
    </StateView>
  );
}

export default function AdminTravelProductsView() {
  const { L } = useI18n();
  const [tab, setTab] = useState('ALL');
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const [create, setCreate] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const [k, setK] = useState(0);
  const supplierOptions = useSupplierOptions();
  const bump = () => setK((x) => x + 1);

  // Kept deliberately narrow: the row actions sit in the last column, and a wider table pushes them out of view
  // on a laptop. Everything left out (slug, updated-at, the full supplier record) is in the manage drawer.
  const columns: Column[] = [
    { key: 'title', label: L('상품명', 'Title'), primary: true },
    { key: 'supplierName', label: L('공급사', 'Supplier'), render: (r) => str(r, 'supplierName') || str(r, 'seller.name') || '—' },
    { key: 'type', label: L('유형 · 도시', 'Type & city'), hideOnMobile: true, render: (r) => [str(r, 'type'), str(r, 'city')].filter(Boolean).join(' · ') || '—' },
    { key: 'basePriceMinor', label: L('기본 가격', 'Base price'), kind: 'money', align: 'right' },
    { key: 'openDepartures', label: L('출발일', 'Departures'), align: 'right', hideOnMobile: true },
    { key: 'status', label: L('상태', 'Status'), kind: 'status', badge: true },
  ];
  const actions: RowAction[] = [
    { label: L('관리', 'Manage'), tone: 'primary', icon: 'settings', run: async (r) => setDetail(str(r, 'id')) },
    {
      label: L('심사 요청', 'Send to review'),
      menu: true,
      when: (r) => ['DRAFT', 'PAUSED'].includes(str(r, 'status')),
      reason: L('심사 요청 사유', 'Reason'),
      run: (r, reason) => post(`/v1/admin/travel-products/${str(r, 'id')}/submit`, { reason }),
    },
    {
      label: L('게시 승인', 'Publish'),
      menu: true,
      when: (r) => ['IN_REVIEW', 'PAUSED'].includes(str(r, 'status')),
      confirm: L('승인하면 상품이 공개 카탈로그에 노출됩니다.', 'Publishing puts the product in the public catalog.'),
      fields: [{ name: 'note', label: L('심사 메모', 'Review note') }],
      run: (r, _reason, values) => post(`/v1/admin/travel-products/${str(r, 'id')}/publish`, { note: values?.note || undefined }),
    },
    {
      label: L('반려 · 판매 중지', 'Reject / pause'),
      tone: 'danger',
      menu: true,
      when: (r) => str(r, 'status') !== 'ARCHIVED',
      reason: L('반려 사유 (공급사에 전달)', 'Reason (shared with the supplier)'),
      fields: [
        {
          name: 'to',
          label: L('처리 결과', 'Move to'),
          type: 'select',
          options: [
            { value: 'DRAFT', label: L('임시저장으로 반려 (DRAFT)', 'Back to draft') },
            { value: 'PAUSED', label: L('판매 중지 (PAUSED)', 'Pause sales') },
            { value: 'ARCHIVED', label: L('보관 (ARCHIVED, 되돌릴 수 없음)', 'Archive (irreversible)') },
          ],
          defaultValue: 'DRAFT',
          required: true,
        },
      ],
      run: (r, reason, values) => post(`/v1/admin/travel-products/${str(r, 'id')}/reject`, { reason, to: values?.to ?? 'DRAFT' }),
    },
  ];

  // The catalog opens on everything, not on the review queue: an operator arrives here to manage products, and
  // the pending-review count is already a queue card on the dashboard.
  const tabs = [
    { value: 'ALL', label: L('전체', 'All') },
    { value: 'IN_REVIEW', label: L('심사 대기', 'In review') },
    { value: 'PUBLISHED', label: L('판매 중', 'Published') },
    { value: 'DRAFT', label: L('임시저장', 'Draft') },
    { value: 'PAUSED', label: L('판매 중지', 'Paused') },
    { value: 'ARCHIVED', label: L('보관', 'Archived') },
  ];
  return (
    <>
      <PageHeader
        title={L('여행 상품 관리', 'Travel products')}
        subtitle={L('상품 등록, 심사·게시, 출발일과 재고를 관리합니다. 게시는 승인된 공급사와 가격이 있어야 가능합니다.', 'Register products, review and publish them, and manage departures. Publishing needs an approved supplier and a price.')}
        actions={<Button variant="primary" icon="plus" onClick={() => setCreate(true)}>{L('상품 등록', 'Register product')}</Button>}
      />
      <Tabs label={L('여행 상품 관리', 'Travel products')} value={tab} onChange={setTab} tabs={tabs} />
      <form
        className="row"
        style={{ margin: '16px 0' }}
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setSubmitted(q.trim());
        }}
      >
        <label className="sr-only" htmlFor="product-q">{L('상품명, 공급사로 검색', 'Search by title or supplier')}</label>
        <input id="product-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('상품명, 공급사로 검색', 'Search by title or supplier')} style={{ maxWidth: 360 }} />
        <button className="btn">{L('검색', 'Search')}</button>
      </form>
      <ResourceTable
        key={`${tab}:${submitted}:${k}`}
        path="/v1/admin/travel-products"
        query={{ ...(tab === 'ALL' ? {} : { status: tab }), ...(submitted ? { q: submitted } : {}) }}
        columns={columns}
        actions={actions}
        caption={L('여행 상품 관리', 'Travel products')}
        empty={<p className="muted">{L('해당 상태의 상품이 없습니다.', 'No products in this state.')}</p>}
      />

      <Modal open={create} onClose={() => setCreate(false)} title={L('여행 상품 등록', 'Register a travel product')} wide>
        <p className="small muted">
          {L('공급사를 대신해 상품을 등록합니다. 등록된 상품은 임시저장(DRAFT) 상태로 들어가며, 심사 요청 후 게시 승인을 거쳐야 공개됩니다.', 'Registers a product on behalf of a supplier. It starts as a draft and still goes through review and publish before it is public.')}
        </p>
        {supplierOptions.length === 0 && <Alert tone="warn">{L('승인된 공급사가 없습니다. 먼저 공급사를 승인해 주세요.', 'No approved suppliers yet — approve a supplier first.')}</Alert>}
        <FormCard
          cols={2}
          fields={productFields(L, supplierOptions, 'create')}
          submitLabel={L('등록', 'Register')}
          submit={async (b) => {
            const created = await api<any>('/v1/admin/travel-products', { method: 'POST', body: b });
            setCreate(false);
            bump();
            const id = str(item<any>(created) ?? {}, 'id');
            if (id) setDetail(id);
          }}
        />
      </Modal>

      <Drawer open={!!detail} onClose={() => setDetail(null)} title={L('상품 관리', 'Manage product')}>
        {detail && <ProductDetail id={detail} onChanged={bump} />}
      </Drawer>
    </>
  );
}
