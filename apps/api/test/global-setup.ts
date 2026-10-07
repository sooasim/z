import pg from 'pg';
import { migrate } from '../../../packages/db/migrate.mjs';

export const TEMPLATE_DB = 'jetpool_test_template';

function adminUrl() {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres';
  return base.replace(/\/[^/]*$/, '/postgres');
}

export default async function setup() {
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE_DB} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  await migrate(adminUrl().replace(/\/postgres$/, `/${TEMPLATE_DB}`), { log: () => {} });
  // drop stale per-file databases from previous runs
  const { rows } = await admin.query(`SELECT datname FROM pg_database WHERE starts_with(datname, 'jetpool_t_')`);
  for (const r of rows) await admin.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
  await admin.end();
  return async () => {
    const a = new pg.Client({ connectionString: adminUrl() });
    await a.connect();
    const { rows } = await a.query(`SELECT datname FROM pg_database WHERE starts_with(datname, 'jetpool_t_')`);
    for (const r of rows) await a.query(`DROP DATABASE IF EXISTS ${r.datname} WITH (FORCE)`);
    await a.end();
  };
}
