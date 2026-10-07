import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { StateMachine } from '../../platform/fsm.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { notify } from '../../platform/notify.js';
import { hasRole } from '../../platform/auth.js';
import { conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { resolveContextParties, type ContextType } from '../disputes/parties.js';
import { maskEmail, shouldMask } from '../roles/service.js';

export type CaseStatus = 'OPEN' | 'PENDING_CUSTOMER' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export type Priority = 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';

export const supportCaseMachine = new StateMachine<CaseStatus>('support_case', {
  OPEN: ['IN_PROGRESS', 'PENDING_CUSTOMER', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['PENDING_CUSTOMER', 'RESOLVED', 'CLOSED'],
  PENDING_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'CLOSED'],
  CLOSED: [],
});

/** First-response SLA by priority (hours). */
export const SLA_HOURS: Record<Priority, number> = { URGENT: 4, HIGH: 8, NORMAL: 24, LOW: 72 };
export const slaDue = (from: Date, p: Priority) => new Date(from.getTime() + SLA_HOURS[p] * 3600_000);

export const CONTEXT_TYPES = ['RESERVATION', 'EXCHANGE', 'GUIDE_BOOKING', 'ORDER', 'DISPUTE', 'PAYMENT', 'ACCOUNT', 'OTHER'] as const;

export const isSupportStaff = (ctx: Ctx) => !!ctx.actor && ctx.actor.aal === 'aal2' && hasRole(ctx.actor, 'SUPPORT', 'ADMIN');

async function addEvent(tx: Tx, ctx: Ctx, caseId: string, type: 'COMMENT' | 'INTERNAL_NOTE' | 'STATUS_CHANGE' | 'ASSIGNMENT', body: string | null) {
  return one(tx, `INSERT INTO support_case_events(case_id, actor_id, event_type, body) VALUES ($1,$2,$3,$4) RETURNING *`, [caseId, ctx.actor?.userId ?? null, type, body]);
}

async function assertContextAccess(db: Db, userId: string, contextType: string, contextId: string) {
  if (['RESERVATION', 'EXCHANGE', 'GUIDE_BOOKING', 'ORDER'].includes(contextType)) {
    const p = await resolveContextParties(db, contextType as ContextType, contextId);
    if (!p) throw notFound(contextType.toLowerCase());
    if (!p.parties.includes(userId)) throw forbidden('NOT_A_PARTY', 'You can only open cases about your own transactions');
  } else if (contextType === 'DISPUTE') {
    const d = await maybeOne(db, `SELECT opened_by, counterparty_id FROM disputes WHERE id = $1`, [contextId]);
    if (!d) throw notFound('Dispute');
    if (d.opened_by !== userId && d.counterparty_id !== userId) throw forbidden('NOT_A_PARTY', 'You can only open cases about your own disputes');
  } else if (contextType === 'PAYMENT') {
    const pm = await maybeOne(db, `SELECT payer_id FROM payments WHERE id = $1`, [contextId]);
    if (!pm) throw notFound('Payment');
    if (pm.payer_id !== userId) throw forbidden('NOT_A_PARTY', 'You can only open cases about your own payments');
  }
}

export async function openCase(
  tx: Tx,
  ctx: Ctx,
  input: { category: string; subject: string; description: string; priority?: 'LOW' | 'NORMAL' | 'HIGH'; contextType?: string; contextId?: string },
) {
  const userId = ctx.actor!.userId;
  if (!!input.contextType !== !!input.contextId && input.contextType !== 'ACCOUNT' && input.contextType !== 'OTHER') {
    throw unprocessable('CONTEXT_INCOMPLETE', 'contextType and contextId must be provided together');
  }
  if (input.contextType && input.contextId) await assertContextAccess(tx, userId, input.contextType, input.contextId);
  const u = await one(tx, `SELECT email FROM users WHERE id = $1`, [userId]);
  const priority: Priority = input.priority ?? 'NORMAL';
  const now = new Date();
  const c = await one(
    tx,
    `INSERT INTO support_cases(requester_id, contact_email, category, subject, description, context_type, context_id, priority, sla_due_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
    [userId, u.email, input.category, input.subject, input.description, input.contextType ?? null, input.contextId ?? null, priority, slaDue(now, priority)],
  );
  await tx.query(
    `INSERT INTO state_transitions(aggregate_type, aggregate_id, from_state, to_state, actor_id, actor_type, correlation_id) VALUES ('support_case',$1,NULL,'OPEN',$2,'USER',$3)`,
    [c.id, userId, ctx.correlationId],
  );
  await emit(tx, ctx, { aggregateType: 'support_case', aggregateId: c.id, eventType: 'support.case.opened', payload: { caseId: c.id, requesterId: userId, category: c.category, priority, contextType: c.context_type, contextId: c.context_id } });
  await audit(tx, ctx, { action: 'support.case.opened', resourceType: 'support_case', resourceId: c.id, after: { category: c.category, priority }, category: 'GENERAL' });
  return c;
}

/** Requester or support staff; anyone else gets 404 (no existence leak). */
export async function loadCase(db: Db, ctx: Ctx, id: string, lock = false) {
  const c = await maybeOne(db, `SELECT * FROM support_cases WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!c) throw notFound('Support case');
  const requester = c.requester_id === ctx.actor?.userId;
  const staff = isSupportStaff(ctx);
  if (!requester && !staff) throw notFound('Support case');
  return { c, requester, staff };
}

export function presentCase(c: any, viewer: Ctx) {
  const mask = isSupportStaff(viewer) && shouldMask(viewer.actor);
  return {
    id: c.id,
    requesterId: c.requester_id,
    contactEmail: mask ? maskEmail(c.contact_email) : c.contact_email,
    category: c.category,
    subject: c.subject,
    description: c.description,
    contextType: c.context_type,
    contextId: c.context_id,
    priority: c.priority,
    status: c.status,
    assigneeId: isSupportStaff(viewer) ? c.assignee_id : undefined,
    slaDueAt: c.sla_due_at,
    slaBreached: !!c.sla_due_at && new Date(c.sla_due_at) < new Date() && !['RESOLVED', 'CLOSED'].includes(c.status),
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

export async function caseDetail(db: Db, ctx: Ctx, id: string) {
  const { c, staff } = await loadCase(db, ctx, id);
  // Internal notes are never shown to the requester.
  const events = await q(
    db,
    `SELECT id, actor_id, event_type, body, created_at FROM support_case_events WHERE case_id = $1 AND ($2 OR event_type <> 'INTERNAL_NOTE') ORDER BY created_at, id`,
    [id, staff],
  );
  return { ...presentCase(c, ctx), events };
}

export async function comment(tx: Tx, ctx: Ctx, id: string, body: string) {
  const { c, requester, staff } = await loadCase(tx, ctx, id, true);
  if (c.status === 'CLOSED') throw conflict('CASE_CLOSED', 'This case is closed; open a new case');
  const ev = await addEvent(tx, ctx, id, 'COMMENT', body);
  await tx.query(`UPDATE support_cases SET updated_at = now() WHERE id = $1`, [id]);
  if (requester && !staff && (c.status === 'PENDING_CUSTOMER' || c.status === 'RESOLVED')) {
    await supportCaseMachine.transition(tx, ctx, { table: 'support_cases', id, to: 'IN_PROGRESS', reason: 'customer replied', set: { updated_at: new Date() } });
  }
  if (staff && !requester && c.requester_id) {
    await notify(tx, ctx, { userId: c.requester_id, templateKey: 'support.case.reply', title: '고객센터 답변이 등록되었습니다', body: body.slice(0, 200), data: { caseId: id }, dedupeKey: `support.reply:${ev.id}` });
  }
  return ev;
}

export async function internalNote(tx: Tx, ctx: Ctx, id: string, body: string) {
  await loadCase(tx, ctx, id);
  if (!isSupportStaff(ctx)) throw forbidden();
  return addEvent(tx, ctx, id, 'INTERNAL_NOTE', body);
}

export async function changeStatus(tx: Tx, ctx: Ctx, id: string, to: CaseStatus, note?: string) {
  const { row, from } = await supportCaseMachine.transition(tx, ctx, { table: 'support_cases', id, to, reason: note, actorType: isSupportStaff(ctx) ? 'ADMIN' : 'USER', set: { updated_at: new Date() } });
  await addEvent(tx, ctx, id, 'STATUS_CHANGE', `${from} -> ${to}${note ? `: ${note}` : ''}`);
  await audit(tx, ctx, { action: 'support.case.status_changed', resourceType: 'support_case', resourceId: id, before: { status: from }, after: { status: to }, reason: note ?? null });
  if (to === 'RESOLVED' && row.requester_id && row.requester_id !== ctx.actor?.userId) {
    await notify(tx, ctx, { userId: row.requester_id, templateKey: 'support.case.resolved', title: '문의가 해결되었습니다', body: note ?? 'Your support case was resolved.', data: { caseId: id }, dedupeKey: `support.resolved:${id}:${ctx.correlationId}` });
  }
  await emit(tx, ctx, { aggregateType: 'support_case', aggregateId: id, eventType: 'support.case.status_changed', payload: { caseId: id, from, to } });
  return row;
}

export async function assign(tx: Tx, ctx: Ctx, id: string, assigneeId: string) {
  await loadCase(tx, ctx, id, true);
  const roles = await q<{ role: string }>(tx, `SELECT role FROM user_roles WHERE user_id = $1`, [assigneeId]);
  if (!roles.some((r) => r.role === 'SUPPORT' || r.role === 'ADMIN')) throw unprocessable('ASSIGNEE_NOT_STAFF', 'Cases can only be assigned to support staff');
  const before = await one(tx, `SELECT assignee_id, status, requester_id FROM support_cases WHERE id = $1`, [id]);
  if (before.requester_id === assigneeId) throw unprocessable('CONFLICT_OF_INTEREST', 'Staff cannot handle their own case');
  if (before.status === 'CLOSED') throw conflict('CASE_CLOSED', 'Case is closed');
  await tx.query(`UPDATE support_cases SET assignee_id = $2, updated_at = now() WHERE id = $1`, [id, assigneeId]);
  if (before.status === 'OPEN') await supportCaseMachine.transition(tx, ctx, { table: 'support_cases', id, to: 'IN_PROGRESS', from: 'OPEN', reason: 'assigned', actorType: 'ADMIN', set: { updated_at: new Date() } });
  await addEvent(tx, ctx, id, 'ASSIGNMENT', assigneeId);
  await audit(tx, ctx, { action: 'support.case.assigned', resourceType: 'support_case', resourceId: id, before: { assigneeId: before.assignee_id }, after: { assigneeId } });
  return one(tx, `SELECT * FROM support_cases WHERE id = $1`, [id]);
}

export async function setPriority(tx: Tx, ctx: Ctx, id: string, priority: Priority) {
  const { c } = await loadCase(tx, ctx, id, true);
  if (c.priority === priority) return c;
  const row = await one(tx, `UPDATE support_cases SET priority = $2, sla_due_at = $3, updated_at = now() WHERE id = $1 RETURNING *`, [id, priority, slaDue(new Date(c.created_at), priority)]);
  await audit(tx, ctx, { action: 'support.case.priority_changed', resourceType: 'support_case', resourceId: id, before: { priority: c.priority }, after: { priority } });
  return row;
}
