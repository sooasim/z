import type { Ctx } from '../../platform/context.js';
import type { Actor } from '../../platform/auth.js';
import { isStaff } from '../../platform/auth.js';
import type { Db } from '../../platform/db.js';
import { maybeOne, q, withTx } from '../../platform/db.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { StateMachine } from '../../platform/fsm.js';
import { hostPublishBlockers } from '../hosts/service.js';
import { isVerified } from '../verification/service.js';
import { haversineKm } from '../geo/service.js';

export type ComplianceDecision = 'ALLOW' | 'DENY' | 'REVIEW';
export type ListingMode = 'RENTAL' | 'EXCHANGE';
export interface ComplianceResult { decision: ComplianceDecision; reasons: string[]; rulesEvaluated: string[] }

export type PermitStatus = 'PENDING' | 'VERIFIED' | 'REJECTED' | 'EXPIRED' | 'REVOKED';
export const permitFsm = new StateMachine<PermitStatus>('PROPERTY_PERMIT', {
  PENDING: ['VERIFIED', 'REJECTED'],
  VERIFIED: ['EXPIRED', 'REVOKED'],
  REJECTED: [],
  EXPIRED: [],
  REVOKED: [],
});

export type RuleStatus = 'DRAFT' | 'APPROVED' | 'RETIRED';
export const ruleFsm = new StateMachine<RuleStatus>('COMPLIANCE_RULE', {
  DRAFT: ['APPROVED', 'RETIRED'],
  APPROVED: ['RETIRED'],
  RETIRED: [],
});

/**
 * Jurisdiction codes a property falls under, most general first: '*', 'KR', 'KR-11'. The host-declared
 * country/region are UNIONED with the server-derived `geo_jurisdictions` (geocoded from the stored address and
 * coordinates by the properties module): declaring another region can add rules but never removes the rules of
 * the place the listing actually is (invariant 7).
 */
export function propertyJurisdictions(p: { country: string; region?: string | null; geo_jurisdictions?: string[] | null }): string[] {
  const country = String(p.country).trim().toUpperCase();
  const out = ['*', country];
  const region = p.region?.trim().toUpperCase();
  if (region) out.push(region.includes('-') ? region : `${country}-${region}`);
  for (const g of p.geo_jurisdictions ?? []) {
    const code = String(g).trim().toUpperCase();
    if (!/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/.test(code)) continue;
    out.push(code.slice(0, 2));
    if (code.includes('-')) out.push(code);
  }
  return [...new Set(out)];
}

const enabledModes = (p: any): ListingMode[] => [p.rental_enabled ? 'RENTAL' : null, p.exchange_enabled ? 'EXCHANGE' : null].filter(Boolean) as ListingMode[];

// --- permit binding: a verified permit is bound to the subject (location + type) it was verified for -----------

/** What a permit is verified FOR. Moving the listing or changing its type requires a re-verified permit. */
export interface PermitSubject {
  v: 1;
  country: string | null;
  region: string | null;
  propertyType: string | null;
  roomType: string | null;
  lat: number | null;
  lng: number | null;
  address: { line1: string | null; line2: string | null; postalCode: string | null; city: string | null; region: string | null; country: string | null } | null;
}

/** Max pin movement (metres) tolerated before a verified permit must be re-verified (pin corrections). */
export const PERMIT_PIN_TOLERANCE_M = 100;

export async function permitSubjectOf(db: Db, propertyId: string): Promise<PermitSubject> {
  const r = await maybeOne(
    db,
    `SELECT p.country, p.region, p.property_type, p.room_type, p.lat, p.lng, a.property_id AS has_addr, a.line1, a.line2, a.postal_code,
            a.city AS a_city, a.region AS a_region, a.country AS a_country
       FROM properties p LEFT JOIN property_addresses a ON a.property_id = p.id WHERE p.id = $1`,
    [propertyId],
  );
  if (!r) throw notFound('Property');
  return {
    v: 1,
    country: r.country ?? null,
    region: r.region ?? null,
    propertyType: r.property_type ?? null,
    roomType: r.room_type ?? null,
    lat: r.lat === null ? null : Number(r.lat),
    lng: r.lng === null ? null : Number(r.lng),
    address: r.has_addr
      ? { line1: r.line1 ?? null, line2: r.line2 ?? null, postalCode: r.postal_code ?? null, city: r.a_city ?? null, region: r.a_region ?? null, country: r.a_country ?? null }
      : null,
  };
}

const normText = (s: unknown) => (s === null || s === undefined ? '' : String(s).normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim());

