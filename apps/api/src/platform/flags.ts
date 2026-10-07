import type { Db } from './db.js';
import { maybeOne } from './db.js';
import { forbidden } from './errors.js';

/** Feature flags default OFF when missing (PLAT-06: critical features can stay OFF independent of deploys). */
export async function isEnabled(db: Db, key: string, subject?: { userId?: string; roles?: string[] }): Promise<boolean> {
  const row = await maybeOne<{ enabled: boolean; rules: any }>(db, `SELECT enabled, rules FROM feature_flags WHERE flag_key = $1`, [key]);
  if (!row) return false;
  if (row.enabled) return true;
  // allowlist rules: {"allow_user_ids": [...], "allow_roles": [...]} enable for specific subjects while globally OFF
  const r = row.rules ?? {};
  if (subject?.userId && Array.isArray(r.allow_user_ids) && r.allow_user_ids.includes(subject.userId)) return true;
  if (subject?.roles && Array.isArray(r.allow_roles) && subject.roles.some((x) => r.allow_roles.includes(x))) return true;
  return false;
}

export async function assertEnabled(db: Db, key: string, subject?: { userId?: string; roles?: string[] }) {
  if (!(await isEnabled(db, key, subject))) throw forbidden('FEATURE_DISABLED', `Feature '${key}' is not enabled`);
}

export async function setFlag(db: Db, key: string, enabled: boolean, updatedBy: string | null = null) {
  await db.query(
    `INSERT INTO feature_flags(flag_key, enabled, updated_by) VALUES ($1,$2,$3)
     ON CONFLICT (flag_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, enabled, updatedBy],
  );
}
