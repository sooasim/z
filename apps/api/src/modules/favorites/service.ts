import type { Ctx } from '../../platform/context.js';
import type { Actor } from '../../platform/auth.js';
import type { Db } from '../../platform/db.js';
import { maybeOne, q, withTx } from '../../platform/db.js';
import { forbidden, notFound, unprocessable } from '../../platform/errors.js';
import { emit } from '../../platform/outbox.js';
import { randomToken } from '../../platform/crypto.js';
import { publicCoordinates } from '../geo/service.js';

export const TARGET_TYPES = ['PROPERTY', 'GUIDE', 'TRAVEL_PRODUCT'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];
export type Visibility = 'PRIVATE' | 'LINK' | 'PUBLIC';

/** Only published properties can be newly saved; other domains' targets are validated by id shape only. */
async function assertTargetSaveable(db: Db, targetType: TargetType, targetId: string) {
  if (targetType === 'PROPERTY') {
    const p = await maybeOne(db, `SELECT status FROM properties WHERE id = $1`, [targetId]);
    if (!p || p.status !== 'PUBLISHED') throw unprocessable('TARGET_NOT_AVAILABLE', 'This listing cannot be saved');
  }
}

/** Public summaries for saved targets. Unpublished properties come back as unavailable (no private data). */
async function summaries(db: Db, items: { target_type: string; target_id: string }[]) {
  const propIds = items.filter((i) => i.target_type === 'PROPERTY').map((i) => i.target_id);
  const props = propIds.length
    ? await q(
        db,
        `SELECT p.id, p.slug, p.title, p.city, p.region, p.property_type, p.base_price_minor, p.currency, p.rental_enabled, p.exchange_enabled,
                p.lat, p.lng, rs.rating_avg, rs.review_count,
                (SELECT m.public_url FROM property_media pm JOIN media_assets m ON m.id = pm.media_id
                  WHERE pm.property_id = p.id AND m.status = 'READY' AND m.visibility = 'PUBLIC' ORDER BY pm.sort_order LIMIT 1) AS cover_url
           FROM properties p LEFT JOIN reputation_scores rs ON rs.target_type = 'PROPERTY' AND rs.target_id = p.id
          WHERE p.id = ANY($1::uuid[]) AND p.status = 'PUBLISHED'`,
        [propIds],
      )
    : [];
  const byId = new Map(props.map((p) => [p.id, p]));
  return (i: { target_type: string; target_id: string }) => {
    if (i.target_type !== 'PROPERTY') return null;
    const p = byId.get(i.target_id);
    if (!p) return { available: false };
    return {
      available: true,
      slug: p.slug,
      title: p.title,
      city: p.city,
      region: p.region,
      propertyType: p.property_type,
      priceMinor: p.rental_enabled ? p.base_price_minor : null,
      currency: p.currency,
      exchangeEnabled: p.exchange_enabled,
      coverUrl: p.cover_url,
      ratingAvg: p.rating_avg,
      reviewCount: p.review_count ?? 0,
      location: publicCoordinates(p.id, p.lat, p.lng),
    };
  };
}

// --- favorites ----------------------------------------------------------------------------------

export async function addFavorite(ctx: Ctx, actor: Actor, targetType: TargetType, targetId: string) {
  return withTx(ctx.app.pool, async (tx) => {
    const existing = await maybeOne(tx, `SELECT * FROM favorites WHERE user_id = $1 AND target_type = $2 AND target_id = $3`, [actor.userId, targetType, targetId]);
    if (existing) return { created: false, item: toFavorite(existing) };
    await assertTargetSaveable(tx, targetType, targetId);
    const rows = await q(
      tx,
      `INSERT INTO favorites(user_id, target_type, target_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING *`,
      [actor.userId, targetType, targetId],
    );
    if (rows[0]) {
      await emit(tx, ctx, { aggregateType: 'favorite', aggregateId: actor.userId, eventType: 'favorite.added', payload: { userId: actor.userId, targetType, targetId } });
      return { created: true, item: toFavorite(rows[0]) };
    }
    // lost a concurrent race: the other request created it
    const row = await maybeOne(tx, `SELECT * FROM favorites WHERE user_id = $1 AND target_type = $2 AND target_id = $3`, [actor.userId, targetType, targetId]);
    return { created: false, item: toFavorite(row) };
  });
}

