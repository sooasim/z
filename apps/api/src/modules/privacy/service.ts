import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { AppError, conflict, notFound, unprocessable } from '../../platform/errors.js';
import { revokeAllSessions, userStatusMachine } from '../identity/users.js';

export const CONSENT_TYPES = ['TERMS', 'PRIVACY', 'MARKETING', 'LOCATION', 'THIRD_PARTY', 'EXCHANGE_TERMS', 'GUIDE_TERMS', 'REFUND_POLICY'] as const;
export type ConsentType = (typeof CONSENT_TYPES)[number];
/** Consents every account must grant at signup (CORE-04). */
export const SIGNUP_REQUIRED_CONSENTS: ConsentType[] = ['TERMS', 'PRIVACY'];

export interface ConsentInput {
  type: ConsentType;
  version: string;
  granted: boolean;
}

export interface ConsentDocument {
  consent_type: ConsentType;
  version: string;
  title: string;
  body_md: string;
  required: boolean;
  published_at: string | null;
}

/**
 * Current document version per consent type: the latest PUBLISHED version. Outside production we fall back
 * to the latest draft so environments work before legal publishes (G9); production never accepts drafts.
 */
export async function currentConsentDocuments(db: Db, ctx: Pick<Ctx, 'app'>, type?: ConsentType): Promise<ConsentDocument[]> {
  const allowDrafts = ctx.app.config.NODE_ENV !== 'production';
  return q<ConsentDocument>(
    db,
    `SELECT DISTINCT ON (consent_type) consent_type, version, title, body_md, required, published_at
       FROM consent_documents
      WHERE ($1::text IS NULL OR consent_type = $1) AND (published_at IS NOT NULL AND published_at <= now() OR $2)
      ORDER BY consent_type, (published_at IS NOT NULL AND published_at <= now()) DESC, published_at DESC NULLS LAST, version DESC`,
    [type ?? null, allowDrafts],
  );
}

/** Validates that the required consents are granted with the CURRENT version. Throws 422 otherwise. */
export async function assertRequiredConsents(db: Db, ctx: Pick<Ctx, 'app'>, consents: ConsentInput[], required: ConsentType[] = SIGNUP_REQUIRED_CONSENTS) {
  const docs = await currentConsentDocuments(db, ctx);
  const missing: Array<{ type: string; version: string | null }> = [];
  for (const type of required) {
    const doc = docs.find((d) => d.consent_type === type);
    if (!doc) throw new AppError(503, 'CONSENT_DOCUMENT_UNAVAILABLE', `No published ${type} document is available`);
    const given = consents.find((c) => c.type === type);
    if (!given || !given.granted || given.version !== doc.version) missing.push({ type, version: doc.version });
  }
  if (missing.length) throw unprocessable('CONSENT_REQUIRED', 'Required consents must be granted for the current document versions', { missing });
}

/**
 * Append consent records with evidence (ip, user agent, version, correlation id). Used by identity signup and
 * POST /v1/consents. Unknown (type, version) pairs are rejected. Keeps user_preferences.marketing_opt_in in sync.
 */
