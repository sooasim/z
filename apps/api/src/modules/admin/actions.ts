import type { Db } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { emit } from '../../platform/outbox.js';

/**
 * OPS-02 contract: every staff/admin console mutation emits `admin.action.performed` in the SAME transaction
 * as the change (transactional outbox). The payload is an operations trail only: ids, action names and
 * non-sensitive details — never contact data, secrets or message bodies.
 */
export async function recordAdminAction(
  db: Db,
  ctx: Ctx,
  a: { action: string; resourceType: string; resourceId?: string | null; reason?: string | null; details?: Record<string, unknown> },
): Promise<string> {
  return emit(db, ctx, {
    aggregateType: 'admin_action',
    aggregateId: a.resourceId ?? ctx.actor?.userId ?? 'system',
    eventType: 'admin.action.performed',
    payload: {
      action: a.action,
      resourceType: a.resourceType,
      resourceId: a.resourceId ?? null,
      actorId: ctx.actor?.userId ?? null,
      actorRoles: ctx.actor?.roles ?? [],
      reason: a.reason ?? null,
      ...(a.details ?? {}),
    },
  });
}
