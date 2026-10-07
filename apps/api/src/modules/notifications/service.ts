import type { Db } from '../../platform/db.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import type { AppContext, Ctx } from '../../platform/context.js';
import { systemCtx } from '../../platform/context.js';
import { emit } from '../../platform/outbox.js';
import { notify } from '../../platform/notify.js';
import { notFound, unprocessable } from '../../platform/errors.js';
import { decodeCursor, encodeCursor } from '../../platform/http.js';
import { CHANNELS, type Channel, getRegistry } from './providers.js';

export const CATEGORIES = ['TRANSACTIONAL', 'SECURITY', 'MARKETING', 'SYSTEM'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Default per-category channel matrix (used when the user has no explicit preference row). */
export const DEFAULTS: Record<Category, Record<Channel, boolean>> = {
  SECURITY: { IN_APP: true, EMAIL: true, SMS: false, PUSH: true, KAKAO_ALIMTALK: false },
  TRANSACTIONAL: { IN_APP: true, EMAIL: true, SMS: false, PUSH: true, KAKAO_ALIMTALK: true },
  MARKETING: { IN_APP: true, EMAIL: true, SMS: false, PUSH: false, KAKAO_ALIMTALK: false },
  SYSTEM: { IN_APP: true, EMAIL: false, SMS: false, PUSH: false, KAKAO_ALIMTALK: false },
};
/** Mandatory-channel policy: these can never be disabled (critical notices ignore opt-outs). */
export const MANDATORY: Record<Category, Channel[]> = {
  SECURITY: ['IN_APP', 'EMAIL'],
  TRANSACTIONAL: ['IN_APP'],
  MARKETING: [],
  SYSTEM: ['IN_APP'],
};
export const MAX_ATTEMPTS = 5;

export const isMandatory = (category: string, channel: string) => (MANDATORY[category as Category] ?? []).includes(channel as Channel);

/** {{var}} interpolation; unknown variables render empty. Values are stringified, never evaluated. */
export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_m, key: string) => {
    const v = key.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), vars);
    return v == null ? '' : String(v);
  });
}

export async function hasMarketingConsent(db: Db, userId: string): Promise<boolean> {
  const pref = await maybeOne<{ marketing_opt_in: boolean }>(db, `SELECT marketing_opt_in FROM user_preferences WHERE user_id = $1`, [userId]);
  if (pref?.marketing_opt_in) return true;
  const c = await maybeOne<{ granted: boolean }>(
    db,
    `SELECT granted FROM consent_records WHERE user_id = $1 AND consent_type = 'MARKETING' ORDER BY created_at DESC LIMIT 1`,
    [userId],
  );
  return !!c?.granted;
}

export async function effectivePreferences(db: Db, userId: string) {
  const rows = await q<{ category: string; channel: string; enabled: boolean }>(
    db,
    `SELECT category, channel, enabled FROM notification_preferences WHERE user_id = $1`,
    [userId],
  );
  const explicit = new Map(rows.map((r) => [`${r.category}:${r.channel}`, r.enabled]));
  const items: Array<{ category: Category; channel: Channel; enabled: boolean; mandatory: boolean; explicit: boolean }> = [];
  for (const cat of CATEGORIES) {
    for (const ch of CHANNELS) {
      const mandatory = isMandatory(cat, ch);
      const e = explicit.get(`${cat}:${ch}`);
      items.push({ category: cat, channel: ch, enabled: mandatory ? true : e ?? DEFAULTS[cat][ch], mandatory, explicit: e !== undefined });
    }
  }
  return items;
}

export async function updatePreferences(db: Db, ctx: Ctx, userId: string, prefs: Array<{ category: Category; channel: Channel; enabled: boolean }>) {
  for (const p of prefs) {
    if (!p.enabled && isMandatory(p.category, p.channel)) {
      throw unprocessable('MANDATORY_CHANNEL', `${p.category} notifications cannot be disabled for ${p.channel}`, { category: p.category, channel: p.channel });
    }
  }
  for (const p of prefs) {
    await db.query(
      `INSERT INTO notification_preferences(user_id, category, channel, enabled) VALUES ($1,$2,$3,$4)
       ON CONFLICT (user_id, category, channel) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()`,
      [userId, p.category, p.channel, p.enabled],
    );
  }
  await emit(db, ctx, { aggregateType: 'user', aggregateId: userId, eventType: 'notification.preferences.updated', payload: { userId, changes: prefs } });
  return effectivePreferences(db, userId);
}

interface NotificationJoin {
  id: string;
  user_id: string;
  template_key: string;
  category: Category;
  title: string;
  body: string;
  data: Record<string, unknown>;
  email: string | null;
  phone: string | null;
  locale: string;
  display_name: string | null;
  user_status: string;
}

