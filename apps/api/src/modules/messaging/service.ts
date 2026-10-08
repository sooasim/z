import type { Db } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { AppContext, Ctx } from '../../platform/context.js';
import { emit } from '../../platform/outbox.js';
import { badRequest, conflict, notFound, unprocessable } from '../../platform/errors.js';
import { assertElevatedAccess } from '../disputes/service.js';
import { decodeCursor, encodeCursor } from '../../platform/http.js';

/** COMMS-01: context-bound P2P messaging. Postgres is the source of truth; realtime is a delivery aid (invariant 1). */

export const CONTEXT_TYPES = ['RESERVATION', 'EXCHANGE', 'GUIDE_REQUEST', 'GUIDE_BOOKING', 'ORDER', 'INQUIRY', 'SUPPORT'] as const;
export type ContextType = (typeof CONTEXT_TYPES)[number];
export const MEMBER_ROLES = ['GUEST', 'HOST', 'REQUESTER', 'RESPONDER', 'TRAVELER', 'GUIDE', 'BUYER', 'SUPPLIER', 'SUPPORT', 'MEMBER'] as const;
export const MAX_BODY_LENGTH = 4000;
export const NOTIFY_CHANNEL = 'jetpool_messages';

export interface MessageRow {
  id: string;
  conversation_id: string;
  sender_id: string | null;
  type: 'TEXT' | 'IMAGE' | 'SYSTEM' | 'OFFER_REF';
  body: string | null;
  media_id: string | null;
  client_message_id: string | null;
  redacted_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

const lockKey = (contextType: string, contextId: string) => `conversation:${contextType}:${contextId}`;

/**
 * Cross-module contract (booking, exchange, guide, travel): returns the conversation for a context, creating it
 * if needed, and adds any missing members. Idempotent by (contextType, contextId); for INQUIRY (many per
 * context) it is idempotent by (contextType, contextId, exact member set).
 */
export async function ensureConversation(
  db: Db,
  ctx: Ctx,
  args: { contextType: string; contextId: string; members: Array<{ userId: string; role: string }> },
): Promise<string> {
  if (!(CONTEXT_TYPES as readonly string[]).includes(args.contextType)) throw badRequest('INVALID_CONTEXT_TYPE', `Unknown context type ${args.contextType}`);
  for (const m of args.members) {
    if (!(MEMBER_ROLES as readonly string[]).includes(m.role)) throw badRequest('INVALID_MEMBER_ROLE', `Unknown member role ${m.role}`);
  }
  // serialize concurrent creators of the same context (no-op outside a transaction, the unique index still holds)
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [lockKey(args.contextType, args.contextId)]);
  const userIds = [...new Set(args.members.map((m) => m.userId))];
  let conv: { id: string } | null;
  if (args.contextType === 'INQUIRY') {
    conv = await maybeOne<{ id: string }>(
      db,
      `SELECT c.id FROM conversations c
        WHERE c.context_type = 'INQUIRY' AND c.context_id = $1
          AND (SELECT count(*) FROM conversation_members m WHERE m.conversation_id = c.id AND m.user_id = ANY($2::uuid[])) = $3
          AND (SELECT count(*) FROM conversation_members m WHERE m.conversation_id = c.id) = $3
        ORDER BY c.created_at LIMIT 1`,
      [args.contextId, userIds, userIds.length],
    );
  } else {
    conv = await maybeOne<{ id: string }>(db, `SELECT id FROM conversations WHERE context_type = $1 AND context_id = $2`, [args.contextType, args.contextId]);
  }
  let created = false;
  if (!conv) {
    const createdBy = ctx.actor?.userId ?? null;
    if (args.contextType === 'INQUIRY') {
      conv = await one<{ id: string }>(db, `INSERT INTO conversations(context_type, context_id, created_by) VALUES ('INQUIRY',$1,$2) RETURNING id`, [args.contextId, createdBy]);
      created = true;
    } else {
      const ins = await maybeOne<{ id: string }>(
        db,
        `INSERT INTO conversations(context_type, context_id, created_by) VALUES ($1,$2,$3)
         ON CONFLICT (context_type, context_id) WHERE context_id IS NOT NULL AND context_type <> 'INQUIRY' DO NOTHING RETURNING id`,
        [args.contextType, args.contextId, createdBy],
      );
      created = !!ins;
      conv = ins ?? (await one<{ id: string }>(db, `SELECT id FROM conversations WHERE context_type = $1 AND context_id = $2`, [args.contextType, args.contextId]));
    }
  }
  for (const m of args.members) {
    await db.query(`INSERT INTO conversation_members(conversation_id, user_id, role) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [conv.id, m.userId, m.role]);
  }
  if (created) {
    await emit(db, ctx, {
      aggregateType: 'conversation',
      aggregateId: conv.id,
      eventType: 'conversation.created',
      payload: { conversationId: conv.id, contextType: args.contextType, contextId: args.contextId, memberIds: userIds },
    });
  }
  return conv.id;
}

/** System message (booking confirmed, offer updated ...) — no sender, never masked. */
export async function postSystemMessage(db: Db, ctx: Ctx, conversationId: string, body: string): Promise<MessageRow> {
  const conv = await maybeOne(db, `SELECT id FROM conversations WHERE id = $1`, [conversationId]);
  if (!conv) throw notFound('Conversation');
  const msg = await one<MessageRow>(
    db,
    `INSERT INTO messages(conversation_id, sender_id, type, body) VALUES ($1, NULL, 'SYSTEM', $2) RETURNING *`,
    [conversationId, body.slice(0, MAX_BODY_LENGTH)],
  );
  await afterInsert(db, ctx, msg);
  return msg;
}

async function afterInsert(db: Db, ctx: Ctx, msg: MessageRow) {
  // monotonic: concurrent senders may commit out of order, the newest timestamp must win
  // (the row's own created_at, not the JS Date copy: keeps microsecond precision)
  await db.query(
    `UPDATE conversations SET last_message_at = greatest(coalesce(last_message_at, '-infinity'), (SELECT created_at FROM messages WHERE id = $2)) WHERE id = $1`,
    [msg.conversation_id, msg.id],
  );
  const payload = { messageId: msg.id, conversationId: msg.conversation_id, senderId: msg.sender_id, type: msg.type };
  // message.created is the AsyncAPI contract name; message.sent is kept for consumers wired to the build brief.
  await emit(db, ctx, { aggregateType: 'conversation', aggregateId: msg.conversation_id, eventType: 'message.created', payload });
  await emit(db, ctx, { aggregateType: 'conversation', aggregateId: msg.conversation_id, eventType: 'message.sent', payload });
  // multi-instance realtime bridge: delivered by Postgres only after COMMIT (ids only; consumers re-read the row)
  await db.query(`SELECT pg_notify($1, $2)`, [NOTIFY_CHANNEL, JSON.stringify({ messageId: msg.id, conversationId: msg.conversation_id })]);
}

// ---------------------------------------------------------------- contact-info leakage

const EMAIL_RE = /[A-Z0-9._%+-]+\s*(?:@|\(at\)|\[at\]| at )\s*[A-Z0-9.-]+\s*(?:\.|\(dot\)| dot )\s*[A-Z]{2,}/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|\b[a-z0-9-]+\.(?:com|net|org|kr|co\.kr|io|me|ly|gl|app|link)(?:\/[^\s]*)?\b/gi;
// Korean mobile/landline and international numbers, tolerant of separators: 010-1234-5678, 010 1234 5678, +82 10 1234 5678
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?0?\d{1,3}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}\b/g;
const KAKAO_RE = /(?:카카오\s*톡?|카톡|kakao(?:talk)?|라인|line|텔레그램|telegram|whatsapp|위챗|wechat)\s*(?:id|아이디)?\s*[:：]?\s*[A-Za-z0-9._-]{3,}/gi;

export interface MaskResult { body: string; masked: boolean; kinds: string[] }

/** Mask phone/email/URL/messenger-id patterns. Pure; exported for tests and other modules. */
export function maskContactInfo(text: string): MaskResult {
  const kinds = new Set<string>();
  let out = text.replace(EMAIL_RE, () => {
    kinds.add('EMAIL');
    return '[연락처 비공개]';
  });
  out = out.replace(URL_RE, () => {
    kinds.add('URL');
    return '[링크 비공개]';
  });
  out = out.replace(KAKAO_RE, () => {
    kinds.add('MESSENGER_ID');
    return '[연락처 비공개]';
  });
  out = out.replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 9) return m; // prices, dates, small numbers
    kinds.add('PHONE');
    return '[연락처 비공개]';
  });
  return { body: out, masked: kinds.size > 0, kinds: [...kinds].sort() };
}

export const CONTACT_MASK_NOTICE =
  '안전한 거래를 위해 예약 확정 전에는 연락처·외부 링크가 가려집니다. (Contact details and links are hidden until the booking is confirmed.)';

/** Contact details may be shared only once the conversation's transaction context is confirmed. */
export async function isConfirmedContext(db: Db, contextType: string, contextId: string | null): Promise<boolean> {
  if (!contextId) return false;
  const sql: Record<string, string> = {
    RESERVATION: `SELECT 1 FROM reservations WHERE id = $1 AND status IN ('CONFIRMED','CHECKED_IN','COMPLETED')`,
    EXCHANGE: `SELECT 1 FROM exchange_requests WHERE id = $1 AND status IN ('CONFIRMED','IN_PROGRESS','COMPLETED','REVIEWED')`,
    GUIDE_BOOKING: `SELECT 1 FROM guide_bookings WHERE id = $1 AND status IN ('CONFIRMED','IN_PROGRESS','COMPLETED','REVIEWED')`,
    ORDER: `SELECT 1 FROM orders WHERE id = $1 AND status IN ('PAID','FULFILLED')`,
  };
  if (contextType === 'SUPPORT') return true;
  const s = sql[contextType];
  if (!s) return false;
  return (await q(db, s, [contextId])).length > 0;
}

// ---------------------------------------------------------------- membership

export async function getMembership(db: Db, conversationId: string, userId: string) {
  return maybeOne<{ role: string; last_read_at: string | null }>(
    db,
    `SELECT role, last_read_at FROM conversation_members WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, userId],
  );
}

