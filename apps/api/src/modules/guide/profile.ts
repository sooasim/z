import type { Db } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import type { Actor } from '../../platform/auth.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { notify } from '../../platform/notify.js';
import { conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { isPaidType, type GuideType } from './fsm.js';
import { evaluateGuideEligibility, type EligibilityResult } from './eligibility.js';
import type { ProfileCreateInput, ProfilePatchInput, QualificationInput } from './schemas.js';

export interface GuideProfileRow {
  user_id: string;
  guide_type: GuideType;
  headline: string | null;
  bio: string | null;
  languages: string[];
  regions: string[];
  interests: string[];
  specialties: string[];
  lat: number | null;
  lng: number | null;
  city: string | null;
  verification_status: string;
  paid_enabled: boolean;
  hourly_price_minor: number | null;
  currency: string;
  max_group_size: number;
  status: 'DRAFT' | 'PUBLISHED' | 'HIDDEN' | 'SUSPENDED';
  rating_avg: number | null;
  created_at: Date;
  updated_at: Date;
}

const norm = (xs: string[] | undefined) => (xs ? Array.from(new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))) : xs);

function assertPricePolicy(guideType: GuideType, hourlyPriceMinor: number | null | undefined) {
  if (!isPaidType(guideType) && hourlyPriceMinor != null && hourlyPriceMinor !== 0) {
    throw unprocessable('FREE_GUIDE_PRICE_NOT_ALLOWED', `${guideType} guides are free and cannot set a price`);
  }
}

export async function getProfile(db: Db, userId: string, lock = false): Promise<GuideProfileRow | null> {
  return maybeOne<GuideProfileRow>(db, `SELECT * FROM guide_profiles WHERE user_id = $1${lock ? ' FOR UPDATE' : ''}`, [userId]);
}

async function profileEvents(db: Db, ctx: Ctx, p: GuideProfileRow, change: string) {
  await emit(db, ctx, {
    aggregateType: 'guide_profile',
    aggregateId: p.user_id,
    eventType: 'guide.profile.updated',
    payload: { guideId: p.user_id, guideType: p.guide_type, status: p.status, paidEnabled: p.paid_enabled, change },
  });
  await emit(db, ctx, {
    aggregateType: 'guide_profile',
    aggregateId: p.user_id,
    eventType: 'guide.search.reindex',
    payload: { guideId: p.user_id, op: p.status === 'PUBLISHED' ? 'UPSERT' : 'DELETE' },
  });
}

