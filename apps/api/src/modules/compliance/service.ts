import type { Ctx } from '../../platform/context.js';
import type { Actor } from '../../platform/auth.js';
import { isStaff } from '../../platform/auth.js';
import type { Db } from '../../platform/db.js';
import { maybeOne, q, withTx } from '../../platform/db.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { StateMachine } from '../../platform/fsm.js';

export type ComplianceDecision = 'ALLOW' | 'DENY' | 'REVIEW';
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

/** Jurisdiction codes a property falls under, most general first: '*', 'KR', 'KR-11'. */
export function propertyJurisdictions(p: { country: string; region?: string | null }): string[] {
  const country = String(p.country).trim().toUpperCase();
  const out = ['*', country];
  const region = p.region?.trim().toUpperCase();
  if (region) out.push(region.includes('-') ? region : `${country}-${region}`);
  return out;
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
export async function evaluatePropertyCompliance(db: Db, propertyId: string, opts?: { persist?: boolean }): Promise<ComplianceResult> {
  const p = await maybeOne(db, `SELECT * FROM properties WHERE id = $1`, [propertyId]);
  if (!p) throw notFound('Property');
  const modes = [p.rental_enabled ? 'RENTAL' : null, p.exchange_enabled ? 'EXCHANGE' : null].filter(Boolean) as string[];
  const reasons: string[] = [];
  const rulesEvaluated: string[] = [];
  let decision: ComplianceDecision;

  if (modes.length === 0) {
    decision = 'REVIEW';
    reasons.push('NO_LISTING_MODE');
  } else {
    const candidates = await q(
      db,
      `SELECT * FROM compliance_rules
        WHERE subject_type = 'PROPERTY' AND status = 'APPROVED' AND approved_at IS NOT NULL
          AND effective_from <= current_date AND (effective_until IS NULL OR effective_until >= current_date)
          AND jurisdiction = ANY($1::text[])
        ORDER BY effective_from, rule_key`,
      [propertyJurisdictions(p)],
    );
    const rules = candidates.filter((r) => ruleApplies(r, p, modes));
    const permits = await q(db, `SELECT * FROM property_permits WHERE property_id = $1`, [propertyId]);
    let deny = false, review = false;
    for (const rule of rules) {
      rulesEvaluated.push(`${rule.rule_key}@${rule.id}`);
      for (const type of rule.required_permit_types as string[]) {
        const ofType = permits.filter((x) => x.permit_type === type);
        const valid = ofType.find(
          (x) => x.status === 'VERIFIED' && (!x.valid_from || x.valid_from <= today()) && (!x.valid_until || x.valid_until >= today()),
        );
        if (valid) continue;
        if (ofType.some((x) => x.status === 'PENDING')) {
          review = true;
          reasons.push(`PERMIT_PENDING:${rule.rule_key}:${type}`);
        } else if (ofType.some((x) => x.status === 'EXPIRED' || (x.status === 'VERIFIED' && x.valid_until && x.valid_until < today()))) {
          deny = true;
          reasons.push(`PERMIT_EXPIRED:${rule.rule_key}:${type}`);
        } else if (ofType.some((x) => x.status === 'VERIFIED' && x.valid_from && x.valid_from > today())) {
          deny = true;
          reasons.push(`PERMIT_NOT_YET_VALID:${rule.rule_key}:${type}`);
        } else {
          deny = true;
          reasons.push(`PERMIT_MISSING:${rule.rule_key}:${type}`);
        }
      }
    }
    if (rules.length === 0) {
      if (p.rental_enabled) {
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
export async function guestEligibilityFor(db: Db, propertyId: string): Promise<Record<string, unknown>> {
  const p = await maybeOne(db, `SELECT * FROM properties WHERE id = $1`, [propertyId]);
  if (!p) throw notFound('Property');
  const modes = [p.rental_enabled ? 'RENTAL' : null, p.exchange_enabled ? 'EXCHANGE' : null].filter(Boolean) as string[];
  const rules = await q(
    db,
    `SELECT * FROM compliance_rules WHERE subject_type = 'PROPERTY' AND status = 'APPROVED'
        AND effective_from <= current_date AND (effective_until IS NULL OR effective_until >= current_date)
        AND jurisdiction = ANY($1::text[]) ORDER BY effective_from`,
    [propertyJurisdictions(p)],
  );
  return Object.assign({}, ...rules.filter((r) => ruleApplies(r, p, modes)).map((r) => r.guest_eligibility ?? {}));
}

/**
 * Booking-side gate (consumed by STAY-08/09): the listing must be PUBLISHED with paid booking enabled AND a
 * fresh evaluation must be ALLOW. Throws 403 COMPLIANCE_BLOCKED otherwise.
 */
export async function assertPaidBookingAllowed(db: Db, propertyId: string): Promise<void> {
  const p = await maybeOne(db, `SELECT status, paid_booking_enabled, rental_enabled FROM properties WHERE id = $1`, [propertyId]);
  if (!p) throw notFound('Property');
  if (p.status !== 'PUBLISHED' || !p.paid_booking_enabled || !p.rental_enabled) {
    throw forbidden('COMPLIANCE_BLOCKED', 'Paid booking is not enabled for this listing');
  }
  const r = await evaluatePropertyCompliance(db, propertyId, { persist: false });
  if (r.decision !== 'ALLOW') throw forbidden('COMPLIANCE_BLOCKED', `Paid booking is blocked by compliance (${r.reasons.join(', ') || r.decision})`);
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Re-evaluate a property and reconcile paid_booking_enabled for live listings. Turning paid booking OFF emits
 * listing.blocked (scope PAID_BOOKING). Returns the decision.
 */
export async function syncPaidBooking(db: Db, ctx: Ctx, propertyId: string, reason: string): Promise<ComplianceResult & { paidBookingEnabled: boolean }> {
  const p = await maybeOne(db, `SELECT id, status, rental_enabled, paid_booking_enabled FROM properties WHERE id = $1 FOR UPDATE`, [propertyId]);
  if (!p) throw notFound('Property');
  const r = await evaluatePropertyCompliance(db, propertyId, { persist: true });
  const shouldEnable = p.status === 'PUBLISHED' && p.rental_enabled && r.decision === 'ALLOW';
  if (shouldEnable !== p.paid_booking_enabled) {
    await db.query(`UPDATE properties SET paid_booking_enabled = $2 WHERE id = $1`, [propertyId, shouldEnable]);
    if (!shouldEnable) {
      await emit(db, ctx, { aggregateType: 'property', aggregateId: propertyId, eventType: 'listing.blocked', payload: { propertyId, scope: 'PAID_BOOKING', reason, decision: r.decision, reasons: r.reasons } });
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

export async function decidePermit(ctx: Ctx, permitId: string, to: 'VERIFIED' | 'REJECTED' | 'REVOKED', reason: string | null) {
  return withTx(ctx.app.pool, async (tx) => {
    const before = await maybeOne(tx, `SELECT * FROM property_permits WHERE id = $1 FOR UPDATE`, [permitId]);
    if (!before) throw notFound('Permit');
    const set: Record<string, unknown> = { reviewer_id: ctx.actor?.userId ?? null, decision_reason: reason };
    if (to === 'VERIFIED') set.verified_at = new Date();
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

/**
 * Daily job: expire VERIFIED permits past valid_until, emit compliance.expired, re-evaluate affected and all
 * paid-enabled listings, and switch paid booking OFF where the decision is no longer ALLOW (listing.blocked).
 */
export async function runPermitExpiry(ctx: Ctx): Promise<{ expired: number; reevaluated: number; blocked: number }> {
  return withTx(ctx.app.pool, async (tx) => {
    const due = await q(tx, `SELECT id FROM property_permits WHERE status = 'VERIFIED' AND valid_until IS NOT NULL AND valid_until < current_date FOR UPDATE SKIP LOCKED`);
    const affected = new Set<string>();
    for (const { id } of due) {
      const { row } = await permitFsm.transition(tx, ctx, { table: 'property_permits', id, from: 'VERIFIED', to: 'EXPIRED', reason: 'validity ended', actorType: 'SYSTEM' });
      affected.add(row.property_id);
      await emit(tx, ctx, { aggregateType: 'property_permit', aggregateId: id, eventType: 'compliance.expired', payload: { permitId: id, propertyId: row.property_id, permitType: row.permit_type, validUntil: row.valid_until } });
      await audit(tx, ctx, { action: 'permit.expired', resourceType: 'property_permit', resourceId: id, after: { status: 'EXPIRED' }, category: 'COMPLIANCE', actorId: null });
    }
    for (const r of await q(tx, `SELECT id FROM properties WHERE paid_booking_enabled = true`)) affected.add(r.id);
    let blocked = 0;
    for (const pid of affected) {
      const before = await maybeOne(tx, `SELECT paid_booking_enabled FROM properties WHERE id = $1`, [pid]);
      const r = await syncPaidBooking(tx, ctx, pid, 'permit expiry sweep');
      if (before?.paid_booking_enabled && !r.paidBookingEnabled) blocked++;
    }
    return { expired: due.length, reevaluated: affected.size, blocked };
  });
}
