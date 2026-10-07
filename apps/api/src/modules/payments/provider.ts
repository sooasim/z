/**
 * PAY-01 PG adapter boundary. JETPOOL never handles card data (invariant 9): the browser talks to the
 * PG-hosted widget, and the server only sees paymentKey / orderId / amount.
 */
import { randomUUID } from 'node:crypto';

export type ProviderStatus =
  | 'READY'
  | 'IN_PROGRESS'
  | 'WAITING_FOR_DEPOSIT'
  | 'DONE'
  | 'CANCELED'
  | 'PARTIAL_CANCELED'
  | 'ABORTED'
  | 'EXPIRED';

export const PROVIDER_STATUSES: readonly ProviderStatus[] = ['READY', 'IN_PROGRESS', 'WAITING_FOR_DEPOSIT', 'DONE', 'CANCELED', 'PARTIAL_CANCELED', 'ABORTED', 'EXPIRED'];

export interface ProviderPayment {
  paymentKey: string;
  orderId: string;
  status: ProviderStatus;
  totalAmount: number;
  /** remaining (not cancelled) amount */
  balanceAmount: number;
  currency: string;
  method: string | null;
  receiptUrl: string | null;
  approvedAt: string | null;
  cancels: Array<{ cancelAmount: number; transactionKey: string | null; canceledAt: string | null; cancelReason: string | null }>;
}

export class ProviderError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** true when the outcome is unknown or transient (network / 5xx): the caller must reconcile, not fail */
    public readonly retryable: boolean,
    public readonly httpStatus?: number,
  ) {
    super(message);
  }
}

export interface PaymentProvider {
  readonly name: 'TOSS' | 'MOCK';
  /** `currency` is a hint used only by the MOCK provider (Toss derives it from the payment). */
  confirm(args: { paymentKey: string; orderId: string; amount: number; idempotencyKey?: string; currency?: string }): Promise<ProviderPayment>;
  get(paymentKey: string): Promise<ProviderPayment>;
  cancel(args: { paymentKey: string; cancelAmount: number; cancelReason: string; idempotencyKey: string }): Promise<ProviderPayment>;
}

/** Map an arbitrary provider status string to the closed set (unknown → IN_PROGRESS, i.e. "not final"). */
export function normalizeStatus(s: unknown): ProviderStatus {
  return (PROVIDER_STATUSES as readonly string[]).includes(String(s)) ? (s as ProviderStatus) : 'IN_PROGRESS';
}

// ---------------------------------------------------------------------------------------------
// TossPayments REST v1
// ---------------------------------------------------------------------------------------------

/** Toss error codes where the payment was definitively not processed but a retry may succeed. */
const TOSS_RETRYABLE_CODES = new Set(['PROVIDER_ERROR', 'FAILED_INTERNAL_SYSTEM_PROCESSING', 'FAILED_PAYMENT_INTERNAL_SYSTEM_PROCESSING', 'UNKNOWN_PAYMENT_ERROR']);

export function mapTossPayment(p: any): ProviderPayment {
  return {
    paymentKey: String(p?.paymentKey ?? ''),
    orderId: String(p?.orderId ?? ''),
    status: normalizeStatus(p?.status),
    totalAmount: Number(p?.totalAmount ?? 0),
    balanceAmount: Number(p?.balanceAmount ?? p?.totalAmount ?? 0),
    currency: String(p?.currency ?? 'KRW'),
    method: p?.method ?? null,
    receiptUrl: p?.receipt?.url ?? null,
    approvedAt: p?.approvedAt ?? null,
    cancels: Array.isArray(p?.cancels)
      ? p.cancels.map((c: any) => ({
          cancelAmount: Number(c?.cancelAmount ?? 0),
          transactionKey: c?.transactionKey ?? null,
          canceledAt: c?.canceledAt ?? null,
          cancelReason: c?.cancelReason ?? null,
        }))
      : [],
  };
}

export class TossProvider implements PaymentProvider {
  readonly name = 'TOSS' as const;
  private readonly auth: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: { secretKey: string; apiBase: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    if (!opts.secretKey) throw new Error('TOSS_SECRET_KEY is required for the Toss payment provider');
    this.auth = `Basic ${Buffer.from(`${opts.secretKey}:`).toString('base64')}`;
    this.base = opts.apiBase.replace(/\/+$/, '');
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown, idempotencyKey?: string): Promise<ProviderPayment> {
    const headers: Record<string, string> = { Authorization: this.auth, Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err: any) {
      // outcome unknown (timeout / connection reset): never treat as a definitive failure
      throw new ProviderError('NETWORK_ERROR', `Toss request failed: ${err?.name ?? 'error'}`, true);
    }
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      const code = String(json?.code ?? `HTTP_${res.status}`);
      const retryable = res.status >= 500 || res.status === 429 || TOSS_RETRYABLE_CODES.has(code);
      throw new ProviderError(code, String(json?.message ?? `Toss responded ${res.status}`), retryable, res.status);
    }
    return mapTossPayment(json);
  }

  confirm(args: { paymentKey: string; orderId: string; amount: number; idempotencyKey?: string }) {
    return this.request('POST', '/v1/payments/confirm', { paymentKey: args.paymentKey, orderId: args.orderId, amount: args.amount }, args.idempotencyKey);
  }

  get(paymentKey: string) {
    return this.request('GET', `/v1/payments/${encodeURIComponent(paymentKey)}`);
  }

  cancel(args: { paymentKey: string; cancelAmount: number; cancelReason: string; idempotencyKey: string }) {
    return this.request(
      'POST',
      `/v1/payments/${encodeURIComponent(args.paymentKey)}/cancel`,
      { cancelReason: args.cancelReason.slice(0, 200), cancelAmount: args.cancelAmount },
      args.idempotencyKey,
    );
  }
}

