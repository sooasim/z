import pg from 'pg';

// bigint (int8) → JS number. All money columns are *_minor bigint; values stay far below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// numeric → number
pg.types.setTypeParser(1700, (v) => Number(v));
// date → 'YYYY-MM-DD' string (avoid timezone shifts)
pg.types.setTypeParser(1082, (v) => v);

export type Db = pg.Pool | pg.PoolClient;
export type Tx = pg.PoolClient;

export function createPool(connectionString: string, max = 20): pg.Pool {
  const pool = new pg.Pool({ connectionString, max, idleTimeoutMillis: 30_000, application_name: 'jetpool-api' });
  pool.on('error', (err) => console.error('pg pool error', err));
  return pool;
}

export async function q<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await db.query(sql, params as any[]);
  return res.rows as T[];
}

export async function one<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T> {
  const rows = await q<T>(db, sql, params);
  if (rows.length !== 1) throw new Error(`expected exactly one row, got ${rows.length}`);
  return rows[0];
}

export async function maybeOne<T = any>(db: Db, sql: string, params: unknown[] = []): Promise<T | null> {
  const rows = await q<T>(db, sql, params);
  return rows[0] ?? null;
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected

/**
 * Run fn inside a transaction. Retries on serialization failures / deadlocks.
 * Use isolation 'serializable' for availability-sensitive write paths where an exclusion
 * constraint alone is not sufficient.
 */
export async function withTx<T>(
  pool: pg.Pool,
  fn: (tx: Tx) => Promise<T>,
  opts: { isolation?: 'read committed' | 'repeatable read' | 'serializable'; retries?: number } = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${(opts.isolation ?? 'read committed').toUpperCase()}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if (RETRYABLE.has(err?.code) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 10 * 2 ** attempt + Math.random() * 10));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
