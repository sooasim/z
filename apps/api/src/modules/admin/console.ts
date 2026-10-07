import type { Db } from '../../platform/db.js';
import { q } from '../../platform/db.js';
import { badRequest } from '../../platform/errors.js';
import { decodeCursor } from '../../platform/http.js';

/**
 * OPS-02 read-only console lists over other domains' tables (reservations, exchanges, guide bookings, listings).
 * Strictly SELECT-only: the admin module never writes another domain's tables (state changes go through the
 * owning module's endpoints / services). Keyset pagination over (created_at, id) DESC.
 *
 * SQL fragments below are constants selected by enum keys; every user-supplied value is a $n parameter.
 */

export const RESERVATION_STATUSES = ['DRAFT', 'QUOTED', 'HELD', 'PAYMENT_PENDING', 'PAYMENT_FAILED', 'EXPIRED', 'CONFIRMED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'REFUND_PENDING', 'PARTIALLY_REFUNDED', 'REFUNDED', 'NO_SHOW', 'DISPUTED'] as const;
export const EXCHANGE_STATUSES = ['REQUESTED', 'COUNTERED', 'MUTUAL_ACCEPTED', 'VERIFICATION_PENDING', 'AGREEMENT_PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED', 'DECLINED', 'WITHDRAWN', 'EXPIRED', 'DISPUTED', 'CANCELLED'] as const;
export const GUIDE_BOOKING_STATUSES = ['ACCEPTED', 'PAYMENT_PENDING', 'CONFIRMED', 'IN_PROGRESS', 'COMPLETED', 'REVIEWED', 'CANCELLED', 'DISPUTED', 'PAYMENT_FAILED'] as const;
export const LISTING_STATUSES = ['DRAFT', 'IN_REVIEW', 'PUBLISHED', 'UNLISTED', 'BLOCKED', 'ARCHIVED'] as const;

/** Console dates are business days in Korea (platform default timezone). */
const TZ = 'Asia/Seoul';

type DateKind = 'ts' | 'date';
interface ListSpec {
  statuses: readonly string[];
  select: string;
  from: string;
  /** main table alias (created_at / id / status live there) */
  a: string;
  /** columns matched by ?userId= (any party) */
  userCols: string[];
  dates: Record<string, { expr: string; kind: DateKind }>;
}

export interface ConsoleFilter {
  limit: number;
  cursor?: string;
  /** comma-separated status list */
  status?: string;
  userId?: string;
  from?: string;
  to?: string;
  dateField?: string;
}

function parseStatuses(raw: string | undefined, allowed: readonly string[]): string[] | null {
  if (!raw) return null;
  const list = Array.from(new Set(raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)));
  const bad = list.filter((s) => !allowed.includes(s));
  if (bad.length) throw badRequest('INVALID_STATUS', `Unknown status: ${bad.join(', ')}`, { allowed });
  return list.length ? list : null;
}

const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)?$/;
const CURSOR_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseCursor(raw: string | undefined) {
  if (!raw) return null;
  const c = decodeCursor(raw);
  if (!c || typeof c.createdAt !== 'string' || !CURSOR_TS_RE.test(c.createdAt) || !CURSOR_ID_RE.test(String(c.id))) {
    throw badRequest('INVALID_CURSOR', 'Malformed pagination cursor');
  }
  return c;
}

/** Generic keyset list: shared filters (status/user/date range/cursor) + module-specific extra predicates. */
async function runList(db: Db, spec: ListSpec, f: ConsoleFilter, extra: (p: (v: unknown) => string) => string[]) {
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const where: string[] = [];
  const statuses = parseStatuses(f.status, spec.statuses);
  if (statuses) where.push(`${spec.a}.status = ANY(${p(statuses)}::text[])`);
  if (f.userId) {
    const ph = p(f.userId);
    where.push(`(${spec.userCols.map((c) => `${c} = ${ph}::uuid`).join(' OR ')})`);
  }
  if (f.from || f.to) {
    const key = (f.dateField ?? 'CREATED').toUpperCase();
    const d = spec.dates[key];
    if (!d) throw badRequest('INVALID_DATE_FIELD', `dateField must be one of ${Object.keys(spec.dates).join(', ')}`);
    if (f.from && f.to && f.from > f.to) throw badRequest('INVALID_RANGE', 'from must be on or before to');
    // inclusive [from, to] business days
    if (d.kind === 'ts') {
      if (f.from) where.push(`${d.expr} >= (${p(f.from)}::date::timestamp AT TIME ZONE '${TZ}')`);
      if (f.to) where.push(`${d.expr} < ((${p(f.to)}::date + 1)::timestamp AT TIME ZONE '${TZ}')`);
    } else {
      if (f.from) where.push(`${d.expr} >= ${p(f.from)}::date`);
      if (f.to) where.push(`${d.expr} <= ${p(f.to)}::date`);
    }
  }
  where.push(...extra(p));
  const c = parseCursor(f.cursor);
  if (c) where.push(`(${spec.a}.created_at, ${spec.a}.id) < (${p(c.createdAt)}::timestamptz, ${p(c.id)}::uuid)`);
  const sql = `SELECT ${spec.select}, to_char(${spec.a}.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
    FROM ${spec.from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${spec.a}.created_at DESC, ${spec.a}.id DESC LIMIT ${p(f.limit + 1)}`;
  return pageExact(await q(db, sql, params), f.limit);
}

