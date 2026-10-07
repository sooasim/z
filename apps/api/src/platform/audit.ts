import type { Db } from './db.js';
import type { Ctx } from './context.js';

export type AuditCategory = 'GENERAL' | 'MONEY' | 'PERMISSION' | 'COMPLIANCE' | 'ELEVATED_ACCESS' | 'PRIVACY' | 'SECURITY' | 'CONTENT';

/** Append-only audit record. Never put secrets, tokens, PAN or raw documents in before/after. */
export async function audit(
  db: Db,
  ctx: Ctx,
  e: {
    action: string;
    resourceType: string;
    resourceId?: string | null;
    before?: unknown;
    after?: unknown;
    reason?: string | null;
    category?: AuditCategory;
    actorId?: string | null;
  },
) {
  await db.query(
    `INSERT INTO audit_logs(actor_id, actor_roles, action, resource_type, resource_id, before_state, after_state, reason, correlation_id, ip, user_agent, category)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      e.actorId !== undefined ? e.actorId : ctx.actor?.userId ?? null,
      ctx.actor?.roles ?? [],
      e.action,
      e.resourceType,
      e.resourceId ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.reason ?? null,
      ctx.correlationId,
      ctx.ip ?? null,
      ctx.userAgent ?? null,
      e.category ?? 'GENERAL',
    ],
  );
}
