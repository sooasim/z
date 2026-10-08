import type pg from 'pg';
import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import type { AppContext, Ctx } from '../../platform/context.js';
import { systemCtx } from '../../platform/context.js';
import { StateMachine } from '../../platform/fsm.js';
import { emit } from '../../platform/outbox.js';
import { audit } from '../../platform/audit.js';
import { notify } from '../../platform/notify.js';
import { hasRole } from '../../platform/auth.js';
import { conflict, forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { resolveContextParties, type ContextType } from '../disputes/parties.js';
import { maskEmail, maskPhone } from '../roles/service.js';
import { supportDeskOf, type SupportDesk } from './desk.js';

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

export const LINK_TYPES = ['RESERVATION', 'EXCHANGE', 'GUIDE_BOOKING', 'ORDER', 'DISPUTE', 'PAYMENT', 'USER', 'CONVERSATION'] as const;
export type LinkType = (typeof LINK_TYPES)[number];
/** Existence check table per link type (constant SQL identifiers selected by enum). */
const LINK_TABLES: Record<LinkType, string> = {
  RESERVATION: 'reservations',
  EXCHANGE: 'exchange_requests',
  GUIDE_BOOKING: 'guide_bookings',
  ORDER: 'orders',
  DISPUTE: 'disputes',
  PAYMENT: 'payments',
  USER: 'users',
  CONVERSATION: 'conversations',
};

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
  } else if (contextType === 'ACCOUNT') {
    if (contextId !== userId) throw forbidden('NOT_A_PARTY', 'You can only open cases about your own account');
  }
}

