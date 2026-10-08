import { z } from 'zod';

export const uuid = z.uuid();
export const idParams = z.object({ id: z.uuid() });
/** True for a real calendar day 'YYYY-MM-DD' (2026-02-30 / 2026-13-01 are rejected instead of reaching `::date`). */
export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(2000, mo - 1, d));
  dt.setUTCFullYear(y);
  return y >= 1 && mo >= 1 && mo <= 12 && dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD').refine(isCalendarDate, 'Not a valid calendar date');
export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type Pagination = z.infer<typeof pagination>;

// ------------------------------------------------------------------------------------------------ keyset cursors
//
// PostgreSQL timestamptz has MICROSECOND precision, a JS Date only milliseconds. A cursor built from a Date
// therefore truncates the sort key, and rows created in the same millisecond are skipped (DESC) or repeated
// (ASC) across pages. To page exactly, select the sort key as text with `cursorColumns()` and let `page()`
// encode that text verbatim; queries compare `(created_at, id) < ($1::timestamptz, $2::uuid)`.

/** Name of the exact-text sort key column added by `cursorColumns()`; `page()` prefers it and strips it from items. */
export const CURSOR_COLUMN = 'created_at_cursor';

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2}){0,2})?$/;
const CURSOR_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CURSOR_TS_PARTS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|[+-](\d{2})(?::?(\d{2}))?(?::?(\d{2}))?)?$/;

/**
 * The shape regex alone lets out-of-range values through (month 13, Feb 30, hour 25, year 0000, offset +99:99)
 * and `$n::timestamptz` then raises 22007/22008/22009 (a 500). Accept only values PostgreSQL will parse.
 */
function isCursorTimestampInRange(s: string): boolean {
  const m = CURSOR_TS_PARTS_RE.exec(s);
  if (!m) return false;
  const [y, mo, d, h, mi, se] = m.slice(1, 7).map(Number);
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (y < 1 || !daysInMonth || d < 1 || d > daysInMonth || h > 23 || mi > 59 || se > 59) return false;
  const [oh, om, os] = [m[7], m[8], m[9]].map((v) => (v === undefined ? 0 : Number(v)));
  return oh <= 15 && om <= 59 && os <= 59;
}

/**
 * SQL select-list snippet that exposes the exact (microsecond) sort key as text, independent of the session's
 * DateStyle/TimeZone: `created_at_cursor` = '2026-01-01T00:00:00.123456Z'. Add it next to your columns:
 *   `SELECT r.*, ${cursorColumns('r')} FROM risk_events r WHERE ($1::timestamptz IS NULL OR (r.created_at, r.id) < ($1::timestamptz, $2::uuid)) ...`
 * `column` overrides the timestamp column (e.g. 'submitted_at' or 'opened_at') when the keyset uses another one.
 */
export function cursorColumns(alias?: string, column = 'created_at'): string {
  if (alias !== undefined && !IDENT_RE.test(alias)) throw new Error(`cursorColumns: invalid alias '${alias}'`);
  if (!IDENT_RE.test(column)) throw new Error(`cursorColumns: invalid column '${column}'`);
  const col = alias ? `${alias}.${column}` : column;
  return `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS ${CURSOR_COLUMN}`;
}

/**
 * Keyset cursor over (created_at, id). A string `created_at` (exact Postgres text, e.g. from `cursorColumns()` or
 * `created_at::text`) is encoded as-is; a Date is encoded with millisecond precision (legacy behaviour — prefer
 * selecting `cursorColumns()` so `page()` can use the exact value). `created_at_cursor`, when present, wins.
 */
export function encodeCursor(row: { created_at: string | Date; id: string; created_at_cursor?: string | null }): string {
  const exact = typeof row.created_at_cursor === 'string' && row.created_at_cursor ? row.created_at_cursor : null;
  const ts = exact ?? (row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at);
  return Buffer.from(JSON.stringify([ts, row.id])).toString('base64url');
}

