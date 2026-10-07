import { arr, item, num, str } from './shape';

export function quoteView(res: any) {
  const q = item(res) ?? {};
  const lines = arr(q, 'lines', 'breakdown', 'items', 'lineItems').map((l: any) => ({
    label: str(l, 'label', 'name', 'description', 'code', 'type'),
    code: str(l, 'code', 'type', 'kind'),
    amountMinor: num(l, 'amountMinor', 'amount', 'totalMinor') ?? 0,
  }));
  if (lines.length === 0) {
    // API shape (STAY-07): subtotal/cleaning/platform fee/tax/discount fields + breakdown.
    const nights = num(q, 'nights', 'breakdown.nightsCount');
    const add = (code: string, label: string, v: number | undefined, sign = 1) => {
      if (v !== undefined && v !== 0) lines.push({ code, label, amountMinor: sign * Math.abs(v) });
    };
    add('NIGHTLY', nights ? `NIGHTLY×${nights}` : 'NIGHTLY', num(q, 'subtotalMinor'));
    add('CLEANING', 'CLEANING', num(q, 'cleaningFeeMinor'));
    add('SERVICE_FEE', 'SERVICE_FEE', num(q, 'platformFeeMinor', 'guestFeeMinor'));
    add('TAX', 'TAX', num(q, 'taxMinor'));
    add('DISCOUNT', 'DISCOUNT', num(q, 'discountMinor'), -1);
  }
  return {
    id: str(q, 'id', 'quoteId'),
    propertyId: str(q, 'propertyId'),
    checkIn: str(q, 'checkIn', 'startDate', 'start'),
    checkOut: str(q, 'checkOut', 'endDate', 'end'),
    guests: num(q, 'guests', 'guestCount'),
    nights: num(q, 'nights', 'breakdown.nightsCount'),
    currency: str(q, 'currency') || 'KRW',
    totalMinor: num(q, 'totalMinor', 'totalAmountMinor', 'amountMinor', 'total') ?? lines.reduce((s, l) => s + l.amountMinor, 0),
    lines,
    expiresAt: str(q, 'expiresAt', 'expires_at', 'validUntil'),
    cancellationPolicy: str(q, 'cancellationPolicy', 'cancellationPolicyCode'),
  };
}
export type QuoteView = ReturnType<typeof quoteView>;

export const quoteStoreKey = (id: string) => `jp_quote_${id}`;
export function stashQuote(q: any) {
  try {
    const v = quoteView(q);
    if (v.id) sessionStorage.setItem(quoteStoreKey(v.id), JSON.stringify(q));
  } catch {
    /* ignore */
  }
}
export function readQuote(id: string): any | null {
  try {
    const s = sessionStorage.getItem(quoteStoreKey(id));
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}
/** Stable idempotency key per (scope, id), persisted for the tab session so reloads replay rather than duplicate. */
export function stableKey(scope: string, id: string, gen: () => string): string {
  const k = `jp_idem_${scope}_${id}`;
  try {
    const existing = sessionStorage.getItem(k);
    if (existing) return existing;
    const v = gen();
    sessionStorage.setItem(k, v);
    return v;
  } catch {
    return gen();
  }
}
