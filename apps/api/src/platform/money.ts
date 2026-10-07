import { z } from 'zod';
import { badRequest } from './errors.js';

/** All amounts are integer minor units (KRW has 0 decimals; USD cents, etc.). */
export const SUPPORTED_CURRENCIES = ['KRW', 'USD', 'JPY', 'EUR'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];
export const currencySchema = z.enum(SUPPORTED_CURRENCIES);
export const minorSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** basis points of an amount, rounded half-up (deterministic). */
export function applyBps(amountMinor: number, bps: number): number {
  if (!Number.isInteger(amountMinor) || !Number.isInteger(bps)) throw new Error('integer inputs required');
  return Math.floor((amountMinor * bps + 5000) / 10000);
}

export function assertSameCurrency(a: string, b: string) {
  if (a !== b) throw badRequest('CURRENCY_MISMATCH', `Currency mismatch: ${a} vs ${b}`);
}

/** Split `total` into parts proportional to `weights` with the remainder going to the largest part (sums exactly). */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const parts = weights.map((w) => Math.floor((total * w) / sum));
  let rem = total - parts.reduce((a, b) => a + b, 0);
  const order = weights.map((w, i) => [w, i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; rem > 0; k = (k + 1) % order.length, rem--) parts[order[k][1]]++;
  return parts;
}