// ---------------------------------------------------------------------------------------------
// MOCK provider (dev/test only — rejected in production by config)
// ---------------------------------------------------------------------------------------------

/** Amount that the MOCK provider always rejects (card declined). */
export const MOCK_FAIL_AMOUNT = 4_040_404;

/**
 * Deterministic in-memory PG. Conventions:
 * - paymentKey must start with `mock_`; `mock_fail_*` keys are declined (REJECT_CARD_PAYMENT);
 * - `mock_timeout_*` keys simulate an unknown outcome (retryable NETWORK_ERROR) *after* approving;
 * - amount === MOCK_FAIL_AMOUNT is declined;
 * - cancelReason starting with `MOCK_FAIL` makes cancel fail (retryable PROVIDER_ERROR).
 */
export class MockProvider implements PaymentProvider {
  readonly name = 'MOCK' as const;
  readonly payments = new Map<string, ProviderPayment>();
  private readonly cancelByKey = new Map<string, ProviderPayment>();
  readonly calls: Array<{ op: string; args: unknown }> = [];

  async confirm(args: { paymentKey: string; orderId: string; amount: number; currency?: string }): Promise<ProviderPayment> {
    this.calls.push({ op: 'confirm', args });
    if (!args.paymentKey.startsWith('mock_')) throw new ProviderError('INVALID_PAYMENT_KEY', 'MOCK paymentKey must start with mock_', false, 400);
    const existing = this.payments.get(args.paymentKey);
    if (existing) {
      if (existing.orderId !== args.orderId || existing.totalAmount !== args.amount) throw new ProviderError('ALREADY_PROCESSED_PAYMENT', 'Already processed', false, 400);
      return { ...existing };
    }
    if (args.paymentKey.startsWith('mock_fail_') || args.amount === MOCK_FAIL_AMOUNT) {
      throw new ProviderError('REJECT_CARD_PAYMENT', 'Card was declined (mock)', false, 403);
    }
    const p: ProviderPayment = {
      paymentKey: args.paymentKey,
      orderId: args.orderId,
      status: 'DONE',
      totalAmount: args.amount,
      balanceAmount: args.amount,
      currency: args.currency ?? 'KRW',
      method: 'CARD',
      receiptUrl: `https://mock.pg.local/receipts/${encodeURIComponent(args.paymentKey)}`,
      approvedAt: new Date().toISOString(),
      cancels: [],
    };
    this.payments.set(args.paymentKey, p);
    if (args.paymentKey.startsWith('mock_timeout_')) throw new ProviderError('NETWORK_ERROR', 'Simulated timeout (mock)', true);
    return { ...p };
  }

  async get(paymentKey: string): Promise<ProviderPayment> {
    this.calls.push({ op: 'get', args: { paymentKey } });
    const p = this.payments.get(paymentKey);
    if (!p) throw new ProviderError('NOT_FOUND_PAYMENT', 'Payment not found (mock)', false, 404);
    return { ...p, cancels: [...p.cancels] };
  }

  async cancel(args: { paymentKey: string; cancelAmount: number; cancelReason: string; idempotencyKey: string }): Promise<ProviderPayment> {
    this.calls.push({ op: 'cancel', args });
    const prev = this.cancelByKey.get(args.idempotencyKey);
    if (prev) return { ...prev };
    if (args.cancelReason.startsWith('MOCK_FAIL')) throw new ProviderError('PROVIDER_ERROR', 'Simulated cancel failure (mock)', true, 500);
    const p = this.payments.get(args.paymentKey);
    if (!p) throw new ProviderError('NOT_FOUND_PAYMENT', 'Payment not found (mock)', false, 404);
    if (args.cancelAmount <= 0 || args.cancelAmount > p.balanceAmount) throw new ProviderError('NOT_CANCELABLE_AMOUNT', 'Cancel amount exceeds balance', false, 400);
    p.balanceAmount -= args.cancelAmount;
    p.status = p.balanceAmount === 0 ? 'CANCELED' : 'PARTIAL_CANCELED';
    p.cancels.push({ cancelAmount: args.cancelAmount, transactionKey: `mock_tx_${randomUUID()}`, canceledAt: new Date().toISOString(), cancelReason: args.cancelReason });
    const snap = { ...p, cancels: [...p.cancels] };
    this.cancelByKey.set(args.idempotencyKey, snap);
    return { ...snap };
  }
}