/** Non-members get 404 (do not reveal existence). Staff are NOT members by role — see readAsStaff. */
export async function assertMember(db: Db, conversationId: string, userId: string) {
  const m = await getMembership(db, conversationId, userId);
  if (!m) throw notFound('Conversation');
  return m;
}

// ---------------------------------------------------------------- queries

export async function listMyConversations(db: Db, userId: string, opts: { limit: number; cursor?: string }) {
  const c = decodeCursor(opts.cursor);
  const rows = await q(
    db,
    `SELECT c.id, c.context_type, c.context_id, c.status, c.created_at, c.last_message_at,
            coalesce(c.last_message_at, c.created_at) AS sort_at,
            me.role AS my_role, me.last_read_at, me.muted,
            (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id AND m.created_at > coalesce(me.last_read_at, '-infinity')
                 AND m.sender_id IS DISTINCT FROM $1) AS unread_count,
            (SELECT json_build_object('id', m.id, 'senderId', m.sender_id, 'type', m.type,
                      'body', CASE WHEN m.redacted_at IS NULL THEN left(m.body, 200) END, 'createdAt', m.created_at)
               FROM messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
            (SELECT json_agg(json_build_object('userId', u.id, 'role', om.role, 'displayName', u.display_name))
               FROM conversation_members om JOIN users u ON u.id = om.user_id WHERE om.conversation_id = c.id) AS members
       FROM conversation_members me JOIN conversations c ON c.id = me.conversation_id
      WHERE me.user_id = $1 AND c.status <> 'ARCHIVED'
        AND ($2::timestamptz IS NULL OR (date_trunc('milliseconds', coalesce(c.last_message_at, c.created_at)), c.id) < ($2::timestamptz, $3::uuid))
      ORDER BY date_trunc('milliseconds', coalesce(c.last_message_at, c.created_at)) DESC, c.id DESC LIMIT $4`,
    [userId, c?.createdAt ?? null, c?.id ?? null, opts.limit + 1],
  );
  const items = rows.slice(0, opts.limit).map((r) => ({
    id: r.id,
    contextType: r.context_type,
    contextId: r.context_id,
    status: r.status,
    myRole: r.my_role,
    muted: r.muted,
    unreadCount: r.unread_count,
    lastMessage: r.last_message,
    lastMessageAt: r.last_message_at,
    members: r.members ?? [],
    createdAt: r.created_at,
  }));
  const last = rows.length > opts.limit ? rows[opts.limit - 1] : null;
  return { items, nextCursor: last ? encodeCursor({ created_at: last.sort_at, id: last.id }) : null };
}

