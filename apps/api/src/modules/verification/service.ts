import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { StateMachine } from '../../platform/fsm.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { notify } from '../../platform/notify.js';
import { conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { isStaff } from '../../platform/auth.js';

export const SUBJECT_TYPES = ['IDENTITY', 'HOST', 'GUIDE', 'SUPPLIER', 'BUSINESS', 'PAYOUT_ACCOUNT', 'PROPERTY'] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];
export type CaseStatus = 'DRAFT' | 'SUBMITTED' | 'IN_REVIEW' | 'APPROVED' | 'REJECTED' | 'EXPIRED';

export const verificationMachine = new StateMachine<CaseStatus>('verification_case', {
  DRAFT: ['SUBMITTED'],
  SUBMITTED: ['IN_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED'],
  IN_REVIEW: ['APPROVED', 'REJECTED', 'SUBMITTED'],
  APPROVED: ['EXPIRED'],
  REJECTED: [],
  EXPIRED: [],
});

export interface DocumentInput {
  documentType: string;
  mediaId?: string | null;
  sha256: string;
}

/** Subject-specific ownership checks for subject_id. */
async function assertSubjectOwnership(db: Db, userId: string, subjectType: SubjectType, subjectId: string | null | undefined) {
  if (!subjectId) {
    if (subjectType === 'BUSINESS' || subjectType === 'PAYOUT_ACCOUNT' || subjectType === 'PROPERTY') throw unprocessable('SUBJECT_ID_REQUIRED', `${subjectType} verification requires subjectId`);
    return;
  }
  const sql: Partial<Record<SubjectType, string>> = {
    BUSINESS: `SELECT user_id AS owner FROM business_profiles WHERE id = $1`,
    PAYOUT_ACCOUNT: `SELECT user_id AS owner FROM payout_accounts WHERE id = $1`,
    PROPERTY: `SELECT host_id AS owner FROM properties WHERE id = $1`,
    SUPPLIER: `SELECT owner_user_id AS owner FROM suppliers WHERE id = $1`,
  };
  const stmt = sql[subjectType];
  if (!stmt) {
    if (subjectId !== userId) throw unprocessable('SUBJECT_MISMATCH', `${subjectType} verification subject must be yourself`);
    return;
  }
  const row = await maybeOne<{ owner: string }>(db, stmt, [subjectId]);
  if (!row) throw notFound(subjectType.toLowerCase().replace('_', ' '));
  if (row.owner !== userId) throw forbidden('NOT_SUBJECT_OWNER', 'You can only submit verification for your own records');
}

export async function submitCase(tx: Tx, ctx: Ctx, input: { subjectType: SubjectType; subjectId?: string | null; documents: DocumentInput[] }) {
  const userId = ctx.actor!.userId;
  await assertSubjectOwnership(tx, userId, input.subjectType, input.subjectId);
  for (const d of input.documents) {
    if (!d.mediaId) continue;
    const m = await maybeOne(tx, `SELECT owner_id, sha256, status FROM media_assets WHERE id = $1`, [d.mediaId]);
    if (!m || m.owner_id !== userId) throw unprocessable('MEDIA_NOT_OWNED', 'Documents must be uploaded by you');
    if (m.sha256 && m.sha256.toLowerCase() !== d.sha256.toLowerCase()) throw unprocessable('DOCUMENT_HASH_MISMATCH', 'Document hash does not match the uploaded file');
  }
  const open = await maybeOne(
    tx,
    `SELECT id FROM verification_cases WHERE user_id = $1 AND subject_type = $2 AND subject_id IS NOT DISTINCT FROM $3 AND status IN ('SUBMITTED','IN_REVIEW')`,
    [userId, input.subjectType, input.subjectId ?? null],
  );
  if (open) throw conflict('VERIFICATION_ALREADY_OPEN', 'A verification case for this subject is already under review', { caseId: open.id });
  const c = await one(
    tx,
    `INSERT INTO verification_cases(user_id, subject_type, subject_id, status) VALUES ($1,$2,$3,'SUBMITTED') RETURNING *`,
    [userId, input.subjectType, input.subjectId ?? null],
  );
  for (const d of input.documents) {
    await tx.query(`INSERT INTO verification_documents(case_id, document_type, media_id, sha256) VALUES ($1,$2,$3,$4)`, [c.id, d.documentType, d.mediaId ?? null, d.sha256.toLowerCase()]);
  }
  await emit(tx, ctx, { aggregateType: 'verification_case', aggregateId: c.id, eventType: 'verification.submitted', payload: { caseId: c.id, userId, subjectType: c.subject_type, subjectId: c.subject_id } });
  await audit(tx, ctx, { action: 'verification.submitted', resourceType: 'verification_case', resourceId: c.id, after: { subjectType: c.subject_type, documents: input.documents.length }, category: 'COMPLIANCE' });
  return c;
}

export async function getCase(db: Db, ctx: Ctx, id: string) {
  const c = await maybeOne(db, `SELECT * FROM verification_cases WHERE id = $1`, [id]);
  if (!c) throw notFound('Verification case');
  const staff = isStaff(ctx.actor) && ctx.actor!.aal === 'aal2' && (ctx.actor!.roles.includes('ADMIN') || ctx.actor!.roles.includes('COMPLIANCE'));
  if (c.user_id !== ctx.actor!.userId && !staff) throw notFound('Verification case');
  const documents = await q(db, `SELECT id, document_type, media_id, sha256, created_at FROM verification_documents WHERE case_id = $1 ORDER BY created_at`, [id]);
  const timeline = await q(db, `SELECT from_state, to_state, reason, actor_type, created_at FROM state_transitions WHERE aggregate_type = 'verification_case' AND aggregate_id = $1 ORDER BY id`, [id]);
  return { ...c, documents, timeline };
}