export async function removeFavorite(ctx: Ctx, actor: Actor, targetType: TargetType, targetId: string) {
  return withTx(ctx.app.pool, async (tx) => {
    const rows = await q(tx, `DELETE FROM favorites WHERE user_id = $1 AND target_type = $2 AND target_id = $3 RETURNING 1`, [actor.userId, targetType, targetId]);
    if (rows.length) await emit(tx, ctx, { aggregateType: 'favorite', aggregateId: actor.userId, eventType: 'favorite.removed', payload: { userId: actor.userId, targetType, targetId } });
    return { removed: rows.length > 0 };
  });
}

const toFavorite = (f: any) => ({ targetType: f.target_type, targetId: f.target_id, createdAt: f.created_at });

export async function listFavorites(db: Db, actor: Actor, targetType?: TargetType) {
  const rows = await q(
    db,
    `SELECT * FROM favorites WHERE user_id = $1 AND ($2::text IS NULL OR target_type = $2) ORDER BY created_at DESC LIMIT 500`,
    [actor.userId, targetType ?? null],
  );
  const sum = await summaries(db, rows);
  return rows.map((r) => ({ ...toFavorite(r), target: sum(r) }));
}

// --- collections --------------------------------------------------------------------------------

const toCollection = (c: any, includeToken: boolean) => ({
  id: c.id,
  name: c.name,
  visibility: c.visibility,
  // the share token is a bearer capability: only the owner sees it
  shareToken: includeToken && c.visibility !== 'PRIVATE' ? c.share_token : undefined,
  itemCount: c.item_count ?? undefined,
  createdAt: c.created_at,
});

