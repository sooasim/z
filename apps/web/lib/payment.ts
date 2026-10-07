import { f, item, num, str } from './shape';

/** Normalise `/v1/payments/toss/prepare` response. */
export function parsePrepare(res: any) {
  const p = item(res) ?? {};
  return {
    paymentId: str(p, 'paymentId', 'id', 'payment.id'),
    orderId: str(p, 'orderId', 'providerOrderId', 'payment.orderId'),
    amount: num(p, 'amount', 'amountMinor', 'totalMinor', 'payment.amountMinor') ?? 0,
    currency: str(p, 'currency') || 'KRW',
    orderName: str(p, 'orderName', 'title') || 'JETPOOL',
    clientKey: str(p, 'clientKey', 'tossClientKey'),
    customerKey: str(p, 'customerKey') || 'ANONYMOUS',
    provider: (str(p, 'provider') || (str(p, 'clientKey') ? 'TOSS' : 'MOCK')).toUpperCase(),
    customerEmail: str(p, 'customerEmail'),
    customerName: str(p, 'customerName'),
  };
}
export type Prepared = ReturnType<typeof parsePrepare>;

const APPROVED = ['APPROVED', 'DONE', 'CAPTURED', 'PAID', 'SUCCEEDED', 'CONFIRMED'];
const FAILED = ['FAILED', 'ABORTED', 'CANCELED', 'CANCELLED', 'EXPIRED', 'REJECTED', 'DECLINED'];

/** Map confirm/payment status → UI phase. A browser redirect alone is never treated as approval. */
export function paymentPhase(res: any): 'approved' | 'failed' | 'pending' {
  const p = item(res) ?? {};
  const s = (str(p, 'status', 'state', 'payment.status') || '').toUpperCase();
  if (APPROVED.includes(s)) return 'approved';
  if (FAILED.includes(s)) return 'failed';
  return 'pending';
}

export function paymentSubject(res: any): { type: string; id: string } {
  const p = item(res) ?? {};
  return { type: str(p, 'subjectType', 'payment.subjectType'), id: str(p, 'subjectId', 'payment.subjectId') };
}

export function subjectHref(type: string, id: string): string {
  switch ((type || '').toUpperCase()) {
    case 'RESERVATION':
      return `/trips/${id}`;
    case 'GUIDE_BOOKING':
      return `/guide-bookings/${id}`;
    case 'ORDER':
      return `/orders/${id}`;
    default:
      return '/trips';
  }
}

export function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') return reject(new Error('no document'));
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${src}"]`);
    if (existing) {
      if ((existing as any)._loaded) return resolve();
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('script failed')));
      return;
    }
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => {
      (s as any)._loaded = true;
      resolve();
    };
    s.onerror = () => reject(new Error('script failed'));
    document.head.appendChild(s);
  });
}

export const TOSS_SDK = 'https://js.tosspayments.com/v2/standard';
export { f };
