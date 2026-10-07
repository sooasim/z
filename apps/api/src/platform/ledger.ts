import type { Db } from './db.js';
import { maybeOne, one } from './db.js';
import type { Ctx } from './context.js';

export type AccountType = 'ASSET' | 'LIABILITY' | 'REVENUE' | 'EXPENSE' | 'EQUITY';

/** Well-known platform accounts. Payee accounts are per user: payeePayable(userId, currency). */
export const PlatformAccount = {
  cashClearing: (cur: string) => ({ code: `PLATFORM:PG_CLEARING:${cur}`, ownerType: 'PLATFORM', accountType: 'ASSET', purpose: 'PG_CLEARING', currency: cur }),
  bank: (cur: string) => ({ code: `PLATFORM:BANK:${cur}`, ownerType: 'PLATFORM', accountType: 'ASSET', purpose: 'BANK', currency: cur }),
  feeRevenue: (cur: string) => ({ code: `PLATFORM:FEE_REVENUE:${cur}`, ownerType: 'PLATFORM', accountType: 'REVENUE', purpose: 'FEE_REVENUE', currency: cur }),
  taxPayable: (cur: string) => ({ code: `PLATFORM:TAX_PAYABLE:${cur}`, ownerType: 'PLATFORM', accountType: 'LIABILITY', purpose: 'TAX_PAYABLE', currency: cur }),
  refundsPayable: (cur: string) => ({ code: `PLATFORM:REFUNDS_PAYABLE:${cur}`, ownerType: 'PLATFORM', accountType: 'LIABILITY', purpose: 'REFUNDS_PAYABLE', currency: cur }),
  /** Funds held for a supplier that is itself the merchant of record (pass-through) */
  passThrough: (cur: string) => ({ code: `PLATFORM:PASS_THROUGH:${cur}`, ownerType: 'PLATFORM', accountType: 'LIABILITY', purpose: 'PASS_THROUGH', currency: cur }),
  payeePayable: (userId: string, cur: string) => ({ code: `PAYEE:${userId}:PAYABLE:${cur}`, ownerType: 'USER', ownerId: userId, accountType: 'LIABILITY', purpose: 'PAYEE_PAYABLE', currency: cur }),
} as const;

export interface AccountSpec { code: string; ownerType: string; ownerId?: string; accountType: string; purpose: string; currency: string }

export async function ensureAccount(db: Db, spec: AccountSpec): Promise<string> {
  const existing = await maybeOne<{ id: string }>(db, `SELECT id FROM ledger_accounts WHERE code = $1`, [spec.code]);
  if (existing) return existing.id;
  const row = await one<{ id: string }>(
    db,
    `INSERT INTO ledger_accounts(code, owner_type, owner_id, account_type, purpose, currency)
     VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
    [spec.code, spec.ownerType, spec.ownerId ?? null, spec.accountType, spec.purpose, spec.currency],
  );
  return row.id;
}

export interface LedgerLine { account: AccountSpec; debit?: number; credit?: number }

/**
 * Post a balanced, immutable double-entry transaction (invariant 11). Idempotent by `idempotencyKey`:
 * re-posting the same key returns the existing transaction id without new entries.
 * Balance is enforced again by a DEFERRED constraint trigger at COMMIT.
 */
export async function postLedger(
  db: Db,
  ctx: Pick<Ctx, 'correlationId'>,
  t: { type: string; sourceType: string; sourceId?: string | null; idempotencyKey: string; memo?: string; reverses?: string | null; lines: LedgerLine[] },
): Promise<{ transactionId: string; created: boolean }> {
  const lines = t.lines.filter((l) => (l.debit ?? 0) > 0 || (l.credit ?? 0) > 0);
  const d = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const c = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  if (lines.length < 2 || d !== c) throw new Error(`unbalanced ledger posting ${t.type}: debit ${d} != credit ${c}`);
  const currencies = new Set(lines.map((l) => l.account.currency));
  if (currencies.size !== 1) throw new Error('ledger transaction must be single-currency');
  for (const l of lines) {
    if (!Number.isInteger(l.debit ?? 0) || !Number.isInteger(l.credit ?? 0)) throw new Error('ledger amounts must be integers');
    if ((l.debit ?? 0) > 0 && (l.credit ?? 0) > 0) throw new Error('a ledger line is either debit or credit');
  }
  const existing = await maybeOne<{ id: string }>(db, `SELECT id FROM ledger_transactions WHERE idempotency_key = $1`, [t.idempotencyKey]);
  if (existing) return { transactionId: existing.id, created: false };
  const tx = await one<{ id: string }>(
    db,
    `INSERT INTO ledger_transactions(transaction_type, source_type, source_id, idempotency_key, reverses_transaction_id, memo, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [t.type, t.sourceType, t.sourceId ?? null, t.idempotencyKey, t.reverses ?? null, t.memo ?? null, ctx.correlationId],
  );
  for (const l of lines) {
    const accountId = await ensureAccount(db, l.account);
    await db.query(
      `INSERT INTO ledger_entries(transaction_id, account_id, debit_minor, credit_minor, currency) VALUES ($1,$2,$3,$4,$5)`,
      [tx.id, accountId, l.debit ?? 0, l.credit ?? 0, l.account.currency],
    );
  }
  return { transactionId: tx.id, created: true };
}

export async function accountBalance(db: Db, code: string): Promise<number> {
  const row = await maybeOne<{ balance_minor: number }>(db, `SELECT balance_minor FROM ledger_balances WHERE code = $1`, [code]);
  return row?.balance_minor ?? 0;
}
