import type { Db } from '../../platform/db.js';
import { maybeOne, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import type { Actor, Role } from '../../platform/auth.js';
import { hasRole, isStaff } from '../../platform/auth.js';
import { audit } from '../../platform/audit.js';
import { forbidden, notFound, conflict } from '../../platform/errors.js';
import { emit } from '../../platform/outbox.js';
import { acquireBlock, releaseBlock } from '../../platform/inventory.js';
import { assertRange, localToday } from './dates.js';
import { loadProperty, nightlyInfo, type PropertyRow } from './pricing.js';

/**
 * Staff overrides in the booking module are role-scoped (least privilege), never "any staff role", and always
 * need an AAL2 session:
 *  READ      someone else's reservation detail / cancellation preview / host calendar (audited ELEVATED_ACCESS)
 *  LIFECYCLE check-in / complete / no-show / hold release on behalf of a party; exact address in staff reads
 *  CANCEL    staff cancellation = 100 % refund incl. the service fee → the PAY-02 staff-refund roles (ACCOUNTING/ADMIN)
 *  MANAGE    price / availability / host-block writes on another host's listing (ADMIN only, audited)
 * EDITOR and COMPLIANCE get none of them.
 */
export const STAFF_CAPABILITIES = {
  READ: ['ADMIN', 'SUPPORT', 'ACCOUNTING'],
  LIFECYCLE: ['ADMIN', 'SUPPORT'],
  CANCEL: ['ADMIN', 'ACCOUNTING'],
  MANAGE: ['ADMIN'],
} as const satisfies Record<string, readonly Role[]>;
export type StaffCapability = keyof typeof STAFF_CAPABILITIES;

export const staffOk = (actor: Actor | null | undefined, cap: StaffCapability = 'READ') =>
  !!actor && actor.aal === 'aal2' && hasRole(actor, ...STAFF_CAPABILITIES[cap]);

/** 403 for an actor without the capability; staff learn which roles the action needs. */
export function staffDenied(actor: Actor | null | undefined, cap: StaffCapability) {
  if (actor && isStaff(actor)) {
    if (actor.aal !== 'aal2') return forbidden('AAL2_REQUIRED', 'Multi-factor authentication is required for this action');
    return forbidden('ROLE_REQUIRED', `Requires one of: ${STAFF_CAPABILITIES[cap].join(', ')}`);
  }
  return forbidden();
}

/** Owner, or staff with `cap` (MANAGE for writes). Returns whether the access is a staff override. */
export async function loadManagedProperty(db: Db, actor: Actor, propertyId: string, cap: 'READ' | 'MANAGE' = 'MANAGE'): Promise<PropertyRow & { staffOverride: boolean }> {
  const prop = await loadProperty(db, propertyId);
  if (prop.host_id === actor.userId) return { ...prop, staffOverride: false };
  if (!staffOk(actor, cap)) throw staffDenied(actor, cap);
  return { ...prop, staffOverride: true };
}

async function auditStaffWrite(db: Db, ctx: Ctx, prop: PropertyRow & { staffOverride: boolean }, action: string, after: unknown) {
  if (!prop.staffOverride) return;
  await audit(db, ctx, { action, resourceType: 'property', resourceId: prop.id, after: { hostId: prop.host_id, ...(after as object) }, category: 'PERMISSION' });
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
  const prop = await loadManagedProperty(tx, actor, propertyId, 'MANAGE');
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
  await auditStaffWrite(tx, ctx, prop, 'availability.staff_updated', { ranges });
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
  const prop = await loadManagedProperty(tx, actor, propertyId, 'MANAGE');
  assertRange(b.start, b.end, 400);
  const block = await acquireBlock(tx, {
    propertyId, start: b.start, end: b.end, blockType: 'HOST_BLOCK', sourceType: 'HOST', sourceId: null, createdBy: actor.userId, note: b.note,
  });
  await auditStaffWrite(tx, ctx, prop, 'host_block.staff_added', { blockId: block.id, start: b.start, end: b.end });
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
  const prop = await loadManagedProperty(tx, actor, propertyId, 'MANAGE');
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
  await auditStaffWrite(tx, ctx, prop, 'host_block.staff_removed', { blockId, start: block.start, end: block.end });
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
  const privileged = !!actor && (prop.host_id === actor.userId || staffOk(actor, 'READ'));
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
export async function hostCalendar(db: Db, actor: Actor, propertyId: string, from: string, to: string, ctx: Ctx) {
  assertRange(from, to, 400);
  const prop = await loadManagedProperty(db, actor, propertyId, 'READ');
  const [nights, blocks] = await Promise.all([nightlyInfo(db, prop, from, to), activeBlocks(db, propertyId, from, to)]);
  if (prop.staffOverride) {
    await audit(db, ctx, { action: 'host_calendar.read', resourceType: 'property', resourceId: propertyId, after: { from, to }, category: 'ELEVATED_ACCESS' });
  }
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

