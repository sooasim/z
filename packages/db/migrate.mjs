#!/usr/bin/env node
// Forward-only migration runner (G2: forward-fix tested). Each file runs in its own transaction,
// recorded with a sha256 checksum; a modified, already-applied migration aborts the run.
import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(databaseUrl, { log = console.log } = {}) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    await client.query('SELECT pg_advisory_lock(727274)');
    const applied = new Map((await client.query('SELECT filename, checksum FROM schema_migrations')).rows.map(r => [r.filename, r.checksum]));
    const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
    let count = 0;
    for (const f of files) {
      const sql = await readFile(path.join(dir, f), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      if (applied.has(f)) {
        if (applied.get(f) !== sum) throw new Error(`migration ${f} was modified after being applied; write a new forward-fix migration instead`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(filename, checksum) VALUES ($1,$2)', [f, sum]);
        await client.query('COMMIT');
        log(`applied ${f}`);
        count++;
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${f} failed: ${e.message}`);
      }
    }
    await client.query('SELECT pg_advisory_unlock(727274)');
    return count;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/jetpool';
  const verify = process.argv.includes('--verify');
  let target = url;
  if (verify) {
    // apply all migrations twice on a scratch database: proves clean apply + idempotent re-run
    const admin = new pg.Client({ connectionString: url.replace(/\/[^/]*$/, '/postgres') });
    await admin.connect();
    const scratch = `jetpool_migverify_${Date.now()}`;
    await admin.query(`CREATE DATABASE ${scratch}`);
    target = url.replace(/\/[^/]*$/, `/${scratch}`);
    try {
      const n = await migrate(target);
      const again = await migrate(target, { log: () => {} });
      if (again !== 0) throw new Error('re-run applied migrations again');
      console.log(`verify ok: ${n} migrations applied cleanly, re-run is a no-op`);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
      await admin.end();
    }
  } else {
    await migrate(target);
  }
}
