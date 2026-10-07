import type { Db } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { audit } from '../../platform/audit.js';
import { emit } from '../../platform/outbox.js';
import { isEnabled } from '../../platform/flags.js';
import { badRequest, conflict, forbidden, notFound } from '../../platform/errors.js';
import { gmv } from '../analytics/service.js';

/** OPS-02 backoffice + PLAT-06 flags/config. */

export async function overview(db: Db) {
  const [gmvRows, reservations, exchanges, guideBookings, orders, disputes, verification, compliance, outbox, webhooks] = await Promise.all([
    gmv(db),
    q(db, `SELECT status, count(*)::int AS n FROM reservations GROUP BY status ORDER BY status`),
    q(db, `SELECT status, count(*)::int AS n FROM exchange_requests GROUP BY status ORDER BY status`),
    q(db, `SELECT status, count(*)::int AS n FROM guide_bookings GROUP BY status ORDER BY status`),
    q(db, `SELECT status, count(*)::int AS n FROM orders GROUP BY status ORDER BY status`),
    one(db, `SELECT count(*)::int AS open, count(*) FILTER (WHERE severity IN ('HIGH','CRITICAL'))::int AS high_severity FROM disputes WHERE status NOT IN ('RESOLVED','REJECTED')`),
    one(db, `SELECT count(*)::int AS pending, min(submitted_at) AS oldest FROM verification_cases WHERE status IN ('SUBMITTED','IN_REVIEW')`),
    one(
      db,
      `SELECT (SELECT count(*)::int FROM property_permits WHERE status = 'PENDING') AS permits_pending,
              (SELECT count(*)::int FROM properties WHERE status = 'IN_REVIEW') AS listings_in_review,
              (SELECT count(*)::int FROM guide_qualifications WHERE status = 'PENDING') AS guide_qualifications_pending`,
    ),
    one(
      db,
      `SELECT count(*) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)::int AS pending,
              coalesce(extract(epoch FROM now() - min(created_at) FILTER (WHERE published_at IS NULL AND dead_lettered_at IS NULL)), 0)::int AS oldest_pending_age_sec,
              count(*) FILTER (WHERE dead_lettered_at IS NOT NULL)::int AS dead_letters
         FROM outbox_events`,
    ),
    one(
      db,
      `SELECT count(*) FILTER (WHERE process_error IS NOT NULL)::int AS failed,
              count(*) FILTER (WHERE NOT signature_valid)::int AS invalid_signature,
              count(*) FILTER (WHERE processed_at IS NULL AND process_error IS NULL AND created_at < now() - interval '5 minutes')::int AS stuck
         FROM webhook_events`,
    ),
  ]);
  const byStatus = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return {
    generatedAt: new Date().toISOString(),
    gmv: gmvRows.map((g) => ({ currency: g.currency, gmvMinor: g.gmv_minor, grossMinor: g.gross_minor, refundedMinor: g.refunded_minor })),
    bookings: { reservations: byStatus(reservations), exchanges: byStatus(exchanges), guideBookings: byStatus(guideBookings), orders: byStatus(orders) },
    disputes: { open: disputes.open, highSeverity: disputes.high_severity },
    verificationBacklog: { pending: verification.pending, oldestSubmittedAt: verification.oldest },
    complianceBacklog: { permitsPending: compliance.permits_pending, listingsInReview: compliance.listings_in_review, guideQualificationsPending: compliance.guide_qualifications_pending },
    outbox: { pending: outbox.pending, oldestPendingAgeSec: outbox.oldest_pending_age_sec, deadLetters: outbox.dead_letters },
    webhooks: { failed: webhooks.failed, invalidSignature: webhooks.invalid_signature, stuck: webhooks.stuck },
  };
}

// ---------------------------------------------------------------- feature flags

export async function listFlags(db: Db) {
  return q(db, `SELECT flag_key, description, enabled, rules, updated_by, updated_at FROM feature_flags ORDER BY flag_key`);
}

