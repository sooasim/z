import type pg from 'pg';
import type { FastifyRequest } from 'fastify';
import type { Tx } from './db.js';
import { maybeOne, withTx } from './db.js';
import { canonicalJson, sha256 } from './crypto.js';
import { badRequest, conflict, unprocessable } from './errors.js';

export interface IdempotentResult<T> { status: number; body: T; replayed: boolean }

export function idempotencyKeyFrom(req: FastifyRequest, required = true): string | null {
  const key = (req.headers['idempotency-key'] as string | undefined)?.trim();
  if (!key) {
    if (required) throw badRequest('IDEMPOTENCY_KEY_REQUIRED', 'Idempotency-Key header is required for this operation');
    return null;
  }
  if (key.length < 8 || key.length > 200) throw badRequest('IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 8-200 characters');
  return key;
}

/**
 * Exactly-once mutation. The key row and the business change commit in ONE transaction:
 * - a concurrent duplicate blocks on the unique key until the first commits, then replays its response;
 * - the same key with a different payload is rejected (422);
 * - if fn throws, nothing is stored and the client may retry with the same key.
 */
export async function withIdempotency<T>(
  pool: pg.Pool,
  scope: string,
  key: string | null,
  request: unknown,
  fn: (tx: Tx) => Promise<{ status?: number; body: T }>,
  opts: { isolation?: 'read committed' | 'serializable' } = {},
): Promise<IdempotentResult<T>> {
  if (!key) {
    return withTx(pool, async (tx) => {
      const r = await fn(tx);
      return { status: r.status ?? 200, body: r.body, replayed: false };
    }, opts);
  }
  const requestHash = sha256(canonicalJson(request ?? null));
  return withTx(pool, async (tx) => {
    const ins = await tx.query(
      `INSERT INTO idempotency_keys(scope, idempotency_key, request_hash) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [scope, key, requestHash],
    );
    if (ins.rowCount === 0) {
      const prev = await maybeOne<{ request_hash: string; response_status: number | null; response_body: T }>(
        tx,
        `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE scope = $1 AND idempotency_key = $2`,
        [scope, key],
      );
      if (!prev) throw conflict('IDEMPOTENCY_RACE', 'Retry the request');
      if (prev.request_hash !== requestHash) throw unprocessable('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was used with a different request');
      if (prev.response_status == null) throw conflict('IDEMPOTENCY_IN_PROGRESS', 'A request with this key is in progress');
      return { status: prev.response_status, body: prev.response_body, replayed: true };
    }
    const r = await fn(tx);
    const status = r.status ?? 200;
    await tx.query(
      `UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE scope = $1 AND idempotency_key = $2`,
      [scope, key, status, JSON.stringify(r.body ?? null)],
    );
    return { status, body: r.body, replayed: false };
  }, opts);
}
