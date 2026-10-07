import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { maybeOne } from './db.js';
import { forbidden } from './errors.js';

/**
 * Flag rules (feature_flags.rules jsonb). Evaluation order — the first match decides:
 *   1. {"kill_switch": true}   → OFF for everyone, even when `enabled` is true or the subject is allow-listed.
 *   2. enabled = true          → ON for everyone.
 *   3. {"allow_user_ids": [...], "allow_roles": [...]} → ON for the listed subjects while globally OFF.
 *   4. {"rollout_pct": 0-100}  → ON for a deterministic bucket of users: bucket(flagKey, userId) < pct, where
 *      bucket = first 4 bytes (uint32, big-endian) of sha256(flagKey + ':' + userId) mod 100. The same user always
 *      lands in the same bucket for a flag, and raising pct only adds users. 100 enables everyone (anonymous too);
 *      below 100 an anonymous subject is OFF.
 *   5. otherwise OFF (missing flags are OFF: PLAT-06, critical features stay off independent of deploys).
 */
export interface FlagRules {
  kill_switch?: boolean;
  allow_user_ids?: string[];
  allow_roles?: string[];
  rollout_pct?: number;
}

export interface FlagSubject {
  userId?: string;
  roles?: string[];
}

/** Deterministic rollout bucket in [0, 100). */
export function rolloutBucket(flagKey: string, userId: string): number {
  return createHash('sha256').update(`${flagKey}:${userId}`).digest().readUInt32BE(0) % 100;
}

/** Pure rule evaluation (exported for tests and for admin "who gets this flag" previews). */
export function evaluateFlag(flagKey: string, row: { enabled: boolean; rules: unknown } | null, subject?: FlagSubject): boolean {
  if (!row) return false;
  const r: FlagRules = row.rules && typeof row.rules === 'object' && !Array.isArray(row.rules) ? (row.rules as FlagRules) : {};
  if (r.kill_switch === true) return false;
  if (row.enabled) return true;
  if (subject?.userId && Array.isArray(r.allow_user_ids) && r.allow_user_ids.includes(subject.userId)) return true;
  if (subject?.roles && Array.isArray(r.allow_roles) && subject.roles.some((x) => r.allow_roles!.includes(x))) return true;
  const pct = typeof r.rollout_pct === 'number' && Number.isFinite(r.rollout_pct) ? Math.min(100, Math.max(0, r.rollout_pct)) : 0;
  if (pct >= 100) return true;
  if (pct > 0 && subject?.userId) return rolloutBucket(flagKey, subject.userId) < pct;
  return false;
}

/** Feature flags default OFF when missing (PLAT-06: critical features can stay OFF independent of deploys). */
export async function isEnabled(db: Db, key: string, subject?: { userId?: string; roles?: string[] }): Promise<boolean> {
  const row = await maybeOne<{ enabled: boolean; rules: unknown }>(db, `SELECT enabled, rules FROM feature_flags WHERE flag_key = $1`, [key]);
  return evaluateFlag(key, row, subject);
}

export async function assertEnabled(db: Db, key: string, subject?: { userId?: string; roles?: string[] }) {
  if (!(await isEnabled(db, key, subject))) throw forbidden('FEATURE_DISABLED', `Feature '${key}' is not enabled`);
}

/**
 * Upsert a flag's enabled state. Every effective change is versioned in `config_versions` by a DB trigger
 * (changed_by = updated_by). `reason`, when given, is recorded with the version (session setting
 * `jetpool.change_reason`, local to the current transaction).
 */
export async function setFlag(db: Db, key: string, enabled: boolean, updatedBy: string | null = null, reason?: string) {
  await db.query(
    `WITH cfg AS (SELECT set_config('jetpool.change_reason', coalesce($4::text, ''), true) AS r)
     INSERT INTO feature_flags(flag_key, enabled, updated_by) SELECT $1, $2, $3 FROM cfg
     ON CONFLICT (flag_key) DO UPDATE SET enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [key, enabled, updatedBy, reason ?? null],
  );
}
