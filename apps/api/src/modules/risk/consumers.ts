import type { Tx } from '../../platform/db.js';
import { maybeOne, one, q, withTx } from '../../platform/db.js';
import type { AppContext, Ctx } from '../../platform/context.js';
import { systemCtx } from '../../platform/context.js';
import { onEvent } from '../../platform/outbox.js';
import { registerJob } from '../../platform/jobs.js';
import { recordRiskEvent } from './service.js';

/**
 * PLAT-05 detectors that derive risk from existing domain events / append-only records WITHOUT changing the
 * owning modules. Consumers are idempotent (outbox_consumptions + risk dedupe keys) and defensive: missing
 * referenced rows are skipped rather than failing the event (a failure would retry and dead-letter it).
 */

export const CARD_TESTING_THRESHOLD = 5;
export const CARD_TESTING_WINDOW_MINUTES = 10;
/** payment.failed codes that are not card declines (expiry, duplicate charge void, user/provider cancel, lost confirm). */
const NON_DECLINE_CODES = new Set(['EXPIRED', 'DUPLICATE_PAYMENT', 'CANCELED_AT_PROVIDER', 'CONFIRM_NOT_RECEIVED']);
const CONTACT_LEAK_RE = /(contact|phone|e-?mail|kakao|line|whats ?app|telegram|wechat|off[- ]?platform|outside|direct(ly)? pay|계좌|연락처|전화|카톡|카카오|외부|직거래)/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

/** UPLOAD_REJECTED (LOW) against the uploader, one per media asset whichever source saw it first. */
export async function recordUploadRejected(
  tx: Tx,
  ctx: Ctx,
  m: { mediaId: string; ownerId?: string | null; reason?: string | null; sourceEventId?: string },
) {
  return recordRiskEvent(tx, ctx, {
    subjectType: m.ownerId ? 'USER' : 'MEDIA',
    subjectId: m.ownerId ?? m.mediaId,
    riskType: 'UPLOAD_REJECTED',
    severity: 'LOW',
    detail: { mediaId: m.mediaId, reason: m.reason ?? null },
    dedupeKey: `UPLOAD_REJECTED:MEDIA:${m.mediaId}`,
    sourceEventId: m.sourceEventId,
  });
}

