import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { StateMachine } from '../../platform/fsm.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { notify } from '../../platform/notify.js';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { grantRole } from '../roles/service.js';
import { isVerified } from '../verification/service.js';
import { hasActiveSanction } from '../disputes/sanctions.js';

export type ApplicationStatus = 'SUBMITTED' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN';
export const hostApplicationMachine = new StateMachine<ApplicationStatus>('host_application', {
  SUBMITTED: ['IN_REVIEW', 'APPROVED', 'REJECTED', 'WITHDRAWN'],
  IN_REVIEW: ['APPROVED', 'REJECTED', 'WITHDRAWN'],
  APPROVED: [],
  REJECTED: [],
  WITHDRAWN: [],
});

export type HostStatus = 'APPLIED' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
/** host_profiles.status lifecycle. host_profiles is keyed by user_id, so transitions are written explicitly. */
export const hostProfileMachine = new StateMachine<HostStatus>('host_profile', {
  APPLIED: ['APPROVED', 'REJECTED'],
  APPROVED: ['SUSPENDED'],
  REJECTED: ['APPLIED'],
  SUSPENDED: ['APPROVED'],
});

async function transitionHostProfile(tx: Tx, ctx: Ctx, userId: string, to: HostStatus, reason?: string) {
  const cur = await maybeOne<{ status: HostStatus }>(tx, `SELECT status FROM host_profiles WHERE user_id = $1 FOR UPDATE`, [userId]);
  if (!cur) throw notFound('Host profile');
  hostProfileMachine.assert(cur.status, to);
  await tx.query(`UPDATE host_profiles SET status = $2 WHERE user_id = $1 AND status = $3`, [userId, to, cur.status]);
  await tx.query(
    `INSERT INTO state_transitions(aggregate_type, aggregate_id, from_state, to_state, actor_id, actor_type, reason, correlation_id) VALUES ('host_profile',$1,$2,$3,$4,$5,$6,$7)`,
    [userId, cur.status, to, ctx.actor?.userId ?? null, ctx.actor ? (ctx.actor.userId === userId ? 'USER' : 'ADMIN') : 'SYSTEM', reason ?? null, ctx.correlationId],
  );
}

/** Onboarding checklist, recomputed from authoritative predicates. */
export async function hostChecklist(db: Db, userId: string) {
  const u = await one(db, `SELECT email_verified_at, phone, identity_verified_at FROM users WHERE id = $1`, [userId]);
  const payout = await maybeOne(db, `SELECT status FROM payout_accounts WHERE user_id = $1 ORDER BY (status = 'VERIFIED') DESC, created_at DESC LIMIT 1`, [userId]).catch(() => null);
  const hostVerified = await isVerified(db, userId, 'HOST');
  return {
    emailVerified: !!u.email_verified_at,
    phoneProvided: !!u.phone,
    identityVerified: !!u.identity_verified_at || (await isVerified(db, userId, 'IDENTITY')),
    hostVerified,
    payoutAccount: payout?.status ?? 'MISSING',
  };
}

export async function apply(tx: Tx, ctx: Ctx, input: { displayName?: string; about?: string }) {
  const userId = ctx.actor!.userId;
  const existing = await maybeOne(tx, `SELECT status FROM host_profiles WHERE user_id = $1 FOR UPDATE`, [userId]);
  if (existing?.status === 'APPROVED') throw conflict('ALREADY_HOST', 'You are already an approved host');
  if (existing?.status === 'SUSPENDED') throw forbidden('HOST_SUSPENDED', 'Your host profile is suspended');
  if (await maybeOne(tx, `SELECT 1 FROM host_applications WHERE user_id = $1 AND status IN ('SUBMITTED','IN_REVIEW')`, [userId])) {
    throw conflict('APPLICATION_OPEN', 'A host application is already under review');
  }
  if (await hasActiveSanction(tx, userId, ['BAN', 'ACCOUNT_SUSPENSION', 'LISTING_SUSPENSION'])) throw forbidden('SANCTIONED', 'Your account cannot apply to host at this time');
  const u = await one(tx, `SELECT display_name FROM users WHERE id = $1`, [userId]);
  const verification = (await isVerified(tx, userId, 'HOST')) ? 'VERIFIED' : 'PENDING';
  if (!existing) {
    await tx.query(
      `INSERT INTO host_profiles(user_id, display_name, about, status, verification_status) VALUES ($1,$2,$3,'APPLIED',$4)`,
      [userId, input.displayName ?? u.display_name, input.about ?? null, verification],
    );
    await tx.query(
      `INSERT INTO state_transitions(aggregate_type, aggregate_id, from_state, to_state, actor_id, actor_type, correlation_id) VALUES ('host_profile',$1,NULL,'APPLIED',$1,'USER',$2)`,
      [userId, ctx.correlationId],
    );
  } else {
    await tx.query(`UPDATE host_profiles SET display_name = coalesce($2, display_name), about = coalesce($3, about) WHERE user_id = $1`, [userId, input.displayName ?? null, input.about ?? null]);
    if (existing.status === 'REJECTED') await transitionHostProfile(tx, ctx, userId, 'APPLIED', 'reapplied');
  }
  const checklist = await hostChecklist(tx, userId);
  const app = await one(tx, `INSERT INTO host_applications(user_id, status, checklist) VALUES ($1,'SUBMITTED',$2) RETURNING *`, [userId, JSON.stringify(checklist)]);
  await emit(tx, ctx, { aggregateType: 'host_application', aggregateId: app.id, eventType: 'host.applied', payload: { applicationId: app.id, userId } });
  await audit(tx, ctx, { action: 'host.applied', resourceType: 'host_application', resourceId: app.id, after: { checklist }, category: 'COMPLIANCE' });
  return app;
}

