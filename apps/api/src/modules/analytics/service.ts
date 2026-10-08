import { z } from 'zod';
import type { Db } from '../../platform/db.js';
import { one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { audit } from '../../platform/audit.js';
import { decodeCursor, encodeCursor } from '../../platform/http.js';

/** OPS-04 analytics & audit. Analytics payloads must be non-PII (analytics_events comment in 0006). */

// Bounded quantifiers (RFC 5321 local part ≤ 64, domain ≤ 255): the unbounded `[..]+@` form backtracked
// quadratically on long '@'-less runs (~1.2 s of event-loop CPU for one 2 MB anonymous batch).
export const EMAIL_PATTERN = /[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,255}\.[A-Z]{2,24}/i;
// 9+ digits with optional separators/country code: phone numbers (Korean and international)
export const PHONE_PATTERN = /(?:\+?\d[\s.-]?){9,}\d/;
// Korean resident registration number (주민등록번호) / card-like long digit runs
const RRN_PATTERN = /\b\d{6}-?[1-4]\d{6}\b/;

/** Shape limits for the anonymous ingest: keys per object, and the serialized size of one event's properties. */
export const MAX_PROPERTY_KEYS = 50;
export const MAX_EVENT_PROPERTIES_BYTES = 8 * 1024;
const maxKeys = (o: Record<string, unknown>) => Object.keys(o).length <= MAX_PROPERTY_KEYS;
const PII_KEYS = /^(e-?mail|phone|phone_?number|mobile|tel|name|full_?name|first_?name|last_?name|address|password|passwd|token|access_?token|refresh_?token|secret|card|card_?number|cvc|ssn|rrn|birth|birthday|dob)$/i;

const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean(), z.null()]);
const propValue = z.union([
  scalar,
  z.array(scalar).max(50),
  z.record(z.string().max(64), z.union([scalar, z.array(scalar).max(50)])).refine(maxKeys, `at most ${MAX_PROPERTY_KEYS} keys`),
]);

export const analyticsEventSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/, 'lowercase dotted event name'),
  properties: z
    .record(z.string().max(64), propValue)
    .refine(maxKeys, `at most ${MAX_PROPERTY_KEYS} properties`)
    .refine((o) => Buffer.byteLength(JSON.stringify(o)) <= MAX_EVENT_PROPERTIES_BYTES, `properties must serialize to at most ${MAX_EVENT_PROPERTIES_BYTES} bytes`)
    .default({}),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});
export const analyticsBatchSchema = z.object({
  anonymousId: z.string().min(8).max(100).optional(),
  events: z.array(analyticsEventSchema).min(1).max(50),
});
export type AnalyticsBatch = z.infer<typeof analyticsBatchSchema>;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL_CH = /[A-Z0-9._%+-]/i;
const DOMAIN_CH = /[A-Z0-9.-]/i;
const ALPHA = /[A-Z]/i;
/** Same language as EMAIL_PATTERN (`x@y.zz`), decided in one linear pass per string (no regex backtracking). */
export function looksLikeEmail(s: string): boolean {
  for (let at = s.indexOf('@'); at !== -1; at = s.indexOf('@', at + 1)) {
    if (at === 0 || !LOCAL_CH.test(s[at - 1])) continue;
    let end = at + 1;
    while (end < s.length && DOMAIN_CH.test(s[end])) end++;
    // at least one domain char, then '.', then two letters
    for (let j = at + 2; j < end - 2; j++) if (s[j] === '.' && ALPHA.test(s[j + 1]) && ALPHA.test(s[j + 2])) return true;
  }
  return false;
}
const looksLikePii = (s: string) => !UUID_RE.test(s.trim()) && (looksLikeEmail(s) || PHONE_PATTERN.test(s) || RRN_PATTERN.test(s));

/** Remove PII-named keys and redact PII-looking values (recursively). Returns the stripped paths. */
export function stripPii(props: Record<string, unknown>, prefix = ''): { clean: Record<string, unknown>; stripped: string[] } {
  const clean: Record<string, unknown> = {};
  const stripped: string[] = [];
  for (const [k, v] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (PII_KEYS.test(k)) {
      stripped.push(path);
      continue;
    }
    if (typeof v === 'string') {
      if (looksLikePii(v)) {
        clean[k] = '[REDACTED]';
        stripped.push(path);
      } else clean[k] = v;
    } else if (Array.isArray(v)) {
      clean[k] = v.map((x, i) => {
        if (typeof x === 'string' && looksLikePii(x)) {
          stripped.push(`${path}[${i}]`);
          return '[REDACTED]';
        }
        return x;
      });
    } else if (v && typeof v === 'object') {
      const r = stripPii(v as Record<string, unknown>, path);
      clean[k] = r.clean;
      stripped.push(...r.stripped);
    } else clean[k] = v;
  }
  return { clean, stripped };
}

