'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { useApi } from '@/lib/hooks';
import { post } from '@/lib/api';
import { arr, item, str, num } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { Alert, ErrorText, PageHeader, PriceBreakdown, StatusPill, Timeline, Section } from '@/components/ui';

export default function OrderDetailView() {
  const { id } = useParams<{ id: string }>();
  const { L } = useI18n();
  const st = useApi<any>(`/v1/orders/${id}`, { auth: true });
  const [err, setErr] = useState<unknown>(null);
  return (
    <RequireAuth>
      <StateView state={st} skeleton="detail">
        {(d) => {
          const o = item(d);
          const status = str(o, 'status', 'state').toUpperCase();
          const lines = arr<any>(o, 'items', 'lines', 'orderItems');
          const cur = str(o, 'currency') || 'KRW';
          return (
            <>
              <PageHeader title={`${L('주문', 'Order')} ${str(o, 'code') || '#' + str(o, 'id').slice(0, 8)}`} back="/trips?tab=orders" actions={<StatusPill status={status} />} />
              {status === 'PAYMENT_PENDING' && <Alert tone="warn">{L('결제가 완료되지 않았습니다.', 'Payment not completed.')} <Link href={`/checkout?type=ORDER&id=${id}`}>{L('결제하기', 'Pay now')}</Link></Alert>}
              <div className="grid-2">
                <section className="card stack">
                  <h2>{L('주문 상품', 'Items')}</h2>
                  <PriceBreakdown currency={cur} totalMinor={num(o, 'totalMinor', 'amountMinor') ?? 0} lines={[...lines.map((l) => ({ label: `${str(l, 'title', 'productTitle', 'name')} × ${num(l, 'qty', 'quantity') ?? 1}`, amountMinor: num(l, 'amountMinor', 'totalMinor') ?? 0 })), ...(num(o, 'feeMinor') ? [{ label: L('서비스 수수료', 'Service fee'), amountMinor: num(o, 'feeMinor')! }] : [])]} />
                  {lines.some((l) => arr(l, 'vouchers').length) && (
                    <div className="stack">
                      <h3>{L('바우처', 'Vouchers')}</h3>
                      {lines.flatMap((l) => arr<any>(l, 'vouchers')).map((v, i) => <div key={i} className="card flat row between"><span className="mono">{str(v, 'code')}</span><StatusPill status={str(v, 'status')} /></div>)}
                    </div>
                  )}
                  <p className="small muted">{L('바우처는 확정 후 이메일과 이 페이지에서 확인할 수 있어요.', 'Vouchers appear here and by email after confirmation.')}</p>
                  {['CONFIRMED', 'PAID'].includes(status) && (
                    <button className="btn danger" style={{ justifySelf: 'start' }} onClick={async () => { if (!window.confirm(L('주문을 취소할까요? 공급사 규정에 따라 환불됩니다.', 'Cancel order? Refunds follow supplier terms.'))) return; setErr(null); try { await post(`/v1/orders/${id}/cancel`, { reason: 'BUYER_REQUEST' }, { idempotencyKey: `ocancel-${id}` }); st.reload(); } catch (e) { setErr(e); } }}>{L('주문 취소', 'Cancel order')}</button>
                  )}
                  <ErrorText error={err} />
                </section>
                <aside className="card">
                  <Section title={L('진행 상태', 'Status history')}>
                    <Timeline events={arr<any>(o, 'history', 'transitions').map((h) => ({ status: str(h, 'toState', 'to', 'status'), at: str(h, 'createdAt', 'at'), note: str(h, 'reason') }))} />
                  </Section>
                </aside>
              </div>
            </>
          );
        }}
      </StateView>
    </RequireAuth>
  );
}
