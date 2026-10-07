import type { Db } from '../../platform/db.js';
import { maybeOne } from '../../platform/db.js';
import { forbidden } from '../../platform/errors.js';

/**
 * HOST-01 contract (owner: hosts module / Agent A). Minimal implementation created by the Stay Catalog
 * agent because properties (STAY-01) consumes it; the owner may extend it.
 * A host may publish only when the HOST role is granted and host_profiles.status = 'APPROVED'.
 */
export async function assertHostCanPublish(db: Db, userId: string): Promise<void> {
  const row = await maybeOne<{ status: string; has_role: boolean }>(
    db,
    `SELECT hp.status,
            EXISTS (SELECT 1 FROM user_roles r WHERE r.user_id = hp.user_id AND r.role = 'HOST') AS has_role
       FROM host_profiles hp WHERE hp.user_id = $1`,
    [userId],
  );
  if (!row || row.status !== 'APPROVED' || !row.has_role) {
    throw forbidden('HOST_NOT_APPROVED', 'Host onboarding must be approved before publishing listings');
  }
}
