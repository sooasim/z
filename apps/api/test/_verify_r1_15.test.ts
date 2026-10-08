import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp } from './helpers.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());

async function liveSessions(userId: string) {
  const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  return rows[0].n as number;
}

describe('r1_15 concurrent refresh', () => {
  it('A: two parallel refreshes with the same token (plain Promise.all)', async () => {
    const admin = await createUser(t, { roles: ['ADMIN'] });
    const u = await createUser(t);
    const login = await call(t, null, 'POST', '/v1/auth/login', { email: u.email, password: u.password });
    expect(login.status).toBe(200);
    console.log('A live sessions before:', await liveSessions(u.id));
    const [a, b] = await Promise.all([
      call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: login.body.refreshToken }),
      call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: login.body.refreshToken }),
    ]);
    console.log('A responses:', JSON.stringify([{ s: a.status, code: a.body.code, sid: a.body.sessionId }, { s: b.status, code: b.body.code, sid: b.body.sessionId }]));
    const winner = a.status === 200 ? a : b;
    const me = await call(t, { headers: { authorization: `Bearer ${winner.body.accessToken}` } } as any, 'GET', '/v1/me');
    console.log('A winner /v1/me status:', me.status);
    const winnerNext = await call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: winner.body.refreshToken });
    console.log('A winner rotated token refresh:', winnerNext.status, winnerNext.body.code);
    console.log('A live sessions after:', await liveSessions(u.id));
    await t.drain();
    const { rows: risk } = await t.pool.query(`SELECT risk_type, severity, status FROM risk_events WHERE subject_id = $1`, [u.id]);
    console.log('A risk events:', JSON.stringify(risk));
    const { rows: notes } = await t.pool.query(`SELECT user_id, template_key, title FROM notifications WHERE user_id = ANY($1::uuid[])`, [[u.id, admin.id]]);
    console.log('A notifications:', JSON.stringify(notes));
  });

  it('B: forced overlap: hold the row lock externally, fire both, release', async () => {
    const u = await createUser(t);
    const login = await call(t, null, 'POST', '/v1/auth/login', { email: u.email, password: u.password });
    expect(login.status).toBe(200);
    const locker = new pg.Client({ connectionString: `postgres://postgres@localhost:5432/${t.dbName}` });
    await locker.connect();
    await locker.query('BEGIN');
    await locker.query(`SELECT id FROM sessions WHERE id = $1 FOR UPDATE`, [login.body.sessionId]);
    const pa = call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: login.body.refreshToken });
    const pb = call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: login.body.refreshToken });
    // wait until both backends are blocked on the lock
    for (let i = 0; i < 100; i++) {
      const { rows } = await locker.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [t.dbName]);
      if (rows[0].n >= 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const { rows: waiting } = await locker.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [t.dbName]);
    console.log('B backends waiting on lock:', waiting[0].n);
    await locker.query('COMMIT');
    await locker.end();
    const [a, b] = await Promise.all([pa, pb]);
    console.log('B responses:', JSON.stringify([{ s: a.status, code: a.body.code }, { s: b.status, code: b.body.code }]));
    console.log('B live sessions after:', await liveSessions(u.id));
    const { rows: audit } = await t.pool.query(`SELECT action FROM audit_logs WHERE action = 'auth.refresh_token_reuse' AND resource_id = $1`, [login.body.sessionId]);
    console.log('B reuse audit rows:', audit.length);
  });
});