export async function ingestEvents(db: Db, args: { userId: string | null; batch: AnalyticsBatch }) {
  const now = Date.now();
  const strippedFields: string[] = [];
  let accepted = 0;
  for (const [i, e] of args.batch.events.entries()) {
    const { clean, stripped } = stripPii(e.properties);
    strippedFields.push(...stripped.map((s) => `events[${i}].properties.${s}`));
    let at = e.occurredAt ? Date.parse(e.occurredAt) : now;
    // clamp client clocks: no future events, no backfill older than 7 days
    if (!Number.isFinite(at) || at > now + 5 * 60_000 || at < now - 7 * 86400_000) at = now;
    await db.query(`INSERT INTO analytics_events(event_name, user_id, anonymous_id, properties, occurred_at) VALUES ($1,$2,$3,$4,$5)`, [
      e.name,
      args.userId,
      args.batch.anonymousId ?? null,
      JSON.stringify(clean),
      new Date(at),
    ]);
    accepted++;
  }
  return { accepted, strippedFields };
}

export interface Range { from: Date; to: Date }
export function parseRange(from?: string, to?: string): Range {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 86400_000);
  return { from: start, to: end };
}

/** GMV = provider-approved payments minus refunds, per currency (reconciles against payments). */
export async function gmv(db: Db, range?: Range) {
  return q<{ currency: string; gross_minor: number; refunded_minor: number; gmv_minor: number; payments: number }>(
    db,
    `SELECT currency, sum(amount_minor)::bigint AS gross_minor, sum(refunded_minor)::bigint AS refunded_minor,
            sum(amount_minor - refunded_minor)::bigint AS gmv_minor, count(*)::int AS payments
       FROM payments WHERE status IN ('APPROVED','PARTIALLY_REFUNDED','REFUNDED')
        AND ($1::timestamptz IS NULL OR approved_at >= $1) AND ($2::timestamptz IS NULL OR approved_at < $2)
      GROUP BY currency ORDER BY currency`,
    [range?.from ?? null, range?.to ?? null],
  );
}

export async function funnel(db: Db, range: Range) {
  const r = await one<{ searches: number; quotes: number; holds: number; paid: number; search_users: number }>(
    db,
    `SELECT
       (SELECT count(*)::int FROM analytics_events WHERE event_name IN ('search','search.performed','stay.search') AND occurred_at >= $1 AND occurred_at < $2) AS searches,
       (SELECT count(DISTINCT coalesce(user_id::text, anonymous_id))::int FROM analytics_events WHERE event_name IN ('search','search.performed','stay.search') AND occurred_at >= $1 AND occurred_at < $2) AS search_users,
       (SELECT count(*)::int FROM booking_quotes WHERE created_at >= $1 AND created_at < $2) AS quotes,
       (SELECT count(*)::int FROM reservation_holds WHERE created_at >= $1 AND created_at < $2) AS holds,
       (SELECT count(*)::int FROM payments WHERE subject_type = 'RESERVATION' AND status IN ('APPROVED','PARTIALLY_REFUNDED','REFUNDED') AND approved_at >= $1 AND approved_at < $2) AS paid`,
    [range.from, range.to],
  );
  const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : null);
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    steps: [
      { step: 'search', count: r.searches, uniqueActors: r.search_users },
      { step: 'quote', count: r.quotes, conversionFromPrevious: rate(r.quotes, r.searches) },
      { step: 'hold', count: r.holds, conversionFromPrevious: rate(r.holds, r.quotes) },
      { step: 'paid', count: r.paid, conversionFromPrevious: rate(r.paid, r.holds) },
    ],
    overallConversion: rate(r.paid, r.searches),
  };
}

