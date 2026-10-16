/**
 * CORE-01 demo sign-in. A demo deployment exists to be clicked through, and typing an e-mail and a shared
 * password for each of the nine seeded roles is the slowest part of that. These routes let the login page offer
 * one button per role instead — without ever shipping a password to the browser, which is why the sign-in takes
 * a role key and no credential at all.
 *
 * It is a demo feature and it is gated like one: `DEMO_LOGINS` defaults to whatever `OAUTH_MOCK` is (a mocked
 * environment is a demo environment), production refuses both, and with the gate off the list is empty and the
 * sign-in is a 404 — the same answer an environment that never had these accounts would give.
 */
import type pg from 'pg';
import type { Ctx } from '../../platform/context.js';
import { notFound, forbidden } from '../../platform/errors.js';
import { maybeOne, q, withTx, type Db } from '../../platform/db.js';
import { audit } from '../../platform/audit.js';
import { accountSummary, issueSession } from './users.js';

/**
 * The seeded personas, in the order the login page shows them (packages/db/seed-dev.mjs). The key is the
 * contract with the web, which owns the Korean/English labels; only the e-mail belongs here, so an environment
 * seeded differently simply yields a shorter list.
 */
export const DEMO_ACCOUNTS = [
  { key: 'guest', email: 'guest@jetpool.dev' },
  { key: 'host-seoul', email: 'host.seoul@jetpool.dev' },
  { key: 'host-jeju', email: 'host.jeju@jetpool.dev' },
  { key: 'exchange', email: 'exchange.busan@jetpool.dev' },
  { key: 'guide-friend', email: 'friend.guide@jetpool.dev' },
  { key: 'guide-pro', email: 'pro.guide@jetpool.dev' },
  { key: 'supplier', email: 'supplier@jetpool.dev' },
  { key: 'accounting', email: 'accounting@jetpool.dev' },
  { key: 'admin', email: 'admin@jetpool.dev' },
] as const;

export type DemoAccountKey = (typeof DEMO_ACCOUNTS)[number]['key'];

const byEmail = new Map<string, string>(DEMO_ACCOUNTS.map((a) => [a.email, a.key]));
const emails: string[] = DEMO_ACCOUNTS.map((a) => a.email);
const order = new Map<string, number>(DEMO_ACCOUNTS.map((a, i) => [a.key, i]));

export interface DemoAccount {
  key: string;
  email: string;
  displayName: string;
  roles: string[];
}

/** The demo accounts this environment actually has. Empty when the gate is off — never an error. */
export async function listDemoAccounts(db: Db, enabled: boolean): Promise<DemoAccount[]> {
  if (!enabled) return [];
  const rows = await q<{ email: string; display_name: string | null; roles: string[] | null }>(
    db,
    `SELECT u.email, u.display_name, array_remove(array_agg(ur.role), NULL) AS roles
       FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id
      WHERE u.email = ANY($1::text[]) AND u.status = 'ACTIVE'
      GROUP BY u.id, u.email, u.display_name`,
    [emails],
  );
  return rows
    .map((r) => ({ key: byEmail.get(r.email)!, email: r.email, displayName: r.display_name ?? r.email.split('@')[0], roles: (r.roles ?? []).sort() }))
    .sort((a, b) => (order.get(a.key) ?? 0) - (order.get(b.key) ?? 0));
}

/**
 * Sign in as a seeded demo persona. No password is taken or checked: the gate is the environment, so there is
 * nothing a caller could learn here that `listDemoAccounts` does not already say out loud. The session is
 * recorded as `TEST` so an audit reader can tell these apart from real password logins.
 */
export async function demoLogin(pool: pg.Pool, ctx: Ctx, key: string, enabled: boolean) {
  if (!enabled) throw notFound('Demo sign-in');
  const acct = DEMO_ACCOUNTS.find((a) => a.key === key);
  if (!acct) throw notFound('Demo account');
  return withTx(pool, async (tx) => {
    const u = await maybeOne<{ id: string; status: string }>(tx, `SELECT id, status FROM users WHERE email = $1`, [acct.email as string]);
    if (!u) throw notFound('Demo account');
    if (u.status !== 'ACTIVE') throw forbidden('ACCOUNT_SUSPENDED', 'Account is not active');
    await tx.query(`UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`, [u.id]);
    const s = await issueSession(tx, ctx, { userId: u.id, authMethod: 'TEST' });
    await audit(tx, ctx, { action: 'auth.login', resourceType: 'session', resourceId: s.sessionId, after: { method: 'TEST', demoAccount: acct.key }, category: 'SECURITY', actorId: u.id });
    return { ...s, user: await accountSummary(tx, u.id) };
  });
}