/** True when the current subject is still the one the permit was verified for. Legacy permits (no binding) match. */
export function permitSubjectMatches(bound: any, cur: PermitSubject): boolean {
  if (!bound || typeof bound !== 'object') return true; // verified before bindings existed (backfilled by migration 0960)
  for (const k of ['country', 'region', 'propertyType', 'roomType'] as const) {
    if (normText(bound[k]) !== normText(cur[k])) return false;
  }
  const ba = bound.address ?? null;
  const ca = cur.address;
  if (!!ba !== !!ca) return false;
  if (ba && ca) {
    for (const k of ['line1', 'line2', 'postalCode', 'city', 'region', 'country'] as const) {
      if (normText(ba[k]) !== normText(ca[k])) return false;
    }
  }
  const bHas = bound.lat !== null && bound.lat !== undefined && bound.lng !== null && bound.lng !== undefined;
  const cHas = cur.lat !== null && cur.lng !== null;
  if (bHas !== cHas) return false;
  if (bHas && cHas && haversineKm(Number(bound.lat), Number(bound.lng), cur.lat!, cur.lng!) * 1000 > PERMIT_PIN_TOLERANCE_M) return false;
  return true;
}

/**
 * applies_to filters: every key maps to an allowed-values array. 'mode' selects listing modes
 * (RENTAL / EXCHANGE; default RENTAL — rules gate paid accommodation unless stated otherwise). Unknown keys
 * are treated as matching (fail closed: an unrecognised filter never exempts a property from a rule).
 */
function ruleApplies(rule: any, p: any, modes: string[]): boolean {
  const a = (rule.applies_to ?? {}) as Record<string, unknown>;
  const ruleModes = Array.isArray(a.mode) ? (a.mode as string[]).map((x) => String(x).toUpperCase()) : ['RENTAL'];
  if (!ruleModes.some((m) => modes.includes(m))) return false;
  for (const [k, allowed] of Object.entries(a)) {
    if (k === 'mode' || !Array.isArray(allowed)) continue;
    if (!(k in p)) continue;
    const v = p[k];
    if (!allowed.map(String).includes(String(v))) return false;
  }
  return true;
}

/**
 * STAY-03 contract (consumed by properties + booking). Finds APPROVED rules effective today for the property's
 * jurisdiction and checks required permits are VERIFIED and unexpired. Paid (rental) listings with no matching
 * approved rule get REVIEW (fail closed). Nothing here hard-codes a legal rule (invariant 8).
 */
