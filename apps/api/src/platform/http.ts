import { z } from 'zod';

export const uuid = z.uuid();
export const idParams = z.object({ id: z.uuid() });
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});
export type Pagination = z.infer<typeof pagination>;

/** Keyset cursor over (created_at, id). */
export function encodeCursor(row: { created_at: string | Date; id: string }): string {
  const ts = row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at;
  return Buffer.from(JSON.stringify([ts, row.id])).toString('base64url');
}
export function decodeCursor(cursor?: string): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    return { createdAt, id };
  } catch {
    return null;
  }
}
export function page<T extends { created_at: any; id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]) : null };
}