/** Track a payment failure signal for the payer and raise CARD_TESTING (HIGH) at ≥5 failures in 10 minutes. */
export async function onPaymentFailed(tx: Tx, ctx: Ctx, ev: { id: string; created_at: string | Date; aggregate_id: string; payload: any }) {
  const code = String(ev.payload?.code ?? '');
  if (NON_DECLINE_CODES.has(code)) return;
  const paymentId = isUuid(ev.payload?.paymentId) ? ev.payload.paymentId : isUuid(ev.aggregate_id) ? ev.aggregate_id : null;
  if (!paymentId) return;
  const p = await maybeOne<{ payer_id: string | null }>(tx, `SELECT payer_id FROM payments WHERE id = $1`, [paymentId]);
  if (!p?.payer_id) return;
  const payer = p.payer_id;
  // serialize burst evaluation per payer (concurrent dispatchers)
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended('risk:card-testing:' || $1, 0))`, [payer]);
  await tx.query(
    `INSERT INTO risk_signals(signal_type, subject_type, subject_id, source_event_id, occurred_at)
     VALUES ('PAYMENT_FAILURE','USER',$1,$2,$3) ON CONFLICT DO NOTHING`,
    [payer, ev.id, ev.created_at],
  );
  const w = await one<{ n: number; first_at: string; last_at: string }>(
    tx,
    `SELECT count(*)::int AS n, min(occurred_at) AS first_at, max(occurred_at) AS last_at FROM risk_signals
      WHERE signal_type = 'PAYMENT_FAILURE' AND subject_type = 'USER' AND subject_id = $1
        AND occurred_at > $2::timestamptz - make_interval(mins => $3) AND occurred_at <= $2::timestamptz`,
    [payer, ev.created_at, CARD_TESTING_WINDOW_MINUTES],
  );
  if (w.n < CARD_TESTING_THRESHOLD) return;
  const open = await maybeOne<{ id: string }>(
    tx,
    `SELECT id FROM risk_events WHERE subject_type = 'USER' AND subject_id = $1 AND risk_type = 'CARD_TESTING' AND status IN ('OPEN','ACKNOWLEDGED')
      ORDER BY created_at DESC LIMIT 1`,
    [payer],
  );
  const detail = { failureCount: w.n, windowMinutes: CARD_TESTING_WINDOW_MINUTES, firstFailureAt: w.first_at, lastFailureAt: w.last_at, lastPaymentId: paymentId, lastCode: code || null };
  if (open) {
    // the burst is already under triage: keep its evidence current instead of raising a duplicate
    await tx.query(`UPDATE risk_events SET detail = detail || $2::jsonb WHERE id = $1`, [open.id, JSON.stringify(detail)]);
    return;
  }
  await recordRiskEvent(tx, ctx, { subjectType: 'USER', subjectId: payer, riskType: 'CARD_TESTING', severity: 'HIGH', detail, sourceEventId: ev.id });
}

export async function onMessageReported(tx: Tx, ctx: Ctx, ev: { id: string; payload: any }) {
  const { reportId, messageId, conversationId } = ev.payload ?? {};
  if (!isUuid(messageId)) return;
  // only the sender id and the report reason are read — never the message body (invariant 10)
  const msg = await maybeOne<{ sender_id: string | null }>(tx, `SELECT sender_id FROM messages WHERE id = $1`, [messageId]);
  if (!msg?.sender_id) return;
  const rep = isUuid(reportId) ? await maybeOne<{ reason: string }>(tx, `SELECT reason FROM message_reports WHERE id = $1`, [reportId]) : null;
  const reason = String(rep?.reason ?? '').slice(0, 200);
  await recordRiskEvent(tx, ctx, {
    subjectType: 'USER',
    subjectId: msg.sender_id,
    riskType: CONTACT_LEAK_RE.test(reason) ? 'CONTACT_LEAK' : 'ABUSE',
    severity: 'MEDIUM',
    detail: { messageId, conversationId: conversationId ?? null, reportId: reportId ?? null, reason: reason || null },
    dedupeKey: `MESSAGE_REPORT:${isUuid(reportId) ? reportId : ev.id}`,
    sourceEventId: ev.id,
  });
}

const MEDIA_SCANNER = 'media.rejections';
/** Re-scan this many ids below the watermark: bigserial ids can commit out of order; dedupe keys make it idempotent. */
const SCAN_OVERLAP = 1000;

/**
 * The media module records rejections as MEDIA → REJECTED state transitions but emits no event, so this sweep
 * reads the append-only state_transitions log incrementally (watermark in risk_scan_cursors).
 */
export async function sweepMediaRejections(app: AppContext): Promise<number> {
  return withTx(app.pool, async (tx) => {
    await tx.query(`INSERT INTO risk_scan_cursors(scanner) VALUES ($1) ON CONFLICT DO NOTHING`, [MEDIA_SCANNER]);
    const cur = await one<{ last_id: number }>(tx, `SELECT last_id FROM risk_scan_cursors WHERE scanner = $1 FOR UPDATE`, [MEDIA_SCANNER]);
    const hi = await one<{ hi: number | null }>(tx, `SELECT max(id) AS hi FROM state_transitions`);
    if (hi.hi == null || hi.hi <= cur.last_id) return 0;
    const upper = Math.min(hi.hi, cur.last_id + 50_000);
    const rows = await q<{ id: number; media_id: string; reason: string | null; correlation_id: string; owner_id: string | null }>(
      tx,
      `SELECT st.id, st.aggregate_id AS media_id, st.reason, st.correlation_id, m.owner_id
         FROM state_transitions st LEFT JOIN media_assets m ON m.id = st.aggregate_id
        WHERE st.id > $1 AND st.id <= $2 AND st.aggregate_type = 'MEDIA' AND st.to_state = 'REJECTED'
          AND st.created_at > now() - interval '7 days'
        ORDER BY st.id`,
      [Math.max(0, cur.last_id - SCAN_OVERLAP), upper],
    );
    for (const r of rows) {
      await recordUploadRejected(tx, systemCtx(app, r.correlation_id), { mediaId: r.media_id, ownerId: r.owner_id, reason: r.reason });
    }
    await tx.query(`UPDATE risk_scan_cursors SET last_id = greatest(last_id, $2), updated_at = now() WHERE scanner = $1`, [MEDIA_SCANNER, upper]);
    return rows.length;
  });
}

let registered = false;
export function registerRiskConsumers() {
  if (registered) return;
  registered = true;

  onEvent('identity.session.compromised', 'risk.session-compromised', async (tx, ev, ctx) => {
    const userId = isUuid(ev.payload?.userId) ? ev.payload.userId : isUuid(ev.aggregate_id) ? ev.aggregate_id : null;
    if (!userId) return;
    await recordRiskEvent(tx, ctx, {
      subjectType: 'USER',
      subjectId: userId,
      riskType: 'SESSION_COMPROMISED',
      severity: 'HIGH',
      detail: { sessionId: ev.payload?.sessionId ?? null, signal: 'REFRESH_TOKEN_REUSE' },
      dedupeKey: `SESSION_COMPROMISED:${ev.id}`,
      sourceEventId: ev.id,
    });
  });

  onEvent('payment.failed', 'risk.card-testing', (tx, ev, ctx) => onPaymentFailed(tx, ctx, ev));

  onEvent('message.reported', 'risk.message-reported', (tx, ev, ctx) => onMessageReported(tx, ctx, ev));

  // forward-compatible contract: if media starts emitting `media.rejected` {mediaId, ownerId, reason}, it is
  // consumed here; the dedupe key is shared with the state_transitions sweep so nothing is counted twice.
  onEvent('media.rejected', 'risk.media-rejected', async (tx, ev, ctx) => {
    const mediaId = isUuid(ev.payload?.mediaId) ? ev.payload.mediaId : isUuid(ev.aggregate_id) ? ev.aggregate_id : null;
    if (!mediaId) return;
    const ownerId = isUuid(ev.payload?.ownerId)
      ? ev.payload.ownerId
      : (await maybeOne<{ owner_id: string | null }>(tx, `SELECT owner_id FROM media_assets WHERE id = $1`, [mediaId]))?.owner_id ?? null;
    await recordUploadRejected(tx, ctx, { mediaId, ownerId, reason: ev.payload?.reason ?? ev.payload?.code ?? null, sourceEventId: ev.id });
  });

  registerJob('risk.media-rejections', 60_000, (app) => sweepMediaRejections(app));
}
