import pg from 'pg';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Role } from '../src/platform/auth.js';
import { signAccessToken } from '../src/platform/auth.js';
import { hashPassword, sha256, randomToken } from '../src/platform/crypto.js';
import { drainOutbox } from '../src/platform/outbox.js';
import { runAllJobsOnce } from '../src/platform/jobs.js';
import { setFlag } from '../src/platform/flags.js';
import { systemCtx, type Ctx } from '../src/platform/context.js';

import { inject } from 'vitest';
const templateDb = () => (inject as any)('template') ?? process.env.JETPOOL_TEST_TEMPLATE;
const base = () => (process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/postgres').replace(/\/[^/]*$/, '');

export interface TestApp {
  app: FastifyInstance;
  dbName: string;
  pool: pg.Pool;
  close(): Promise<void>;
  /** process all pending outbox events (cross-module handlers) */
  drain(): Promise<void>;
  runJobs(): Promise<void>;
  ctx(): Ctx;
}

/** Fresh isolated database (cloned from the migrated template) + app instance for one test file. */
export async function createTestApp(config: Record<string, unknown> = {}): Promise<TestApp> {
  const dbName = `jetpool_t_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const admin = new pg.Client({ connectionString: `${base()}/postgres` });
  await admin.connect();
  // template DB must have no other connections while cloning; retry briefly if a parallel clone is running
  for (let i = 0; ; i++) {
    try {
      await admin.query(`CREATE DATABASE ${dbName} TEMPLATE ${templateDb()}`);
      break;
    } catch (e: any) {
      if (i > 50 || !String(e.message).includes('being accessed')) throw e;
      await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
    }
  }
  await admin.end();
  const app = await buildApp({
    logger: false,
    config: {
      NODE_ENV: 'test',
      DATABASE_URL: `${base()}/${dbName}`,
      DATABASE_POOL_MAX: 10,
      PAYMENT_PROVIDER: 'MOCK',
      OAUTH_MOCK: true,
      RATE_LIMIT_PER_MIN: 100000,
      ...config,
    } as any,
  });
  await app.ready();
  return {
    app,
    dbName,
    pool: app.ctx.pool,
    drain: () => drainOutbox(app.ctx),
    runJobs: () => runAllJobsOnce(app.ctx),
    ctx: () => systemCtx(app.ctx, `test-${randomUUID()}`),
    async close() {
      await app.close();
      const a = new pg.Client({ connectionString: `${base()}/postgres` });
      await a.connect();
      // pg-pool's end() resolves before its sockets are closed; let those backends exit first so the forced
      // drop does not terminate a still-attached pool client (a spurious "pg pool error" 57P01 on stderr)
      for (let i = 0; i < 50; i++) {
        const { rows } = await a.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1`, [dbName]);
        if (rows[0].n === 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      await a.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
      await a.end();
    },
  };
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  token: string;
  sessionId: string;
  headers: Record<string, string>;
}

/** Create a user directly in the DB with roles and a live session (aal2 for staff by default). */
export async function createUser(
  t: TestApp,
  opts: { roles?: Role[]; aal?: 'aal1' | 'aal2'; email?: string; verified?: boolean; displayName?: string } = {},
): Promise<TestUser> {
  const email = opts.email ?? `u_${randomUUID().slice(0, 8)}@test.jetpool.kr`;
  const password = 'Passw0rd!long';
  const { rows } = await t.pool.query(
    `INSERT INTO users(email, password_hash, display_name, email_verified_at, identity_verified_at)
     VALUES ($1,$2,$3, now(), CASE WHEN $4 THEN now() END) RETURNING id`,
    [email, await hashPassword(password), opts.displayName ?? email.split('@')[0], opts.verified ?? false],
  );
  const id = rows[0].id as string;
  for (const role of opts.roles ?? []) {
    await t.pool.query(`INSERT INTO user_roles(user_id, role) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [id, role]);
  }
  const staff = (opts.roles ?? []).some((r) => ['ADMIN', 'ACCOUNTING', 'SUPPORT', 'EDITOR', 'COMPLIANCE'].includes(r));
  const aal = opts.aal ?? (staff ? 'aal2' : 'aal1');
  const { rows: s } = await t.pool.query(
    `INSERT INTO sessions(user_id, refresh_token_hash, aal, expires_at) VALUES ($1,$2,$3, now() + interval '1 day') RETURNING id`,
    [id, sha256(randomToken()), aal],
  );
  const token = await signAccessToken(t.app.ctx.config, { sub: id, sid: s[0].id, aal });
  return { id, email, password, token, sessionId: s[0].id, headers: { authorization: `Bearer ${token}` } };
}

/** Typed-ish inject helper: returns {status, body}. */
export async function call(t: TestApp, user: TestUser | null, method: InjectOptions['method'], url: string, payload?: unknown, headers: Record<string, string> = {}) {
  const res = await t.app.inject({
    method,
    url,
    payload: payload as any,
    headers: { ...(user?.headers ?? {}), ...headers },
  });
  let body: any = res.body;
  try {
    body = res.json();
  } catch {}
  return { status: res.statusCode, body, headers: res.headers };
}

export const idem = () => ({ 'idempotency-key': `test-${randomUUID()}` });

export async function enableFlags(t: TestApp, ...keys: string[]) {
  for (const k of keys) await setFlag(t.pool, k, true);
}

/** Dates relative to today, YYYY-MM-DD. */
export function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