/**
 * Exact keyset page: timestamptz has microsecond precision but a JS Date only milliseconds, so the cursor is built
 * from the sort key selected as UTC text (`cursor_ts`) — rows created within the same millisecond are never skipped.
 * Same wire format as platform/http encodeCursor ([ts, id] JSON, base64url).
 */
function pageExact<T extends { id: string; cursor_ts: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify([last.cursor_ts, last.id])).toString('base64url') : null };
}

const likeEscape = (s: string) => s.replace(/[%_\\]/g, (m) => `\\${m}`);

// ---------------------------------------------------------------- reservations (STAY)

const reservationsSpec: ListSpec = {
  statuses: RESERVATION_STATUSES,
  a: 'r',
  select: `r.id, r.code, r.status, r.property_id, p.title AS property_title, r.host_id, hu.display_name AS host_name,
           r.guest_id, gu.display_name AS guest_name, r.check_in, r.check_out, r.guests, r.total_minor, r.refunded_minor,
           r.currency, r.confirmed_at, r.cancelled_at, r.created_at, r.updated_at`,
  from: `reservations r JOIN properties p ON p.id = r.property_id JOIN users hu ON hu.id = r.host_id JOIN users gu ON gu.id = r.guest_id`,
  userCols: ['r.guest_id', 'r.host_id'],
  dates: { CREATED: { expr: 'r.created_at', kind: 'ts' }, CHECK_IN: { expr: 'r.check_in', kind: 'date' }, CHECK_OUT: { expr: 'r.check_out', kind: 'date' } },
};