async function ownedCollection(db: Db, actor: Actor, id: string, lock = false) {
  const c = await maybeOne(db, `SELECT * FROM collections WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [id]);
  if (!c) throw notFound('Collection');
  if (c.owner_id !== actor.userId) {
    // do not reveal private collections to non-owners
    if (c.visibility !== 'PUBLIC') throw notFound('Collection');
    throw forbidden('NOT_COLLECTION_OWNER', 'You do not own this collection');
  }
  return c;
}

export async function createCollection(ctx: Ctx, actor: Actor, name: string, visibility: Visibility) {
  return withTx(ctx.app.pool, async (tx) => {
    const c = await maybeOne(
      tx,
      `INSERT INTO collections(owner_id, name, visibility, share_token) VALUES ($1,$2,$3,$4) RETURNING *`,
      [actor.userId, name, visibility, visibility === 'PRIVATE' ? null : randomToken(18)],
    );
    await emit(tx, ctx, { aggregateType: 'collection', aggregateId: c.id, eventType: 'collection.created', payload: { collectionId: c.id, ownerId: actor.userId, visibility } });
    return toCollection(c, true);
  });
}

export async function updateCollection(ctx: Ctx, actor: Actor, id: string, patch: { name?: string; visibility?: Visibility; rotateToken?: boolean }) {
  return withTx(ctx.app.pool, async (tx) => {
    const c = await ownedCollection(tx, actor, id, true);
    const visibility = patch.visibility ?? c.visibility;
    let token: string | null = c.share_token;
    // going PRIVATE revokes the link; sharing again (or an explicit rotate) issues a fresh token
    if (visibility === 'PRIVATE') token = null;
    else if (!token || patch.rotateToken) token = randomToken(18);
    const row = await maybeOne(tx, `UPDATE collections SET name = $2, visibility = $3, share_token = $4 WHERE id = $1 RETURNING *`, [id, patch.name ?? c.name, visibility, token]);
    await emit(tx, ctx, { aggregateType: 'collection', aggregateId: id, eventType: 'collection.updated', payload: { collectionId: id, visibility } });
    return toCollection(row, true);
  });
}

export async function deleteCollection(ctx: Ctx, actor: Actor, id: string) {
  return withTx(ctx.app.pool, async (tx) => {
    await ownedCollection(tx, actor, id, true);
    await tx.query(`DELETE FROM collections WHERE id = $1`, [id]);
    await emit(tx, ctx, { aggregateType: 'collection', aggregateId: id, eventType: 'collection.deleted', payload: { collectionId: id } });
    return { deleted: true };
  });
}

export async function listCollections(db: Db, actor: Actor) {
  const rows = await q(
    db,
    `SELECT c.*, (SELECT count(*)::int FROM collection_items i WHERE i.collection_id = c.id) AS item_count
       FROM collections c WHERE c.owner_id = $1 ORDER BY c.created_at DESC`,
    [actor.userId],
  );
  return rows.map((c) => toCollection(c, true));
}

async function collectionWithItems(db: Db, c: any, isOwner: boolean) {
  const items = await q(db, `SELECT * FROM collection_items WHERE collection_id = $1 ORDER BY added_at DESC`, [c.id]);
  const sum = await summaries(db, items);
  const owner = await maybeOne(db, `SELECT display_name FROM users WHERE id = $1`, [c.owner_id]);
  return {
    ...toCollection(c, isOwner),
    owner: { displayName: owner?.display_name ?? null },
    items: items
      .map((i) => ({ targetType: i.target_type, targetId: i.target_id, note: isOwner ? i.note : undefined, addedAt: i.added_at, target: sum(i) }))
      // non-owners never see unavailable (unpublished) targets
      .filter((i) => isOwner || i.targetType !== 'PROPERTY' || (i.target as any)?.available),
  };
}

export async function getCollection(db: Db, actor: Actor | null, id: string) {
  const c = await maybeOne(db, `SELECT * FROM collections WHERE id = $1`, [id]);
  if (!c) throw notFound('Collection');
  const isOwner = !!actor && c.owner_id === actor.userId;
  if (!isOwner && c.visibility !== 'PUBLIC') throw notFound('Collection');
  return collectionWithItems(db, c, isOwner);
}

export async function getSharedCollection(db: Db, token: string) {
  const c = await maybeOne(db, `SELECT * FROM collections WHERE share_token = $1 AND visibility IN ('LINK','PUBLIC')`, [token]);
  if (!c) throw notFound('Collection');
  return collectionWithItems(db, c, false);
}

export async function addCollectionItem(ctx: Ctx, actor: Actor, id: string, item: { targetType: TargetType; targetId: string; note?: string | null }) {
  return withTx(ctx.app.pool, async (tx) => {
    await ownedCollection(tx, actor, id, true);
    const existing = await maybeOne(tx, `SELECT 1 FROM collection_items WHERE collection_id = $1 AND target_type = $2 AND target_id = $3`, [id, item.targetType, item.targetId]);
    if (existing) {
      if (item.note !== undefined) await tx.query(`UPDATE collection_items SET note = $4 WHERE collection_id = $1 AND target_type = $2 AND target_id = $3`, [id, item.targetType, item.targetId, item.note]);
      return { created: false };
    }
    const n = await maybeOne<{ n: number }>(tx, `SELECT count(*)::int AS n FROM collection_items WHERE collection_id = $1`, [id]);
    if ((n?.n ?? 0) >= 500) throw unprocessable('COLLECTION_FULL', 'A collection can hold at most 500 items');
    await assertTargetSaveable(tx, item.targetType, item.targetId);
    const rows = await q(
      tx,
      `INSERT INTO collection_items(collection_id, target_type, target_id, note) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING 1`,
      [id, item.targetType, item.targetId, item.note ?? null],
    );
    if (rows.length) await emit(tx, ctx, { aggregateType: 'collection', aggregateId: id, eventType: 'collection.item_added', payload: { collectionId: id, targetType: item.targetType, targetId: item.targetId } });
    return { created: rows.length > 0 };
  });
}

export async function removeCollectionItem(ctx: Ctx, actor: Actor, id: string, targetType: TargetType, targetId: string) {
  return withTx(ctx.app.pool, async (tx) => {
    await ownedCollection(tx, actor, id, true);
    const rows = await q(tx, `DELETE FROM collection_items WHERE collection_id = $1 AND target_type = $2 AND target_id = $3 RETURNING 1`, [id, targetType, targetId]);
    return { removed: rows.length > 0 };
  });
}
