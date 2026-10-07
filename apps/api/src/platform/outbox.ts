import type pg from 'pg';
import type { Db, Tx } from './db.js';
import { q, withTx } from './db.js';
import type { Ctx, AppContext } from './context.js';
import { systemCtx } from './context.js';
import { outboxDeadLettered, outboxDispatched, outboxFailed } from './metrics.js';

export interface DomainEvent<P = any> {
  id: string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  version: number;
  payload: P;
  correlation_id: string;
  created_at: string;
}

/** Append a domain event in the SAME transaction as the state change (transactional outbox). */
export async function emit(
  tx: Tx | Db,
  ctx: Pick<Ctx, 'correlationId'>,
  e: { aggregateType: string; aggregateId: string; eventType: string; payload: unknown; version?: number },
): Promise<string> {
  const [row] = await q<{ id: string }>(
    tx,
    `INSERT INTO outbox_events(aggregate_type, aggregate_id, event_type, version, payload, correlation_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [e.aggregateType, e.aggregateId, e.eventType, e.version ?? 1, JSON.stringify(e.payload ?? {}), ctx.correlationId],
  );
  return row.id;
}

export type EventHandler = (tx: Tx, event: DomainEvent, ctx: Ctx) => Promise<void>;
interface Registration { consumer: string; pattern: string; handler: EventHandler }

const registrations: Registration[] = [];

/**
 * Subscribe a consumer to an event type ('reservation.confirmed'), a prefix ('reservation.*') or '*'.
 * Each (consumer, event) pair is processed exactly once thanks to outbox_consumptions.
 */
export function onEvent(pattern: string, consumer: string, handler: EventHandler) {
  if (registrations.some((r) => r.consumer === consumer && r.pattern === pattern)) return;
  registrations.push({ consumer, pattern, handler });
}

const matches = (pattern: string, type: string) =>
  pattern === '*' || pattern === type || (pattern.endsWith('.*') && type.startsWith(pattern.slice(0, -1)));

const MAX_ATTEMPTS = 8;

/** Process one batch of pending outbox events. Safe to run concurrently (SKIP LOCKED). Returns processed count. */
export async function dispatchOutbox(app: AppContext, limit = 50): Promise<number> {
  const pool: pg.Pool = app.pool;
  // metrics are counted only once the dispatch tx has committed (withTx may retry fn)
  let stats = { dispatched: [] as string[], failed: [] as string[], deadLettered: 0 };
  const processed = await withTx(pool, async (tx) => {
    stats = { dispatched: [], failed: [], deadLettered: 0 };
    const events = await q<DomainEvent & { attempts: number }>(
      tx,
      `SELECT * FROM outbox_events
        WHERE published_at IS NULL AND dead_lettered_at IS NULL AND available_at <= now()
        ORDER BY created_at, id LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const ev of events) {
      const handlers = registrations.filter((r) => matches(r.pattern, ev.event_type));
      let failed: string | null = null;
      for (const h of handlers) {
        await tx.query('SAVEPOINT h');
        try {
          const ins = await tx.query(
            `INSERT INTO outbox_consumptions(consumer, event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
            [h.consumer, ev.id],
          );
          if (ins.rowCount === 1) await h.handler(tx, ev, systemCtx(app, ev.correlation_id));
          await tx.query('RELEASE SAVEPOINT h');
        } catch (err: any) {
          await tx.query('ROLLBACK TO SAVEPOINT h');
          failed = `${h.consumer}: ${err?.message ?? err}`;
          stats.failed.push(h.consumer);
          app.log.error({ err, event: ev.event_type, consumer: h.consumer }, 'outbox handler failed');
        }
      }
      if (failed) {
        const attempts = ev.attempts + 1;
        await tx.query(
          `UPDATE outbox_events SET attempts = $2::int, last_error = $3,
              available_at = now() + make_interval(secs => $4::double precision),
              dead_lettered_at = CASE WHEN $2::int >= $5::int THEN now() END
            WHERE id = $1`,
          [ev.id, attempts, failed, Math.min(2 ** attempts, 3600), MAX_ATTEMPTS],
        );
        if (attempts >= MAX_ATTEMPTS) stats.deadLettered++;
      } else {
        await tx.query(`UPDATE outbox_events SET published_at = now() WHERE id = $1`, [ev.id]);
        stats.dispatched.push(ev.event_type);
      }
      app.realtime.publish(`events:${ev.event_type}`, ev);
    }
    return events.length;
  });
  for (const t of stats.dispatched) outboxDispatched.inc({ event_type: t });
  for (const c of stats.failed) outboxFailed.inc({ consumer: c });
  if (stats.deadLettered) outboxDeadLettered.inc(stats.deadLettered);
  return processed;
}

/** Drain the outbox until empty (tests / one-shot jobs). */
export async function drainOutbox(app: AppContext, maxRounds = 50) {
  for (let i = 0; i < maxRounds; i++) if ((await dispatchOutbox(app)) === 0) return;
}
