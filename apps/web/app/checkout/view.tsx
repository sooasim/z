'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useApi } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { item, str, num, arr } from '@/lib/shape';
import { RequireAuth } from '@/components/gate';
import { StateView } from '@/components/states';
import { TossPayment } from '@/components/payment';
import { Alert, Money, PageHeader, StatusBadge } from '@/components/ui';

/** Generic checkout for travel orders and paid guide bookings: /checkout?type=ORDER|GUIDE_BOOKING&id=… */
function Inner() {
  const sp = useSearchParams();
  const { L } = useI18n();
  const type = (sp.get('type') ?? 'ORDER').toUpperCase() as 'ORDER' | 'GUIDE_BOOKING' | 'RESERVATION';
  const id = sp.get('id') ?? '';
  const path = !id ? null : type === 'ORDER' ? `/v1/orders/${id}` : type === 'GUIDE_BOOKING' ? `/v1/guide-bookings/${id}` : `/v1/reservations/${id}`;
  const st = useApi<any>(path, { auth: true });
  if (!id)
    return (
      <Alert tone="warn">
        {L('결제할 주문이 없습니다.', 'Nothing to pay for.')} <Link href="/travel">{L('여행 상품 보기', 'Browse travel')}</Link>
      </Alert>
    );
  return (
    <StateView state={st}>
      {(d) => {
        const o = item(d);
        const lines = arr(o, 'items', 'lines', 'orderItems');
        return (
          <div className="grid-2">
            <section className="card stack">
              <h2>{L('결제', 'Payment')}</h2>
              <TossPayment subjectType={type} subjectId={id} />
            </section>
            <aside className="card stack">
              <h2>{L('주문 요약', 'Summary')}</h2>
              <StatusBadge status={str(o, 'status', 'state')} />
              <ul className="price-lines" style={{ listStyle: 'none', padding: 0 }}>
                {lines.map((l: any, i: number) => (
                  <li key={i} className="line">
                    <span>
                      {str(l, 'title', 'name', 'productTitle')} × {num(l, 'qty', 'quantity') ?? 1}
                    </span>
                    <Money minor={num(l, 'amountMinor', 'totalMinor')} currency={str(o, 'currency') || 'KRW'} />
                  </li>
                ))}
                <li className="line total">
                  <span>{L('총액', 'Total')}</span>
                  <Money minor={num(o, 'totalMinor', 'amountMinor', 'priceMinor')} currency={str(o, 'currency') || 'KRW'} />
                </li>
              </ul>
            </aside>
          </div>
        );
      }}
    </StateView>
  );
}

export default function CheckoutView() {
  const { L } = useI18n();
  return (
    <RequireAuth>
      <PageHeader title={L('결제하기', 'Checkout')} />
      <Inner />
    </RequireAuth>
  );
}