export function toMessageDto(m: MessageRow) {
  return {
    id: m.id,
    conversationId: m.conversation_id,
    senderId: m.sender_id,
    type: m.type,
    body: m.redacted_at ? null : m.body,
    mediaId: m.redacted_at ? null : m.media_id,
    clientMessageId: m.client_message_id,
    redacted: !!m.redacted_at,
    metadata: m.metadata ?? {},
    createdAt: m.created_at,
  };
}

/** Keyset pagination, newest first. Caller must have checked access. */
export async function pageMessages(db: Db, conversationId: string, opts: { limit: number; cursor?: string }) {
  const c = decodeCursor(opts.cursor);
  const rows = await q<MessageRow>(
    db,
    `SELECT * FROM messages WHERE conversation_id = $1
        AND ($2::timestamptz IS NULL OR (date_trunc('milliseconds', created_at), id) < ($2::timestamptz, $3::uuid))
      ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC LIMIT $4`,
    [conversationId, c?.createdAt ?? null, c?.id ?? null, opts.limit + 1],
  );
  const items = rows.slice(0, opts.limit);
  return { items: items.map(toMessageDto), nextCursor: rows.length > opts.limit ? encodeCursor(items[items.length - 1]) : null };
}

export async function listMessagesAsMember(db: Db, conversationId: string, userId: string, opts: { limit: number; cursor?: string }) {
  await assertMember(db, conversationId, userId);
  return pageMessages(db, conversationId, opts);
}