export async function updateFlag(
  db: Db,
  ctx: Ctx,
  args: { flagKey: string; enabled?: boolean; rules?: Record<string, unknown>; description?: string; reason: string; create?: boolean },
) {
  const before = await maybeOne(db, `SELECT flag_key, enabled, rules, description FROM feature_flags WHERE flag_key = $1 FOR UPDATE`, [args.flagKey]);
  if (!before && !args.create) throw notFound('Feature flag');
  const row = await one(
    db,
    `INSERT INTO feature_flags(flag_key, description, enabled, rules, updated_by) VALUES ($1,$2,coalesce($3,false),coalesce($4,'{}'::jsonb),$5)
     ON CONFLICT (flag_key) DO UPDATE SET enabled = coalesce($3, feature_flags.enabled), rules = coalesce($4, feature_flags.rules),
       description = coalesce($2, feature_flags.description), updated_by = $5, updated_at = now()
     RETURNING flag_key, description, enabled, rules, updated_by, updated_at`,
    [args.flagKey, args.description ?? null, args.enabled ?? null, args.rules ? JSON.stringify(args.rules) : null, ctx.actor?.userId ?? null],
  );
  await audit(db, ctx, { action: 'feature_flag.updated', resourceType: 'feature_flag', resourceId: args.flagKey, before, after: row, reason: args.reason, category: 'PERMISSION' });
  await emit(db, ctx, {
    aggregateType: 'config',
    aggregateId: args.flagKey,
    eventType: 'config.changed',
    payload: { kind: 'feature_flag', key: args.flagKey, enabled: row.enabled, previous: before?.enabled ?? null, actorId: ctx.actor?.userId ?? null },
  });
  return row;
}

/** Flags safe for the web app: enabled state only (allowlist rules are never exposed), evaluated for the viewer. */
export async function publicConfig(db: Db, subject?: { userId?: string; roles?: string[] }) {
  const flags = await q<{ flag_key: string }>(db, `SELECT flag_key FROM feature_flags ORDER BY flag_key`);
  const out: Record<string, boolean> = {};
  for (const f of flags) out[f.flag_key] = await isEnabled(db, f.flag_key, subject);
  const cfg = await q<{ config_key: string; value: unknown }>(
    db,
    `SELECT DISTINCT ON (config_key) config_key, value FROM config_values
      WHERE config_key LIKE 'public.%' AND approved_by IS NOT NULL AND effective_from <= now() AND (effective_until IS NULL OR effective_until > now())
      ORDER BY config_key, effective_from DESC`,
  );
  return { flags: out, config: Object.fromEntries(cfg.map((c) => [c.config_key.slice('public.'.length), c.value])) };
}

// ---------------------------------------------------------------- effective-dated config (invariant 8)

export const CONFIG_KEY_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){1,5}$/;
const SENSITIVE_KEY_RE = /(secret|password|token|api_?key|private)/i;

/** Approved value effective at `at` (default now), or null. */
export async function getEffectiveConfig<T = unknown>(db: Db, key: string, at: Date = new Date()): Promise<T | null> {
  const row = await maybeOne<{ value: T }>(
    db,
    `SELECT value FROM config_values WHERE config_key = $1 AND approved_by IS NOT NULL
        AND effective_from <= $2 AND (effective_until IS NULL OR effective_until > $2)
      ORDER BY effective_from DESC LIMIT 1`,
    [key, at],
  );
  return row?.value ?? null;
}

export async function listConfig(db: Db, key?: string) {
  const rows = await q(
    db,
    `SELECT config_key, value, effective_from, effective_until, proposed_by, approved_by, approved_at, note, created_at,
            (approved_by IS NOT NULL AND effective_from <= now() AND (effective_until IS NULL OR effective_until > now())) AS in_window
       FROM config_values WHERE ($1::text IS NULL OR config_key = $1) ORDER BY config_key, effective_from DESC`,
    [key ?? null],
  );
  // exactly one effective row per key: the newest approved in-window
  const seen = new Set<string>();
  return rows.map((r) => {
    const effective = r.in_window && !seen.has(r.config_key);
    if (effective) seen.add(r.config_key);
    const { in_window: _w, ...rest } = r;
    return { ...rest, status: r.approved_by ? 'APPROVED' : 'PENDING_APPROVAL', effective };
  });
}

