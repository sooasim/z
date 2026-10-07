import type { Db } from '../../platform/db.js';
import { maybeOne, q } from '../../platform/db.js';
import { badRequest, forbidden, notFound, unprocessable, conflict } from '../../platform/errors.js';
import { applyBps } from '../../platform/money.js';
import type { Ctx } from '../../platform/context.js';
import { emit } from '../../platform/outbox.js';
import { isRangeFree } from '../../platform/inventory.js';
import { quoteFees } from '../finance/rules.js';
import { assertRange, eachDay, localToday, weekday } from './dates.js';

export const PRICING_VERSION = 'booking-pricing-v1';

export interface PropertyRow {
  id: string;
  host_id: string;
  title: string;
  status: string;
  rental_enabled: boolean;
  paid_booking_enabled: boolean;
  max_guests: number;
  base_price_minor: number | null;
  cleaning_fee_minor: number;
  currency: string;
  min_nights: number;
  max_nights: number;
  timezone: string;
  check_in_time: string;
  check_out_time: string;
  cancellation_policy_id: string | null;
}

export async function loadProperty(db: Db, id: string, lock = false): Promise<PropertyRow> {
  const row = await maybeOne<PropertyRow>(db, `SELECT * FROM properties WHERE id = $1 ${lock ? 'FOR SHARE' : ''}`, [id]);
  if (!row) throw notFound('Property');
  return row;
}

interface RateRule {
  id: string;
  rule_type: 'WEEKEND' | 'WEEKLY_DISCOUNT' | 'MONTHLY_DISCOUNT' | 'SEASON' | 'EXTRA_GUEST';
  params: any;
  valid_from: string | null;
  valid_until: string | null;
  priority: number;
}

const ruleCovers = (r: RateRule, d: string) => (!r.valid_from || r.valid_from <= d) && (!r.valid_until || d <= r.valid_until);
const isInt = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;

export interface NightInfo {
  date: string;
  /** host availability setting (missing row = AVAILABLE) */
  status: 'AVAILABLE' | 'UNAVAILABLE';
  minNights: number | null;
  priceMinor: number | null;
  source: 'OVERRIDE' | 'SEASON' | 'WEEKEND' | 'BASE' | 'UNPRICED';
  ruleId: string | null;
}

async function loadRules(db: Db, propertyId: string): Promise<RateRule[]> {
  // deterministic order: priority, then SEASON before WEEKEND, then id
  return q<RateRule>(
    db,
    `SELECT id, rule_type, params, valid_from::text, valid_until::text, priority FROM rate_rules
      WHERE property_id = $1 AND active ORDER BY priority, CASE rule_type WHEN 'SEASON' THEN 0 WHEN 'WEEKEND' THEN 1 ELSE 2 END, id`,
    [propertyId],
  );
}

/** Nightly price + availability settings for each night in [start, end). override > rate rules > base price. */
export async function nightlyInfo(db: Db, prop: PropertyRow, start: string, end: string, rules?: RateRule[]): Promise<NightInfo[]> {
  const all = rules ?? (await loadRules(db, prop.id));
  const nightly = all.filter((r) => r.rule_type === 'SEASON' || r.rule_type === 'WEEKEND');
  const days = await q<{ day: string; status: 'AVAILABLE' | 'UNAVAILABLE'; price_minor: number | null; min_nights: number | null }>(
    db,
    `SELECT day::text, status, price_minor, min_nights FROM availability_days WHERE property_id = $1 AND day >= $2 AND day < $3`,
    [prop.id, start, end],
  );
  const byDay = new Map(days.map((d) => [d.day, d]));
  const base = prop.base_price_minor;
  return eachDay(start, end).map((date) => {
    const a = byDay.get(date);
    const info: NightInfo = { date, status: a?.status ?? 'AVAILABLE', minNights: a?.min_nights ?? null, priceMinor: null, source: 'UNPRICED', ruleId: null };
    if (a?.price_minor != null) return { ...info, priceMinor: a.price_minor, source: 'OVERRIDE' };
    for (const r of nightly) {
      if (!ruleCovers(r, date)) continue;
      if (r.rule_type === 'WEEKEND') {
        const days: number[] = Array.isArray(r.params?.days) ? r.params.days : [5, 6];
        if (!days.includes(weekday(date))) continue;
      }
      let price: number | null = null;
      if (isInt(r.params?.price_minor)) price = r.params.price_minor;
      else if (isInt(r.params?.multiplier_bps) && base != null) price = applyBps(base, r.params.multiplier_bps);
      if (price == null) continue;
      return { ...info, priceMinor: price, source: r.rule_type as 'SEASON' | 'WEEKEND', ruleId: r.id };
    }
    if (base != null) return { ...info, priceMinor: base, source: 'BASE' };
    return info;
  });
}