// ---------------------------------------------------------------- commands

export async function sendMessage(
  db: Db,
  ctx: Ctx,
  args: { conversationId: string; senderId: string; body: string; clientMessageId?: string | null; mediaId?: string | null },
): Promise<{ message: MessageRow; created: boolean }> {
  const body = args.body.trim();
  if (!body && !args.mediaId) throw badRequest('EMPTY_MESSAGE', 'Message body is required');
  if (body.length > MAX_BODY_LENGTH) throw badRequest('MESSAGE_TOO_LONG', `Message body must be at most ${MAX_BODY_LENGTH} characters`);
  await assertMember(db, args.conversationId, args.senderId);
  const conv = await one<{ status: string; context_type: string; context_id: string | null }>(
    db,
    // FOR NO KEY UPDATE, the mode afterInsert's `UPDATE conversations` needs anyway: senders queue per conversation.
    // (FOR SHARE here deadlocked two concurrent senders upgrading their shared locks — 40P01 → 500.)
    `SELECT status, context_type, context_id FROM conversations WHERE id = $1 FOR NO KEY UPDATE`,
    [args.conversationId],
  );
  if (conv.status !== 'OPEN') throw conflict('CONVERSATION_LOCKED', 'This conversation no longer accepts messages');

  if (args.clientMessageId) {
    const existing = await maybeOne<MessageRow>(
      db,
      `SELECT * FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND client_message_id = $3`,
      [args.conversationId, args.senderId, args.clientMessageId],
    );
    if (existing) return { message: existing, created: false };
  }
  if (args.mediaId) {
    const media = await maybeOne(db, `SELECT 1 FROM media_assets WHERE id = $1 AND owner_id = $2 AND status <> 'DELETED'`, [args.mediaId, args.senderId]);
    if (!media) throw unprocessable('MEDIA_NOT_FOUND', 'Attachment not found');
  }

  let finalBody = body;
  const metadata: Record<string, unknown> = {};
  if (!(await isConfirmedContext(db, conv.context_type, conv.context_id))) {
    const m = maskContactInfo(body);
    if (m.masked) {
      finalBody = m.body;
      metadata.contactInfoMasked = true;
      metadata.maskedKinds = m.kinds;
      metadata.notice = CONTACT_MASK_NOTICE;
    }
  }
  const ins = await maybeOne<MessageRow>(
    db,
    `INSERT INTO messages(conversation_id, sender_id, type, body, media_id, client_message_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (conversation_id, sender_id, client_message_id) DO NOTHING RETURNING *`,
    [args.conversationId, args.senderId, args.mediaId ? 'IMAGE' : 'TEXT', finalBody || null, args.mediaId ?? null, args.clientMessageId ?? null, JSON.stringify(metadata)],
  );
  if (!ins) {
    // concurrent duplicate with the same client_message_id committed first
    const existing = await one<MessageRow>(
      db,
      `SELECT * FROM messages WHERE conversation_id = $1 AND sender_id = $2 AND client_message_id = $3`,
      [args.conversationId, args.senderId, args.clientMessageId],
    );
    return { message: existing, created: false };
  }
  await db.query(
    `UPDATE conversation_members SET last_read_at = greatest(coalesce(last_read_at, '-infinity'), (SELECT created_at FROM messages WHERE id = $3))
      WHERE conversation_id = $1 AND user_id = $2`,
    [args.conversationId, args.senderId, ins.id],
  );
  await afterInsert(db, ctx, ins);
  return { message: ins, created: true };
}