export async function recordConsents(tx: Tx, ctx: Ctx, userId: string, consents: ConsentInput[], source = 'API') {
  const out: any[] = [];
  for (const c of consents) {
    const doc = await maybeOne(tx, `SELECT 1 FROM consent_documents WHERE consent_type = $1 AND version = $2`, [c.type, c.version]);
    if (!doc) throw unprocessable('CONSENT_DOCUMENT_NOT_FOUND', `Unknown consent document ${c.type}@${c.version}`);
    const evidence = { ip: ctx.ip ?? null, userAgent: ctx.userAgent ?? null, version: c.version, source, correlationId: ctx.correlationId };
    const row = await one(
      tx,
      `INSERT INTO consent_records(user_id, consent_type, version, granted, evidence) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [userId, c.type, c.version, c.granted, JSON.stringify(evidence)],
    );
    out.push(row);
    if (c.type === 'MARKETING') {
      await tx.query(
        `INSERT INTO user_preferences(user_id, marketing_opt_in) VALUES ($1,$2)
         ON CONFLICT (user_id) DO UPDATE SET marketing_opt_in = EXCLUDED.marketing_opt_in`,
        [userId, c.granted],
      );
    }
  }
  if (out.length) {
    await emit(tx, ctx, {
      aggregateType: 'user',
      aggregateId: userId,
      eventType: 'consent.recorded',
      payload: { userId, consents: consents.map((c) => ({ type: c.type, version: c.version, granted: c.granted })), source },
    });
    await audit(tx, ctx, {
      action: 'consent.recorded',
      resourceType: 'user',
      resourceId: userId,
      after: consents.map((c) => ({ type: c.type, version: c.version, granted: c.granted })),
      category: 'PRIVACY',
      actorId: ctx.actor?.userId ?? userId,
    });
  }
  return out;
}

/** Latest consent state per type for a user. */
export async function consentState(db: Db, userId: string) {
  return q(
    db,
    `SELECT DISTINCT ON (consent_type) consent_type, version, granted, created_at
       FROM consent_records WHERE user_id = $1 ORDER BY consent_type, created_at DESC, id DESC`,
    [userId],
  );
}

/** Has the user currently granted `type` (optionally a specific version)? */
export async function hasConsent(db: Db, userId: string, type: ConsentType, version?: string): Promise<boolean> {
  const row = await maybeOne<{ granted: boolean; version: string }>(
    db,
    `SELECT granted, version FROM consent_records WHERE user_id = $1 AND consent_type = $2 ORDER BY created_at DESC, id DESC LIMIT 1`,
    [userId, type],
  );
  return !!row && row.granted && (!version || row.version === version);
}

// ---------------------------------------------------------------------------------------------------------
// Export (data portability)
// ---------------------------------------------------------------------------------------------------------

const EXPORT_QUERIES: Array<[string, string]> = [
  ['account', `SELECT id, email, phone, display_name, status, locale, email_verified_at, phone_verified_at, identity_verified_at, last_login_at, created_at FROM users WHERE id = $1`],
  ['profile', `SELECT * FROM user_profiles WHERE user_id = $1`],
  ['preferences', `SELECT * FROM user_preferences WHERE user_id = $1`],
  ['roles', `SELECT role, granted_at FROM user_roles WHERE user_id = $1`],
  ['linkedIdentities', `SELECT provider, email, linked_at FROM oauth_identities WHERE user_id = $1`],
  ['mfaFactors', `SELECT factor_type, status, created_at, verified_at FROM mfa_factors WHERE user_id = $1`],
  ['sessions', `SELECT id, aal, user_agent, host(ip) AS ip, created_at, last_used_at, expires_at, revoked_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`],
  ['consents', `SELECT consent_type, version, granted, evidence, created_at FROM consent_records WHERE user_id = $1 ORDER BY created_at`],
  ['privacyRequests', `SELECT id, request_type, status, requested_at, completed_at FROM privacy_requests WHERE user_id = $1 ORDER BY requested_at`],
  ['verifications', `SELECT id, subject_type, status, submitted_at, decided_at FROM verification_cases WHERE user_id = $1`],
  ['businessProfiles', `SELECT * FROM business_profiles WHERE user_id = $1`],
  ['hostProfile', `SELECT * FROM host_profiles WHERE user_id = $1`],
  ['hostApplications', `SELECT id, status, checklist, created_at, decided_at FROM host_applications WHERE user_id = $1`],
  ['reviewsWritten', `SELECT id, target_type, target_id, transaction_type, transaction_id, rating, sub_ratings, body, status, created_at FROM reviews WHERE author_id = $1`],
  ['disputes', `SELECT id, context_type, context_id, status, reason, description, created_at, resolved_at FROM disputes WHERE opened_by = $1`],
  ['safetyReports', `SELECT id, subject_type, subject_id, category, description, status, created_at FROM safety_reports WHERE reporter_id = $1`],
  ['supportCases', `SELECT id, category, subject, description, status, created_at FROM support_cases WHERE requester_id = $1`],
  ['properties', `SELECT id, title, status, created_at FROM properties WHERE host_id = $1`],
  ['reservations', `SELECT id, code, property_id, status, check_in, check_out, guests, total_minor, currency, created_at FROM reservations WHERE guest_id = $1 OR host_id = $1`],
  ['exchanges', `SELECT id, status, property_a_id, property_b_id, lower(dates_a) AS dates_a_start, upper(dates_a) AS dates_a_end, lower(dates_b) AS dates_b_start, upper(dates_b) AS dates_b_end, created_at FROM exchange_requests WHERE requester_id = $1 OR responder_id = $1`],
  ['guideBookings', `SELECT id, guide_id, traveler_id, status, start_at, end_at, price_minor, currency, created_at FROM guide_bookings WHERE guide_id = $1 OR traveler_id = $1`],
  ['orders', `SELECT id, code, status, total_minor, currency, created_at FROM orders WHERE buyer_id = $1`],
  ['payments', `SELECT id, subject_type, subject_id, status, amount_minor, currency, created_at FROM payments WHERE payer_id = $1`],
  ['favorites', `SELECT * FROM favorites WHERE user_id = $1`],
  ['messagesSent', `SELECT id, conversation_id, type, body, created_at FROM messages WHERE sender_id = $1 AND redacted_at IS NULL ORDER BY created_at LIMIT 5000`],
  ['notifications', `SELECT id, template_key, title, created_at FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1000`],
];

/** Builds a JSON export of the user's own data. Tables owned by modules not yet deployed are skipped safely. */
export async function buildExport(tx: Tx, userId: string) {
  const data: Record<string, unknown> = { generatedAt: new Date().toISOString(), userId, format: 'jetpool.export.v1' };
  for (const [key, sql] of EXPORT_QUERIES) {
    await tx.query('SAVEPOINT export_section');
    try {
      const rows = await q(tx, sql, [userId]);
      data[key] = key === 'account' || key === 'profile' || key === 'preferences' || key === 'hostProfile' ? rows[0] ?? null : rows;
      await tx.query('RELEASE SAVEPOINT export_section');
    } catch {
      await tx.query('ROLLBACK TO SAVEPOINT export_section');
      data[key] = null;
    }
  }
  return data;
}

export async function requestExport(tx: Tx, ctx: Ctx, userId: string) {
  const open = await maybeOne(
    tx,
    `SELECT id FROM privacy_requests WHERE user_id = $1 AND request_type = 'EXPORT' AND status = 'COMPLETED' AND completed_at > now() - interval '1 minute'`,
    [userId],
  );
  if (open) throw new AppError(429, 'EXPORT_RATE_LIMITED', 'An export was produced moments ago; please retry later');
  const req = await one(tx, `INSERT INTO privacy_requests(user_id, request_type, status) VALUES ($1,'EXPORT','PROCESSING') RETURNING id`, [userId]);
  await emit(tx, ctx, { aggregateType: 'privacy_request', aggregateId: req.id, eventType: 'privacy.requested', payload: { requestId: req.id, userId, type: 'EXPORT' } });
  const result = await buildExport(tx, userId);
  const done = await one(
    tx,
    `UPDATE privacy_requests SET status = 'COMPLETED', result = $2, completed_at = now() WHERE id = $1 RETURNING *`,
    [req.id, JSON.stringify(result)],
  );
  await emit(tx, ctx, { aggregateType: 'privacy_request', aggregateId: req.id, eventType: 'privacy.completed', payload: { requestId: req.id, userId, type: 'EXPORT' } });
  await audit(tx, ctx, { action: 'privacy.export', resourceType: 'user', resourceId: userId, after: { requestId: req.id }, category: 'PRIVACY' });
  return done;
}

// ---------------------------------------------------------------------------------------------------------
// Deletion (soft-delete + PII scrub; financial/legal records are retained)
// ---------------------------------------------------------------------------------------------------------

export const DELETION_GRACE_DAYS_DEFAULT = 7;

export async function deletionGraceDays(db: Db): Promise<number> {
  const row = await maybeOne<{ value: any }>(
    db,
    `SELECT value FROM config_values WHERE config_key = 'privacy.deletion_grace_days' AND effective_from <= now()
        AND (effective_until IS NULL OR effective_until > now()) ORDER BY effective_from DESC LIMIT 1`,
  );
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 ? n : DELETION_GRACE_DAYS_DEFAULT;
}

/**
 * Open obligations that must be settled before an account may be deleted (read-only checks on the owning domains'
 * tables). A deleted account cannot sign in, so it must not leave behind bookings or orders in flight, open
 * disputes, unpaid payouts, or inventory that guests can still book and pay for.
 */
const DELETION_BLOCKERS: Array<[string, string]> = [
  ['ACTIVE_RESERVATIONS', `SELECT 1 FROM reservations WHERE (guest_id = $1 OR host_id = $1) AND status IN ('HELD','PAYMENT_PENDING','CONFIRMED','CHECKED_IN','REFUND_PENDING','DISPUTED') LIMIT 1`],
  [
    'ACTIVE_EXCHANGES',
    `SELECT 1 FROM exchange_requests WHERE (requester_id = $1 OR responder_id = $1)
        AND status IN ('REQUESTED','COUNTERED','MUTUAL_ACCEPTED','VERIFICATION_PENDING','AGREEMENT_PENDING','CONFIRMED','IN_PROGRESS','DISPUTED') LIMIT 1`,
  ],
  ['ACTIVE_GUIDE_BOOKINGS', `SELECT 1 FROM guide_bookings WHERE (traveler_id = $1 OR guide_id = $1) AND status IN ('ACCEPTED','PAYMENT_PENDING','CONFIRMED','IN_PROGRESS','DISPUTED') LIMIT 1`],
  [
    'ACTIVE_ORDERS',
    `SELECT 1 FROM orders o WHERE o.status IN ('PAYMENT_PENDING','PAID') AND (o.buyer_id = $1 OR EXISTS (
        SELECT 1 FROM order_items i JOIN suppliers s ON s.id = i.supplier_id WHERE i.order_id = o.id AND i.status = 'ACTIVE' AND s.owner_user_id = $1)) LIMIT 1`,
  ],
  ['OPEN_DISPUTES', `SELECT 1 FROM disputes WHERE (opened_by = $1 OR counterparty_id = $1) AND status NOT IN ('RESOLVED','REJECTED') LIMIT 1`],
  ['UNSETTLED_PAYOUTS', `SELECT 1 FROM settlements WHERE payee_id = $1 AND status NOT IN ('PAID','RECONCILED') LIMIT 1`],
  ['PUBLISHED_LISTINGS', `SELECT 1 FROM properties WHERE host_id = $1 AND status = 'PUBLISHED' LIMIT 1`],
  ['PUBLISHED_GUIDE_PROFILE', `SELECT 1 FROM guide_profiles WHERE user_id = $1 AND status = 'PUBLISHED' LIMIT 1`],
  ['PUBLISHED_TRAVEL_PRODUCTS', `SELECT 1 FROM travel_products tp JOIN suppliers s ON s.id = tp.supplier_id WHERE s.owner_user_id = $1 AND tp.status = 'PUBLISHED' LIMIT 1`],
];

export async function deletionBlockers(db: Db, userId: string): Promise<string[]> {
  const out: string[] = [];
  for (const [code, sql] of DELETION_BLOCKERS) if (await maybeOne(db, sql, [userId])) out.push(code);
  return out;
}

export const deletionBlocked = (blockers: string[]) =>
  conflict('DELETION_BLOCKED', 'Finish or cancel open bookings and orders, resolve disputes, wait for payouts and unpublish your listings before deleting your account', { blockers });

/** PII scrub for one user. Keeps reservations/payments/ledger/consents/audit (legal retention), anonymizes identity. */
export async function scrubUser(tx: Tx, ctx: Ctx, userId: string) {
  const anonEmail = `deleted+${userId}@deleted.invalid`;
  const before = await maybeOne<{ email: string | null }>(tx, `SELECT email FROM users WHERE id = $1 FOR UPDATE`, [userId]);
  if (!before) throw notFound('User');
  await tx.query(
    `UPDATE users SET email = $2, phone = NULL, display_name = 'Deleted user', password_hash = NULL,
            deleted_at = now(), email_verified_at = NULL, phone_verified_at = NULL
      WHERE id = $1`,
    [userId, anonEmail],
  );
  await userStatusMachine.transition(tx, ctx, { table: 'users', id: userId, to: 'DELETED', reason: 'privacy deletion', actorType: 'SYSTEM' });
  await revokeAllSessions(tx, userId, 'ACCOUNT_DELETED');
  await tx.query(
    `UPDATE user_profiles SET legal_name = NULL, preferred_name = NULL, bio = NULL, avatar_media_id = NULL, birth_year = NULL,
            languages = '{}', accessibility = '{}'::jsonb WHERE user_id = $1`,
    [userId],
  );
  await tx.query(
    `UPDATE user_preferences SET travel_styles = '{}', interests = '{}', personalization_opt_out = true, marketing_opt_in = false, extra = '{}'::jsonb WHERE user_id = $1`,
    [userId],
  );
  await tx.query(`DELETE FROM oauth_identities WHERE user_id = $1`, [userId]);
  await tx.query(`DELETE FROM mfa_factors WHERE user_id = $1`, [userId]);
  if (before.email) await tx.query(`DELETE FROM auth_challenges WHERE subject = $1`, [String(before.email).toLowerCase()]);
  await tx.query(`UPDATE host_profiles SET display_name = 'Deleted user', about = NULL WHERE user_id = $1`, [userId]);
  await tx.query(`UPDATE business_profiles SET representative = NULL, address = NULL WHERE user_id = $1 AND status <> 'VERIFIED'`, [userId]);
  // Optional tables owned by other modules: scrub free-text PII when present.
  // Message bodies are retained (counterparty record / dispute evidence) but are no longer attributable by profile.
  for (const sql of [`UPDATE support_cases SET contact_email = NULL WHERE requester_id = $1`]) {
    await tx.query('SAVEPOINT scrub_optional');
    try {
      await tx.query(sql, [userId]);
      await tx.query('RELEASE SAVEPOINT scrub_optional');
    } catch {
      await tx.query('ROLLBACK TO SAVEPOINT scrub_optional');
    }
  }
  await audit(tx, ctx, { action: 'privacy.user_scrubbed', resourceType: 'user', resourceId: userId, category: 'PRIVACY', reason: 'Account deletion request' });
}