export interface QuoteComputation {
  nightsCount: number;
  nights: Array<{ date: string; priceMinor: number; source: NightInfo['source']; ruleId: string | null }>;
  nightsTotalMinor: number;
  extraGuestFeeMinor: number;
  extraGuest: { includedGuests: number; feePerGuestNightMinor: number; extraGuests: number; ruleId: string } | null;
  discount: { type: 'WEEKLY_DISCOUNT' | 'MONTHLY_DISCOUNT'; bps: number; ruleId: string; amountMinor: number } | null;
  discountMinor: number;
  subtotalMinor: number;
  cleaningFeeMinor: number;
  platformFeeMinor: number;
  taxMinor: number;
  hostFeeMinor: number;
  totalMinor: number;
  currency: string;
  rulesVersion: Record<string, unknown>;
}

/**
 * Deterministic itemized pricing. subtotal = nights + extra-guest fees − length-of-stay discount;
 * total = subtotal + cleaning + platform fee + tax (fees/tax from approved finance rules on subtotal+cleaning).
 */
export async function computeQuote(
  db: Db,
  prop: PropertyRow,
  args: { checkIn: string; checkOut: string; guests: number; at?: Date },
  nights?: NightInfo[],
): Promise<QuoteComputation> {
  const rules = await loadRules(db, prop.id);
  const info = nights ?? (await nightlyInfo(db, prop, args.checkIn, args.checkOut, rules));
  const n = info.length;
  const priced = info.map((x) => {
    if (x.priceMinor == null) throw unprocessable('PRICE_NOT_SET', `No nightly price configured for ${x.date}`);
    return { date: x.date, priceMinor: x.priceMinor, source: x.source, ruleId: x.ruleId };
  });
  const nightsTotalMinor = priced.reduce((s, x) => s + x.priceMinor, 0);

  let extraGuest: QuoteComputation['extraGuest'] = null;
  let extraGuestFeeMinor = 0;
  const eg = rules.find((r) => r.rule_type === 'EXTRA_GUEST' && ruleCovers(r, args.checkIn));
  if (eg && isInt(eg.params?.fee_minor) && isInt(eg.params?.included_guests ?? 1)) {
    const included = eg.params.included_guests ?? 1;
    const extra = Math.max(0, args.guests - included);
    extraGuestFeeMinor = extra * eg.params.fee_minor * n;
    extraGuest = { includedGuests: included, feePerGuestNightMinor: eg.params.fee_minor, extraGuests: extra, ruleId: eg.id };
  }

  let discount: QuoteComputation['discount'] = null;
  const pick = (type: 'WEEKLY_DISCOUNT' | 'MONTHLY_DISCOUNT', minDefault: number) =>
    rules.find((r) => r.rule_type === type && ruleCovers(r, args.checkIn) && isInt(r.params?.bps) && r.params.bps <= 10000 && n >= (r.params?.min_nights ?? minDefault));
  const d = pick('MONTHLY_DISCOUNT', 28) ?? pick('WEEKLY_DISCOUNT', 7);
  if (d) {
    const base = nightsTotalMinor + extraGuestFeeMinor;
    discount = { type: d.rule_type as 'WEEKLY_DISCOUNT' | 'MONTHLY_DISCOUNT', bps: d.params.bps, ruleId: d.id, amountMinor: applyBps(base, d.params.bps) };
  }
  const discountMinor = discount?.amountMinor ?? 0;
  const subtotalMinor = nightsTotalMinor + extraGuestFeeMinor - discountMinor;
  const cleaningFeeMinor = prop.cleaning_fee_minor;
  const fees = await quoteFees(db, { domain: 'STAY', amountMinor: subtotalMinor + cleaningFeeMinor, currency: prop.currency, at: args.at });
  const totalMinor = subtotalMinor + cleaningFeeMinor + fees.platformFeeMinor + fees.taxMinor;
  const usedRules = Array.from(new Set([...priced.map((p) => p.ruleId), extraGuest?.ruleId, discount?.ruleId].filter((x): x is string => !!x))).sort();
  return {
    nightsCount: n,
    nights: priced,
    nightsTotalMinor,
    extraGuestFeeMinor,
    extraGuest,
    discount,
    discountMinor,
    subtotalMinor,
    cleaningFeeMinor,
    platformFeeMinor: fees.platformFeeMinor,
    taxMinor: fees.taxMinor,
    hostFeeMinor: fees.hostFeeMinor,
    totalMinor,
    currency: prop.currency,
    rulesVersion: { pricing: PRICING_VERSION, finance: fees.rulesVersion, rateRules: usedRules },
  };
}