export async function evaluatePropertyCompliance(
  db: Db,
  propertyId: string,
  opts?: { persist?: boolean; /** evaluate only these listing modes (intersected with the enabled ones) */ modes?: ListingMode[] },
): Promise<ComplianceResult> {
  const p = await maybeOne(db, `SELECT * FROM properties WHERE id = $1`, [propertyId]);
  if (!p) throw notFound('Property');
  const modes = enabledModes(p).filter((m) => !opts?.modes || opts.modes.includes(m));
  const reasons: string[] = [];
  const rulesEvaluated: string[] = [];
  let decision: ComplianceDecision;

  if (modes.length === 0) {
    decision = 'REVIEW';
    reasons.push('NO_LISTING_MODE');
  } else {
    const jurisdictions = propertyJurisdictions(p);
    // `rule_key COLLATE "C"`: this order decides the order of `reasons`, which is persisted as compliance
    // evidence (compliance_decisions.reasons). A locale-aware collation ignores punctuation at the primary
    // level, so 'r7.kr.biz' and 'r7.kr11.homestay' sort one way on a C-locale cluster and the other way on an
    // en_US.utf8 one — the same listing would yield a different evidence row per deployment. Byte order keeps
    // the decision reproducible everywhere.
    const candidates = await q(
      db,
      `SELECT * FROM compliance_rules
        WHERE subject_type = 'PROPERTY' AND status = 'APPROVED' AND approved_at IS NOT NULL
          AND effective_from <= current_date AND (effective_until IS NULL OR effective_until >= current_date)
          AND jurisdiction = ANY($1::text[])
        ORDER BY effective_from, rule_key COLLATE "C"`,
      [jurisdictions],
    );
    const rules = candidates.filter((r) => ruleApplies(r, p, modes));
    const permits = rules.length ? await q(db, `SELECT * FROM property_permits WHERE property_id = $1`, [propertyId]) : [];
    const subject = rules.length ? await permitSubjectOf(db, propertyId) : null;
    const t0 = today();
    const dated = (x: any) => (!x.valid_from || x.valid_from <= t0) && (!x.valid_until || x.valid_until >= t0);
    // a permit only counts where it was issued (one of the property's jurisdictions) and for the subject it was verified for
    const inJurisdiction = (x: any) => x.jurisdiction === '*' || jurisdictions.includes(String(x.jurisdiction).toUpperCase());
    const bound = (x: any) => permitSubjectMatches(x.verified_subject, subject!);
    let deny = false, review = false;
    for (const rule of rules) {
      rulesEvaluated.push(`${rule.rule_key}@${rule.id}`);
      for (const type of rule.required_permit_types as string[]) {
        const ofType = permits.filter((x) => x.permit_type === type);
        const valid = ofType.find((x) => x.status === 'VERIFIED' && dated(x) && inJurisdiction(x) && bound(x));
        if (valid) continue;
        if (ofType.some((x) => x.status === 'PENDING')) {
          review = true;
          reasons.push(`PERMIT_PENDING:${rule.rule_key}:${type}`);
        } else if (ofType.some((x) => x.status === 'VERIFIED' && dated(x) && inJurisdiction(x) && !bound(x))) {
          // the listing moved / changed type after verification: the permit must be re-verified for the new subject
          deny = true;
          reasons.push(`PERMIT_SUBJECT_CHANGED:${rule.rule_key}:${type}`);
        } else if (ofType.some((x) => x.status === 'VERIFIED' && dated(x) && !inJurisdiction(x))) {
          deny = true;
          reasons.push(`PERMIT_JURISDICTION_MISMATCH:${rule.rule_key}:${type}`);
        } else if (ofType.some((x) => x.status === 'EXPIRED' || (x.status === 'VERIFIED' && x.valid_until && x.valid_until < t0))) {
          deny = true;
          reasons.push(`PERMIT_EXPIRED:${rule.rule_key}:${type}`);
        } else if (ofType.some((x) => x.status === 'VERIFIED' && x.valid_from && x.valid_from > t0)) {
          deny = true;
          reasons.push(`PERMIT_NOT_YET_VALID:${rule.rule_key}:${type}`);
        } else {
          deny = true;
          reasons.push(`PERMIT_MISSING:${rule.rule_key}:${type}`);
        }
      }
    }
    if (rules.length === 0) {
      if (modes.includes('RENTAL')) {
        review = true;
        reasons.push('NO_APPROVED_RULE');
      } else {
        reasons.push('NO_PAID_BOOKING'); // exchange-only: publishable, never paid-bookable
      }
    }
    decision = deny ? 'DENY' : review ? 'REVIEW' : 'ALLOW';
  }

  if (opts?.persist ?? true) {
    await db.query(
      `INSERT INTO compliance_decisions(subject_type, subject_id, decision, reasons, rules_evaluated) VALUES ('PROPERTY',$1,$2,$3,$4)`,
      [propertyId, decision, JSON.stringify(reasons), JSON.stringify(rulesEvaluated)],
    );
  }
  return { decision, reasons, rulesEvaluated };
}

/** Merged guest-eligibility constraints of the approved rules applying to a property (for booking). */
export async function guestEligibilityFor(db: Db, propertyId: string, opts?: { modes?: ListingMode[] }): Promise<Record<string, unknown>> {
  const p = await maybeOne(db, `SELECT * FROM properties WHERE id = $1`, [propertyId]);
  if (!p) throw notFound('Property');
  const modes = enabledModes(p).filter((m) => !opts?.modes || opts.modes.includes(m));
  const rules = await q(
    db,
    `SELECT * FROM compliance_rules WHERE subject_type = 'PROPERTY' AND status = 'APPROVED' AND approved_at IS NOT NULL
        AND effective_from <= current_date AND (effective_until IS NULL OR effective_until >= current_date)
        AND jurisdiction = ANY($1::text[]) ORDER BY effective_from`,
    [propertyJurisdictions(p)],
  );
  return Object.assign({}, ...rules.filter((r) => ruleApplies(r, p, modes)).map((r) => r.guest_eligibility ?? {}));
}

/** Eligibility keys this gate knows how to evaluate. Any other active key fails closed. */
export const SUPPORTED_GUEST_ELIGIBILITY = ['foreigners_only'] as const;
const inactiveConstraint = (v: unknown) => v === false || v === null || v === undefined;

/**
 * Evaluate merged guest-eligibility constraints for one guest. Returns failure reasons (empty = eligible).
 *  - foreigners_only: the guest must be identity-verified and have a declared country (user_profiles.country)
 *    different from the listing's country. Unknown nationality fails closed.
 *  - any other active key: UNSUPPORTED_ELIGIBILITY:<key> (fail closed; a configured legal constraint is never ignored).
 */