/**
 * Decode a cursor into the exact timestamp TEXT and id; compare in SQL with `$n::timestamptz` / `$m::uuid`.
 * Malformed or tampered cursors decode to null (the listing restarts from the first page).
 */
export function decodeCursor(cursor?: string): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [createdAt, id] = parsed;
    if (typeof createdAt !== 'string' || typeof id !== 'string') return null;
    if (!CURSOR_TS_RE.test(createdAt) || !isCursorTimestampInRange(createdAt) || !CURSOR_ID_RE.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/** Slice a `limit + 1` result into a page. Rows selected with `cursorColumns()` get an exact cursor. */
export function page<T extends { created_at: any; id: string }>(rows: T[], limit: number) {
  const slice = rows.slice(0, limit);
  const last = slice[slice.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(last) : null;
  const items = slice.map((r) => {
    if (r && typeof r === 'object' && CURSOR_COLUMN in r) {
      const { [CURSOR_COLUMN]: _c, ...rest } = r as any;
      return rest as T;
    }
    return r;
  });
  return { items, nextCursor };
}

// ------------------------------------------------------------------------------------------------ log redaction

/** Query parameters that carry credentials (SSE/iCal `?token=`, OAuth `code`/`state`, Toss `paymentKey`). */
export const SECRET_QUERY_PARAMS = ['token', 'code', 'state', 'access_token', 'refresh_token', 'paymentKey'] as const;
const SECRET_PARAM_SET = new Set(SECRET_QUERY_PARAMS.map((p) => p.toLowerCase()));
const REDACTED = '[REDACTED]';

function isSecretParam(rawName: string): boolean {
  let name = rawName;
  try {
    name = decodeURIComponent(rawName.replace(/\+/g, ' '));
  } catch {}
  return SECRET_PARAM_SET.has(name.trim().toLowerCase());
}

/** Replace the values of secret query parameters in a URL (path + query) with [REDACTED]; everything else is kept. */
export function redactUrl(url: string | undefined | null): string {
  if (typeof url !== 'string') return url as any;
  const q = url.indexOf('?');
  if (q < 0) return url;
  const hashAt = url.indexOf('#', q);
  const query = hashAt < 0 ? url.slice(q + 1) : url.slice(q + 1, hashAt);
  const hash = hashAt < 0 ? '' : url.slice(hashAt);
  const parts = query.split(/([&;])/);
  const out = parts.map((part) => {
    if (part === '&' || part === ';' || part === '') return part;
    const eq = part.indexOf('=');
    const name = eq < 0 ? part : part.slice(0, eq);
    if (!isSecretParam(name)) return part;
    return `${name}=${REDACTED}`;
  });
  return `${url.slice(0, q)}?${out.join('')}${hash}`;
}

const SECRET_IN_TEXT_RE = new RegExp(`([?&;](?:${SECRET_QUERY_PARAMS.join('|')})=)[^&;#\\s"'<>]*`, 'gi');

/** Scrub secret query parameters inside free text (log messages such as "Route GET:/v1/x?token=... not found"). */
export function redactSecretsInText(text: string): string {
  if (typeof text !== 'string' || !text.includes('=')) return text;
  return text.replace(SECRET_IN_TEXT_RE, `$1${REDACTED}`);
}

/**
 * Pino `req` serializer (same shape as Fastify's default) with secret query parameters redacted from the URL.
 * Accepts a Fastify request or a raw IncomingMessage.
 */
export function serializeRequest(req: any): Record<string, unknown> {
  if (!req || typeof req !== 'object') return req;
  return {
    method: req.method,
    url: redactUrl(req.url ?? req.raw?.url),
    version: req.headers?.['accept-version'],
    host: req.host ?? req.headers?.host,
    remoteAddress: req.ip ?? req.socket?.remoteAddress,
    remotePort: req.socket ? req.socket.remotePort : undefined,
  };
}