export async function createProfile(db: Db, ctx: Ctx, actor: Actor, b: ProfileCreateInput): Promise<GuideProfileRow> {
  assertPricePolicy(b.guideType, b.hourlyPriceMinor);
  if (await getProfile(db, actor.userId)) throw conflict('GUIDE_PROFILE_EXISTS', 'Guide profile already exists; use PATCH');
  const row = await one<GuideProfileRow>(
    db,
    `INSERT INTO guide_profiles(user_id, guide_type, headline, bio, languages, regions, interests, specialties, city, lat, lng,
                                hourly_price_minor, currency, max_group_size)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [
      actor.userId, b.guideType, b.headline ?? null, b.bio ?? null, norm(b.languages), norm(b.regions), norm(b.interests), norm(b.specialties),
      b.city ?? null, b.lat ?? null, b.lng ?? null, isPaidType(b.guideType) ? b.hourlyPriceMinor ?? null : null, b.currency, b.maxGroupSize,
    ],
  );
  await profileEvents(db, ctx, row, 'CREATED');
  return row;
}

export async function updateProfile(db: Db, ctx: Ctx, actor: Actor, b: ProfilePatchInput): Promise<GuideProfileRow> {
  const cur = await getProfile(db, actor.userId, true);
  if (!cur) throw notFound('Guide profile');
  if (cur.status === 'SUSPENDED') throw forbidden('GUIDE_SUSPENDED', 'Suspended guide profiles cannot be edited');
  const guideType = b.guideType ?? cur.guide_type;
  const price = b.hourlyPriceMinor !== undefined ? b.hourlyPriceMinor : cur.hourly_price_minor;
  if (b.hourlyPriceMinor !== undefined) assertPricePolicy(guideType, b.hourlyPriceMinor);
  const typeChanged = guideType !== cur.guide_type;
  const set: Record<string, unknown> = {};
  const map: Array<[keyof ProfilePatchInput, string, (v: any) => unknown]> = [
    ['headline', 'headline', (v) => v], ['bio', 'bio', (v) => v], ['languages', 'languages', norm], ['regions', 'regions', norm],
    ['interests', 'interests', norm], ['specialties', 'specialties', norm], ['city', 'city', (v) => v], ['lat', 'lat', (v) => v],
    ['lng', 'lng', (v) => v], ['currency', 'currency', (v) => v], ['maxGroupSize', 'max_group_size', (v) => v],
  ];
  for (const [k, col, f] of map) if (b[k] !== undefined) set[col] = f(b[k]);
  if (typeChanged) {
    set.guide_type = guideType;
    // a type change invalidates prior verification: back to DRAFT, paid selling off, must republish
    set.paid_enabled = false;
    set.verification_status = 'PENDING';
    if (cur.status === 'PUBLISHED') set.status = 'DRAFT';
  }
  set.hourly_price_minor = isPaidType(guideType) ? price ?? null : null;
  const cols = Object.keys(set);
  const row = await one<GuideProfileRow>(
    db,
    `UPDATE guide_profiles SET ${cols.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE user_id = $1 RETURNING *`,
    [actor.userId, ...cols.map((c) => set[c])],
  );
  await profileEvents(db, ctx, row, typeChanged ? 'TYPE_CHANGED' : 'UPDATED');
  return row;
}

/** Grant GUIDE role on first publish (user_roles + role_grants history + PERMISSION audit) in the caller's tx. */
async function ensureGuideRole(db: Db, ctx: Ctx, userId: string) {
  const ins = await db.query(
    `INSERT INTO user_roles(user_id, role, granted_by) VALUES ($1,'GUIDE',NULL) ON CONFLICT DO NOTHING`,
    [userId],
  );
  if (ins.rowCount === 1) {
    await db.query(`INSERT INTO role_grants(user_id, role, action, actor_id, reason) VALUES ($1,'GUIDE','GRANT',$2,'guide profile published')`, [
      userId,
      ctx.actor?.userId ?? null,
    ]);
    await audit(db, ctx, { action: 'role.granted', resourceType: 'user', resourceId: userId, after: { role: 'GUIDE' }, reason: 'guide profile published', category: 'PERMISSION' });
  }
}

async function recordDecision(db: Db, guideId: string, e: EligibilityResult, evaluatedBy: string) {
  await db.query(
    `INSERT INTO compliance_decisions(subject_type, subject_id, decision, reasons, rules_evaluated, evaluated_by) VALUES ('GUIDE',$1,$2,$3,$4,$5)`,
    [guideId, e.publishable ? 'ALLOW' : 'DENY', JSON.stringify(e.reasons), JSON.stringify(e.rulesEvaluated), evaluatedBy],
  );
}

/**
 * Returns published=false (without throwing) when predicates fail so the caller can COMMIT the DENY
 * compliance decision and then respond 422; paid selling stays OFF (invariant 7).
 */
export async function publishProfile(db: Db, ctx: Ctx, actor: Actor): Promise<{ published: boolean; profile: GuideProfileRow; eligibility: EligibilityResult }> {
  const cur = await getProfile(db, actor.userId, true);
  if (!cur) throw notFound('Guide profile');
  if (cur.status === 'SUSPENDED') throw forbidden('GUIDE_SUSPENDED', 'Suspended guide profiles cannot be published');
  const e = await evaluateGuideEligibility(db, actor.userId, cur.guide_type);
  await recordDecision(db, actor.userId, e, `USER:${actor.userId}`);
  if (!e.publishable) {
    if (isPaidType(cur.guide_type) && cur.status === 'PUBLISHED') {
      // same safe state as continuous enforcement (reevaluatePaidGuide): paid selling off AND hidden until
      // republished — a PAID/PROFESSIONAL guide must never stay PUBLISHED as free (it cannot sell anything)
      const row = await one<GuideProfileRow>(db, `UPDATE guide_profiles SET paid_enabled = false, status = 'HIDDEN' WHERE user_id = $1 RETURNING *`, [actor.userId]);
      await audit(db, ctx, {
        action: 'guide.paid_disabled', resourceType: 'guide_profile', resourceId: actor.userId,
        before: { status: cur.status, paidEnabled: cur.paid_enabled }, after: { status: row.status, paidEnabled: row.paid_enabled, reasons: e.reasons },
        category: 'COMPLIANCE',
      });
      await profileEvents(db, ctx, row, 'PAID_GATE_LAPSED');
      return { published: false, profile: row, eligibility: e };
    }
    if (cur.paid_enabled) await db.query(`UPDATE guide_profiles SET paid_enabled = false WHERE user_id = $1`, [actor.userId]);
    return { published: false, profile: { ...cur, paid_enabled: false }, eligibility: e };
  }
  const wasVerified = cur.verification_status === 'VERIFIED';
  const row = await one<GuideProfileRow>(
    db,
    `UPDATE guide_profiles SET status = 'PUBLISHED', verification_status = 'VERIFIED', paid_enabled = $2 WHERE user_id = $1 RETURNING *`,
    [actor.userId, isPaidType(cur.guide_type) && e.paidAllowed],
  );
  await ensureGuideRole(db, ctx, actor.userId);
  await audit(db, ctx, {
    action: 'guide.published', resourceType: 'guide_profile', resourceId: actor.userId,
    before: { status: cur.status, paidEnabled: cur.paid_enabled }, after: { status: row.status, paidEnabled: row.paid_enabled, rules: e.rulesEvaluated.map((r) => r.ruleId) },
    category: 'COMPLIANCE',
  });
  if (!wasVerified) {
    await emit(db, ctx, { aggregateType: 'guide_profile', aggregateId: actor.userId, eventType: 'guide.verified', payload: { guideId: actor.userId, guideType: row.guide_type, paidEnabled: row.paid_enabled } });
  }
  await profileEvents(db, ctx, row, 'PUBLISHED');
  return { published: true, profile: row, eligibility: e };
}

export function publicationDenied(r: { profile: GuideProfileRow; eligibility: EligibilityResult }) {
  return unprocessable(
    isPaidType(r.profile.guide_type) ? 'GUIDE_PAID_GATE_FAILED' : 'GUIDE_PUBLICATION_DENIED',
    'Guide publication requirements are not met',
    { reasons: r.eligibility.reasons, rules: r.eligibility.rulesEvaluated },
  );
}

export async function unpublishProfile(db: Db, ctx: Ctx, actor: Actor): Promise<GuideProfileRow> {
  const cur = await getProfile(db, actor.userId, true);
  if (!cur) throw notFound('Guide profile');
  if (cur.status !== 'PUBLISHED') throw conflict('INVALID_STATE_TRANSITION', `Guide profile is ${cur.status}`);
  const row = await one<GuideProfileRow>(db, `UPDATE guide_profiles SET status = 'HIDDEN' WHERE user_id = $1 RETURNING *`, [actor.userId]);
  await profileEvents(db, ctx, row, 'HIDDEN');
  return row;
}

/** Public view: published only, coarse location (≈1 km), no verification internals. */
export function publicProfile(p: GuideProfileRow & { display_name?: string | null; review_count?: number }) {
  const round = (v: number | null) => (v == null ? null : Math.round(Number(v) * 100) / 100);
  return {
    guideId: p.user_id,
    displayName: p.display_name ?? null,
    guideType: p.guide_type,
    headline: p.headline,
    bio: p.bio,
    languages: p.languages,
    regions: p.regions,
    interests: p.interests,
    specialties: p.specialties,
    city: p.city,
    approxLat: round(p.lat),
    approxLng: round(p.lng),
    free: !p.paid_enabled,
    paidEnabled: p.paid_enabled,
    hourlyPriceMinor: p.paid_enabled ? p.hourly_price_minor : null,
    currency: p.currency,
    maxGroupSize: p.max_group_size,
    verified: p.verification_status === 'VERIFIED',
    ratingAvg: p.rating_avg == null ? null : Number(p.rating_avg),
    reviewCount: p.review_count ?? 0,
  };
}

export async function getPublicProfile(db: Db, guideId: string) {
  const p = await maybeOne<GuideProfileRow & { display_name: string | null; review_count: number }>(
    db,
    `SELECT g.*, u.display_name,
            (SELECT count(*)::int FROM reviews r WHERE r.target_type = 'GUIDE' AND r.target_id = g.user_id AND r.status = 'PUBLISHED') AS review_count
       FROM guide_profiles g JOIN users u ON u.id = g.user_id
      WHERE g.user_id = $1 AND g.status = 'PUBLISHED' AND u.status = 'ACTIVE'`,
    [guideId],
  );
  if (!p) throw notFound('Guide');
  return publicProfile(p);
}

export async function getMyProfile(db: Db, actor: Actor) {
  const p = await getProfile(db, actor.userId);
  if (!p) throw notFound('Guide profile');
  const qualifications = await q(
    db,
    `SELECT id, qualification_type, reference_no, document_media_id, valid_until, status, verified_at, created_at
       FROM guide_qualifications WHERE guide_id = $1 ORDER BY created_at DESC`,
    [actor.userId],
  );
  const eligibility = await evaluateGuideEligibility(db, actor.userId, p.guide_type);
  return { profile: p, qualifications, eligibility };
}

// ---------------------------------------------------------------- qualifications

export async function submitQualification(db: Db, ctx: Ctx, actor: Actor, b: QualificationInput) {
  if (!(await getProfile(db, actor.userId))) throw notFound('Guide profile');
  const media = await maybeOne<{ owner_id: string; status: string }>(db, `SELECT owner_id, status FROM media_assets WHERE id = $1`, [b.documentMediaId]);
  if (!media || media.owner_id !== actor.userId) throw unprocessable('DOCUMENT_NOT_FOUND', 'Document media not found or not owned by you');
  if (media.status === 'DELETED' || media.status === 'REJECTED') throw unprocessable('DOCUMENT_UNUSABLE', 'Document media is not usable');
  if (b.validUntil && b.validUntil < new Date().toISOString().slice(0, 10)) throw unprocessable('QUALIFICATION_EXPIRED', 'Qualification is already expired');
  const row = await one(
    db,
    `INSERT INTO guide_qualifications(guide_id, qualification_type, reference_no, document_media_id, valid_until)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, guide_id, qualification_type, reference_no, document_media_id, valid_until, status, created_at`,
    [actor.userId, b.qualificationType, b.referenceNo ?? null, b.documentMediaId, b.validUntil ?? null],
  );
  await emit(db, ctx, { aggregateType: 'guide_qualification', aggregateId: row.id, eventType: 'guide.qualification.submitted', payload: { qualificationId: row.id, guideId: actor.userId, qualificationType: b.qualificationType } });
  return row;
}

export async function decideQualification(db: Db, ctx: Ctx, actor: Actor, id: string, decision: 'VERIFIED' | 'REJECTED', reason?: string) {
  const cur = await maybeOne<any>(db, `SELECT * FROM guide_qualifications WHERE id = $1 FOR UPDATE`, [id]);
  if (!cur) throw notFound('Guide qualification');
  if (cur.status !== 'PENDING') throw conflict('INVALID_STATE_TRANSITION', `Qualification is ${cur.status}`);
  if (decision === 'VERIFIED' && cur.valid_until && String(cur.valid_until) < new Date().toISOString().slice(0, 10)) {
    throw unprocessable('QUALIFICATION_EXPIRED', 'Qualification validity has passed; it cannot be verified');
  }
  const row = await one(
    db,
    `UPDATE guide_qualifications SET status = $2, verified_by = $3, verified_at = now() WHERE id = $1
     RETURNING id, guide_id, qualification_type, reference_no, valid_until, status, verified_by, verified_at`,
    [id, decision, actor.userId],
  );
  await audit(db, ctx, {
    action: decision === 'VERIFIED' ? 'guide.qualification.verified' : 'guide.qualification.rejected',
    resourceType: 'guide_qualification', resourceId: id,
    before: { status: cur.status }, after: { status: row.status, qualificationType: row.qualification_type },
    reason: reason ?? null, category: 'COMPLIANCE',
  });
  await emit(db, ctx, {
    aggregateType: 'guide_qualification', aggregateId: id,
    eventType: decision === 'VERIFIED' ? 'guide.qualification.verified' : 'guide.qualification.rejected',
    payload: { qualificationId: id, guideId: row.guide_id, qualificationType: row.qualification_type },
  });
  await notify(db, ctx, {
    userId: row.guide_id,
    templateKey: decision === 'VERIFIED' ? 'guide.qualification.verified' : 'guide.qualification.rejected',
    title: decision === 'VERIFIED' ? '자격 서류가 승인되었습니다' : '자격 서류가 반려되었습니다',
    body: decision === 'VERIFIED' ? 'Your guide qualification was verified.' : `Your guide qualification was rejected.${reason ? ` ${reason}` : ''}`,
    data: { qualificationId: id },
    dedupeKey: `guide-qualification:${id}:${decision}`,
  });
  if (decision === 'REJECTED') await reevaluatePaidGuide(db, ctx, row.guide_id);
  return row;
}

/**
 * Continuous enforcement of invariant 7: if a published PAID/PROFESSIONAL guide no longer satisfies the
 * configured predicates (expired/rejected qualification, rule change, flag OFF), paid selling is turned off
 * and the profile is hidden until republished.
 */
export async function reevaluatePaidGuide(db: Db, ctx: Ctx, guideId: string): Promise<boolean> {
  const p = await getProfile(db, guideId, true);
  if (!p || p.status !== 'PUBLISHED' || !isPaidType(p.guide_type)) return true;
  const e = await evaluateGuideEligibility(db, guideId, p.guide_type);
  if (e.publishable && e.paidAllowed) return true;
  await recordDecision(db, guideId, e, 'SYSTEM:reevaluation');
  const row = await one<GuideProfileRow>(db, `UPDATE guide_profiles SET paid_enabled = false, status = 'HIDDEN' WHERE user_id = $1 RETURNING *`, [guideId]);
  await audit(db, ctx, { action: 'guide.paid_disabled', resourceType: 'guide_profile', resourceId: guideId, after: { reasons: e.reasons }, category: 'COMPLIANCE', actorId: null });
  await profileEvents(db, ctx, row, 'PAID_GATE_LAPSED');
  await notify(db, ctx, {
    userId: guideId, templateKey: 'guide.paid_gate_lapsed', title: '유료 가이드 노출이 중지되었습니다',
    body: 'Your paid guide listing was hidden because a required qualification or approval is no longer valid.',
    data: { reasons: e.reasons }, dedupeKey: `guide-paid-lapsed:${guideId}:${new Date().toISOString().slice(0, 10)}`,
  });
  return false;
}
