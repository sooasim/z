import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { StateMachine } from '../../platform/fsm.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { notify } from '../../platform/notify.js';
import { sha256 } from '../../platform/crypto.js';
import { hasRole, isStaff, STAFF_ROLES } from '../../platform/auth.js';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { currentSuspensionSource, suspendUser, restoreUser } from '../roles/service.js';
import { counterpartyOf, resolveContextParties, type ContextType } from './parties.js';
import { ACCOUNT_BLOCKING_SANCTIONS, hasActiveSanction, lockSanctionSubject, type SanctionType } from './sanctions.js';

export * from './sanctions.js';
export { resolveContextParties, reviewTargetOwners, counterpartyOf } from './parties.js';

export type DisputeStatus = 'OPEN' | 'IN_REVIEW' | 'AWAITING_PARTY' | 'RESOLVED' | 'REJECTED' | 'ESCALATED';
export const disputeMachine = new StateMachine<DisputeStatus>('dispute', {
  OPEN: ['IN_REVIEW', 'AWAITING_PARTY', 'ESCALATED', 'RESOLVED', 'REJECTED'],
  IN_REVIEW: ['AWAITING_PARTY', 'ESCALATED', 'RESOLVED', 'REJECTED'],
  AWAITING_PARTY: ['IN_REVIEW', 'ESCALATED', 'RESOLVED', 'REJECTED'],
  ESCALATED: ['IN_REVIEW', 'AWAITING_PARTY', 'RESOLVED', 'REJECTED'],
  RESOLVED: [],
  REJECTED: [],
});
const CLOSED: DisputeStatus[] = ['RESOLVED', 'REJECTED'];

export type SafetyStatus = 'OPEN' | 'TRIAGED' | 'ACTIONED' | 'CLOSED';
export const safetyReportMachine = new StateMachine<SafetyStatus>('safety_report', {
  OPEN: ['TRIAGED', 'ACTIONED', 'CLOSED'],
  TRIAGED: ['ACTIONED', 'CLOSED'],
  ACTIONED: ['CLOSED'],
  CLOSED: [],
});

/** Dispute desk staff: ADMIN / SUPPORT (full), COMPLIANCE (read). Always AAL2. */
export const isDisputeStaff = (ctx: Ctx, write = false) =>
  !!ctx.actor && ctx.actor.aal === 'aal2' && hasRole(ctx.actor, ...(write ? (['ADMIN', 'SUPPORT'] as const) : (['ADMIN', 'SUPPORT', 'COMPLIANCE'] as const)));

async function addEvent(tx: Tx, ctx: Ctx, disputeId: string, eventType: string, note?: string | null, internal = false) {
  await tx.query(`INSERT INTO dispute_events(dispute_id, actor_id, event_type, note, internal) VALUES ($1,$2,$3,$4,$5)`, [disputeId, ctx.actor?.userId ?? null, eventType, note ?? null, internal]);
}