async function loadTemplate(db: Db, key: string, channel: Channel, locale: string) {
  return maybeOne<{ subject: string | null; body: string }>(
    db,
    `SELECT subject, body FROM notification_templates
      WHERE template_key = ANY($1::text[]) AND channel = $2 AND locale = ANY($3::text[])
      ORDER BY array_position($1::text[], template_key), array_position($3::text[], locale) LIMIT 1`,
    [[key, 'generic'], channel, [locale, 'ko-KR']],
  );
}

/**
 * Fan out one notification to channels per category rules + user preferences (outbox consumer of
 * `notification.created`). Idempotent: one notification_deliveries row per (notification, channel).
 */
export async function fanOutNotification(db: Db, ctx: Ctx, app: AppContext, notificationId: string) {
  const n = await maybeOne<NotificationJoin>(
    db,
    `SELECT n.*, u.email, u.phone, u.locale, u.display_name, u.status AS user_status
       FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.id = $1`,
    [notificationId],
  );
  if (!n) return [];
  const prefs = await effectivePreferences(db, n.user_id);
  const marketingOk = n.category === 'MARKETING' ? await hasMarketingConsent(db, n.user_id) : true;
  const registry = getRegistry(app);
  const vars = { ...n.data, title: n.title, body: n.body, displayName: n.display_name ?? '' };
  const results: Array<{ channel: Channel; status: string; reason?: string }> = [];
  for (const channel of CHANNELS) {
    const pref = prefs.find((p) => p.category === n.category && p.channel === channel)!;
    let status: 'QUEUED' | 'SENT' | 'SUPPRESSED' = channel === 'IN_APP' ? 'SENT' : 'QUEUED';
    let reason: string | undefined;
    if (n.user_status === 'DELETED' || n.user_status === 'PENDING_DELETION') {
      status = 'SUPPRESSED';
      reason = 'USER_INACTIVE';
    } else if (!marketingOk) {
      status = 'SUPPRESSED';
      reason = 'NO_MARKETING_CONSENT';
    } else if (!pref.enabled) {
      status = 'SUPPRESSED';
      reason = 'PREFERENCE_DISABLED';
    } else if (channel === 'EMAIL' && !n.email) {
      status = 'SUPPRESSED';
      reason = 'NO_ADDRESS';
    } else if ((channel === 'SMS' || channel === 'KAKAO_ALIMTALK') && !n.phone) {
      status = 'SUPPRESSED';
      reason = 'NO_ADDRESS';
    }
    const provider = channel === 'IN_APP' ? 'in_app' : registry.get(channel)?.name ?? 'none';
    if (status === 'QUEUED' && provider === 'none') {
      status = 'SUPPRESSED';
      reason = 'NO_PROVIDER';
    }
    let rendered: { subject: string | null; body: string } | null = null;
    if (status === 'QUEUED') {
      const tpl = await loadTemplate(db, n.template_key, channel, n.locale);
      rendered = tpl
        ? { subject: tpl.subject ? renderTemplate(tpl.subject, vars) : n.title, body: renderTemplate(tpl.body, vars) }
        : { subject: n.title, body: n.body };
    }
    const ins = await db.query(
      `INSERT INTO notification_deliveries(notification_id, channel, provider, status, error, rendered, sent_at)
       VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $4 = 'SENT' THEN now() END)
       ON CONFLICT (notification_id, channel) DO NOTHING`,
      [n.id, channel, provider, status, reason ?? null, rendered ? JSON.stringify(rendered) : null],
    );
    if (ins.rowCount) results.push({ channel, status, reason });
  }
  return results;
}

/**
 * Deliver QUEUED rows with a lease (claim → send outside the DB tx → record). Retries with exponential
 * backoff up to MAX_ATTEMPTS, then FAILED. Emits notification.delivered on success.
 */
