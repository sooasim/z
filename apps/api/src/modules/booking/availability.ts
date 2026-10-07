import type { Db } from '../../platform/db.js';
import { maybeOne, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import type { Actor } from '../../platform/auth.js';
import { isStaff } from '../../platform/auth.js';
import { forbidden, notFound, conflict } from '../../platform/errors.js';
import { emit } from '../../platform/outbox.js';
import { acquireBlock, releaseBlock } from '../../platform/inventory.js';
import { assertRange, localToday } from './dates.js';
import { loadProperty, nightlyInfo, type PropertyRow } from './pricing.js';

export const staffOk = (actor: Actor | null) => !!actor && isStaff(actor) && actor.aal === 'aal2';

export async function loadManagedProperty(db: Db, actor: Actor, propertyId: string): Promise<PropertyRow> {
  const prop = await loadProperty(db, propertyId);
  if (prop.host_id !== actor.userId && !staffOk(actor)) throw forbidden();
  return prop;
}

export interface AvailabilityRange {
  start: string;
  end: string;
  status?: 'AVAILABLE' | 'UNAVAILABLE';
  /** undefined = keep, null = clear override */
  priceMinor?: number | null;
  minNights?: number | null;
  note?: string | null;
}

/** STAY-06 bulk day-range upsert of host availability settings. */
export async function setAvailability(tx: Db, ctx: Ctx, propertyId: string, ranges: AvailabilityRange[]) {
  const actor = ctx.actor!;
  await loadManagedProperty(tx, actor, propertyId);
  let days = 0;
  for (const r of ranges) {
    assertRange(r.start, r.end, 400);
    const res = await tx.query(
      `INSERT INTO availability_days(property_id, day, status, price_minor, min_nights, note)
       SELECT $1, d::date, coalesce($4, 'AVAILABLE'), CASE WHEN $5 THEN $6::bigint END, CASE WHEN $7 THEN $8::int END, CASE WHEN $9 THEN $10 END
         FROM generate_series($2::date, $3::date - 1, interval '1 day') d
       ON CONFLICT (property_id, day) DO UPDATE SET
         status = coalesce($4, availability_days.status),
         price_minor = CASE WHEN $5 THEN $6::bigint ELSE availability_days.price_minor END,
         min_nights = CASE WHEN $7 THEN $8::int ELSE availability_days.min_nights END,
         note = CASE WHEN $9 THEN $10 ELSE availability_days.note END`,
      [
        propertyId, r.start, r.end, r.status ?? null,
        r.priceMinor !== undefined, r.priceMinor ?? null,
        r.minNights !== undefined, r.minNights ?? null,
        r.note !== undefined, r.note ?? null,
      ],
    );
    days += res.rowCount ?? 0;
  }
  await emit(tx, ctx, {
    aggregateType: 'property',
    aggregateId: propertyId,
    eventType: 'availability.changed',
    payload: { propertyId, reason: 'AVAILABILITY_UPDATED', ranges: ranges.map((r) => ({ start: r.start, end: r.end, status: r.status ?? null })) },
  });
  return { days };
}

export async function addHostBlock(tx: Db, ctx: Ctx, propertyId: string, b: { start: string; end: string; note?: string }) {
  const actor = ctx.actor!;
  await loadManagedProperty(tx, actor, propertyId);
  assertRange(b.start, b.end, 400);
  const block = await acquireBlock(tx, {
    propertyId, start: b.start, end: b.end, blockType: 'HOST_BLOCK', sourceType: 'HOST', sourceId: null, createdBy: actor.userId, note: b.note,
  });
  await emit(tx, ctx, {
    aggregateType: 'property',
    aggregateId: propertyId,
    eventType: 'availability.changed',
    payload: { propertyId, reason: 'HOST_BLOCK_ADDED', blockId: block.id, start: b.start, end: b.end },
  });
  return block;
}

export async function removeHostBlock(tx: Db, ctx: Ctx, propertyId: string, blockId: string) {
  const actor = ctx.actor!;
  await loadManagedProperty(tx, actor, propertyId);
  const block = await maybeOne<{ id: string; block_type: string; state: string; start: string; end: string }>(
    tx,
    `SELECT id, block_type, state, lower(stay_range)::text AS start, upper(stay_range)::text AS end
       FROM inventory_blocks WHERE id = $1 AND property_id = $2 FOR UPDATE`,
    [blockId, propertyId],
  );
  if (!block) throw notFound('Block');
  if (block.block_type !== 'HOST_BLOCK') throw forbidden('NOT_HOST_BLOCK', 'Only host blocks can be removed here');
  if (block.state !== 'ACTIVE') throw conflict('BLOCK_NOT_ACTIVE', 'Block is not active');
  await releaseBlock(tx, blockId, 'RELEASED');
  await emit(tx, ctx, {
    aggregateType: 'property',
    aggregateId: propertyId,
    eventType: 'availability.changed',
    payload: { propertyId, reason: 'HOST_BLOCK_REMOVED', blockId, start: block.start, end: block.end },
  });
}

interface BlockOverlay {
  id: string;
  block_type: 'HOLD' | 'RESERVATION' | 'EXCHANGE' | 'HOST_BLOCK' | 'EXTERNAL';
  source_type: string;
  source_id: string | null;
  start: string;
  end: string;
  expires_at: string | null;
  note: string | null;
  reservation_id: string | null;
  reservation_code: string | null;
  reservation_status: string | null;
}

async function activeBlocks(db: Db, propertyId: string, from: string, to: string): Promise<BlockOverlay[]> {
  return q<BlockOverlay>(
    db,
    `SELECT b.id, b.block_type, b.source_type, b.source_id, lower(b.stay_range)::text AS start, upper(b.stay_range)::text AS end,
            b.expires_at, b.note, r.id AS reservation_id, r.code AS reservation_code, r.status AS reservation_status
       FROM inventory_blocks b
       LEFT JOIN reservations r ON r.inventory_block_id = b.id
      WHERE b.property_id = $1 AND b.state = 'ACTIVE' AND (b.expires_at IS NULL OR b.expires_at > now())
        AND b.stay_range && daterange($2::date, $3::date, '[)')
      ORDER BY lower(b.stay_range), b.id`,
    [propertyId, from, to],
  );
}

const covers = (b: { start: string; end: string }, d: string) => b.start <= d && d < b.end;

/** Public day-level calendar: never reveals who booked or why a day is blocked. */
export async function publicCalendar(db: Db, actor: Actor | null, propertyId: string, from: string, to: string) {
  assertRange(from, to, 400);
  const prop = await loadProperty(db, propertyId);
  const privileged = !!actor && (prop.host_id === actor.userId || staffOk(actor));
  if (prop.status !== 'PUBLISHED' && !privileged) throw notFound('Property');
  const [nights, blocks, today] = await Promise.all([nightlyInfo(db, prop, from, to), activeBlocks(db, propertyId, from, to), localToday(db, prop.timezone)]);
  const days = nights.map((n) => {
    const b = blocks.find((x) => covers(x, n.date));
    let status: 'available' | 'booked' | 'blocked' = 'available';
    if (b && (b.block_type === 'RESERVATION' || b.block_type === 'EXCHANGE' || b.block_type === 'HOLD')) status = 'booked';
    else if (b || n.status === 'UNAVAILABLE' || n.date < today || n.priceMinor == null) status = 'blocked';
    return { date: n.date, status, priceMinor: n.priceMinor, minNights: n.minNights ?? prop.min_nights };
  });
  return { propertyId, currency: prop.currency, from, to, days };
}

/** Host calendar overlaying RESERVATION / EXCHANGE / HOST_BLOCK / HOLD with source ids. */
export async function hostCalendar(db: Db, actor: Actor, propertyId: string, from: string, to: string) {
  assertRange(from, to, 400);
  const prop = await loadManagedProperty(db, actor, propertyId);
  const [nights, blocks] = await Promise.all([nightlyInfo(db, prop, from, to), activeBlocks(db, propertyId, from, to)]);
  const blockDto = (b: BlockOverlay) => ({
    blockId: b.id,
    type: b.block_type,
    sourceType: b.source_type,
    sourceId: b.source_id,
    start: b.start,
    end: b.end,
    expiresAt: b.expires_at,
    note: b.note,
    reservation: b.reservation_id ? { id: b.reservation_id, code: b.reservation_code, status: b.reservation_status } : null,
  });
  const days = nights.map((n) => {
    const b = blocks.find((x) => covers(x, n.date));
    return {
      date: n.date,
      availability: n.status,
      priceMinor: n.priceMinor,
      priceSource: n.source,
      minNights: n.minNights ?? prop.min_nights,
      block: b ? { blockId: b.id, type: b.block_type, sourceType: b.source_type, sourceId: b.source_id, reservationId: b.reservation_id } : null,
    };
  });
  return { propertyId, currency: prop.currency, from, to, days, blocks: blocks.map(blockDto) };
}