/** All booking preconditions for a stay request (also rechecked at hold time inside the hold tx). */
export async function validateStayRequest(
  db: Db,
  prop: PropertyRow,
  args: { checkIn: string; checkOut: string; guests: number; guestId: string },
): Promise<NightInfo[]> {
  if (prop.status !== 'PUBLISHED' || !prop.rental_enabled) throw unprocessable('PROPERTY_NOT_BOOKABLE', 'Property is not open for paid stays');
  if (prop.host_id === args.guestId) throw forbidden('SELF_BOOKING', 'Hosts cannot book their own property');
  const n = assertRange(args.checkIn, args.checkOut, 400);
  if (args.guests < 1 || args.guests > prop.max_guests) throw unprocessable('MAX_GUESTS_EXCEEDED', `Property allows at most ${prop.max_guests} guests`);
  const today = await localToday(db, prop.timezone);
  if (args.checkIn < today) throw badRequest('DATE_IN_PAST', 'Check-in date is in the past');
  const nights = await nightlyInfo(db, prop, args.checkIn, args.checkOut);
  const minNights = nights[0]?.minNights ?? prop.min_nights;
  if (n < minNights) throw unprocessable('MIN_NIGHTS', `Minimum stay is ${minNights} nights`, { minNights });
  if (n > prop.max_nights) throw unprocessable('MAX_NIGHTS', `Maximum stay is ${prop.max_nights} nights`, { maxNights: prop.max_nights });
  const closed = nights.filter((x) => x.status !== 'AVAILABLE').map((x) => x.date);
  if (closed.length) throw conflict('DATES_UNAVAILABLE', 'Some nights are not available', { dates: closed });
  if (!(await isRangeFree(db, prop.id, args.checkIn, args.checkOut))) throw conflict('INVENTORY_UNAVAILABLE', 'The requested dates are no longer available');
  return nights;
}

export interface QuoteRow {
  id: string;
  property_id: string;
  guest_id: string;
  check_in: string;
  check_out: string;
  guests: number;
  subtotal_minor: number;
  cleaning_fee_minor: number;
  platform_fee_minor: number;
  tax_minor: number;
  discount_minor: number;
  total_minor: number;
  currency: string;
  breakdown: QuoteComputation;
  rules_version: Record<string, unknown>;
  expires_at: string;
  created_at: string;
}

export const quoteDto = (r: QuoteRow) => ({
  id: r.id,
  propertyId: r.property_id,
  guestId: r.guest_id,
  checkIn: r.check_in,
  checkOut: r.check_out,
  guests: r.guests,
  nights: r.breakdown.nightsCount,
  subtotalMinor: r.subtotal_minor,
  cleaningFeeMinor: r.cleaning_fee_minor,
  platformFeeMinor: r.platform_fee_minor,
  taxMinor: r.tax_minor,
  discountMinor: r.discount_minor,
  totalMinor: r.total_minor,
  currency: r.currency,
  breakdown: r.breakdown,
  rulesVersion: r.rules_version,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
});

export async function createQuote(
  tx: Db,
  ctx: Ctx,
  args: { propertyId: string; checkIn: string; checkOut: string; guests: number; guestId: string },
): Promise<QuoteRow> {
  const prop = await loadProperty(tx, args.propertyId);
  const nights = await validateStayRequest(tx, prop, args);
  const c = await computeQuote(tx, prop, args, nights);
  const ttl = ctx.app.config.QUOTE_TTL_SEC;
  const row = await maybeOne<QuoteRow>(
    tx,
    `INSERT INTO booking_quotes(property_id, guest_id, check_in, check_out, guests, subtotal_minor, cleaning_fee_minor, platform_fee_minor,
                                tax_minor, discount_minor, total_minor, currency, breakdown, rules_version, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now() + make_interval(secs => $15))
     RETURNING id, property_id, guest_id, check_in::text, check_out::text, guests, subtotal_minor, cleaning_fee_minor, platform_fee_minor,
               tax_minor, discount_minor, total_minor, currency, breakdown, rules_version, expires_at, created_at`,
    [
      prop.id, args.guestId, args.checkIn, args.checkOut, args.guests, c.subtotalMinor, c.cleaningFeeMinor, c.platformFeeMinor,
      c.taxMinor, c.discountMinor, c.totalMinor, c.currency, JSON.stringify(c), JSON.stringify(c.rulesVersion), ttl,
    ],
  );
  await emit(tx, ctx, {
    aggregateType: 'booking_quote',
    aggregateId: row!.id,
    eventType: 'quote.created',
    payload: { quoteId: row!.id, propertyId: prop.id, guestId: args.guestId, checkIn: args.checkIn, checkOut: args.checkOut, totalMinor: c.totalMinor, currency: c.currency, expiresAt: row!.expires_at },
  });
  return row!;
}

