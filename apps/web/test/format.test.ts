import { describe, expect, it } from 'vitest';
import { addDays, currencyExponent, eachNight, formatMoney, monthGrid, nightsBetween, parseDateRange, rangesOverlap, toMinor, validRange } from '@/lib/format';

describe('money formatting (integer minor units)', () => {
  it('formats KRW with 0 decimals in ko-KR', () => {
    expect(formatMoney(120000, 'KRW', 'ko')).toBe('₩120,000');
  });
  it('formats KRW in en-US', () => {
    expect(formatMoney(5000, 'KRW', 'en')).toBe('₩5,000');
  });
  it('formats USD minor units as cents', () => {
    expect(formatMoney(12345, 'USD', 'en')).toBe('$123.45');
  });
  it('accepts numeric strings (bigint from API) and bigint', () => {
    expect(formatMoney('9900', 'KRW', 'ko')).toBe('₩9,900');
    expect(formatMoney(BigInt(1000), 'KRW', 'ko')).toBe('₩1,000');
  });
  it('returns em dash for missing/invalid values', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
    expect(formatMoney('abc')).toBe('—');
  });
  it('knows currency exponents', () => {
    expect(currencyExponent('KRW')).toBe(0);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('USD')).toBe(2);
    expect(currencyExponent('KWD')).toBe(3);
  });
  it('parses user input into minor units without floats', () => {
    expect(toMinor('120,000', 'KRW')).toBe(120000);
    expect(toMinor('19.99', 'USD')).toBe(1999);
    expect(toMinor('0.1', 'USD')).toBe(10);
    expect(toMinor('', 'KRW')).toBe(0);
  });
});

describe('date ranges (half-open nights)', () => {
  it('counts nights', () => {
    expect(nightsBetween('2026-11-01', '2026-11-05')).toBe(4);
    expect(nightsBetween('2026-11-05', '2026-11-01')).toBe(0);
    expect(nightsBetween('bad', '2026-11-01')).toBe(0);
  });
  it('handles month/year boundaries and DST-free UTC math', () => {
    expect(nightsBetween('2026-12-30', '2027-01-02')).toBe(3);
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });
  it('validates and enumerates ranges', () => {
    expect(validRange('2026-11-01', '2026-11-02')).toBe(true);
    expect(validRange('2026-11-01', '2026-11-01')).toBe(false);
    expect(eachNight('2026-11-01', '2026-11-04')).toEqual(['2026-11-01', '2026-11-02', '2026-11-03']);
  });
  it('detects overlap with half-open semantics (checkout day is free)', () => {
    expect(rangesOverlap('2026-11-01', '2026-11-05', '2026-11-05', '2026-11-08')).toBe(false);
    expect(rangesOverlap('2026-11-01', '2026-11-05', '2026-11-04', '2026-11-08')).toBe(true);
  });
  it('parses Postgres daterange literals', () => {
    expect(parseDateRange('[2026-11-01,2026-11-05)')).toEqual({ start: '2026-11-01', end: '2026-11-05' });
    expect(parseDateRange('nope')).toBeNull();
  });
  it('builds a 6x7 month grid starting on Sunday', () => {
    const g = monthGrid(2026, 10); // November 2026 starts on Sunday
    expect(g).toHaveLength(42);
    expect(g[0]).toBe('2026-11-01');
  });
});

import { formatMoneyCompact } from '@/lib/format';
describe('compact KPI money', () => {
  it('compacts large KRW amounts', () => {
    expect(formatMoneyCompact(184200000, 'KRW', 'ko')).toBe('₩1.8억');
    expect(formatMoneyCompact(184200000, 'KRW', 'en')).toBe('₩184.2M');
    expect(formatMoneyCompact(5000, 'KRW', 'ko')).toBe('₩5,000');
  });
});
