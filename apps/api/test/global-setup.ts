import pg from 'pg';
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../../packages/db/migrate.mjs';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/db/migrations');

function adminUrl() {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres';
  return base.replace(/\/[^/]*$/, '/postgres');
}

/** Template name is derived from the migration set, so parallel test runs share it safely and a schema change gets a fresh one. */
export function templateName(): string {
  const h = createHash('sha256');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) h.update(f).update(readFileSync(path.join(MIGRATIONS, f)));
  return `jetpool_tpl_${h.digest('hex').slice(0, 12)}`;
}

export default async function setup({ provide }: { provide?: (k: string, v: unknown) => void } = {}) {
  const tpl = templateName();
  process.env.JETPOOL_TEST_TEMPLATE = tpl;
  provide?.('template', tpl);
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query('SELECT pg_advisory_lock(424242)');
  try {
    const exists = await admin.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [tpl]);
    if (exists.rowCount === 0) {
      const building = `${tpl}_build`;
      await admin.query(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${building}`);
      await migrate(adminUrl().replace(/\/postgres$/, `/${building}`), { log: () => {} });
      await admin.query(`ALTER DATABASE ${building} RENAME TO ${tpl}`);
    }
    // garbage-collect per-file databases older than 1 hour (left by crashed runs) and obsolete templates
    const stale = await admin.query(
      `SELECT d.datname FROM pg_database d
        WHERE (starts_with(d.datname, 'jetpool_t_') AND (pg_stat_file('base/' || d.oid || '/PG_VERSION')).modification < now() - interval '1 hour')
           OR (starts_with(d.datname, 'jetpool_tpl_') AND d.datname <> $1 AND (pg_stat_file('base/' || d.oid || '/PG_VERSION')).modification < now() - interval '1 hour')`,
      [tpl],
    ).catch(() => ({ rows: [] as any[] }));
    for (const r of stale.rows) await admin.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`).catch(() => {});
  } finally {
    await admin.query('SELECT pg_advisory_unlock(424242)');
    await admin.end();
  }
}
