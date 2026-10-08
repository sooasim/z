import type { Db } from '../../platform/db.js';
import { q } from '../../platform/db.js';

export const SANCTION_TYPES = ['WARNING', 'LISTING_SUSPENSION', 'PAYOUT_HOLD', 'ACCOUNT_SUSPENSION', 'BAN'] as const;
export type SanctionType = (typeof SANCTION_TYPES)[number];
/** Sanctions that keep an account suspended while active. */
export const ACCOUNT_BLOCKING_SANCTIONS: SanctionType[] = ['ACCOUNT_SUSPENSION', 'BAN'];

/**
 * Active (started, not ended, not lifted) sanctions of a user, optionally filtered by type.
 * "Started" is compared with clock_timestamp(), not now(): now() is the reading transaction's START time, so a
 * sanction committed by a transaction that began later (e.g. a BAN racing a lift or the expiry sweep) would
 * otherwise look "not yet started" and be ignored by the restore decision.
 */
export async function activeSanctions(db: Db, userId: string, types?: readonly SanctionType[]) {
  return q(
    db,
    `SELECT * FROM sanctions WHERE user_id = $1 AND lifted_at IS NULL AND starts_at <= clock_timestamp() AND (ends_at IS NULL OR ends_at > now())
        AND ($2::text[] IS NULL OR sanction_type = ANY($2)) ORDER BY starts_at DESC`,
    [userId, types ? [...types] : null],
  );
}

/**
 * Serialize sanction decisions for one user (apply / lift / expiry restore) on the users row, so a restore
 * decision and a concurrently applied blocking sanction can never interleave.
 */
export async function lockSanctionSubject(db: Db, userId: string) {
  await db.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [userId]);
}

export async function hasActiveSanction(db: Db, userId: string, types: readonly SanctionType[]): Promise<boolean> {
  return (await activeSanctions(db, userId, types)).length > 0;
}