export async function markRead(db: Db, conversationId: string, userId: string) {
  await assertMember(db, conversationId, userId);
  const r = await one<{ last_read_at: string }>(
    db,
    `UPDATE conversation_members SET last_read_at = greatest(coalesce(last_read_at, '-infinity'), now())
      WHERE conversation_id = $1 AND user_id = $2 RETURNING last_read_at`,
    [conversationId, userId],
  );
  return { conversationId, lastReadAt: r.last_read_at };
}

export async function reportMessage(db: Db, ctx: Ctx, args: { messageId: string; reporterId: string; reason: string }) {
  const msg = await maybeOne<MessageRow>(db, `SELECT * FROM messages WHERE id = $1`, [args.messageId]);
  if (!msg) throw notFound('Message');
  await assertMember(db, msg.conversation_id, args.reporterId);
  if (msg.sender_id === args.reporterId) throw badRequest('CANNOT_REPORT_OWN_MESSAGE', 'You cannot report your own message');
  const row = await maybeOne(
    db,
    `INSERT INTO message_reports(message_id, reporter_id, reason) VALUES ($1,$2,$3) ON CONFLICT (message_id, reporter_id) DO NOTHING RETURNING *`,
    [args.messageId, args.reporterId, args.reason],
  );
  if (row) {
    await emit(db, ctx, {
      aggregateType: 'message',
      aggregateId: args.messageId,
      eventType: 'message.reported',
      payload: { reportId: row.id, messageId: args.messageId, conversationId: msg.conversation_id, reporterId: args.reporterId },
    });
  }
  return { report: row ?? (await one(db, `SELECT * FROM message_reports WHERE message_id = $1 AND reporter_id = $2`, [args.messageId, args.reporterId])), created: !!row };
}

