import type { Db } from '../../platform/db.js';
import { maybeOne, q } from '../../platform/db.js';
import { isEnabled } from '../../platform/flags.js';
import { isPaidType, type GuideType } from './fsm.js';

/**
 * GUIDE-01 publication predicates (invariant 7 / invariant 8).
 *
 * Legal predicates are NOT hard-coded: requirements come from APPROVED, effective `compliance_rules`
 * rows with subject_type 'GUIDE'. A rule applies to a guide type when `applies_to.guide_type` contains
 * it (a rule with no `guide_type` key applies to every type). Every applicable rule must pass; for each
 * rule_key only the most recent effective version is used. `required_permit_types` entries are
 * qualification types; an entry like 'GUIDE_LICENSE|TRAVEL_AGENCY_REGISTRATION' is satisfied by any one
 * of the alternatives. A qualification counts when VERIFIED and unexpired (valid_until NULL or ≥ today).
 *
 * Fail-closed: PAID/PROFESSIONAL publication is denied when no APPROVED rule applies to the type, when
 * any requirement is missing, or when feature flag `guide.paid` is OFF. Identity verification
 * (users.identity_verified_at) is required for every type.
 */
export interface GuideRuleRow {
  id: string;
  rule_key: string;
  jurisdiction: string;
  applies_to: any;
  required_permit_types: string[];
  effective_from: string;
}

export interface EligibilityResult {
  guideType: GuideType;
  identityVerified: boolean;
  /** may the profile be published at all */
  publishable: boolean;
  /** may the guide sell paid offers (PAID/PROFESSIONAL only) */
  paidAllowed: boolean;
  reasons: string[];
  rulesEvaluated: Array<{ ruleId: string; ruleKey: string; required: string[]; missing: string[] }>;
}

export async function applicableGuideRules(db: Db, guideType: GuideType): Promise<GuideRuleRow[]> {
  const rows = await q<GuideRuleRow>(
    db,
    `SELECT DISTINCT ON (rule_key) id, rule_key, jurisdiction, applies_to, required_permit_types, effective_from
       FROM compliance_rules
      WHERE subject_type = 'GUIDE' AND status = 'APPROVED'
        AND effective_from <= current_date AND (effective_until IS NULL OR effective_until >= current_date)
        AND (NOT (applies_to ? 'guide_type') OR applies_to->'guide_type' @> to_jsonb($1::text))
      ORDER BY rule_key, effective_from DESC, id`,
    [guideType],
  );
  return rows;
}

export async function verifiedQualificationTypes(db: Db, guideId: string): Promise<Set<string>> {
  const rows = await q<{ qualification_type: string }>(
    db,
    `SELECT DISTINCT qualification_type FROM guide_qualifications
      WHERE guide_id = $1 AND status = 'VERIFIED' AND (valid_until IS NULL OR valid_until >= current_date)`,
    [guideId],
  );
  return new Set(rows.map((r) => r.qualification_type));
}

export async function evaluateGuideEligibility(db: Db, guideId: string, guideTypeOverride?: GuideType): Promise<EligibilityResult> {
  const u = await maybeOne<{ identity_verified_at: Date | null; guide_type: GuideType | null }>(
    db,
    `SELECT u.identity_verified_at, g.guide_type FROM users u LEFT JOIN guide_profiles g ON g.user_id = u.id WHERE u.id = $1`,
    [guideId],
  );
  const guideType = (guideTypeOverride ?? u?.guide_type ?? 'FRIEND') as GuideType;
  const reasons: string[] = [];
  const identityVerified = !!u?.identity_verified_at;
  if (!identityVerified) reasons.push('IDENTITY_NOT_VERIFIED');

  const rules = await applicableGuideRules(db, guideType);
  const have = await verifiedQualificationTypes(db, guideId);
  const rulesEvaluated = rules.map((r) => {
    const required = r.required_permit_types ?? [];
    const missing = required.filter((req) => !req.split('|').some((alt) => have.has(alt.trim())));
    return { ruleId: r.id, ruleKey: r.rule_key, required, missing };
  });
  const rulesPass = rulesEvaluated.every((r) => r.missing.length === 0);
  for (const r of rulesEvaluated) for (const m of r.missing) reasons.push(`QUALIFICATION_MISSING:${m}`);

  let paidAllowed = false;
  if (isPaidType(guideType)) {
    if (rules.length === 0) reasons.push('NO_APPROVED_COMPLIANCE_RULE');
    const flag = await isEnabled(db, 'guide.paid', { userId: guideId });
    if (!flag) reasons.push('FEATURE_DISABLED:guide.paid');
    paidAllowed = identityVerified && rules.length > 0 && rulesPass && flag;
  }
  const publishable = identityVerified && rulesPass && (!isPaidType(guideType) || paidAllowed);
  return { guideType, identityVerified, publishable, paidAllowed, reasons, rulesEvaluated };
}