export async function adminListReservations(db: Db, f: ConsoleFilter & { propertyId?: string; code?: string }) {
  const res = await runList(db, reservationsSpec, f, (p) => [
    ...(f.propertyId ? [`r.property_id = ${p(f.propertyId)}::uuid`] : []),
    ...(f.code ? [`r.code = ${p(f.code.trim().toUpperCase())}`] : []),
  ]);
  return {
    items: res.items.map((r: any) => ({
      id: r.id,
      code: r.code,
      status: r.status,
      propertyId: r.property_id,
      propertyTitle: r.property_title,
      hostId: r.host_id,
      hostName: r.host_name,
      guestId: r.guest_id,
      guestName: r.guest_name,
      checkIn: r.check_in,
      checkOut: r.check_out,
      guests: r.guests,
      totalMinor: r.total_minor,
      refundedMinor: r.refunded_minor,
      currency: r.currency,
      confirmedAt: r.confirmed_at,
      cancelledAt: r.cancelled_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    nextCursor: res.nextCursor,
  };
}

// ---------------------------------------------------------------- exchanges (EXCH)

const exchangesSpec: ListSpec = {
  statuses: EXCHANGE_STATUSES,
  a: 'e',
  select: `e.id, e.status, e.requester_id, ru.display_name AS requester_name, e.responder_id, su.display_name AS responder_name,
           e.property_a_id, pa.title AS property_a_title, e.property_b_id, pb.title AS property_b_title,
           lower(e.dates_a) AS dates_a_start, upper(e.dates_a) AS dates_a_end, lower(e.dates_b) AS dates_b_start, upper(e.dates_b) AS dates_b_end,
           e.current_offer_version, e.created_at, e.updated_at`,
  from: `exchange_requests e JOIN users ru ON ru.id = e.requester_id JOIN users su ON su.id = e.responder_id
         JOIN properties pa ON pa.id = e.property_a_id JOIN properties pb ON pb.id = e.property_b_id`,
  userCols: ['e.requester_id', 'e.responder_id'],
  dates: { CREATED: { expr: 'e.created_at', kind: 'ts' }, START: { expr: 'least(lower(e.dates_a), lower(e.dates_b))', kind: 'date' } },
};

export async function adminListExchanges(db: Db, f: ConsoleFilter & { propertyId?: string }) {
  const res = await runList(db, exchangesSpec, f, (p) => {
    if (!f.propertyId) return [];
    const ph = p(f.propertyId);
    return [`(e.property_a_id = ${ph}::uuid OR e.property_b_id = ${ph}::uuid)`];
  });
  return {
    items: res.items.map((r: any) => ({
      id: r.id,
      status: r.status,
      requesterId: r.requester_id,
      requesterName: r.requester_name,
      responderId: r.responder_id,
      responderName: r.responder_name,
      propertyAId: r.property_a_id,
      propertyATitle: r.property_a_title,
      propertyBId: r.property_b_id,
      propertyBTitle: r.property_b_title,
      datesA: { start: r.dates_a_start, end: r.dates_a_end },
      datesB: { start: r.dates_b_start, end: r.dates_b_end },
      currentOfferVersion: r.current_offer_version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    nextCursor: res.nextCursor,
  };
}

// ---------------------------------------------------------------- guide bookings (GUIDE)

const guideBookingsSpec: ListSpec = {
  statuses: GUIDE_BOOKING_STATUSES,
  a: 'b',
  select: `b.id, b.status, b.guide_id, gu.display_name AS guide_name, b.traveler_id, tu.display_name AS traveler_name, b.guide_type,
           b.start_at, b.end_at, b.paid, b.price_minor, b.refunded_minor, b.currency, b.created_at, b.updated_at`,
  from: `guide_bookings b JOIN users gu ON gu.id = b.guide_id JOIN users tu ON tu.id = b.traveler_id`,
  userCols: ['b.guide_id', 'b.traveler_id'],
  dates: { CREATED: { expr: 'b.created_at', kind: 'ts' }, START: { expr: 'b.start_at', kind: 'ts' } },
};

export async function adminListGuideBookings(db: Db, f: ConsoleFilter & { paid?: boolean }) {
  const res = await runList(db, guideBookingsSpec, f, (p) => (f.paid === undefined ? [] : [`b.paid = ${p(f.paid)}::boolean`]));
  return {
    items: res.items.map((r: any) => ({
      id: r.id,
      status: r.status,
      guideId: r.guide_id,
      guideName: r.guide_name,
      travelerId: r.traveler_id,
      travelerName: r.traveler_name,
      guideType: r.guide_type,
      startAt: r.start_at,
      endAt: r.end_at,
      paid: r.paid,
      priceMinor: r.price_minor,
      refundedMinor: r.refunded_minor,
      currency: r.currency,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    nextCursor: res.nextCursor,
  };
}

// ---------------------------------------------------------------- listings (STAY-01)

const listingsSpec: ListSpec = {
  statuses: LISTING_STATUSES,
  a: 'p',
  // exact location (lat/lng) is deliberately not part of the console list
  select: `p.id, p.slug, p.title, p.status, p.host_id, hu.display_name AS host_name, p.property_type, p.room_type, p.country, p.region, p.city,
           p.rental_enabled, p.exchange_enabled, p.paid_booking_enabled, p.instant_book, p.base_price_minor, p.currency, p.max_guests,
           p.published_at, p.created_at, p.updated_at`,
  from: `properties p JOIN users hu ON hu.id = p.host_id`,
  userCols: ['p.host_id'],
  dates: { CREATED: { expr: 'p.created_at', kind: 'ts' }, UPDATED: { expr: 'p.updated_at', kind: 'ts' }, PUBLISHED: { expr: 'p.published_at', kind: 'ts' } },
};

export async function adminListListings(db: Db, f: ConsoleFilter & { city?: string; q?: string; rentalEnabled?: boolean; exchangeEnabled?: boolean }) {
  const res = await runList(db, listingsSpec, f, (p) => [
    ...(f.city ? [`p.city = ${p(f.city)}`] : []),
    ...(f.q ? [`(p.title ILIKE '%' || ${p(likeEscape(f.q))} || '%' OR p.slug = ${p(f.q)})`] : []),
    ...(f.rentalEnabled === undefined ? [] : [`p.rental_enabled = ${p(f.rentalEnabled)}::boolean`]),
    ...(f.exchangeEnabled === undefined ? [] : [`p.exchange_enabled = ${p(f.exchangeEnabled)}::boolean`]),
  ]);
  return {
    items: res.items.map((r: any) => ({
      id: r.id,
      slug: r.slug,
      title: r.title,
      status: r.status,
      hostId: r.host_id,
      hostName: r.host_name,
      propertyType: r.property_type,
      roomType: r.room_type,
      country: r.country,
      region: r.region,
      city: r.city,
      rentalEnabled: r.rental_enabled,
      exchangeEnabled: r.exchange_enabled,
      paidBookingEnabled: r.paid_booking_enabled,
      instantBook: r.instant_book,
      basePriceMinor: r.base_price_minor,
      currency: r.currency,
      maxGuests: r.max_guests,
      publishedAt: r.published_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    nextCursor: res.nextCursor,
  };
}
