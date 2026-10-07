import type { Db } from '../../platform/db.js';
import { q } from '../../platform/db.js';

export const SANCTION_TYPES = ['WARNING', 'LISTING_SUSPENSION', 'PAYOUT_HOLD', 'ACCOUNT_SUSPENSION', 'BAN'] as const;
export type SanctionType = (typeof SANCTION_TYPES)[number];
/** Sanctions that keep an account suspended while active. */
export const ACCOUNT_BLOCKING_SANCTIONS: SanctionType[] = ['ACCOUNT_SUSPENSION', 'BAN'];

/** Active (started, not ended, not lifted) sanctions of a user, optionally filtered by type. */
export async function activeSanctions(db: Db, userId: string, types?: readonly SanctionType[]) {
  return q(
    db,
    `SELECT * FROM sanctions WHERE user_id = $1 AND lifted_at IS NULL AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
        AND ($2::text[] IS NULL OR sanction_type = ANY($2)) ORDER BY starts_at DESC`,
    [userId, types ? [...types] : null],
  );
}

export async function hasActiveSanction(db: Db, userId: string, types: readonly SanctionType[]): Promise<boolean> {
  return (await activeSanctions(db, userId, types)).length > 0;
}
