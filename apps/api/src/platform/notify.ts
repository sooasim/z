import type { Db } from './db.js';
import type { Ctx } from './context.js';
import { emit } from './outbox.js';

export type NotificationCategory = 'TRANSACTIONAL' | 'SECURITY' | 'MARKETING' | 'SYSTEM';

/**
 * Create an in-app notification in the caller's tx and emit `notification.created` so the
 * notifications module can fan out to email/SMS/push per user preferences (COMMS-02).
 * dedupeKey makes repeated triggers (event replays) idempotent.
 */
export async function notify(
  db: Db,
  ctx: Pick<Ctx, 'correlationId'>,
  n: { userId: string; templateKey: string; title: string; body: string; data?: Record<string, unknown>; dedupeKey?: string; category?: NotificationCategory },
): Promise<string | null> {
  const res = await db.query(
    `INSERT INTO notifications(user_id, template_key, category, title, body, data, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (user_id, dedupe_key) DO NOTHING RETURNING id`,
    [n.userId, n.templateKey, n.category ?? 'TRANSACTIONAL', n.title, n.body, JSON.stringify(n.data ?? {}), n.dedupeKey ?? null],
  );
  const id = res.rows[0]?.id ?? null;
  if (id) {
    await emit(db, ctx, {
      aggregateType: 'notification',
      aggregateId: id,
      eventType: 'notification.created',
      payload: { notificationId: id, userId: n.userId, templateKey: n.templateKey, category: n.category ?? 'TRANSACTIONAL' },
    });
  }
  return id;
}
