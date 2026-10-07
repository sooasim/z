/**
 * FIN-02 payout execution boundary. JETPOOL stores only tokenized account references (never full
 * account numbers). `payout.automatic` OFF → MANUAL bank-transfer export (CSV) and operator mark-paid.
 */
import { randomUUID } from 'node:crypto';

export interface PayoutInstruction {
  settlementId: string;
  amountMinor: number;
  currency: string;
  bankCode: string;
  accountToken: string;
  holderName: string;
  idempotencyKey: string;
}

export interface PayoutResult { status: 'PAID' | 'PENDING'; payoutRef: string }

export interface PayoutProvider {
  readonly name: 'MOCK' | 'MANUAL';
  execute(i: PayoutInstruction): Promise<PayoutResult>;
}

/** Deterministic dev/test payout rail (forbidden in production by registration logic). */
export class MockPayoutProvider implements PayoutProvider {
  readonly name = 'MOCK' as const;
  private readonly done = new Map<string, PayoutResult>();
  async execute(i: PayoutInstruction): Promise<PayoutResult> {
    const prev = this.done.get(i.idempotencyKey);
    if (prev) return prev;
    if (i.accountToken.startsWith('fail_')) throw new Error('MOCK payout rejected');
    const r: PayoutResult = { status: 'PAID', payoutRef: `mock_payout_${randomUUID()}` };
    this.done.set(i.idempotencyKey, r);
    return r;
  }
}

/** Manual rail: nothing is sent; operators transfer from the CSV export and mark the settlement paid. */
export class ManualPayoutProvider implements PayoutProvider {
  readonly name = 'MANUAL' as const;
  async execute(i: PayoutInstruction): Promise<PayoutResult> {
    return { status: 'PENDING', payoutRef: `manual:${i.settlementId}` };
  }
}

const csvCell = (v: unknown) => {
  const s = String(v ?? '');
  // neutralise spreadsheet formula injection and quote
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function payoutCsv(rows: Array<{ settlement_id: string; payee_id: string; bank_code: string; account_last4: string; account_token: string; holder_name: string; net_minor: number; currency: string }>): string {
  const header = ['settlement_id', 'payee_id', 'bank_code', 'account_last4', 'account_token', 'holder_name', 'amount_minor', 'currency'];
  const lines = rows.map((r) => [r.settlement_id, r.payee_id, r.bank_code, r.account_last4, r.account_token, r.holder_name, r.net_minor, r.currency].map(csvCell).join(','));
  return [header.join(','), ...lines].join('\n') + '\n';
}