/** The link auto-created from a requester's (already party-verified) context. OTHER has none. */
function contextLink(userId: string, contextType?: string, contextId?: string): { type: LinkType; id: string } | null {
  if (contextType === 'ACCOUNT') return { type: 'USER', id: userId };
  if (!contextType || !contextId) return null;
  return (LINK_TYPES as readonly string[]).includes(contextType) ? { type: contextType as LinkType, id: contextId } : null;
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
  const link = contextLink(userId, input.contextType, input.contextId);
  if (link) {
    await tx.query(`INSERT INTO support_case_links(case_id, link_type, link_id, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [c.id, link.type, link.id, userId]);
  }
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

/**
 * OPS-01 masking: support staff see requester contact data masked unless they hold the ADMIN role or an active,
 * case-scoped elevated grant (detail view only). Requesters always see their own data.
 */
export function contactMasked(c: any, viewer: Ctx, opts: { elevated?: boolean } = {}) {
  if (!isSupportStaff(viewer) || c.requester_id === viewer.actor?.userId) return false;
  return !hasRole(viewer.actor, 'ADMIN') && !opts.elevated;
}

export function presentCase(c: any, viewer: Ctx, opts: { elevated?: boolean } = {}) {
  const mask = contactMasked(c, viewer, opts);
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
    externalRef: isSupportStaff(viewer) ? c.external_ref ?? null : undefined,
    slaDueAt: c.sla_due_at,
    slaBreached: !!c.sla_due_at && new Date(c.sla_due_at) < new Date() && !['RESOLVED', 'CLOSED'].includes(c.status),
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

/** Active (unexpired, unrevoked) elevated grant of `adminId` scoped to this support case (read-only check). */
export async function activeCaseGrant(db: Db, adminId: string, caseId: string) {
  return maybeOne<{ id: string; reason: string; expires_at: Date }>(
    db,
    `SELECT id, reason, expires_at FROM elevated_access_grants
      WHERE admin_id = $1 AND case_type = 'SUPPORT_CASE' AND case_id = $2 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY expires_at DESC LIMIT 1`,
    [adminId, caseId],
  );
}

export async function caseDetail(db: Db, ctx: Ctx, id: string) {
  const { c, staff, requester } = await loadCase(db, ctx, id);
  let elevated = false;
  if (staff && !requester && !hasRole(ctx.actor, 'ADMIN')) {
    const g = await activeCaseGrant(db, ctx.actor!.userId, id);
    if (g) {
      elevated = true;
      // every elevated read of masked data is audited (invariant 10 / OPS-01)
      await audit(db, ctx, { action: 'support.case.contact_viewed', resourceType: 'support_case', resourceId: id, after: { grantId: g.id }, reason: g.reason, category: 'ELEVATED_ACCESS' });
    }
  }
  const mask = contactMasked(c, ctx, { elevated });
  const phone = c.requester_id ? (await maybeOne<{ phone: string | null }>(db, `SELECT phone FROM users WHERE id = $1`, [c.requester_id]))?.phone ?? null : null;
  // Internal notes are never shown to the requester.
  const events = await q(
    db,
    `SELECT id, actor_id, event_type, body, created_at FROM support_case_events WHERE case_id = $1 AND ($2 OR event_type <> 'INTERNAL_NOTE') ORDER BY created_at, id`,
    [id, staff],
  );
  return {
    ...presentCase(c, ctx, { elevated }),
    contactPhone: mask ? maskPhone(phone) : phone,
    contactMasked: mask,
    events,
    // staff-added context links may reference other people's records: staff only
    links: staff ? await listLinks(db, id, c.requester_id) : undefined,
  };
}

// ---------------------------------------------------------------- context links (support_case_links)

const toLinkDto = (r: any, requesterId: string | null) => ({
  linkType: r.link_type,
  linkId: r.link_id,
  createdBy: r.created_by,
  source: r.created_by && r.created_by === requesterId ? 'REQUESTER' : 'STAFF',
  createdAt: r.created_at,
});

export async function listLinks(db: Db, caseId: string, requesterId: string | null) {
  const rows = await q(db, `SELECT * FROM support_case_links WHERE case_id = $1 ORDER BY created_at, link_type, link_id`, [caseId]);
  return rows.map((r) => toLinkDto(r, requesterId));
}

/** Staff links a context record to a case (idempotent). The target must exist. */
export async function linkCase(tx: Tx, ctx: Ctx, caseId: string, link: { linkType: LinkType; linkId: string }) {
  const { c } = await loadCase(tx, ctx, caseId, true);
  if (!isSupportStaff(ctx)) throw forbidden();
  if (c.status === 'CLOSED') throw conflict('CASE_CLOSED', 'Case is closed');
  const target = await maybeOne(tx, `SELECT 1 FROM ${LINK_TABLES[link.linkType]} WHERE id = $1`, [link.linkId]);
  if (!target) throw notFound(link.linkType.toLowerCase().replace('_', ' '));
  const row = await maybeOne(
    tx,
    `INSERT INTO support_case_links(case_id, link_type, link_id, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING *`,
    [caseId, link.linkType, link.linkId, ctx.actor!.userId],
  );
  if (!row) {
    const existing = await one(tx, `SELECT * FROM support_case_links WHERE case_id = $1 AND link_type = $2 AND link_id = $3`, [caseId, link.linkType, link.linkId]);
    return { created: false, item: toLinkDto(existing, c.requester_id) };
  }
  await tx.query(`UPDATE support_cases SET updated_at = now() WHERE id = $1`, [caseId]);
  await audit(tx, ctx, { action: 'support.case.linked', resourceType: 'support_case', resourceId: caseId, after: { linkType: link.linkType, linkId: link.linkId } });
  return { created: true, item: toLinkDto(row, c.requester_id) };
}

export async function unlinkCase(tx: Tx, ctx: Ctx, caseId: string, link: { linkType: LinkType; linkId: string }) {
  const { c } = await loadCase(tx, ctx, caseId, true);
  if (!isSupportStaff(ctx)) throw forbidden();
  if (c.status === 'CLOSED') throw conflict('CASE_CLOSED', 'Case is closed');
  const row = await maybeOne(tx, `DELETE FROM support_case_links WHERE case_id = $1 AND link_type = $2 AND link_id = $3 RETURNING *`, [caseId, link.linkType, link.linkId]);
  if (!row) throw notFound('Case link');
  await tx.query(`UPDATE support_cases SET updated_at = now() WHERE id = $1`, [caseId]);
  await audit(tx, ctx, { action: 'support.case.unlinked', resourceType: 'support_case', resourceId: caseId, before: { linkType: row.link_type, linkId: row.link_id, createdBy: row.created_by } });
  return toLinkDto(row, c.requester_id);
}

// ---------------------------------------------------------------- external desk (Chatwoot) sync
//
// The desk is called OUTSIDE any database transaction: the outbox consumer of `support.case.opened` only marks the
// case as due (no network I/O inside the dispatch transaction, which holds the whole event batch), and the
// `support.desk-sync` job claims due cases with a short lease (SKIP LOCKED), calls the desk without holding locks,
// and stores external_ref with a compare-and-set. Desk adapters look up an existing conversation for the case
// before creating one, so a retry after a lost response does not duplicate it.

export const DESK_SYNC_LEASE_SEC = 120;
export const DESK_SYNC_MAX_ATTEMPTS = 8;

/** Outbox consumer: mark the case for mirroring (no-op desk → nothing to do). */
export async function markCaseForDeskSync(tx: Tx, ctx: Ctx, caseId: string, desk: SupportDesk = supportDeskOf(ctx.app)) {
  if (desk.name === 'noop') return false;
  const r = await tx.query(`UPDATE support_cases SET desk_sync_due_at = now() WHERE id = $1 AND external_ref IS NULL AND desk_sync_due_at IS NULL`, [caseId]);
  return (r.rowCount ?? 0) > 0;
}

const isPool = (db: Db): db is pg.Pool => typeof (db as pg.PoolClient).release !== 'function';

/**
 * Mirror one case into the desk and store `external_ref`. Must not be called while holding a lock on the case:
 * the desk call happens without a row lock; the store is a compare-and-set (`external_ref IS NULL`).
 * Idempotent: a case that already has an external_ref is skipped. Desk failures throw (the job retries).
 */
export async function syncCaseToDesk(db: Db, ctx: Ctx, caseId: string, desk: SupportDesk = supportDeskOf(ctx.app)) {
  const c = await maybeOne(db, `SELECT * FROM support_cases WHERE id = $1`, [caseId]);
  if (!c || c.external_ref) return { externalRef: c?.external_ref ?? null, skipped: true };
  const res = await desk.createConversation({
    id: c.id,
    requesterId: c.requester_id,
    category: c.category,
    subject: c.subject,
    description: c.description,
    priority: c.priority,
    contextType: c.context_type,
    contextId: c.context_id,
  });
  if (!res) return { externalRef: null, skipped: true };
  const store = async (tx: Db) => {
    const upd = await maybeOne<{ external_ref: string }>(
      tx,
      `UPDATE support_cases SET external_ref = $2, desk_sync_due_at = NULL, desk_sync_error = NULL WHERE id = $1 AND external_ref IS NULL RETURNING external_ref`,
      [caseId, res.externalRef],
    );
    if (upd) await audit(tx, ctx, { action: 'support.case.desk_linked', resourceType: 'support_case', resourceId: caseId, after: { desk: desk.name, externalRef: res.externalRef } });
    return !!upd;
  };
  const stored = isPool(db) ? await withTx(db, (tx) => store(tx)) : await store(db);
  if (!stored) {
    const cur = await maybeOne<{ external_ref: string | null }>(db, `SELECT external_ref FROM support_cases WHERE id = $1`, [caseId]);
    return { externalRef: cur?.external_ref ?? null, skipped: true };
  }
  return { externalRef: res.externalRef, skipped: false };
}

/** Job: claim due cases (lease), mirror each outside any transaction, back off on failure. Returns cases linked. */
export async function runDeskSync(app: AppContext, limit = 20): Promise<number> {
  const desk = supportDeskOf(app);
  if (desk.name === 'noop') return 0;
  const claimed = await withTx(app.pool, (tx) =>
    q<{ id: string; desk_sync_attempts: number }>(
      tx,
      `UPDATE support_cases SET desk_sync_due_at = now() + make_interval(secs => $2), desk_sync_attempts = desk_sync_attempts + 1
        WHERE id IN (SELECT id FROM support_cases WHERE desk_sync_due_at <= now() AND external_ref IS NULL ORDER BY desk_sync_due_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING id, desk_sync_attempts`,
      [limit, DESK_SYNC_LEASE_SEC],
    ),
  );
  let linked = 0;
  for (const c of claimed) {
    try {
      const r = await syncCaseToDesk(app.pool, systemCtx(app, `desk-sync-${c.id}`), c.id, desk);
      if (!r.skipped) linked++;
      else await app.pool.query(`UPDATE support_cases SET desk_sync_due_at = NULL WHERE id = $1`, [c.id]);
    } catch (err: any) {
      // never store or log the desk token / request body: adapter errors carry method, path and status only
      const reason = String(err?.message ?? err).slice(0, 500);
      await app.pool.query(
        `UPDATE support_cases SET desk_sync_error = $2,
                desk_sync_due_at = CASE WHEN desk_sync_attempts >= $3 THEN NULL ELSE now() + make_interval(secs => least(power(2, desk_sync_attempts), 3600)) END
          WHERE id = $1 AND external_ref IS NULL`,
        [c.id, reason, DESK_SYNC_MAX_ATTEMPTS],
      );
      app.log.warn({ caseId: c.id, attempts: c.desk_sync_attempts, reason }, 'support desk sync failed');
    }
  }
  return linked;
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