export async function deliverPending(app: AppContext, limit = 50): Promise<{ sent: number; failed: number }> {
  const claimed = await withTx(app.pool, (tx) =>
    q<{ id: string; notification_id: string; channel: Channel; attempts: number; rendered: any }>(
      tx,
      `UPDATE notification_deliveries d SET next_attempt_at = now() + interval '5 minutes'
        WHERE d.id IN (SELECT id FROM notification_deliveries WHERE status = 'QUEUED' AND next_attempt_at <= now()
                        ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
        RETURNING d.id, d.notification_id, d.channel, d.attempts, d.rendered`,
      [limit],
    ),
  );
  const registry = getRegistry(app);
  let sent = 0, failed = 0;
  for (const d of claimed) {
    const n = await maybeOne<NotificationJoin>(
      app.pool,
      `SELECT n.*, u.email, u.phone, u.locale, u.display_name, u.status AS user_status FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.id = $1`,
      [d.notification_id],
    );
    const notifier = registry.get(d.channel);
    if (!n || !notifier) {
      await app.pool.query(`UPDATE notification_deliveries SET status = 'SUPPRESSED', error = 'NO_PROVIDER' WHERE id = $1`, [d.id]);
      continue;
    }
    try {
      const res = await notifier.send({
        notificationId: n.id,
        channel: d.channel,
        templateKey: n.template_key,
        category: n.category,
        to: { userId: n.user_id, email: n.email, phone: n.phone, locale: n.locale },
        subject: d.rendered?.subject ?? n.title,
        body: d.rendered?.body ?? n.body,
        data: n.data ?? {},
      });
      await withTx(app.pool, async (tx) => {
        await tx.query(
          `UPDATE notification_deliveries SET status = 'SENT', provider = $2, provider_ref = $3, attempts = attempts + 1, sent_at = now(), error = NULL WHERE id = $1`,
          [d.id, notifier.name, res.providerRef ?? null],
        );
        await emit(tx, systemCtx(app, `notify-${d.id}`), {
          aggregateType: 'notification',
          aggregateId: n.id,
          eventType: 'notification.delivered',
          payload: { notificationId: n.id, deliveryId: d.id, channel: d.channel, provider: notifier.name },
        });
      });
      sent++;
    } catch (err: any) {
      const attempts = d.attempts + 1;
      const final = attempts >= MAX_ATTEMPTS;
      await app.pool.query(
        `UPDATE notification_deliveries SET attempts = $2, error = $3, status = CASE WHEN $4 THEN 'FAILED' ELSE 'QUEUED' END,
                next_attempt_at = now() + make_interval(secs => $5) WHERE id = $1`,
        [d.id, attempts, String(err?.message ?? err).slice(0, 300), final, Math.min(30 * 2 ** attempts, 6 * 3600)],
      );
      failed++;
    }
  }
  return { sent, failed };
}

/** In-app message notification (coalesced per conversation per hour). */
export async function notifyMessageRecipients(db: Db, ctx: Ctx, ev: { messageId: string; conversationId: string; senderId: string | null; type: string }) {
  if (!ev.senderId || ev.type === 'SYSTEM') return;
  const sender = await maybeOne<{ display_name: string | null }>(db, `SELECT display_name FROM users WHERE id = $1`, [ev.senderId]);
  const members = await q<{ user_id: string; muted: boolean }>(
    db,
    `SELECT user_id, muted FROM conversation_members WHERE conversation_id = $1 AND user_id <> $2`,
    [ev.conversationId, ev.senderId],
  );
  const bucket = new Date().toISOString().slice(0, 13);
  for (const m of members) {
    if (m.muted) continue;
    await notify(db, ctx, {
      userId: m.user_id,
      templateKey: 'message.received',
      category: 'TRANSACTIONAL',
      title: '새 메시지 / New message',
      body: `${sender?.display_name ?? 'JETPOOL'}님이 메시지를 보냈습니다.`,
      data: { conversationId: ev.conversationId, senderName: sender?.display_name ?? '' },
      dedupeKey: `msg:${ev.conversationId}:${m.user_id}:${bucket}`,
    });
  }
}

// ---------------------------------------------------------------- inbox

export async function listNotifications(db: Db, userId: string, opts: { unread?: boolean; limit: number; cursor?: string }) {
  const c = decodeCursor(opts.cursor);
  const marketingOk = await hasMarketingConsent(db, userId);
  const rows = await q(
    db,
    `SELECT n.id, n.template_key, n.category, n.title, n.body, n.data, n.read_at, n.created_at
       FROM notifications n
      WHERE n.user_id = $1 AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL)
        AND ($3::boolean OR n.category <> 'MARKETING')
        AND NOT EXISTS (SELECT 1 FROM notification_deliveries d WHERE d.notification_id = n.id AND d.channel = 'IN_APP' AND d.status = 'SUPPRESSED')
        AND ($4::timestamptz IS NULL OR (date_trunc('milliseconds', n.created_at), n.id) < ($4::timestamptz, $5::uuid))
      ORDER BY date_trunc('milliseconds', n.created_at) DESC, n.id DESC LIMIT $6`,
    [userId, opts.unread ?? false, marketingOk, c?.createdAt ?? null, c?.id ?? null, opts.limit + 1],
  );
  const unread = await one<{ n: number }>(
    db,
    `SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL AND ($2::boolean OR category <> 'MARKETING')`,
    [userId, marketingOk],
  );
  const items = rows.slice(0, opts.limit);
  return {
    items: items.map((r) => ({ id: r.id, templateKey: r.template_key, category: r.category, title: r.title, body: r.body, data: r.data, readAt: r.read_at, createdAt: r.created_at })),
    nextCursor: rows.length > opts.limit ? encodeCursor(items[items.length - 1]) : null,
    unreadCount: unread.n,
  };
}

export async function markNotificationRead(db: Db, userId: string, id: string) {
  const row = await maybeOne(db, `UPDATE notifications SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id, read_at`, [id, userId]);
  if (!row) throw notFound('Notification');
  return { id: row.id, readAt: row.read_at };
}

export async function markAllRead(db: Db, userId: string) {
  const r = await db.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [userId]);
  return { updated: r.rowCount ?? 0 };
}
