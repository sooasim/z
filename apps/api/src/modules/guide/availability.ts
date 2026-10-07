import type { Db } from '../../platform/db.js';
import { q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { emit } from '../../platform/outbox.js';
import { badRequest, conflict, notFound, unprocessable } from '../../platform/errors.js';
import { ACTIVE_BOOKING_STATUSES } from './fsm.js';
import type { AvailabilityInput } from './schemas.js';

export interface Interval { start: number; end: number }
const MAX_RANGE_MS = 93 * 24 * 3600 * 1000;

/** Subtract `cuts` from `base` (all half-open [start,end) ms intervals). Output is sorted and merged. */
export function subtractIntervals(base: Interval[], cuts: Interval[]): Interval[] {
  let out = mergeIntervals(base);
  for (const c of mergeIntervals(cuts)) {
    const next: Interval[] = [];
    for (const b of out) {
      if (c.end <= b.start || c.start >= b.end) { next.push(b); continue; }
      if (c.start > b.start) next.push({ start: b.start, end: c.start });
      if (c.end < b.end) next.push({ start: c.end, end: b.end });
    }
    out = next;
  }
  return out;
}

export function mergeIntervals(xs: Interval[]): Interval[] {
  const s = xs.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start);
  const out: Interval[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end);
    else out.push({ ...x });
  }
  return out;
}

/** Offset (ms) of `tz` at instant `at`: local wall clock − UTC. Deterministic via Intl (GUIDE-02 timezone rule). */
export function tzOffsetMs(at: Date, tz: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
  } catch {
    throw badRequest('INVALID_TIMEZONE', `Unknown timezone ${tz}`);
  }
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Wall-clock date+time in `tz` → UTC instant (DST-safe two-pass). */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let ts = guess - tzOffsetMs(new Date(guess), tz);
  ts = guess - tzOffsetMs(new Date(ts), tz);
  return new Date(ts);
}

/** Expand a weekly template into concrete UTC slots for [fromDate, toDate] (inclusive dates, ≤ 92 days). */
export function expandWeekly(w: NonNullable<AvailabilityInput['weekly']>): Array<{ startAt: Date; endAt: Date }> {
  const from = new Date(`${w.fromDate}T00:00:00Z`).getTime();
  const to = new Date(`${w.toDate}T00:00:00Z`).getTime();
  if (to < from) throw badRequest('INVALID_RANGE', 'weekly.toDate must be on/after fromDate');
  if (to - from > 92 * 86400_000) throw badRequest('RANGE_TOO_LARGE', 'Weekly expansion is limited to 92 days');
  const out: Array<{ startAt: Date; endAt: Date }> = [];
  for (let t = from; t <= to; t += 86400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const weekday = new Date(t).getUTCDay(); // weekday of the calendar date itself (timezone independent)
    for (const r of w.rules) {
      if (r.weekday !== weekday) continue;
      if (r.end <= r.start) throw badRequest('INVALID_RANGE', 'weekly rule end must be after start');
      out.push({ startAt: zonedToUtc(date, r.start, w.timezone), endAt: zonedToUtc(date, r.end, w.timezone) });
    }
  }
  return out;
}

/**
 * Replace the guide's slots inside the window. Window = [from, to) if given, else [now, latest slot end].
 * Slots that started in the past are never touched.
 */