/** INQUIRY to a host about a published property, or to a published guide. */
export async function createInquiry(
  db: Db,
  ctx: Ctx,
  args: { requesterId: string; targetType: 'PROPERTY' | 'GUIDE'; targetId: string; message?: string; clientMessageId?: string },
) {
  let counterpartId: string;
  let roles: [string, string];
  if (args.targetType === 'PROPERTY') {
    const p = await maybeOne<{ host_id: string }>(db, `SELECT host_id FROM properties WHERE id = $1 AND status = 'PUBLISHED'`, [args.targetId]);
    if (!p) throw notFound('Property');
    counterpartId = p.host_id;
    roles = ['GUEST', 'HOST'];
  } else {
    const g = await maybeOne<{ user_id: string }>(db, `SELECT user_id FROM guide_profiles WHERE user_id = $1 AND status = 'PUBLISHED'`, [args.targetId]);
    if (!g) throw notFound('Guide');
    counterpartId = g.user_id;
    roles = ['TRAVELER', 'GUIDE'];
  }
  if (counterpartId === args.requesterId) throw badRequest('CANNOT_MESSAGE_SELF', 'You cannot start a conversation with yourself');
  const target = await maybeOne<{ status: string }>(db, `SELECT status FROM users WHERE id = $1`, [counterpartId]);
  if (!target || target.status !== 'ACTIVE') throw unprocessable('RECIPIENT_UNAVAILABLE', 'The recipient cannot receive messages');
  const conversationId = await ensureConversation(db, ctx, {
    contextType: 'INQUIRY',
    contextId: args.targetId,
    members: [
      { userId: args.requesterId, role: roles[0] },
      { userId: counterpartId, role: roles[1] },
    ],
  });
  let message: MessageRow | null = null;
  if (args.message?.trim()) {
    message = (await sendMessage(db, ctx, { conversationId, senderId: args.requesterId, body: args.message, clientMessageId: args.clientMessageId })).message;
  }
  return { conversationId, message };
}

// ---------------------------------------------------------------- staff elevation (invariant 10)

/**
 * Staff may read a private conversation only via the disputes-owned contract `assertElevatedAccess`
 * (live, non-revoked, non-expired, case-scoped grant on an AAL2 session). It audits every attempt
 * (granted → conversation.read_elevated, denied → elevated_access.denied) with category ELEVATED_ACCESS.
 */
export async function readAsStaff(db: Db, ctx: Ctx, conversationId: string, opts: { limit: number; cursor?: string }) {
  const grant = await assertElevatedAccess(db, ctx, conversationId);
  const conv = await maybeOne(db, `SELECT id FROM conversations WHERE id = $1`, [conversationId]);
  if (!conv) throw notFound('Conversation');
  const pageResult = await pageMessages(db, conversationId, opts);
  return { ...pageResult, grant: { id: grant.grantId, caseType: grant.caseType, caseId: grant.caseId, expiresAt: grant.expiresAt } };
}

// ---------------------------------------------------------------- realtime delivery

/**
 * Re-read a committed message and publish it to each member's realtime channel (`user:<id>`).
 * Called by the LISTEN bridge (multi-instance) or directly after commit when no bridge runs (tests/single process).
 */
export async function deliverRealtime(app: AppContext, messageId: string): Promise<number> {
  const msg = await maybeOne<MessageRow>(app.pool, `SELECT * FROM messages WHERE id = $1`, [messageId]);
  if (!msg) return 0;
  const members = await q<{ user_id: string }>(app.pool, `SELECT user_id FROM conversation_members WHERE conversation_id = $1`, [msg.conversation_id]);
  const dto = toMessageDto(msg);
  for (const m of members) app.realtime.publish(`user:${m.user_id}`, { type: 'message', message: dto });
  app.realtime.publish(`conversation:${msg.conversation_id}`, { type: 'message', message: dto });
  return members.length;
}