export async function withdraw(tx: Tx, ctx: Ctx, applicationId: string) {
  const app = await maybeOne(tx, `SELECT user_id FROM host_applications WHERE id = $1`, [applicationId]);
  if (!app || app.user_id !== ctx.actor!.userId) throw notFound('Host application');
  const { row } = await hostApplicationMachine.transition(tx, ctx, { table: 'host_applications', id: applicationId, to: 'WITHDRAWN', reason: 'withdrawn by applicant' });
  return row;
}

export async function decide(tx: Tx, ctx: Ctx, applicationId: string, d: { approve: boolean; reason?: string }) {
  const app = await maybeOne(tx, `SELECT * FROM host_applications WHERE id = $1 FOR UPDATE`, [applicationId]);
  if (!app) throw notFound('Host application');
  if (app.user_id === ctx.actor!.userId) throw forbidden('SELF_REVIEW_FORBIDDEN', 'You cannot review your own application');
  if (!d.approve && !d.reason) throw unprocessable('REASON_REQUIRED', 'A rejection reason is required');
  const checklist = await hostChecklist(tx, app.user_id);
  const to: ApplicationStatus = d.approve ? 'APPROVED' : 'REJECTED';
  const { row } = await hostApplicationMachine.transition(tx, ctx, {
    table: 'host_applications',
    id: applicationId,
    to,
    from: ['SUBMITTED', 'IN_REVIEW'],
    reason: d.reason,
    actorType: 'ADMIN',
    set: { reviewer_id: ctx.actor!.userId, decision_reason: d.reason ?? null, decided_at: new Date(), checklist },
  });
  await transitionHostProfile(tx, ctx, app.user_id, d.approve ? 'APPROVED' : 'REJECTED', d.reason);
  if (d.approve) {
    await grantRole(tx, ctx, { userId: app.user_id, role: 'HOST', reason: `host application ${applicationId} approved` });
    await emit(tx, ctx, { aggregateType: 'host_application', aggregateId: applicationId, eventType: 'host.approved', payload: { applicationId, userId: app.user_id } });
  } else {
    await emit(tx, ctx, { aggregateType: 'host_application', aggregateId: applicationId, eventType: 'host.rejected', payload: { applicationId, userId: app.user_id } });
  }
  await audit(tx, ctx, { action: d.approve ? 'host.approved' : 'host.rejected', resourceType: 'host_application', resourceId: applicationId, after: { status: to, checklist }, reason: d.reason ?? null, category: 'COMPLIANCE' });
  await notify(tx, ctx, {
    userId: app.user_id,
    templateKey: d.approve ? 'host.approved' : 'host.rejected',
    title: d.approve ? '호스트 승인이 완료되었습니다' : '호스트 신청이 반려되었습니다',
    body: d.approve ? 'Your host application was approved.' : `Your host application was rejected: ${d.reason}`,
    dedupeKey: `host.decision:${applicationId}`,
  });
  return row;
}