export async function guestEligibilityFailures(db: Db, propertyId: string, guestId: string, eligibility?: Record<string, unknown>): Promise<string[]> {
  const elig = eligibility ?? (await guestEligibilityFor(db, propertyId, { modes: ['RENTAL'] }));
  const active = Object.entries(elig).filter(([, v]) => !inactiveConstraint(v));
  if (!active.length) return [];
  const failures: string[] = [];
  const g = await maybeOne(
    db,
    `SELECT u.status, up.country, p.country AS property_country
       FROM users u LEFT JOIN user_profiles up ON up.user_id = u.id CROSS JOIN properties p WHERE u.id = $1 AND p.id = $2`,
    [guestId, propertyId],
  );
  if (!g) return ['GUEST_NOT_FOUND'];
  const identityVerified = await isVerified(db, guestId, 'IDENTITY'); // honours verification expiry
  for (const [key, value] of active) {
    if (key === 'foreigners_only') {
      if (value !== true) {
        failures.push(`UNSUPPORTED_ELIGIBILITY:${key}`);
        continue;
      }
      if (!identityVerified) failures.push('GUEST_IDENTITY_UNVERIFIED');
      else if (!g.country) failures.push('GUEST_NATIONALITY_UNKNOWN');
      else if (String(g.country).trim().toUpperCase() === String(g.property_country).trim().toUpperCase()) failures.push('FOREIGNERS_ONLY');
    } else {
      failures.push(`UNSUPPORTED_ELIGIBILITY:${key}`);
    }
  }
  return failures;
}

/**
 * Host standing for LIVE listings: account ACTIVE, HOST role, host profile approved+verified, no active
 * LISTING_SUSPENSION / ACCOUNT_SUSPENSION / BAN sanction. A missing profile is tolerated here (publication itself
 * requires one via assertHostCanPublish); any adverse signal takes paid booking down immediately.
 */
export async function hostStandingBlockers(db: Db, hostId: string): Promise<string[]> {
  return (await hostPublishBlockers(db, hostId)).filter((r) => r !== 'HOST_NOT_APPLIED');
}

/**
 * Booking-side gate (consumed by STAY-08/09): the listing must be PUBLISHED with paid booking enabled, the host
 * must still be in good standing, a fresh RENTAL evaluation must be ALLOW, and — when the applying rules carry
 * guest-eligibility constraints — the guest must satisfy them. Pass `guestId` (hold creation / payment) so the
 * constraints can be evaluated; without it, a listing with active constraints fails closed.
 * Throws 403 COMPLIANCE_BLOCKED / GUEST_NOT_ELIGIBLE.
 */
export async function assertPaidBookingAllowed(db: Db, propertyId: string, opts?: { guestId?: string | null }): Promise<void> {
  const p = await maybeOne(db, `SELECT status, paid_booking_enabled, rental_enabled, host_id FROM properties WHERE id = $1`, [propertyId]);
  if (!p) throw notFound('Property');
  if (p.status !== 'PUBLISHED' || !p.paid_booking_enabled || !p.rental_enabled) {
    throw forbidden('COMPLIANCE_BLOCKED', 'Paid booking is not enabled for this listing');
  }
  const host = await hostStandingBlockers(db, p.host_id);
  if (host.length) throw new AppError(403, 'COMPLIANCE_BLOCKED', `Paid booking is suspended for this listing (host: ${host.join(', ')})`, { reasons: host.map((r) => `HOST_${r}`) });
  const r = await evaluatePropertyCompliance(db, propertyId, { persist: false, modes: ['RENTAL'] });
  if (r.decision !== 'ALLOW') throw new AppError(403, 'COMPLIANCE_BLOCKED', `Paid booking is blocked by compliance (${r.reasons.join(', ') || r.decision})`, { reasons: r.reasons });
  const elig = await guestEligibilityFor(db, propertyId, { modes: ['RENTAL'] });
  if (Object.values(elig).some((v) => !inactiveConstraint(v))) {
    if (!opts?.guestId) {
      throw new AppError(403, 'GUEST_NOT_ELIGIBLE', 'This listing restricts who may book; guest eligibility could not be verified', { reasons: ['GUEST_CONTEXT_REQUIRED'] });
    }
    const failures = await guestEligibilityFailures(db, propertyId, opts.guestId, elig);
    if (failures.length) throw new AppError(403, 'GUEST_NOT_ELIGIBLE', `Guest is not eligible for this listing (${failures.join(', ')})`, { reasons: failures });
  }
}