export async function kpis(db: Db, range: Range) {
  const g = await gmv(db, range);
  const fees = await q<{ currency: string; fee_minor: number }>(
    db,
    `SELECT a.currency, coalesce(sum(e.credit_minor - e.debit_minor),0)::bigint AS fee_minor
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.purpose = 'FEE_REVENUE' AND e.created_at >= $1 AND e.created_at < $2 GROUP BY a.currency`,
    [range.from, range.to],
  );
  const res = await one<{ total: number; cancelled: number }>(
    db,
    `SELECT count(*) FILTER (WHERE status NOT IN ('DRAFT','QUOTED','HELD','PAYMENT_PENDING','PAYMENT_FAILED','EXPIRED'))::int AS total,
            count(*) FILTER (WHERE status IN ('CANCELLED','REFUND_PENDING','PARTIALLY_REFUNDED','REFUNDED'))::int AS cancelled
       FROM reservations WHERE created_at >= $1 AND created_at < $2`,
    [range.from, range.to],
  );
  const ex = await one<{ confirmed: number; completed: number }>(
    db,
    `SELECT count(*) FILTER (WHERE status IN ('CONFIRMED','IN_PROGRESS','COMPLETED','REVIEWED','DISPUTED'))::int AS confirmed,
            count(*) FILTER (WHERE status IN ('COMPLETED','REVIEWED'))::int AS completed
       FROM exchange_requests WHERE created_at >= $1 AND created_at < $2`,
    [range.from, range.to],
  );
  const gb = await one<{ total: number; paid: number; completed: number }>(
    db,
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE paid)::int AS paid,
            count(*) FILTER (WHERE status IN ('COMPLETED','REVIEWED'))::int AS completed
       FROM guide_bookings WHERE created_at >= $1 AND created_at < $2`,
    [range.from, range.to],
  );
  const rate = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 10000) / 10000 : null);
  return {
    from: range.from.toISOString(),
    to: range.to.toISOString(),
    gmv: g.map((x) => ({ currency: x.currency, gmvMinor: x.gmv_minor, grossMinor: x.gross_minor, refundedMinor: x.refunded_minor, payments: x.payments })),
    takeRate: g.map((x) => {
      const fee = fees.find((f) => f.currency === x.currency)?.fee_minor ?? 0;
      return { currency: x.currency, feeRevenueMinor: fee, takeRateBps: x.gmv_minor > 0 ? Math.round((fee * 10000) / x.gmv_minor) : null };
    }),
    cancellationRate: { reservations: res.total, cancelled: res.cancelled, rate: rate(res.cancelled, res.total) },
    exchangeCompletion: { confirmed: ex.confirmed, completed: ex.completed, rate: rate(ex.completed, ex.confirmed) },
    guideBookings: { total: gb.total, paid: gb.paid, free: gb.total - gb.paid, completed: gb.completed },
  };
}

export const auditQuerySchema = z.object({
  category: z.enum(['GENERAL', 'MONEY', 'PERMISSION', 'COMPLIANCE', 'ELEVATED_ACCESS', 'PRIVACY', 'SECURITY', 'CONTENT']).optional(),
  resourceType: z.string().max(100).optional(),
  resourceId: z.string().max(100).optional(),
  actorId: z.uuid().optional(),
  action: z.string().max(100).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

/** Reading audit logs is itself audited (SECURITY). */
export async function readAuditLogs(db: Db, ctx: Ctx, f: z.infer<typeof auditQuerySchema>) {
  const c = decodeCursor(f.cursor);
  const rows = await q(
    db,
    `SELECT id, actor_id, actor_roles, action, resource_type, resource_id, before_state, after_state, reason, correlation_id,
            host(ip) AS ip, category, created_at
       FROM audit_logs
      WHERE ($1::text IS NULL OR category = $1) AND ($2::text IS NULL OR resource_type = $2) AND ($3::text IS NULL OR resource_id = $3)
        AND ($4::uuid IS NULL OR actor_id = $4) AND ($5::text IS NULL OR action = $5)
        AND ($6::timestamptz IS NULL OR created_at >= $6) AND ($7::timestamptz IS NULL OR created_at < $7)
        AND ($8::timestamptz IS NULL OR (date_trunc('milliseconds', created_at), id) < ($8::timestamptz, $9::uuid))
      ORDER BY date_trunc('milliseconds', created_at) DESC, id DESC LIMIT $10`,
    [f.category ?? null, f.resourceType ?? null, f.resourceId ?? null, f.actorId ?? null, f.action ?? null, f.from ?? null, f.to ?? null, c?.createdAt ?? null, c?.id ?? null, f.limit + 1],
  );
  const { cursor: _c, limit: _l, ...filters } = f;
  await audit(db, ctx, { action: 'audit_logs.read', resourceType: 'audit_logs', category: 'SECURITY', after: { filters, returned: Math.min(rows.length, f.limit) } });
  const items = rows.slice(0, f.limit);
  return { items, nextCursor: rows.length > f.limit ? encodeCursor(items[items.length - 1]) : null };
}
