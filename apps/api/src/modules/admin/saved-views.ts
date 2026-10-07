import { z } from 'zod';
import type { Db, Tx } from '../../platform/db.js';
import { maybeOne, one, q } from '../../platform/db.js';
import type { Ctx } from '../../platform/context.js';
import { conflict, forbidden, notFound } from '../../platform/errors.js';
import { recordAdminAction } from './actions.js';

/** OPS-02 saved console views. Shared views are readable by every staff member; only the owner may change them. */

export const SAVED_VIEW_TYPES = [
  'USERS',
  'LISTINGS',
  'RESERVATIONS',
  'EXCHANGES',
  'GUIDE_BOOKINGS',
  'ORDERS',
  'PAYMENTS',
  'REFUNDS',
  'SETTLEMENTS',
  'DISPUTES',
  'COMPLIANCE',
  'AUDIT',
  'SUPPORT_CASES',
] as const;
export type SavedViewType = (typeof SAVED_VIEW_TYPES)[number];

const fieldName = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,63}$/, 'field name');
const filterValue = z.union([z.string().max(500), z.number(), z.boolean(), z.null(), z.array(z.union([z.string().max(200), z.number()])).max(100)]);

/** Flat filter map (no nested objects) so a saved view can only replay what the list endpoints accept as query params. */
export const savedViewFilters = z
  .record(fieldName, filterValue)
  .refine((f) => Object.keys(f).length <= 50, 'at most 50 filters');
export const savedViewColumns = z.array(fieldName).max(60);
export const savedViewSort = z.array(z.object({ field: fieldName, direction: z.enum(['asc', 'desc']) }).strict()).max(5);

export const savedViewCreate = z.object({
  viewType: z.enum(SAVED_VIEW_TYPES),
  name: z.string().trim().min(1).max(100),
  filters: savedViewFilters.default({}),
  columns: savedViewColumns.default([]),
  sort: savedViewSort.default([]),
  shared: z.boolean().default(false),
});
export const savedViewPatch = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    filters: savedViewFilters.optional(),
    columns: savedViewColumns.optional(),
    sort: savedViewSort.optional(),
    shared: z.boolean().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), 'nothing to update');

export type SavedViewCreate = z.infer<typeof savedViewCreate>;
export type SavedViewPatch = z.infer<typeof savedViewPatch>;

export const toSavedViewDto = (r: any, viewerId?: string) => ({
  id: r.id,
  ownerId: r.owner_id,
  viewType: r.view_type,
  name: r.name,
  filters: r.filters,
  columns: r.columns,
  sort: r.sort,
  shared: r.shared,
  isOwner: !!viewerId && r.owner_id === viewerId,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export async function listSavedViews(db: Db, viewerId: string, f: { viewType?: SavedViewType; mine?: boolean }) {
  const rows = await q(
    db,
    `SELECT * FROM admin_saved_views
      WHERE (owner_id = $1 OR (shared AND NOT $3)) AND ($2::text IS NULL OR view_type = $2)
      ORDER BY view_type, (owner_id = $1) DESC, name, id LIMIT 500`,
    [viewerId, f.viewType ?? null, !!f.mine],
  );
  return rows.map((r) => toSavedViewDto(r, viewerId));
}

/** Own or shared view; anything else is 404 (no existence leak of other staff's private views). */
async function loadVisible(db: Db, viewerId: string, id: string, lock = false) {
  const row = await maybeOne(db, `SELECT * FROM admin_saved_views WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!row || (row.owner_id !== viewerId && !row.shared)) throw notFound('Saved view');
  return row;
}

export async function getSavedView(db: Db, viewerId: string, id: string) {
  return toSavedViewDto(await loadVisible(db, viewerId, id), viewerId);
}

async function loadOwned(tx: Tx, viewerId: string, id: string) {
  const row = await loadVisible(tx, viewerId, id, true);
  if (row.owner_id !== viewerId) throw forbidden('NOT_VIEW_OWNER', 'Only the owner can change a saved view');
  return row;
}

export async function createSavedView(tx: Tx, ctx: Ctx, input: SavedViewCreate) {
  const ownerId = ctx.actor!.userId;
  const row = await maybeOne(
    tx,
    `INSERT INTO admin_saved_views(owner_id, view_type, name, filters, columns, sort, shared) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (owner_id, view_type, name) DO NOTHING RETURNING *`,
    [ownerId, input.viewType, input.name, JSON.stringify(input.filters ?? {}), input.columns ?? [], JSON.stringify(input.sort ?? []), !!input.shared],
  );
  if (!row) throw conflict('SAVED_VIEW_EXISTS', 'You already have a saved view with this name for this console');
  await recordAdminAction(tx, ctx, { action: 'saved_view.created', resourceType: 'admin_saved_view', resourceId: row.id, details: { viewType: row.view_type, shared: row.shared } });
  return toSavedViewDto(row, ownerId);
}

export async function updateSavedView(tx: Tx, ctx: Ctx, id: string, patch: SavedViewPatch) {
  const ownerId = ctx.actor!.userId;
  const before = await loadOwned(tx, ownerId, id);
  if (patch.name !== undefined && patch.name !== before.name) {
    const clash = await maybeOne(tx, `SELECT 1 FROM admin_saved_views WHERE owner_id = $1 AND view_type = $2 AND name = $3 AND id <> $4`, [ownerId, before.view_type, patch.name, id]);
    if (clash) throw conflict('SAVED_VIEW_EXISTS', 'You already have a saved view with this name for this console');
  }
  const row = await one(
    tx,
    `UPDATE admin_saved_views SET name = coalesce($2, name), filters = coalesce($3, filters), columns = coalesce($4, columns),
        sort = coalesce($5, sort), shared = coalesce($6, shared)
      WHERE id = $1 RETURNING *`,
    [
      id,
      patch.name ?? null,
      patch.filters ? JSON.stringify(patch.filters) : null,
      patch.columns ?? null,
      patch.sort ? JSON.stringify(patch.sort) : null,
      patch.shared ?? null,
    ],
  );
  await recordAdminAction(tx, ctx, {
    action: 'saved_view.updated',
    resourceType: 'admin_saved_view',
    resourceId: id,
    details: { viewType: row.view_type, changed: Object.keys(patch).filter((k) => (patch as any)[k] !== undefined), shared: row.shared },
  });
  return toSavedViewDto(row, ownerId);
}

export async function deleteSavedView(tx: Tx, ctx: Ctx, id: string) {
  const ownerId = ctx.actor!.userId;
  const row = await loadOwned(tx, ownerId, id);
  await tx.query(`DELETE FROM admin_saved_views WHERE id = $1`, [id]);
  await recordAdminAction(tx, ctx, { action: 'saved_view.deleted', resourceType: 'admin_saved_view', resourceId: id, details: { viewType: row.view_type } });
  return { id, deleted: true };
}