export async function replaceAvailability(db: Db, ctx: Ctx, guideId: string, b: AvailabilityInput) {
  const prof = await q(db, `SELECT 1 FROM guide_profiles WHERE user_id = $1 FOR UPDATE`, [guideId]);
  if (!prof.length) throw notFound('Guide profile');
  const slots = b.slots.map((s) => ({ startAt: new Date(s.startAt), endAt: new Date(s.endAt), status: s.status }));
  if (b.weekly) for (const s of expandWeekly(b.weekly)) slots.push({ ...s, status: 'AVAILABLE' });
  for (const s of slots) {
    if (s.endAt <= s.startAt) throw badRequest('INVALID_RANGE', 'Slot endAt must be after startAt');
    if (s.endAt.getTime() - s.startAt.getTime() > 24 * 3600_000) throw badRequest('SLOT_TOO_LONG', 'A slot may span at most 24 hours');
  }
  for (const status of ['AVAILABLE', 'BLOCKED'] as const) {
    const same = slots.filter((s) => s.status === status).sort((a, b2) => a.startAt.getTime() - b2.startAt.getTime());
    for (let i = 1; i < same.length; i++) {
      if (same[i].startAt < same[i - 1].endAt) throw unprocessable('OVERLAPPING_SLOTS', 'Supplied slots overlap');
    }
  }
  const now = new Date();
  const from = b.from ? new Date(b.from) : now;
  const latest = slots.reduce((m, s) => (s.endAt > m ? s.endAt : m), from);
  const to = b.to ? new Date(b.to) : latest;
  if (to < from) throw badRequest('INVALID_RANGE', '`to` must be after `from`');
  if (slots.some((s) => s.startAt < from || s.endAt > to)) throw badRequest('SLOT_OUTSIDE_WINDOW', 'All slots must lie inside [from, to)');
  const effFrom = from < now ? now : from;
  const del = await db.query(
    `DELETE FROM guide_availability WHERE guide_id = $1 AND start_at >= $2 AND start_at < $3`,
    [guideId, effFrom, to > effFrom ? to : effFrom],
  );
  let inserted = 0;
  for (const s of slots) {
    if (s.endAt <= now) continue;
    await db.query(`INSERT INTO guide_availability(guide_id, start_at, end_at, status) VALUES ($1,$2,$3,$4)`, [guideId, s.startAt, s.endAt, s.status]);
    inserted++;
  }
  await emit(db, ctx, {
    aggregateType: 'guide_profile', aggregateId: guideId, eventType: 'guide.availability.changed',
    payload: { guideId, from: effFrom.toISOString(), to: to.toISOString(), removed: del.rowCount ?? 0, added: inserted },
  });
  await emit(db, ctx, { aggregateType: 'guide_profile', aggregateId: guideId, eventType: 'guide.search.reindex', payload: { guideId, op: 'UPSERT' } });
  return { removed: del.rowCount ?? 0, added: inserted };
}

/** Free time = AVAILABLE slots − BLOCKED slots − active bookings, clipped to [from, to). */
export async function freeIntervals(db: Db, guideId: string, from: Date, to: Date, opts: { ignoreBookingId?: string } = {}): Promise<Interval[]> {
  if (to <= from) throw badRequest('INVALID_RANGE', '`to` must be after `from`');
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) throw badRequest('RANGE_TOO_LARGE', 'Range is limited to 93 days');
  const slots = await q<{ start_at: Date; end_at: Date; status: string }>(
    db,
    `SELECT start_at, end_at, status FROM guide_availability WHERE guide_id = $1 AND start_at < $3 AND end_at > $2`,
    [guideId, from, to],
  );
  const bookings = await q<{ start_at: Date; end_at: Date }>(
    db,
    `SELECT start_at, end_at FROM guide_bookings
      WHERE guide_id = $1 AND status = ANY($4::text[]) AND start_at < $3 AND end_at > $2 AND ($5::uuid IS NULL OR id <> $5)`,
    [guideId, from, to, ACTIVE_BOOKING_STATUSES, opts.ignoreBookingId ?? null],
  );
  const iv = (r: { start_at: Date; end_at: Date }) => ({ start: Math.max(r.start_at.getTime(), from.getTime()), end: Math.min(r.end_at.getTime(), to.getTime()) });
  return subtractIntervals(
    slots.filter((s) => s.status === 'AVAILABLE').map(iv),
    [...slots.filter((s) => s.status === 'BLOCKED').map(iv), ...bookings.map(iv)],
  );
}

/**
 * Authoritative availability recheck before a booking (GUIDE-03 acceptance). A guide that has never
 * published any slot is treated as "available on request" (the offer itself is their commitment);
 * otherwise the window must be fully inside free time. BLOCKED slots always win. The DB exclusion
 * constraint remains the last line of defence against double booking.
 */
export async function assertGuideWindowFree(db: Db, guideId: string, start: Date, end: Date) {
  const blocked = await q(
    db,
    `SELECT 1 FROM guide_availability WHERE guide_id = $1 AND status = 'BLOCKED' AND start_at < $3 AND end_at > $2 LIMIT 1`,
    [guideId, start, end],
  );
  if (blocked.length) throw conflict('GUIDE_UNAVAILABLE', 'The guide is not available in the requested time');
  const any = await q(db, `SELECT 1 FROM guide_availability WHERE guide_id = $1 AND status = 'AVAILABLE' LIMIT 1`, [guideId]);
  if (!any.length) return;
  const free = await freeIntervals(db, guideId, start, end);
  const covered = free.length === 1 && free[0].start <= start.getTime() && free[0].end >= end.getTime();
  if (!covered) throw conflict('GUIDE_UNAVAILABLE', 'The guide is not available in the requested time');
}

export function toIso(xs: Interval[]) {
  return xs.map((x) => ({ startAt: new Date(x.start).toISOString(), endAt: new Date(x.end).toISOString() }));
}