async function notifyParties(tx: Tx, ctx: Ctx, d: any, templateKey: string, title: string, body: string) {
  for (const uid of [d.opened_by, d.counterparty_id].filter(Boolean)) {
    await notify(tx, ctx, { userId: uid, templateKey, title, body, data: { disputeId: d.id }, dedupeKey: `${templateKey}:${d.id}:${ctx.correlationId}` });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------------------------------------
/** Open OTHER-context disputes one user may have at a time (they name nobody and need staff triage). */
export const MAX_OPEN_OTHER_DISPUTES = 3;
const TRANSACTION_CONTEXTS: ContextType[] = ['RESERVATION', 'EXCHANGE', 'GUIDE_BOOKING', 'ORDER'];

export async function openDispute(
  tx: Tx,
  ctx: Ctx,
  input: { contextType: ContextType; contextId: string; reason: string; description?: string; severity?: 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL'; counterpartyId?: string },
) {
  const userId = ctx.actor!.userId;
  let counterparty: string | null = null;
  // A dispute's counterparty / context drive payout holds downstream, so neither may be chosen freely by the opener.
  let namedCounterparty: string | null = null;
  if (input.contextType !== 'OTHER') {
    const parties = await resolveContextParties(tx, input.contextType, input.contextId);
    if (!parties) throw notFound(input.contextType.toLowerCase());
    if (!parties.parties.includes(userId)) throw forbidden('NOT_A_PARTY', 'Only a party of this transaction can open a dispute');
    if (input.contextType === 'MESSAGE' && parties.roles[userId] === 'SENDER') {
      throw unprocessable('INVALID_COUNTERPARTY', 'A message dispute must reference a message sent by the other party');
    }
    counterparty = counterpartyOf(parties, userId, input.contextType);
  } else {
    // OTHER names nobody automatically: the opener's suggestion is recorded for staff triage, never as counterparty_id,
    // and the context id must not point at a transaction (use its own context type, which checks party membership).
    for (const t of TRANSACTION_CONTEXTS) {
      if (await resolveContextParties(tx, t, input.contextId)) {
        throw unprocessable('USE_TRANSACTION_CONTEXT', `This id refers to a ${t.toLowerCase().replace('_', ' ')}; open the dispute with contextType ${t}`);
      }
    }
    if (input.counterpartyId) {
      if (input.counterpartyId === userId) throw unprocessable('INVALID_COUNTERPARTY', 'You cannot open a dispute against yourself');
      if (!(await maybeOne(tx, `SELECT 1 FROM users WHERE id = $1`, [input.counterpartyId]))) throw notFound('Counterparty');
      namedCounterparty = input.counterpartyId;
    }
    const open = await one<{ n: number }>(
      tx,
      `SELECT count(*)::int AS n FROM disputes WHERE opened_by = $1 AND context_type = 'OTHER' AND status NOT IN ('RESOLVED','REJECTED')`,
      [userId],
    );
    if (open.n >= MAX_OPEN_OTHER_DISPUTES) {
      throw new AppError(429, 'TOO_MANY_OPEN_DISPUTES', `You can have at most ${MAX_OPEN_OTHER_DISPUTES} open general disputes; wait for staff to handle them`);
    }
  }
  const dup = await maybeOne(
    tx,
    `SELECT id FROM disputes WHERE opened_by = $1 AND context_type = $2 AND context_id = $3 AND status NOT IN ('RESOLVED','REJECTED')`,
    [userId, input.contextType, input.contextId],
  );
  if (dup) throw conflict('DISPUTE_ALREADY_OPEN', 'You already have an open dispute for this context', { disputeId: dup.id });
  // Parties may not self-escalate to CRITICAL; staff triage sets the final severity.
  const severity = input.severity === 'CRITICAL' ? 'HIGH' : input.severity ?? 'NORMAL';
  const d = await one(
    tx,
    `INSERT INTO disputes(opened_by, context_type, context_id, counterparty_id, severity, reason, description) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [userId, input.contextType, input.contextId, counterparty, severity, input.reason, input.description ?? null],
  );
  await tx.query(
    `INSERT INTO state_transitions(aggregate_type, aggregate_id, from_state, to_state, actor_id, actor_type, correlation_id) VALUES ('dispute',$1,NULL,'OPEN',$2,'USER',$3)`,
    [d.id, userId, ctx.correlationId],
  );
  await addEvent(tx, ctx, d.id, 'OPENED', input.reason);
  if (namedCounterparty) await addEvent(tx, ctx, d.id, 'COUNTERPARTY_NAMED', `opener named user ${namedCounterparty} (unverified; staff triage)`, true);
  if (input.description) {
    await tx.query(`INSERT INTO dispute_evidence(dispute_id, submitted_by, evidence_type, content, sha256) VALUES ($1,$2,'TEXT',$3,$4)`, [d.id, userId, input.description, sha256(input.description)]);
  }
  await emit(tx, ctx, {
    aggregateType: 'dispute',
    aggregateId: d.id,
    eventType: 'dispute.opened',
    payload: { disputeId: d.id, contextType: d.context_type, contextId: d.context_id, openedBy: userId, counterpartyId: counterparty, severity },
  });
  await audit(tx, ctx, { action: 'dispute.opened', resourceType: 'dispute', resourceId: d.id, after: { contextType: d.context_type, contextId: d.context_id }, category: 'GENERAL' });
  if (counterparty) {
    await notify(tx, ctx, { userId: counterparty, templateKey: 'dispute.opened', title: '분쟁이 접수되었습니다', body: 'A dispute involving you was opened. You can add evidence from your account.', data: { disputeId: d.id }, dedupeKey: `dispute.opened:${d.id}` });
  }
  return d;
}

/** Load a dispute visible to the actor (party or dispute staff). */
export async function loadDisputeFor(db: Db, ctx: Ctx, id: string) {
  const d = await maybeOne(db, `SELECT * FROM disputes WHERE id = $1`, [id]);
  if (!d) throw notFound('Dispute');
  const party = d.opened_by === ctx.actor?.userId || d.counterparty_id === ctx.actor?.userId;
  if (!party && !isDisputeStaff(ctx)) throw notFound('Dispute');
  return { dispute: d, party, staff: isDisputeStaff(ctx) };
}

export async function disputeDetail(db: Db, ctx: Ctx, id: string) {
  const { dispute, staff } = await loadDisputeFor(db, ctx, id);
  const evidence = await q(db, `SELECT id, submitted_by, evidence_type, content, media_id, sha256, created_at FROM dispute_evidence WHERE dispute_id = $1 ORDER BY created_at, id`, [id]);
  const timeline = await q(
    db,
    `SELECT id, actor_id, event_type, note, internal, created_at FROM dispute_events WHERE dispute_id = $1 AND ($2 OR NOT internal) ORDER BY created_at, id`,
    [id, staff],
  );
  return { ...dispute, evidence, timeline };
}

export async function addEvidence(
  tx: Tx,
  ctx: Ctx,
  id: string,
  input: { evidenceType: 'TEXT' | 'MEDIA' | 'MESSAGE_REF' | 'DOCUMENT'; content?: string; mediaId?: string; sha256?: string },
) {
  const { dispute } = await loadDisputeFor(tx, ctx, id);
  if (CLOSED.includes(dispute.status)) throw conflict('DISPUTE_CLOSED', 'Evidence cannot be added to a closed dispute');
  let hash: string;
  if (input.evidenceType === 'TEXT' || input.evidenceType === 'MESSAGE_REF') {
    if (!input.content) throw unprocessable('CONTENT_REQUIRED', 'content is required for TEXT/MESSAGE_REF evidence');
    if (input.evidenceType === 'MESSAGE_REF') {
      // the referenced message must belong to a conversation the submitter is a member of (or staff)
      const m = await maybeOne(tx, `SELECT m.id FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2 WHERE m.id::text = $1`, [input.content, ctx.actor!.userId]);
      if (!m && !isDisputeStaff(ctx)) throw forbidden('MESSAGE_NOT_ACCESSIBLE', 'You can only reference messages from your own conversations');
    }
    hash = sha256(input.content);
  } else {
    if (!input.mediaId) throw unprocessable('MEDIA_REQUIRED', 'mediaId is required for MEDIA/DOCUMENT evidence');
    const m = await maybeOne(tx, `SELECT owner_id, sha256 FROM media_assets WHERE id = $1`, [input.mediaId]);
    if (!m || (m.owner_id !== ctx.actor!.userId && !isDisputeStaff(ctx))) throw unprocessable('MEDIA_NOT_OWNED', 'Evidence media must be uploaded by you');
    const provided = input.sha256?.toLowerCase();
    if (m.sha256 && provided && m.sha256.toLowerCase() !== provided) throw unprocessable('EVIDENCE_HASH_MISMATCH', 'Evidence hash does not match the uploaded file');
    hash = (m.sha256 ?? provided)?.toLowerCase() ?? '';
    if (!/^[0-9a-f]{64}$/.test(hash)) throw unprocessable('EVIDENCE_HASH_REQUIRED', 'sha256 of the file is required');
  }
  const ev = await one(
    tx,
    `INSERT INTO dispute_evidence(dispute_id, submitted_by, evidence_type, content, media_id, sha256) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, ctx.actor!.userId, input.evidenceType, input.content ?? null, input.mediaId ?? null, hash],
  );
  await addEvent(tx, ctx, id, 'EVIDENCE_ADDED', `${input.evidenceType} ${hash.slice(0, 12)}`);
  if (dispute.status === 'AWAITING_PARTY' && !isDisputeStaff(ctx)) {
    await disputeMachine.transition(tx, ctx, { table: 'disputes', id, to: 'IN_REVIEW', from: 'AWAITING_PARTY', reason: 'party responded' });
  }
  return ev;
}

export async function assignDispute(tx: Tx, ctx: Ctx, id: string, assigneeId: string) {
  const staffRoles = await q<{ role: string }>(tx, `SELECT role FROM user_roles WHERE user_id = $1`, [assigneeId]);
  if (!staffRoles.some((r) => ['ADMIN', 'SUPPORT', 'COMPLIANCE'].includes(r.role))) throw unprocessable('ASSIGNEE_NOT_STAFF', 'Disputes can only be assigned to staff');
  const d = await maybeOne(tx, `SELECT * FROM disputes WHERE id = $1 FOR UPDATE`, [id]);
  if (!d) throw notFound('Dispute');
  if (CLOSED.includes(d.status)) throw conflict('DISPUTE_CLOSED', 'Dispute is closed');
  if (assigneeId === d.opened_by || assigneeId === d.counterparty_id) throw unprocessable('CONFLICT_OF_INTEREST', 'A party cannot handle their own dispute');
  await tx.query(`UPDATE disputes SET assignee_id = $2 WHERE id = $1`, [id, assigneeId]);
  if (d.status === 'OPEN') await disputeMachine.transition(tx, ctx, { table: 'disputes', id, to: 'IN_REVIEW', from: 'OPEN', reason: 'assigned', actorType: 'ADMIN' });
  await addEvent(tx, ctx, id, 'ASSIGNED', assigneeId, true);
  await audit(tx, ctx, { action: 'dispute.assigned', resourceType: 'dispute', resourceId: id, before: { assigneeId: d.assignee_id }, after: { assigneeId }, category: 'GENERAL' });
  return one(tx, `SELECT * FROM disputes WHERE id = $1`, [id]);
}

export async function changeDisputeStatus(tx: Tx, ctx: Ctx, id: string, to: 'IN_REVIEW' | 'AWAITING_PARTY', note?: string) {
  const { row } = await disputeMachine.transition(tx, ctx, { table: 'disputes', id, to, reason: note, actorType: 'ADMIN' });
  await addEvent(tx, ctx, id, 'STATUS_CHANGED', `${to}${note ? `: ${note}` : ''}`);
  await audit(tx, ctx, { action: 'dispute.status_changed', resourceType: 'dispute', resourceId: id, after: { status: to }, reason: note ?? null });
  if (to === 'AWAITING_PARTY') await notifyParties(tx, ctx, row, 'dispute.awaiting_party', '분쟁 처리에 추가 정보가 필요합니다', note ?? 'Additional information is requested for your dispute.');
  return row;
}

export async function escalateDispute(tx: Tx, ctx: Ctx, id: string, input: { reason: string; severity?: 'HIGH' | 'CRITICAL' }) {
  const { row } = await disputeMachine.transition(tx, ctx, {
    table: 'disputes',
    id,
    to: 'ESCALATED',
    reason: input.reason,
    actorType: 'ADMIN',
    set: input.severity ? { severity: input.severity } : undefined,
  });
  await addEvent(tx, ctx, id, 'ESCALATED', input.reason, true);
  await audit(tx, ctx, { action: 'dispute.escalated', resourceType: 'dispute', resourceId: id, after: { severity: row.severity }, reason: input.reason });
  await emit(tx, ctx, { aggregateType: 'dispute', aggregateId: id, eventType: 'dispute.escalated', payload: { disputeId: id, severity: row.severity } });
  return row;
}

export async function resolveDispute(
  tx: Tx,
  ctx: Ctx,
  id: string,
  input: { outcome: 'RESOLVED' | 'REJECTED'; resolution: string; detail?: Record<string, unknown> },
) {
  const cur = await maybeOne(tx, `SELECT opened_by, counterparty_id FROM disputes WHERE id = $1`, [id]);
  if (!cur) throw notFound('Dispute');
  if (cur.opened_by === ctx.actor!.userId || cur.counterparty_id === ctx.actor!.userId) throw forbidden('CONFLICT_OF_INTEREST', 'A party cannot resolve their own dispute');
  const { row, from } = await disputeMachine.transition(tx, ctx, {
    table: 'disputes',
    id,
    to: input.outcome,
    reason: input.resolution,
    actorType: 'ADMIN',
    set: { resolution: input.resolution, resolution_detail: input.detail ?? {}, resolved_at: new Date() },
  });
  await addEvent(tx, ctx, id, input.outcome, input.resolution);
  await emit(tx, ctx, {
    aggregateType: 'dispute',
    aggregateId: id,
    eventType: 'dispute.resolved',
    payload: { disputeId: id, outcome: input.outcome, contextType: row.context_type, contextId: row.context_id, openedBy: row.opened_by, counterpartyId: row.counterparty_id, detail: input.detail ?? {} },
  });
  await audit(tx, ctx, { action: 'dispute.resolved', resourceType: 'dispute', resourceId: id, before: { status: from }, after: { status: input.outcome, detail: input.detail ?? {} }, reason: input.resolution });
  await notifyParties(tx, ctx, row, 'dispute.resolved', '분쟁 처리가 완료되었습니다', input.resolution);
  return row;
}

export async function addInternalNote(tx: Tx, ctx: Ctx, id: string, note: string) {
  const d = await maybeOne(tx, `SELECT id FROM disputes WHERE id = $1`, [id]);
  if (!d) throw notFound('Dispute');
  await addEvent(tx, ctx, id, 'NOTE', note, true);
}

// ---------------------------------------------------------------------------------------------------------
// Sanctions
// ---------------------------------------------------------------------------------------------------------
export async function applySanction(
  tx: Tx,
  ctx: Ctx,
  input: { userId: string; sanctionType: SanctionType; reason: string; disputeId?: string | null; endsAt?: string | null },
) {
  const actor = ctx.actor!;
  if (input.userId === actor.userId) throw forbidden('SELF_SANCTION_FORBIDDEN', 'You cannot sanction yourself');
  if (!hasRole(actor, 'ADMIN', 'COMPLIANCE') && input.sanctionType !== 'WARNING') throw forbidden('ROLE_REQUIRED', 'Only ADMIN or COMPLIANCE can apply this sanction');
  // lock the subject first: a concurrent lift / expiry restore must either finish before this sanction exists
  // (and then this transaction suspends the restored account) or see it committed
  const target = await maybeOne(tx, `SELECT status, array(SELECT role FROM user_roles WHERE user_id = users.id) AS roles FROM users WHERE id = $1 FOR UPDATE`, [input.userId]);
  if (!target) throw notFound('User');
  if ((target.roles as string[]).some((r) => STAFF_ROLES.includes(r as any)) && !hasRole(actor, 'ADMIN')) throw forbidden('ROLE_REQUIRED', 'Only ADMIN can sanction staff');
  if (input.endsAt && new Date(input.endsAt) <= new Date()) throw unprocessable('INVALID_END', 'endsAt must be in the future');
  if (input.disputeId && !(await maybeOne(tx, `SELECT 1 FROM disputes WHERE id = $1`, [input.disputeId]))) throw notFound('Dispute');
  const s = await one(
    tx,
    `INSERT INTO sanctions(user_id, sanction_type, reason, dispute_id, issued_by, ends_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.userId, input.sanctionType, input.reason, input.disputeId ?? null, actor.userId, input.endsAt ?? null],
  );
  if (ACCOUNT_BLOCKING_SANCTIONS.includes(input.sanctionType)) {
    await suspendUser(tx, ctx, { userId: input.userId, reason: `sanction ${s.id}: ${input.reason}`, source: 'SANCTION', sanctionId: s.id });
  }
  if (input.disputeId) await addEvent(tx, ctx, input.disputeId, 'SANCTION_APPLIED', `${input.sanctionType} ${s.id}`, true);
  await audit(tx, ctx, { action: 'sanction.applied', resourceType: 'user', resourceId: input.userId, after: { sanctionId: s.id, type: input.sanctionType, endsAt: s.ends_at }, reason: input.reason, category: 'PERMISSION' });
  await emit(tx, ctx, { aggregateType: 'user', aggregateId: input.userId, eventType: 'sanction.applied', payload: { sanctionId: s.id, userId: input.userId, sanctionType: input.sanctionType, disputeId: input.disputeId ?? null, endsAt: s.ends_at } });
  if (input.sanctionType !== 'ACCOUNT_SUSPENSION' && input.sanctionType !== 'BAN') {
    await notify(tx, ctx, { userId: input.userId, templateKey: 'sanction.applied', category: 'SECURITY', title: '계정 제재 안내', body: `A ${input.sanctionType} was applied to your account: ${input.reason}`, data: { sanctionId: s.id } });
  }
  return s;
}

/**
 * After an account sanction ended (lift or expiry): restore the account only when it is suspended BECAUSE of a
 * sanction and no blocking sanction remains. A suspension imposed directly (admin / other source) stands.
 * Caller holds the users row lock (lockSanctionSubject).
 */
async function restoreAfterSanctionEnded(tx: Tx, ctx: Ctx, userId: string, reason: string): Promise<boolean> {
  const u = await one<{ status: string }>(tx, `SELECT status FROM users WHERE id = $1`, [userId]);
  if (u.status !== 'SUSPENDED') return false;
  if (await hasActiveSanction(tx, userId, ACCOUNT_BLOCKING_SANCTIONS)) return false;
  if ((await currentSuspensionSource(tx, userId)) !== 'SANCTION') return false;
  return (await restoreUser(tx, ctx, { userId, reason })).changed;
}

export async function liftSanction(tx: Tx, ctx: Ctx, sanctionId: string, reason: string) {
  const actor = ctx.actor!;
  const s = await maybeOne(tx, `SELECT * FROM sanctions WHERE id = $1 FOR UPDATE`, [sanctionId]);
  if (!s) throw notFound('Sanction');
  if (s.lifted_at) throw conflict('ALREADY_LIFTED', 'Sanction was already lifted');
  if (!hasRole(actor, 'ADMIN', 'COMPLIANCE')) throw forbidden('ROLE_REQUIRED', 'Only ADMIN or COMPLIANCE can lift sanctions');
  // same guards as applying: nobody lifts their own sanction, and only ADMIN decides about staff accounts
  if (s.user_id === actor.userId) throw forbidden('SELF_LIFT_FORBIDDEN', 'You cannot lift a sanction on your own account');
  const target = await one<{ roles: string[] }>(tx, `SELECT array(SELECT role FROM user_roles WHERE user_id = $1) AS roles`, [s.user_id]);
  if (target.roles.some((r) => STAFF_ROLES.includes(r as any)) && !hasRole(actor, 'ADMIN')) throw forbidden('ROLE_REQUIRED', 'Only ADMIN can lift sanctions on staff');
  await lockSanctionSubject(tx, s.user_id);
  const row = await one(tx, `UPDATE sanctions SET lifted_at = now(), lifted_by = $2, lift_reason = $3 WHERE id = $1 RETURNING *`, [sanctionId, actor.userId, reason]);
  const restored = ACCOUNT_BLOCKING_SANCTIONS.includes(s.sanction_type) ? await restoreAfterSanctionEnded(tx, ctx, s.user_id, `sanction ${sanctionId} lifted: ${reason}`) : false;
  await audit(tx, ctx, { action: 'sanction.lifted', resourceType: 'user', resourceId: s.user_id, before: { sanctionId, type: s.sanction_type }, after: { restored }, reason, category: 'PERMISSION' });
  await emit(tx, ctx, { aggregateType: 'user', aggregateId: s.user_id, eventType: 'sanction.lifted', payload: { sanctionId, userId: s.user_id, sanctionType: s.sanction_type } });
  return { ...row, accountRestored: restored };
}

export const SANCTION_EXPIRED_REASON = 'EXPIRED';

/**
 * Expiry job: each ended time-boxed ACCOUNT_SUSPENSION/BAN is processed exactly once (stamped lifted_at with
 * lift_reason EXPIRED, no lifted_by), and its user is restored only if the current suspension came from a sanction.
 */
export async function sweepExpiredSanctions(tx: Tx, ctx: Ctx): Promise<number> {
  const expired = await q<{ id: string; user_id: string; sanction_type: string }>(
    tx,
    `UPDATE sanctions SET lifted_at = now(), lift_reason = $1
      WHERE id IN (SELECT id FROM sanctions
                    WHERE sanction_type IN ('ACCOUNT_SUSPENSION','BAN') AND lifted_at IS NULL AND ends_at IS NOT NULL AND ends_at <= now()
                    ORDER BY ends_at LIMIT 100 FOR UPDATE SKIP LOCKED)
      RETURNING id, user_id, sanction_type`,
    [SANCTION_EXPIRED_REASON],
  );
  let restored = 0;
  for (const userId of [...new Set(expired.map((e) => e.user_id))]) {
    await lockSanctionSubject(tx, userId);
    for (const e of expired.filter((x) => x.user_id === userId)) {
      await audit(tx, ctx, { action: 'sanction.expired', resourceType: 'user', resourceId: userId, before: { sanctionId: e.id, type: e.sanction_type }, category: 'PERMISSION' });
      await emit(tx, ctx, { aggregateType: 'user', aggregateId: userId, eventType: 'sanction.expired', payload: { sanctionId: e.id, userId, sanctionType: e.sanction_type } });
    }
    if (await restoreAfterSanctionEnded(tx, ctx, userId, 'sanction period ended')) restored++;
  }
  return restored;
}

// ---------------------------------------------------------------------------------------------------------
// Elevated access to private conversations (invariant 10)
// ---------------------------------------------------------------------------------------------------------
export const ELEVATED_MAX_MINUTES = 24 * 60;

/** Is this conversation part of the case? Context match, referenced message, or both case parties are members. */
async function conversationBelongsToCase(db: Db, caseType: 'DISPUTE' | 'SAFETY_REPORT' | 'SUPPORT_CASE', c: any, conversationId: string): Promise<boolean> {
  const conv = await maybeOne(db, `SELECT id, context_type, context_id FROM conversations WHERE id = $1`, [conversationId]);
  if (!conv) return false;
  const members = (await q<{ user_id: string }>(db, `SELECT user_id FROM conversation_members WHERE conversation_id = $1`, [conversationId])).map((m) => m.user_id);
  let contextType: string | null = null;
  let contextId: string | null = null;
  let people: string[] = [];
  if (caseType === 'DISPUTE') {
    contextType = c.context_type;
    contextId = c.context_id;
    people = [c.opened_by, c.counterparty_id].filter(Boolean);
  } else if (caseType === 'SAFETY_REPORT') {
    contextType = c.subject_type;
    contextId = c.subject_id;
    people = [c.reporter_id, ...(c.subject_type === 'USER' ? [c.subject_id] : [])];
  } else {
    contextType = c.context_type;
    contextId = c.context_id;
    people = [c.requester_id].filter(Boolean);
  }
  if (contextType === 'MESSAGE' && contextId) {
    const m = await maybeOne(db, `SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2`, [contextId, conversationId]);
    if (m) return true;
  }
  if (contextId && conv.context_id === contextId && (conv.context_type === contextType || (contextType === 'GUIDE_BOOKING' && conv.context_type === 'GUIDE_REQUEST'))) return true;
  return people.length >= 2 && people.every((p) => members.includes(p));
}

export async function grantElevatedAccess(
  tx: Tx,
  ctx: Ctx,
  input: { caseType: 'DISPUTE' | 'SAFETY_REPORT' | 'SUPPORT_CASE'; caseId: string; conversationId: string; reason: string; durationMinutes?: number },
) {
  const actor = ctx.actor!;
  if (!isStaff(actor) || actor.aal !== 'aal2') throw forbidden('AAL2_REQUIRED', 'Elevated access requires a staff AAL2 session');
  const reason = input.reason.trim();
  if (reason.length < 10) throw unprocessable('REASON_TOO_SHORT', 'A case reason of at least 10 characters is required');
  const minutes = input.durationMinutes ?? 60;
  if (minutes < 1 || minutes > ELEVATED_MAX_MINUTES) throw unprocessable('DURATION_INVALID', 'Elevated access may last at most 24 hours');
  const table = { DISPUTE: 'disputes', SAFETY_REPORT: 'safety_reports', SUPPORT_CASE: 'support_cases' }[input.caseType];
  const c = await maybeOne(tx, `SELECT * FROM ${table} WHERE id = $1`, [input.caseId]);
  if (!c) throw notFound('Case');
  if (['RESOLVED', 'REJECTED', 'CLOSED'].includes(c.status)) throw conflict('CASE_CLOSED', 'Elevated access requires an open case');
  if ([c.opened_by, c.counterparty_id, c.reporter_id, c.requester_id].includes(actor.userId)) throw forbidden('CONFLICT_OF_INTEREST', 'Staff cannot elevate on a case they are party to');
  if (!(await conversationBelongsToCase(tx, input.caseType, c, input.conversationId))) {
    throw unprocessable('CONVERSATION_NOT_IN_CASE', 'The conversation is not related to this case');
  }
  const g = await one(
    tx,
    `INSERT INTO elevated_access_grants(admin_id, case_type, case_id, resource_type, resource_id, reason, expires_at)
     VALUES ($1,$2,$3,'CONVERSATION',$4,$5, now() + make_interval(mins => $6)) RETURNING *`,
    [actor.userId, input.caseType, input.caseId, input.conversationId, reason, minutes],
  );
  await audit(tx, ctx, {
    action: 'elevated_access.granted',
    resourceType: 'conversation',
    resourceId: input.conversationId,
    after: { grantId: g.id, caseType: input.caseType, caseId: input.caseId, expiresAt: g.expires_at },
    reason,
    category: 'ELEVATED_ACCESS',
  });
  if (input.caseType === 'DISPUTE') await addEvent(tx, ctx, input.caseId, 'ELEVATED_ACCESS_GRANTED', `conversation ${input.conversationId} until ${new Date(g.expires_at).toISOString()}`, true);
  await emit(tx, ctx, { aggregateType: 'elevated_access', aggregateId: g.id, eventType: 'elevated_access.granted', payload: { grantId: g.id, adminId: actor.userId, caseType: input.caseType, caseId: input.caseId, conversationId: input.conversationId, expiresAt: g.expires_at } });
  return g;
}

export async function revokeElevatedAccess(tx: Tx, ctx: Ctx, grantId: string) {
  const g = await maybeOne(tx, `UPDATE elevated_access_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL AND (admin_id = $2 OR $3) RETURNING *`, [grantId, ctx.actor!.userId, hasRole(ctx.actor, 'ADMIN')]);
  if (!g) throw notFound('Elevated access grant');
  await audit(tx, ctx, { action: 'elevated_access.revoked', resourceType: 'conversation', resourceId: g.resource_id, after: { grantId }, category: 'ELEVATED_ACCESS' });
  return g;
}

/**
 * Contract for messaging (COMMS-01): staff may read a private conversation only with an active, unexpired,
 * unrevoked, case-scoped grant on an AAL2 session. Every successful check is an audited read.
 * Throws 403 ELEVATED_ACCESS_REQUIRED otherwise.
 */
export async function assertElevatedAccess(db: Db, ctx: Ctx, conversationId: string): Promise<{ grantId: string; caseType: string; caseId: string; expiresAt: string }> {
  const actor = ctx.actor;
  if (!actor || !isStaff(actor)) throw forbidden('ELEVATED_ACCESS_REQUIRED', 'Conversation access requires case-scoped elevated access');
  if (actor.aal !== 'aal2') throw forbidden('AAL2_REQUIRED', 'Multi-factor authentication is required for this action');
  const g = await maybeOne(
    db,
    `SELECT * FROM elevated_access_grants WHERE admin_id = $1 AND resource_type = 'CONVERSATION' AND resource_id = $2
        AND revoked_at IS NULL AND expires_at > now() ORDER BY expires_at DESC LIMIT 1`,
    [actor.userId, conversationId],
  );
  if (!g) {
    await audit(db, ctx, { action: 'elevated_access.denied', resourceType: 'conversation', resourceId: conversationId, category: 'ELEVATED_ACCESS' });
    throw forbidden('ELEVATED_ACCESS_REQUIRED', 'Conversation access requires case-scoped elevated access');
  }
  await audit(db, ctx, {
    action: 'conversation.read_elevated',
    resourceType: 'conversation',
    resourceId: conversationId,
    after: { grantId: g.id, caseType: g.case_type, caseId: g.case_id },
    reason: g.reason,
    category: 'ELEVATED_ACCESS',
  });
  return { grantId: g.id, caseType: g.case_type, caseId: g.case_id, expiresAt: new Date(g.expires_at).toISOString() };
}

// ---------------------------------------------------------------------------------------------------------
// Safety reports
// ---------------------------------------------------------------------------------------------------------
export async function createSafetyReport(
  tx: Tx,
  ctx: Ctx,
  input: { subjectType: string; subjectId: string; category: string; description?: string; urgent?: boolean },
) {
  const userId = ctx.actor!.userId;
  if (input.subjectType === 'USER' && input.subjectId === userId) throw unprocessable('INVALID_SUBJECT', 'You cannot report yourself');
  const exists: Record<string, string> = {
    USER: `SELECT 1 FROM users WHERE id = $1`,
    PROPERTY: `SELECT 1 FROM properties WHERE id = $1`,
    MESSAGE: `SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2 WHERE m.id = $1`,
    REVIEW: `SELECT 1 FROM reviews WHERE id = $1`,
    TRAVEL_PRODUCT: `SELECT 1 FROM travel_products WHERE id = $1`,
    GUIDE: `SELECT 1 FROM guide_profiles WHERE user_id = $1`,
  };
  if (exists[input.subjectType]) {
    const ok = await maybeOne(tx, exists[input.subjectType], input.subjectType === 'MESSAGE' ? [input.subjectId, userId] : [input.subjectId]);
    if (!ok) throw notFound(input.subjectType.toLowerCase());
  } else if (['RESERVATION', 'EXCHANGE', 'GUIDE_BOOKING', 'ORDER'].includes(input.subjectType)) {
    const p = await resolveContextParties(tx, input.subjectType as ContextType, input.subjectId);
    if (!p) throw notFound(input.subjectType.toLowerCase());
    if (!p.parties.includes(userId)) throw forbidden('NOT_A_PARTY', 'Only a party can report this transaction');
  }
  const r = await one(
    tx,
    `INSERT INTO safety_reports(reporter_id, subject_type, subject_id, category, description, urgent) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [userId, input.subjectType, input.subjectId, input.category, input.description ?? null, !!input.urgent],
  );
  await emit(tx, ctx, { aggregateType: 'safety_report', aggregateId: r.id, eventType: 'safety.report.created', payload: { reportId: r.id, subjectType: r.subject_type, subjectId: r.subject_id, category: r.category, urgent: r.urgent } });
  await audit(tx, ctx, { action: 'safety_report.created', resourceType: 'safety_report', resourceId: r.id, after: { subjectType: r.subject_type, category: r.category, urgent: r.urgent }, category: 'GENERAL' });
  return r;
}

export async function changeSafetyStatus(tx: Tx, ctx: Ctx, id: string, to: SafetyStatus, note?: string) {
  const { row, from } = await safetyReportMachine.transition(tx, ctx, { table: 'safety_reports', id, to, reason: note, actorType: 'ADMIN', set: { updated_at: new Date(), assignee_id: ctx.actor!.userId } });
  await audit(tx, ctx, { action: 'safety_report.status_changed', resourceType: 'safety_report', resourceId: id, before: { status: from }, after: { status: to }, reason: note ?? null });
  return row;
}