/**
 * Side effects of a decision on records this module (or Agent A) owns. Records owned by other domains
 * (guide_profiles, payout_accounts, suppliers, properties) are updated by outbox consumers of
 * verification.approved / verification.rejected so the owning module stays authoritative.
 */
async function applyDecisionEffects(tx: Tx, c: any, approved: boolean) {
  switch (c.subject_type as SubjectType) {
    case 'IDENTITY':
      if (approved) await tx.query(`UPDATE users SET identity_verified_at = now() WHERE id = $1`, [c.user_id]);
      break;
    case 'HOST':
      await tx.query(`UPDATE host_profiles SET verification_status = $2 WHERE user_id = $1 AND verification_status <> 'SUSPENDED'`, [c.user_id, approved ? 'VERIFIED' : 'REJECTED']);
      break;
    case 'BUSINESS':
      await tx.query(`UPDATE business_profiles SET status = $2, updated_at = now() WHERE id = $1`, [c.subject_id, approved ? 'VERIFIED' : 'REJECTED']);
      break;
    default:
      break;
  }
}

export async function decideCase(tx: Tx, ctx: Ctx, id: string, d: { approve: boolean; reason?: string | null; expiresAt?: string | null }) {
  const current = await maybeOne(tx, `SELECT * FROM verification_cases WHERE id = $1 FOR UPDATE`, [id]);
  if (!current) throw notFound('Verification case');
  if (current.user_id === ctx.actor!.userId) throw forbidden('SELF_REVIEW_FORBIDDEN', 'You cannot review your own verification');
  if (!d.approve && !d.reason) throw unprocessable('REASON_REQUIRED', 'A rejection reason is required');
  const to: CaseStatus = d.approve ? 'APPROVED' : 'REJECTED';
  const { row } = await verificationMachine.transition(tx, ctx, {
    table: 'verification_cases',
    id,
    to,
    from: ['SUBMITTED', 'IN_REVIEW'],
    reason: d.reason ?? undefined,
    actorType: 'ADMIN',
    set: { reviewer_id: ctx.actor!.userId, decision_reason: d.reason ?? null, decided_at: new Date(), expires_at: d.approve ? d.expiresAt ?? null : null },
  });
  await applyDecisionEffects(tx, row, d.approve);
  const eventType = d.approve ? 'verification.approved' : 'verification.rejected';
  await emit(tx, ctx, { aggregateType: 'verification_case', aggregateId: id, eventType, payload: { caseId: id, userId: row.user_id, subjectType: row.subject_type, subjectId: row.subject_id, reviewerId: ctx.actor!.userId } });
  await audit(tx, ctx, { action: eventType, resourceType: 'verification_case', resourceId: id, before: { status: current.status }, after: { status: to }, reason: d.reason ?? null, category: 'COMPLIANCE' });
  await notify(tx, ctx, {
    userId: row.user_id,
    templateKey: eventType,
    title: d.approve ? '인증이 승인되었습니다' : '인증이 반려되었습니다',
    body: d.approve ? `Your ${row.subject_type} verification was approved.` : `Your ${row.subject_type} verification was rejected: ${d.reason}`,
    data: { caseId: id, subjectType: row.subject_type },
    dedupeKey: `${eventType}:${id}`,
  });
  return row;
}

export async function startReview(tx: Tx, ctx: Ctx, id: string) {
  const c = await maybeOne(tx, `SELECT user_id FROM verification_cases WHERE id = $1`, [id]);
  if (!c) throw notFound('Verification case');
  if (c.user_id === ctx.actor!.userId) throw forbidden('SELF_REVIEW_FORBIDDEN', 'You cannot review your own verification');
  const { row } = await verificationMachine.transition(tx, ctx, { table: 'verification_cases', id, to: 'IN_REVIEW', from: 'SUBMITTED', actorType: 'ADMIN', set: { reviewer_id: ctx.actor!.userId } });
  await audit(tx, ctx, { action: 'verification.review_started', resourceType: 'verification_case', resourceId: id, category: 'COMPLIANCE' });
  return row;
}

/**
 * TRUST-01 predicate used by restricted actions: is there an APPROVED, unexpired case for this subject?
 * IDENTITY also honours users.identity_verified_at (set by approval or by trusted provider integrations).
 */
export async function isVerified(db: Db, userId: string, subjectType: SubjectType, subjectId?: string | null): Promise<boolean> {
  if (subjectType === 'IDENTITY') {
    const u = await maybeOne(db, `SELECT identity_verified_at FROM users WHERE id = $1`, [userId]);
    if (u?.identity_verified_at) return true;
  }
  const row = await maybeOne(
    db,
    `SELECT 1 FROM verification_cases WHERE user_id = $1 AND subject_type = $2 AND status = 'APPROVED'
        AND (expires_at IS NULL OR expires_at > now()) AND ($3::uuid IS NULL OR subject_id = $3) LIMIT 1`,
    [userId, subjectType, subjectId ?? null],
  );
  return !!row;
}

/** Summary of all verification predicates for a user (UI checklists, host onboarding). */
export async function verificationSummary(db: Db, userId: string) {
  const out: Record<string, { verified: boolean; status: string | null }> = {};
  const latest = await q(db, `SELECT DISTINCT ON (subject_type) subject_type, status FROM verification_cases WHERE user_id = $1 ORDER BY subject_type, submitted_at DESC`, [userId]);
  for (const t of SUBJECT_TYPES) {
    out[t] = { verified: await isVerified(db, userId, t), status: latest.find((l) => l.subject_type === t)?.status ?? null };
  }
  return out;
}