/** Exchange-side gate (for STAY-EX request/confirm): PUBLISHED, exchange enabled and EXCHANGE-mode rules ALLOW. */
export async function assertExchangeAllowed(db: Db, propertyId: string): Promise<void> {
  const p = await maybeOne(db, `SELECT status, exchange_enabled FROM properties WHERE id = $1`, [propertyId]);
  if (!p) throw notFound('Property');
  if (p.status !== 'PUBLISHED' || !p.exchange_enabled) throw forbidden('COMPLIANCE_BLOCKED', 'Home exchange is not enabled for this listing');
  const r = await evaluatePropertyCompliance(db, propertyId, { persist: false, modes: ['EXCHANGE'] });
  if (r.decision !== 'ALLOW') throw new AppError(403, 'COMPLIANCE_BLOCKED', `Home exchange is blocked by compliance (${r.reasons.join(', ') || r.decision})`, { reasons: r.reasons });
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Re-evaluate a property and reconcile paid_booking_enabled for live listings: paid booking stays on only while
 * the listing is PUBLISHED, the RENTAL rules ALLOW and the host is in good standing. Turning paid booking OFF
 * emits listing.blocked (scope PAID_BOOKING). Persists (and returns) the combined decision for the listing.
 */
export async function syncPaidBooking(db: Db, ctx: Ctx, propertyId: string, reason: string): Promise<ComplianceResult & { paidBookingEnabled: boolean }> {
  const p = await maybeOne(db, `SELECT id, host_id, status, rental_enabled, exchange_enabled, paid_booking_enabled FROM properties WHERE id = $1 FOR UPDATE`, [propertyId]);
  if (!p) throw notFound('Property');
  const r = await evaluatePropertyCompliance(db, propertyId, { persist: true });
  const rental = p.rental_enabled && p.exchange_enabled ? await evaluatePropertyCompliance(db, propertyId, { persist: false, modes: ['RENTAL'] }) : r;
  const hostBlockers = p.status === 'PUBLISHED' && p.rental_enabled ? await hostStandingBlockers(db, p.host_id) : [];
  const shouldEnable = p.status === 'PUBLISHED' && p.rental_enabled && rental.decision === 'ALLOW' && hostBlockers.length === 0;
  if (shouldEnable !== p.paid_booking_enabled) {
    await db.query(`UPDATE properties SET paid_booking_enabled = $2 WHERE id = $1`, [propertyId, shouldEnable]);
    if (!shouldEnable) {
      const reasons = [...rental.reasons, ...hostBlockers.map((b) => `HOST_${b}`)];
      await emit(db, ctx, { aggregateType: 'property', aggregateId: propertyId, eventType: 'listing.blocked', payload: { propertyId, scope: 'PAID_BOOKING', reason, decision: rental.decision, reasons } });
    } else {
      await emit(db, ctx, { aggregateType: 'property', aggregateId: propertyId, eventType: 'property.updated', payload: { propertyId, fields: ['paid_booking_enabled'] } });
    }
  }
  return { ...r, paidBookingEnabled: shouldEnable };
}

// --- permits ------------------------------------------------------------------------------------

export const toPermitDto = (x: any) => ({
  id: x.id,
  propertyId: x.property_id,
  permitType: x.permit_type,
  permitNo: x.permit_no,
  jurisdiction: x.jurisdiction,
  documentMediaId: x.document_media_id,
  validFrom: x.valid_from,
  validUntil: x.valid_until,
  status: x.status,
  decisionReason: x.decision_reason,
  verifiedAt: x.verified_at,
  createdAt: x.created_at,
});

async function ownedProperty(db: Db, actor: Actor, propertyId: string, allowStaff = false) {
  const p = await maybeOne(db, `SELECT * FROM properties WHERE id = $1`, [propertyId]);
  if (!p) throw notFound('Property');
  if (p.host_id !== actor.userId && !(allowStaff && isStaff(actor) && actor.aal === 'aal2')) throw forbidden('NOT_PROPERTY_OWNER', 'You do not own this property');
  return p;
}

export async function submitPermit(
  ctx: Ctx,
  actor: Actor,
  propertyId: string,
  input: { permitType: string; permitNo?: string | null; jurisdiction: string; documentMediaId?: string | null; validFrom?: string | null; validUntil?: string | null },
) {
  if (input.validFrom && input.validUntil && input.validUntil < input.validFrom) throw badRequest('INVALID_DATE_RANGE', 'validUntil must be on/after validFrom');
  if (input.validUntil && input.validUntil < today()) throw unprocessable('PERMIT_ALREADY_EXPIRED', 'Permit validity has already ended');
  return withTx(ctx.app.pool, async (tx) => {
    const p = await ownedProperty(tx, actor, propertyId);
    if (p.status === 'ARCHIVED') throw conflict('PROPERTY_ARCHIVED', 'Archived properties cannot be changed');
    if (input.documentMediaId) {
      const m = await maybeOne(tx, `SELECT owner_id, purpose, visibility, status FROM media_assets WHERE id = $1`, [input.documentMediaId]);
      if (!m) throw unprocessable('MEDIA_NOT_FOUND', 'Permit document not found');
      if (m.owner_id !== actor.userId) throw forbidden('NOT_MEDIA_OWNER', 'You do not own this document');
      // permit evidence must be private verification/evidence media (never public)
      if (!['VERIFICATION', 'EVIDENCE'].includes(m.purpose) || m.visibility !== 'PRIVATE') throw unprocessable('MEDIA_PURPOSE_MISMATCH', 'Permit documents must be uploaded with purpose VERIFICATION');
      if (m.status !== 'READY') throw unprocessable('MEDIA_NOT_READY', 'Permit document upload is not complete');
    }
    const row = await maybeOne(
      tx,
      `INSERT INTO property_permits(property_id, permit_type, permit_no, jurisdiction, document_media_id, valid_from, valid_until)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [propertyId, input.permitType, input.permitNo ?? null, input.jurisdiction.toUpperCase(), input.documentMediaId ?? null, input.validFrom ?? null, input.validUntil ?? null],
    );
    await emit(tx, ctx, { aggregateType: 'property_permit', aggregateId: row.id, eventType: 'compliance.permit_submitted', payload: { permitId: row.id, propertyId, permitType: row.permit_type } });
    return toPermitDto(row);
  });
}

export async function listPermits(ctx: Ctx, actor: Actor, propertyId: string) {
  await ownedProperty(ctx.app.pool, actor, propertyId, true);
  return (await q(ctx.app.pool, `SELECT * FROM property_permits WHERE property_id = $1 ORDER BY created_at DESC`, [propertyId])).map(toPermitDto);
}

export async function listPermitQueue(db: Db, status: PermitStatus) {
  return (await q(db, `SELECT * FROM property_permits WHERE status = $1 ORDER BY created_at LIMIT 200`, [status])).map(toPermitDto);
}

/**
 * Staff decision on a permit. Conflict of interest / four-eyes: staff can never decide permits of their OWN
 * listings (the decision is what unlocks paid booking). A verification binds the permit to the listing's current
 * subject (address, coordinates, jurisdiction, property/room type) — see permitSubjectMatches.
 */
export async function decidePermit(ctx: Ctx, permitId: string, to: 'VERIFIED' | 'REJECTED' | 'REVOKED', reason: string | null) {
  return withTx(ctx.app.pool, async (tx) => {
    const before = await maybeOne(tx, `SELECT * FROM property_permits WHERE id = $1 FOR UPDATE`, [permitId]);
    if (!before) throw notFound('Permit');
    const prop = await maybeOne(tx, `SELECT host_id FROM properties WHERE id = $1 FOR UPDATE`, [before.property_id]);
    if (!prop) throw notFound('Property');
    if (!ctx.actor || prop.host_id === ctx.actor.userId) {
      throw forbidden('FOUR_EYES_REQUIRED', 'Permits must be decided by staff other than the listing host (conflict of interest)');
    }
    const set: Record<string, unknown> = { reviewer_id: ctx.actor.userId, decision_reason: reason };
    if (to === 'VERIFIED') {
      set.verified_at = new Date();
      set.verified_subject = await permitSubjectOf(tx, before.property_id);
    }
    const { row } = await permitFsm.transition(tx, ctx, { table: 'property_permits', id: permitId, to, reason: reason ?? undefined, actorType: 'ADMIN', set });
    await audit(tx, ctx, {
      action: `permit.${to.toLowerCase()}`,
      resourceType: 'property_permit',
      resourceId: permitId,
      before: { status: before.status },
      after: { status: row.status, permitType: row.permit_type, propertyId: row.property_id },
      reason,
      category: 'COMPLIANCE',
    });
    if (to === 'VERIFIED') {
      await emit(tx, ctx, { aggregateType: 'property_permit', aggregateId: permitId, eventType: 'compliance.verified', payload: { permitId, propertyId: row.property_id, permitType: row.permit_type } });
    } else {
      await emit(tx, ctx, { aggregateType: 'property_permit', aggregateId: permitId, eventType: `compliance.permit_${to.toLowerCase()}`, payload: { permitId, propertyId: row.property_id, permitType: row.permit_type, reason } });
    }
    const evaluation = await syncPaidBooking(tx, ctx, row.property_id, `permit ${to.toLowerCase()}`);
    return { item: toPermitDto(row), evaluation };
  });
}

// --- rules --------------------------------------------------------------------------------------

export const toRuleDto = (r: any) => ({
  id: r.id,
  ruleKey: r.rule_key,
  subjectType: r.subject_type,
  jurisdiction: r.jurisdiction,
  appliesTo: r.applies_to,
  requiredPermitTypes: r.required_permit_types,
  guestEligibility: r.guest_eligibility,
  effectiveFrom: r.effective_from,
  effectiveUntil: r.effective_until,
  status: r.status,
  createdBy: r.created_by,
  approvedBy: r.approved_by,
  approvedAt: r.approved_at,
  note: r.note,
  createdAt: r.created_at,
});

export async function createRule(
  ctx: Ctx,
  input: {
    ruleKey: string; subjectType: 'PROPERTY' | 'GUIDE' | 'SUPPLIER' | 'CHARTER'; jurisdiction: string; appliesTo: Record<string, unknown>;
    requiredPermitTypes: string[]; guestEligibility: Record<string, unknown>; effectiveFrom: string; effectiveUntil?: string | null; note?: string | null;
  },
) {
  if (input.effectiveUntil && input.effectiveUntil < input.effectiveFrom) throw badRequest('INVALID_DATE_RANGE', 'effectiveUntil must be on/after effectiveFrom');
  return withTx(ctx.app.pool, async (tx) => {
    const row = await maybeOne(
      tx,
      `INSERT INTO compliance_rules(rule_key, subject_type, jurisdiction, applies_to, required_permit_types, guest_eligibility, effective_from, effective_until, note, created_by, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT') RETURNING *`,
      [input.ruleKey, input.subjectType, input.jurisdiction.toUpperCase(), JSON.stringify(input.appliesTo), input.requiredPermitTypes, JSON.stringify(input.guestEligibility), input.effectiveFrom, input.effectiveUntil ?? null, input.note ?? null, ctx.actor?.userId ?? null],
    );
    await audit(tx, ctx, { action: 'compliance_rule.created', resourceType: 'compliance_rule', resourceId: row.id, after: toRuleDto(row), category: 'COMPLIANCE' });
    return toRuleDto(row);
  });
}

/** Approve a DRAFT rule. Four-eyes: the approver must differ from the author (business/legal approval, invariant 8). */
export async function approveRule(ctx: Ctx, ruleId: string, reason: string | null) {
  return withTx(ctx.app.pool, async (tx) => {
    const r = await maybeOne(tx, `SELECT * FROM compliance_rules WHERE id = $1 FOR UPDATE`, [ruleId]);
    if (!r) throw notFound('Compliance rule');
    if (r.created_by && r.created_by === ctx.actor?.userId) throw forbidden('FOUR_EYES_REQUIRED', 'A rule must be approved by someone other than its author');
    const { row } = await ruleFsm.transition(tx, ctx, {
      table: 'compliance_rules', id: ruleId, from: 'DRAFT', to: 'APPROVED', reason: reason ?? undefined, actorType: 'ADMIN',
      set: { approved_by: ctx.actor?.userId ?? null, approved_at: new Date() },
    });
    await audit(tx, ctx, { action: 'compliance_rule.approved', resourceType: 'compliance_rule', resourceId: ruleId, before: { status: r.status }, after: { status: row.status }, reason, category: 'COMPLIANCE' });
    await emit(tx, ctx, { aggregateType: 'compliance_rule', aggregateId: ruleId, eventType: 'compliance.rule_approved', payload: { ruleId, ruleKey: row.rule_key, jurisdiction: row.jurisdiction } });
    return toRuleDto(row);
  });
}

export async function retireRule(ctx: Ctx, ruleId: string, reason: string | null) {
  return withTx(ctx.app.pool, async (tx) => {
    const { row, from } = await ruleFsm.transition(tx, ctx, { table: 'compliance_rules', id: ruleId, to: 'RETIRED', reason: reason ?? undefined, actorType: 'ADMIN', set: { retired_at: new Date() } });
    await audit(tx, ctx, { action: 'compliance_rule.retired', resourceType: 'compliance_rule', resourceId: ruleId, before: { status: from }, after: { status: 'RETIRED' }, reason, category: 'COMPLIANCE' });
    return toRuleDto(row);
  });
}

export async function listRules(db: Db, filter: { status?: RuleStatus; jurisdiction?: string }) {
  return (
    await q(
      db,
      `SELECT * FROM compliance_rules WHERE ($1::text IS NULL OR status = $1) AND ($2::text IS NULL OR jurisdiction = $2)
        ORDER BY created_at DESC LIMIT 500`,
      [filter.status ?? null, filter.jurisdiction?.toUpperCase() ?? null],
    )
  ).map(toRuleDto);
}

/** POST /v1/compliance/evaluate — owner or staff; persists the decision and reconciles paid booking for live listings. */
export async function evaluateForActor(ctx: Ctx, actor: Actor, propertyId: string) {
  await ownedProperty(ctx.app.pool, actor, propertyId, true);
  return withTx(ctx.app.pool, (tx) => syncPaidBooking(tx, ctx, propertyId, 'manual evaluation'));
}

/** Advisory-lock key of the permit-expiry sweep (one sweep at a time across all replicas). */
const PERMIT_EXPIRY_LOCK = 'jetpool:compliance.permit-expiry';

/**
 * Daily job: expire VERIFIED permits past valid_until, emit compliance.expired, re-evaluate affected and all
 * paid-enabled listings, and switch paid booking OFF where the decision is no longer ALLOW (listing.blocked).
 *
 * Built for large catalogs and many replicas: a singleton (session advisory lock; a concurrent run returns
 * `skipped`), permits expire in small committed batches (SKIP LOCKED), and every listing is re-evaluated in its
 * OWN short transaction in deterministic id order — a live listing is only row-locked when its paid-booking flag
 * actually has to change. One failing listing is logged and skipped instead of rolling back the whole sweep.
 */
export async function runPermitExpiry(ctx: Ctx, opts: { batchSize?: number } = {}): Promise<{ expired: number; reevaluated: number; blocked: number; skipped?: boolean; failed?: number }> {
  const pool = ctx.app.pool;
  const batchSize = Math.max(1, opts.batchSize ?? 100);
  const lockConn = await pool.connect();
  let locked = false;
  try {
    locked = (await lockConn.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [PERMIT_EXPIRY_LOCK])).rows[0].ok === true;
    if (!locked) return { expired: 0, reevaluated: 0, blocked: 0, skipped: true };

    // 1) expire due permits in short batches
    const affected = new Set<string>();
    let expired = 0;
    for (;;) {
      const batch = await withTx(pool, async (tx) => {
        const due = await q(
          tx,
          `SELECT id FROM property_permits WHERE status = 'VERIFIED' AND valid_until IS NOT NULL AND valid_until < current_date
            ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [batchSize],
        );
        const props: string[] = [];
        for (const { id } of due) {
          const { row } = await permitFsm.transition(tx, ctx, { table: 'property_permits', id, from: 'VERIFIED', to: 'EXPIRED', reason: 'validity ended', actorType: 'SYSTEM' });
          props.push(row.property_id);
          await emit(tx, ctx, { aggregateType: 'property_permit', aggregateId: id, eventType: 'compliance.expired', payload: { permitId: id, propertyId: row.property_id, permitType: row.permit_type, validUntil: row.valid_until } });
          await audit(tx, ctx, { action: 'permit.expired', resourceType: 'property_permit', resourceId: id, after: { status: 'EXPIRED' }, category: 'COMPLIANCE', actorId: null });
        }
        return { n: due.length, props };
      });
      expired += batch.n;
      batch.props.forEach((pid) => affected.add(pid));
      if (batch.n < batchSize) break;
    }

    let blocked = 0, failed = 0;
    const seen = new Set<string>();
    const resync = async (pid: string) => {
      try {
        const r = await withTx(pool, async (tx) => {
          const before = await maybeOne(tx, `SELECT paid_booking_enabled FROM properties WHERE id = $1`, [pid]);
          const res = await syncPaidBooking(tx, ctx, pid, 'permit expiry sweep');
          return { was: !!before?.paid_booking_enabled, now: res.paidBookingEnabled };
        });
        if (r.was && !r.now) blocked++;
      } catch (err) {
        failed++;
        ctx.app.log.error({ err: String(err), propertyId: pid }, 'permit expiry: re-evaluation failed');
      }
    };

    // 2) listings whose permits just expired: always re-evaluated (persists a fresh decision)
    for (const pid of [...affected].sort()) {
      seen.add(pid);
      await resync(pid);
    }

    // 3) every other paid-enabled listing: evaluate WITHOUT locks; only lock + resync when paid booking must go off
    let cursor = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const page = await q<{ id: string; host_id: string }>(
        pool,
        `SELECT id, host_id FROM properties WHERE paid_booking_enabled = true AND id > $1 ORDER BY id LIMIT 500`,
        [cursor],
      );
      if (!page.length) break;
      cursor = page[page.length - 1].id;
      for (const { id, host_id } of page) {
        if (seen.has(id)) continue;
        seen.add(id);
        try {
          const r = await evaluatePropertyCompliance(pool, id, { persist: false, modes: ['RENTAL'] });
          const host = r.decision === 'ALLOW' ? await hostStandingBlockers(pool, host_id) : [];
          if (r.decision === 'ALLOW' && host.length === 0) continue;
        } catch (err) {
          ctx.app.log.warn({ err: String(err), propertyId: id }, 'permit expiry: pre-check failed; re-evaluating under lock');
        }
        await resync(id);
      }
    }
    return { expired, reevaluated: seen.size, blocked, ...(failed ? { failed } : {}) };
  } finally {
    if (locked) await lockConn.query(`SELECT pg_advisory_unlock(hashtext($1))`, [PERMIT_EXPIRY_LOCK]).catch(() => {});
    lockConn.release();
  }
}
