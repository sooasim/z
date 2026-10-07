import type { Db } from '../../platform/db.js';
import { q } from '../../platform/db.js';
import { applyBps } from '../../platform/money.js';

/**
 * FIN-03 fee/tax rule evaluation (contract consumed by booking, guide, travel).
 * (Initial minimal version by the Booking agent; extended by the Finance agent — same signature.)
 *
 * - Only APPROVED, effective-dated `finance_rules` rows are used (invariant 8). With no approved rule
 *   every component is 0: there are no hard-coded rates anywhere.
 * - Lookup: rule_type ∈ {PLATFORM_FEE, HOST_FEE, TAX}, domain = args.domain or '*', jurisdiction 'KR',
 *   effective_from <= at < effective_until. A domain-specific rule wins over '*'; then the latest effective_from.
 * - params: `{bps}` (basis points) or `{flat_minor}`; optional `currency` (rule ignored for other currencies),
 *   `min_minor` / `max_minor` clamps.
 * - TAX is computed on the guest platform fee (VAT on service fee) unless `params.base = 'TOTAL'`
 *   (then on amountMinor) or `params.base = 'FEES'` (platform fee + host fee). `params.inclusive = true`
 *   means the tax is already included in the fee: the inclusive portion is reported and nothing is added.
 * - rulesVersion maps rule_type → finance_rules.id so a quote snapshot pins the exact rule versions
 *   (rule changes never retroactively mutate historical transactions).
 */
export const FEE_JURISDICTION = 'KR';

export interface FeeQuote {
  platformFeeMinor: number;
  taxMinor: number;
  hostFeeMinor: number;
  rulesVersion: Record<string, string>;
}

function componentFor(params: any, base: number): number {
  let v = 0;
  if (params && Number.isInteger(params.bps)) v = applyBps(base, params.bps);
  else if (params && Number.isInteger(params.flat_minor)) v = params.flat_minor;
  if (params && Number.isInteger(params.min_minor)) v = Math.max(v, params.min_minor);
  if (params && Number.isInteger(params.max_minor)) v = Math.min(v, params.max_minor);
  return Math.max(0, v);
}

export async function quoteFees(
  db: Db,
  args: { domain: 'STAY' | 'GUIDE' | 'TRAVEL' | 'EXCHANGE'; amountMinor: number; currency: string; at?: Date },
): Promise<{ platformFeeMinor: number; taxMinor: number; hostFeeMinor: number; rulesVersion: Record<string, string> }> {
  const at = args.at ?? new Date();
  const rows = await q<{ id: string; rule_type: string; domain: string; params: any }>(
    db,
    `SELECT DISTINCT ON (rule_type) id, rule_type, domain, params
       FROM finance_rules
      WHERE status = 'APPROVED' AND rule_type IN ('PLATFORM_FEE','TAX','HOST_FEE')
        AND domain IN ($1, '*') AND jurisdiction = $3
        AND effective_from <= $2 AND (effective_until IS NULL OR effective_until > $2)
        AND (params->>'currency' IS NULL OR params->>'currency' = $4)
      ORDER BY rule_type, (domain = $1) DESC, effective_from DESC, id`,
    [args.domain, at, FEE_JURISDICTION, args.currency],
  );
  const byType = new Map(rows.map((r) => [r.rule_type, r]));
  const out: FeeQuote = { platformFeeMinor: 0, taxMinor: 0, hostFeeMinor: 0, rulesVersion: {} };
  const amount = Math.max(0, Math.trunc(args.amountMinor));
  const pf = byType.get('PLATFORM_FEE');
  if (pf) {
    out.platformFeeMinor = componentFor(pf.params, amount);
    out.rulesVersion.PLATFORM_FEE = pf.id;
  }
  const hf = byType.get('HOST_FEE');
  if (hf) {
    out.hostFeeMinor = componentFor(hf.params, amount);
    out.rulesVersion.HOST_FEE = hf.id;
  }
  const tax = byType.get('TAX');
  if (tax) {
    const p = tax.params ?? {};
    const base = p.base === 'TOTAL' ? amount : p.base === 'FEES' ? out.platformFeeMinor + out.hostFeeMinor : out.platformFeeMinor;
    if (p.inclusive === true && Number.isInteger(p.bps) && p.bps > 0) {
      // tax already inside the base: report nothing extra to charge
      out.taxMinor = 0;
    } else {
      out.taxMinor = componentFor(p, base);
    }
    out.rulesVersion.TAX = tax.id;
  }
  return out;
}
