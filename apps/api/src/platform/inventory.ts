import type { Db } from './db.js';
import { maybeOne, q } from './db.js';
import { conflict, badRequest } from './errors.js';

export type BlockType = 'HOLD' | 'RESERVATION' | 'EXCHANGE' | 'HOST_BLOCK' | 'EXTERNAL';
export type SourceType = 'RESERVATION_HOLD' | 'RESERVATION' | 'EXCHANGE' | 'HOST' | 'INTEGRATION';

export interface InventoryBlock {
  id: string;
  property_id: string;
  stay_range: string;
  block_type: BlockType;
  source_type: SourceType;
  source_id: string | null;
  state: 'ACTIVE' | 'RELEASED' | 'EXPIRED';
  expires_at: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function assertDateRange(start: string, end: string) {
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) throw badRequest('INVALID_DATE', 'Dates must be YYYY-MM-DD');
  if (end <= start) throw badRequest('INVALID_DATE_RANGE', 'End date must be after start date');
}

/** Expire overdue ACTIVE blocks overlapping a range so they do not block new acquisitions. */
export async function expireOverdueBlocks(db: Db, propertyId: string, start: string, end: string) {
  await db.query(
    `UPDATE inventory_blocks SET state = 'EXPIRED', released_at = now()
      WHERE property_id = $1 AND state = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= now()
        AND stay_range && daterange($2::date, $3::date, '[)')`,
    [propertyId, start, end],
  );
}

/**
 * Acquire a durable occupancy block for [start, end) inside the caller's transaction (invariant 5).
 * The DB exclusion constraint `no_overlapping_active_property_blocks` guarantees no overlap across paid
 * stays, exchanges and host blocks even under concurrency; a violation surfaces as 409 INVENTORY_UNAVAILABLE.
 */
export async function acquireBlock(
  db: Db,
  b: { propertyId: string; start: string; end: string; blockType: BlockType; sourceType: SourceType; sourceId?: string | null; expiresAt?: Date | null; createdBy?: string | null; note?: string },
): Promise<InventoryBlock> {
  assertDateRange(b.start, b.end);
  await expireOverdueBlocks(db, b.propertyId, b.start, b.end);
  await db.query('SAVEPOINT acquire_block');
  try {
    const row = await maybeOne<InventoryBlock>(
      db,
      `INSERT INTO inventory_blocks(property_id, stay_range, block_type, source_type, source_id, expires_at, created_by, note)
       VALUES ($1, daterange($2::date, $3::date, '[)'), $4, $5, $6, $7, $8, $9) RETURNING *`,
      [b.propertyId, b.start, b.end, b.blockType, b.sourceType, b.sourceId ?? null, b.expiresAt ?? null, b.createdBy ?? null, b.note ?? null],
    );
    await db.query('RELEASE SAVEPOINT acquire_block');
    return row!;
  } catch (err: any) {
    await db.query('ROLLBACK TO SAVEPOINT acquire_block');
    if (err?.code === '23P01') throw conflict('INVENTORY_UNAVAILABLE', 'The requested dates are no longer available', { propertyId: b.propertyId, start: b.start, end: b.end });
    throw err;
  }
}

export async function releaseBlock(db: Db, blockId: string, state: 'RELEASED' | 'EXPIRED' = 'RELEASED') {
  await db.query(`UPDATE inventory_blocks SET state = $2, released_at = now() WHERE id = $1 AND state = 'ACTIVE'`, [blockId, state]);
}

/** Convert a HOLD block into a durable RESERVATION block (no TTL) without ever releasing the dates. */
export async function convertBlock(db: Db, blockId: string, to: { blockType: BlockType; sourceType: SourceType; sourceId: string }) {
  const row = await maybeOne<InventoryBlock>(
    db,
    `UPDATE inventory_blocks SET block_type = $2, source_type = $3, source_id = $4, expires_at = NULL
      WHERE id = $1 AND state = 'ACTIVE' RETURNING *`,
    [blockId, to.blockType, to.sourceType, to.sourceId],
  );
  if (!row) throw conflict('HOLD_EXPIRED', 'The inventory hold is no longer active');
  return row;
}

/** Is [start,end) free of ACTIVE (non-expired) blocks? Read-only check; writers must still use acquireBlock. */
export async function isRangeFree(db: Db, propertyId: string, start: string, end: string, ignoreBlockId?: string): Promise<boolean> {
  const rows = await q(
    db,
    `SELECT 1 FROM inventory_blocks
      WHERE property_id = $1 AND state = 'ACTIVE' AND (expires_at IS NULL OR expires_at > now())
        AND stay_range && daterange($2::date, $3::date, '[)') AND ($4::uuid IS NULL OR id <> $4) LIMIT 1`,
    [propertyId, start, end, ignoreBlockId ?? null],
  );
  return rows.length === 0;
}

/** Sweep job: mark overdue holds EXPIRED globally. Returns affected block ids. */
export async function sweepExpiredBlocks(db: Db): Promise<string[]> {
  const rows = await q<{ id: string }>(
    db,
    `UPDATE inventory_blocks SET state = 'EXPIRED', released_at = now()
      WHERE state = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= now() RETURNING id`,
  );
  return rows.map((r) => r.id);
}