/** Why a user may not publish paid inventory (empty = eligible). Invariant 7 + HOST-01. */
export async function hostPublishBlockers(db: Db, userId: string): Promise<string[]> {
  const reasons: string[] = [];
  const u = await maybeOne(db, `SELECT status FROM users WHERE id = $1`, [userId]);
  if (!u) return ['USER_NOT_FOUND'];
  if (u.status !== 'ACTIVE') reasons.push('ACCOUNT_NOT_ACTIVE');
  const hp = await maybeOne(db, `SELECT status, verification_status FROM host_profiles WHERE user_id = $1`, [userId]);
  if (!hp) reasons.push('HOST_NOT_APPLIED');
  else {
    if (hp.status !== 'APPROVED') reasons.push('HOST_NOT_APPROVED');
    if (hp.verification_status !== 'VERIFIED') reasons.push('HOST_NOT_VERIFIED');
  }
  if (!(await maybeOne(db, `SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'HOST'`, [userId]))) reasons.push('HOST_ROLE_MISSING');
  if (await hasActiveSanction(db, userId, ['LISTING_SUSPENSION', 'ACCOUNT_SUSPENSION', 'BAN'])) reasons.push('SANCTIONED');
  return reasons;
}

/** Throws 403 HOST_NOT_ELIGIBLE unless the host is approved + verified + active + unsanctioned. */
export async function assertHostCanPublish(db: Db, userId: string): Promise<void> {
  const reasons = await hostPublishBlockers(db, userId);
  if (reasons.length) {
    throw new AppError(403, 'HOST_NOT_ELIGIBLE', `Host cannot publish paid inventory: ${reasons.join(', ')}`, { reasons });
  }
}

export async function publicHost(db: Db, userId: string) {
  const h = await maybeOne(
    db,
    `SELECT h.user_id, coalesce(h.display_name, u.display_name) AS display_name, h.about, h.verification_status, h.response_rate, h.created_at,
            u.identity_verified_at, p.avatar_media_id, p.languages
       FROM host_profiles h JOIN users u ON u.id = h.user_id LEFT JOIN user_profiles p ON p.user_id = h.user_id
      WHERE h.user_id = $1 AND h.status = 'APPROVED' AND u.status = 'ACTIVE'`,
    [userId],
  );
  if (!h) throw notFound('Host');
  const rep = await maybeOne(db, `SELECT review_count, rating_avg FROM reputation_scores WHERE target_type = 'HOST' AND target_id = $1`, [userId]);
  const listings = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM properties WHERE host_id = $1 AND status = 'PUBLISHED'`, [userId]);
  return {
    userId: h.user_id,
    displayName: h.display_name,
    about: h.about,
    verified: h.verification_status === 'VERIFIED',
    identityVerified: !!h.identity_verified_at,
    responseRate: h.response_rate,
    avatarMediaId: h.avatar_media_id,
    languages: h.languages ?? [],
    hostingSince: h.created_at,
    reviewCount: rep?.review_count ?? 0,
    ratingAvg: rep?.rating_avg ?? null,
    publishedListings: listings.n,
  };
}

export async function hostDashboard(db: Db, userId: string) {
  const profile = await maybeOne(db, `SELECT * FROM host_profiles WHERE user_id = $1`, [userId]);
  if (!profile) throw notFound('Host profile');
  const application = await maybeOne(db, `SELECT id, status, checklist, decision_reason, created_at, decided_at FROM host_applications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`, [userId]);
  const listings = await q<{ status: string; n: number }>(db, `SELECT status, count(*)::int AS n FROM properties WHERE host_id = $1 GROUP BY status`, [userId]);
  const res = await maybeOne<{ upcoming: number; in_stay: number; pending: number }>(
    db,
    `SELECT count(*) FILTER (WHERE status = 'CONFIRMED' AND check_in >= current_date)::int AS upcoming,
            count(*) FILTER (WHERE status = 'CHECKED_IN')::int AS in_stay,
            count(*) FILTER (WHERE status IN ('HELD','PAYMENT_PENDING'))::int AS pending
       FROM reservations WHERE host_id = $1`,
    [userId],
  );
  const rep = await maybeOne(db, `SELECT review_count, rating_avg FROM reputation_scores WHERE target_type = 'HOST' AND target_id = $1`, [userId]);
  const blockers = await hostPublishBlockers(db, userId);
  return {
    profile: { status: profile.status, verificationStatus: profile.verification_status, displayName: profile.display_name, about: profile.about, responseRate: profile.response_rate },
    application,
    checklist: await hostChecklist(db, userId),
    listings: Object.fromEntries(listings.map((l) => [l.status, l.n])),
    reservations: { upcoming: res?.upcoming ?? 0, inStay: res?.in_stay ?? 0, pending: res?.pending ?? 0 },
    reputation: { reviewCount: rep?.review_count ?? 0, ratingAvg: rep?.rating_avg ?? null },
    canPublish: blockers.length === 0,
    publishBlockers: blockers,
  };
}
