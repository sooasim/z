import type { Db } from './db.js';
import { maybeOne } from './db.js';
import type { Ctx } from './context.js';
import { conflict, notFound } from './errors.js';

export type ActorType = 'USER' | 'ADMIN' | 'SYSTEM' | 'PROVIDER';

/**
 * Explicit, enumerated state machine. Only listed transitions are accepted (STAY-09 acceptance);
 * every transition is persisted in state_transitions with actor, reason and correlation id.
 */
export class StateMachine<S extends string> {
  constructor(
    public readonly aggregateType: string,
    public readonly transitions: Readonly<Record<S, readonly S[]>>,
  ) {}

  can(from: S, to: S): boolean {
    return (this.transitions[from] ?? []).includes(to);
  }

  assert(from: S, to: S): void {
    if (!this.can(from, to)) {
      throw conflict('INVALID_STATE_TRANSITION', `${this.aggregateType} cannot move from ${from} to ${to}`, { from, to });
    }
  }

  /**
   * Compare-and-set transition on `table`. Uses `WHERE status = from` so concurrent writers cannot
   * both win; bumps `version` when the table has one. Extra column updates may be passed in `set`.
   */
  async transition(
    db: Db,
    ctx: Ctx,
    args: {
      table: string;
      id: string;
      to: S;
      from?: S | readonly S[];
      reason?: string;
      actorType?: ActorType;
      metadata?: Record<string, unknown>;
      set?: Record<string, unknown>;
      /** set true for tables with a `version integer` column (reservations, exchange_requests, guide_bookings, orders, payments) */
      versioned?: boolean;
    },
  ): Promise<{ from: S; to: S; row: any }> {
    const current = await maybeOne<{ status: S }>(db, `SELECT status FROM ${args.table} WHERE id = $1 FOR UPDATE`, [args.id]);
    if (!current) throw notFound(this.aggregateType);
    const allowedFrom = args.from === undefined ? null : Array.isArray(args.from) ? args.from : [args.from];
    if (allowedFrom && !allowedFrom.includes(current.status)) {
      throw conflict('INVALID_STATE_TRANSITION', `${this.aggregateType} is ${current.status}, expected ${allowedFrom.join('|')}`, {
        from: current.status,
        to: args.to,
      });
    }
    this.assert(current.status, args.to);
    const set: Record<string, unknown> = { ...(args.set ?? {}), status: args.to };
    const cols = Object.keys(set);
    const params: unknown[] = [args.id, current.status, ...cols.map((c) => normalize(set[c]))];
    const assignments = cols.map((c, i) => `${c} = $${i + 3}`);
    if (args.versioned) assignments.push('version = version + 1');
    const row = await maybeOne(
      db,
      `UPDATE ${args.table} SET ${assignments.join(', ')} WHERE id = $1 AND status = $2 RETURNING *`,
      params,
    );
    if (!row) throw conflict('CONCURRENT_MODIFICATION', `${this.aggregateType} changed concurrently; retry`);
    await recordTransition(db, ctx, {
      aggregateType: this.aggregateType,
      aggregateId: args.id,
      from: current.status,
      to: args.to,
      reason: args.reason,
      actorType: args.actorType,
      metadata: args.metadata,
    });
    return { from: current.status, to: args.to, row };
  }
}

function normalize(v: unknown) {
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) return JSON.stringify(v);
  return v;
}

export async function recordTransition(
  db: Db,
  ctx: Ctx,
  t: { aggregateType: string; aggregateId: string; from: string | null; to: string; reason?: string; actorType?: ActorType; metadata?: Record<string, unknown> },
) {
  await db.query(
    `INSERT INTO state_transitions(aggregate_type, aggregate_id, from_state, to_state, actor_id, actor_type, reason, correlation_id, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      t.aggregateType,
      t.aggregateId,
      t.from,
      t.to,
      ctx.actor?.userId ?? null,
      t.actorType ?? (ctx.actor ? 'USER' : 'SYSTEM'),
      t.reason ?? null,
      ctx.correlationId,
      JSON.stringify(t.metadata ?? {}),
    ],
  );
}
