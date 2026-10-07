import type { Db } from '../../platform/db.js';
import { one } from '../../platform/db.js';
import { badRequest } from '../../platform/errors.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const toUtc = (d: string) => {
  if (!DATE_RE.test(d)) throw badRequest('INVALID_DATE', 'Dates must be YYYY-MM-DD');
  const ms = Date.parse(`${d}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== d) throw badRequest('INVALID_DATE', `Invalid date ${d}`);
  return ms;
};

export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (d: string, n: number) => isoDate(toUtc(d) + n * DAY_MS);
export const diffDays = (start: string, end: string) => Math.round((toUtc(end) - toUtc(start)) / DAY_MS);
/** 0 = Sunday .. 6 = Saturday */
export const weekday = (d: string) => new Date(toUtc(d)).getUTCDay();

/** Every day in [start, end). */
export function eachDay(start: string, end: string): string[] {
  const out: string[] = [];
  for (let ms = toUtc(start), stop = toUtc(end); ms < stop; ms += DAY_MS) out.push(isoDate(ms));
  return out;
}

export function assertRange(start: string, end: string, maxDays = 400) {
  const n = diffDays(start, end);
  if (n <= 0) throw badRequest('INVALID_DATE_RANGE', 'End date must be after start date');
  if (n > maxDays) throw badRequest('RANGE_TOO_LARGE', `Range may span at most ${maxDays} days`);
  return n;
}

/** Today's calendar date in the property's timezone. */
export async function localToday(db: Db, timezone: string): Promise<string> {
  const r = await one<{ d: string }>(db, `SELECT ((now() AT TIME ZONE $1)::date)::text AS d`, [timezone]);
  return r.d;
}