export async function proposeConfig(
  db: Db,
  ctx: Ctx,
  args: { key: string; value: unknown; effectiveFrom?: string; effectiveUntil?: string; note?: string },
) {
  if (!CONFIG_KEY_RE.test(args.key)) throw badRequest('INVALID_CONFIG_KEY', 'Config keys are dotted lowercase identifiers, e.g. fees.stay.guest_bps');
  if (SENSITIVE_KEY_RE.test(args.key)) throw badRequest('SECRET_IN_CONFIG', 'Secrets must not be stored in config_values');
  const from = args.effectiveFrom ? new Date(args.effectiveFrom) : new Date();
  if (args.effectiveUntil && new Date(args.effectiveUntil) <= from) throw badRequest('INVALID_RANGE', 'effectiveUntil must be after effectiveFrom');
  const row = await maybeOne(
    db,
    `INSERT INTO config_values(config_key, value, effective_from, effective_until, note, proposed_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (config_key, effective_from) DO NOTHING RETURNING *`,
    [args.key, JSON.stringify(args.value), from, args.effectiveUntil ?? null, args.note ?? null, ctx.actor?.userId ?? null],
  );
  if (!row) throw conflict('CONFIG_VERSION_EXISTS', 'A version with this effectiveFrom already exists');
  await audit(db, ctx, { action: 'config.proposed', resourceType: 'config_value', resourceId: args.key, after: row, category: 'GENERAL' });
  return row;
}

/** Four-eyes: the approver must differ from the proposer. */
export async function approveConfig(db: Db, ctx: Ctx, args: { key: string; effectiveFrom: string; reason: string }) {
  const row = await maybeOne(
    db,
    `SELECT * FROM config_values WHERE config_key = $1 AND effective_from = $2 FOR UPDATE`,
    [args.key, new Date(args.effectiveFrom)],
  );
  if (!row) throw notFound('Config version');
  if (row.approved_by) throw conflict('ALREADY_APPROVED', 'This config version is already approved');
  if (row.proposed_by && row.proposed_by === ctx.actor?.userId) throw forbidden('FOUR_EYES_REQUIRED', 'A different administrator must approve this change');
  const updated = await one(
    db,
    `UPDATE config_values SET approved_by = $3, approved_at = now() WHERE config_key = $1 AND effective_from = $2 RETURNING *`,
    [args.key, row.effective_from, ctx.actor?.userId ?? null],
  );
  await audit(db, ctx, { action: 'config.approved', resourceType: 'config_value', resourceId: args.key, before: row, after: updated, reason: args.reason, category: 'GENERAL' });
  await emit(db, ctx, {
    aggregateType: 'config',
    aggregateId: args.key,
    eventType: 'config.changed',
    payload: { kind: 'config_value', key: args.key, effectiveFrom: updated.effective_from, effectiveUntil: updated.effective_until, approvedBy: ctx.actor?.userId ?? null },
  });
  return updated;
}

// ---------------------------------------------------------------- dead-letter outbox

export async function listDeadLetters(db: Db, limit: number) {
  return q(
    db,
    `SELECT id, aggregate_type, aggregate_id, event_type, version, attempts, last_error, created_at, dead_lettered_at, correlation_id
       FROM outbox_events WHERE dead_lettered_at IS NOT NULL ORDER BY dead_lettered_at DESC LIMIT $1`,
    [limit],
  );
}

/** Re-queue a dead-lettered event. Consumers that already succeeded are skipped via outbox_consumptions. */
export async function retryDeadLetter(db: Db, ctx: Ctx, id: string, reason: string) {
  const before = await maybeOne(db, `SELECT id, event_type, attempts, last_error, dead_lettered_at FROM outbox_events WHERE id = $1 FOR UPDATE`, [id]);
  if (!before) throw notFound('Outbox event');
  if (!before.dead_lettered_at) throw conflict('NOT_DEAD_LETTERED', 'The event is not dead-lettered');
  const row = await one(
    db,
    `UPDATE outbox_events SET dead_lettered_at = NULL, attempts = 0, available_at = now() WHERE id = $1 RETURNING id, event_type, attempts, available_at`,
    [id],
  );
  await audit(db, ctx, { action: 'outbox.dead_letter.retried', resourceType: 'outbox_event', resourceId: id, before, after: row, reason, category: 'GENERAL' });
  await emit(db, ctx, { aggregateType: 'admin', aggregateId: id, eventType: 'admin.action.performed', payload: { action: 'outbox.retry', eventId: id, actorId: ctx.actor?.userId ?? null } });
  return row;
}
