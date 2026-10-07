import type { Db } from '../../platform/db.js';
import { maybeOne, q } from '../../platform/db.js';

export type ContextType = 'RESERVATION' | 'EXCHANGE' | 'GUIDE_BOOKING' | 'ORDER' | 'MESSAGE' | 'REVIEW' | 'OTHER';

export interface ContextParties {
  /** every user that is a party of the context */
  parties: string[];
  /** party -> role label */
  roles: Record<string, string>;
}

/** The user(s) who "own" a review target and may respond to / dispute about it. */
export async function reviewTargetOwners(db: Db, targetType: string, targetId: string): Promise<string[]> {
  switch (targetType) {
    case 'PROPERTY': {
      const p = await maybeOne<{ host_id: string }>(db, `SELECT host_id FROM properties WHERE id = $1`, [targetId]);
      return p ? [p.host_id] : [];
    }
    case 'TRAVEL_PRODUCT': {
      const p = await maybeOne<{ owner_user_id: string | null }>(db, `SELECT s.owner_user_id FROM travel_products tp JOIN suppliers s ON s.id = tp.supplier_id WHERE tp.id = $1`, [targetId]);
      return p?.owner_user_id ? [p.owner_user_id] : [];
    }
    default:
      return [targetId]; // HOST, GUEST, EXCHANGE_PARTNER, GUIDE, TRAVELER are user ids
  }
}

/**
 * Authoritative parties of a transaction/context, read from the owning domain tables (read-only).
 * Returns null when the context does not exist; OTHER has no resolvable parties.
 */
export async function resolveContextParties(db: Db, contextType: ContextType, contextId: string): Promise<ContextParties | null> {
  const two = (a: string, ra: string, b: string, rb: string): ContextParties => ({ parties: [a, b], roles: { [a]: ra, [b]: rb } });
  switch (contextType) {
    case 'RESERVATION': {
      const r = await maybeOne(db, `SELECT guest_id, host_id FROM reservations WHERE id = $1`, [contextId]);
      return r ? two(r.guest_id, 'GUEST', r.host_id, 'HOST') : null;
    }
    case 'EXCHANGE': {
      const r = await maybeOne(db, `SELECT requester_id, responder_id FROM exchange_requests WHERE id = $1`, [contextId]);
      return r ? two(r.requester_id, 'REQUESTER', r.responder_id, 'RESPONDER') : null;
    }
    case 'GUIDE_BOOKING': {
      const r = await maybeOne(db, `SELECT traveler_id, guide_id FROM guide_bookings WHERE id = $1`, [contextId]);
      return r ? two(r.traveler_id, 'TRAVELER', r.guide_id, 'GUIDE') : null;
    }
    case 'ORDER': {
      const o = await maybeOne(db, `SELECT buyer_id FROM orders WHERE id = $1`, [contextId]);
      if (!o) return null;
      const sellers = await q<{ owner_user_id: string }>(
        db,
        `SELECT DISTINCT s.owner_user_id FROM order_items i JOIN suppliers s ON s.id = i.supplier_id WHERE i.order_id = $1 AND s.owner_user_id IS NOT NULL`,
        [contextId],
      );
      const roles: Record<string, string> = { [o.buyer_id]: 'BUYER' };
      sellers.forEach((s) => (roles[s.owner_user_id] ??= 'SUPPLIER'));
      return { parties: Object.keys(roles), roles };
    }
    case 'MESSAGE': {
      const m = await maybeOne(db, `SELECT conversation_id, sender_id FROM messages WHERE id = $1`, [contextId]);
      if (!m) return null;
      const members = await q<{ user_id: string }>(db, `SELECT user_id FROM conversation_members WHERE conversation_id = $1`, [m.conversation_id]);
      const roles: Record<string, string> = {};
      members.forEach((x) => (roles[x.user_id] = x.user_id === m.sender_id ? 'SENDER' : 'RECIPIENT'));
      return { parties: Object.keys(roles), roles };
    }
    case 'REVIEW': {
      const r = await maybeOne(db, `SELECT author_id, target_type, target_id FROM reviews WHERE id = $1`, [contextId]);
      if (!r) return null;
      const roles: Record<string, string> = { [r.author_id]: 'AUTHOR' };
      for (const o of await reviewTargetOwners(db, r.target_type, r.target_id)) roles[o] ??= 'SUBJECT';
      return { parties: Object.keys(roles), roles };
    }
    default:
      return null;
  }
}

/** Pick the counterparty of `userId` in a context (MESSAGE: the sender; otherwise the other party). */
export function counterpartyOf(ctx: ContextParties, userId: string, contextType: ContextType): string | null {
  if (contextType === 'MESSAGE') {
    const sender = Object.entries(ctx.roles).find(([, r]) => r === 'SENDER')?.[0] ?? null;
    return sender && sender !== userId ? sender : ctx.parties.find((p) => p !== userId) ?? null;
  }
  return ctx.parties.find((p) => p !== userId) ?? null;
}
