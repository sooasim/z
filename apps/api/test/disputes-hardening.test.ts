import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { liftSanction } from '../src/modules/disputes/service.js';
import { holdReason } from '../src/modules/finance/settlement.js';
import type { Ctx } from '../src/platform/context.js';
import type { Actor } from '../src/platform/auth.js';

/** Regression tests for the trust r1 disputes / sanctions findings. */
let t: TestApp;
let admin: TestUser, admin2: TestUser, compliance: TestUser;

const status = async (id: string) => (await t.pool.query(`SELECT status FROM users WHERE id = $1`, [id])).rows[0].status as string;
const actorCtx = (u: TestUser, roles: Actor['roles']): Ctx => ({ ...t.ctx(), actor: { userId: u.id, sessionId: u.sessionId, roles, aal: 'aal2', status: 'ACTIVE' } });

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  admin2 = await createUser(t, { roles: ['ADMIN'] });
  compliance = await createUser(t, { roles: ['COMPLIANCE'] });
});
afterAll(async () => t.close());

describe('sanction expiry never undoes a later manual suspension', () => {
  it('expired sanctions are processed once; a later admin suspension survives the sweep', async () => {
    const u = await createUser(t);
    const s = await call(t, admin, 'POST', '/v1/admin/sanctions', { userId: u.id, sanctionType: 'ACCOUNT_SUSPENSION', reason: 'cool-off period', endsAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(s.status).toBe(201);
    await t.pool.query(`UPDATE sanctions SET ends_at = now() - interval '1 second' WHERE id = $1`, [s.body.item.id]);
    await t.runJobs();
    expect(await status(u.id)).toBe('ACTIVE');
    const row = (await t.pool.query(`SELECT lifted_at, lifted_by, lift_reason FROM sanctions WHERE id = $1`, [s.body.item.id])).rows[0];
    expect(row.lifted_at).toBeTruthy();
    expect(row).toMatchObject({ lifted_by: null, lift_reason: 'EXPIRED' });

    const manual = await call(t, admin, 'POST', `/v1/admin/users/${u.id}/suspend`, { reason: 'fraud confirmed' });
    expect(manual.body.changed).toBe(true);
    await t.runJobs();
    await t.runJobs();
    expect(await status(u.id)).toBe('SUSPENDED');
    expect((await call(t, null, 'POST', '/v1/auth/login', { email: u.email, password: u.password })).status).toBe(403);
  });

  it('a manual suspension while a time-boxed sanction runs outlives the sanction (expiry and lift)', async () => {
    for (const end of ['expire', 'lift'] as const) {
      const u = await createUser(t);
      const s = await call(t, admin, 'POST', '/v1/admin/sanctions', { userId: u.id, sanctionType: 'ACCOUNT_SUSPENSION', reason: 'cool-off', endsAt: new Date(Date.now() + 3600_000).toISOString() });
      expect(await status(u.id)).toBe('SUSPENDED');
      // fraud found while the sanction runs: the admin takes over the suspension
      expect((await call(t, admin, 'POST', `/v1/admin/users/${u.id}/suspend`, { reason: 'fraud confirmed' })).status).toBe(200);
      if (end === 'expire') {
        await t.pool.query(`UPDATE sanctions SET ends_at = now() - interval '1 second' WHERE id = $1`, [s.body.item.id]);
        await t.runJobs();
      } else {
        const lift = await call(t, compliance, 'POST', `/v1/admin/sanctions/${s.body.item.id}/lift`, { reason: 'appeal granted' });
        expect(lift.status).toBe(200);
        expect(lift.body.item.accountRestored).toBe(false);
      }
      expect(await status(u.id)).toBe('SUSPENDED');
      // an explicit admin restore still works
      expect((await call(t, admin, 'POST', `/v1/admin/users/${u.id}/restore`, { reason: 'cleared' })).body.changed).toBe(true);
    }
  });

  it('a lift that started before a concurrent BAN committed does not restore the banned account', async () => {
    const u = await createUser(t);
    const s1 = await call(t, admin, 'POST', '/v1/admin/sanctions', { userId: u.id, sanctionType: 'ACCOUNT_SUSPENSION', reason: 'first incident' });
    expect(s1.status).toBe(201);
    const liftTx = await t.pool.connect();
    try {
      await liftTx.query('BEGIN');
      await liftTx.query('SELECT now()'); // the lift transaction's now() is fixed here
      await new Promise((r) => setTimeout(r, 30));
      const ban = await call(t, admin2, 'POST', '/v1/admin/sanctions', { userId: u.id, sanctionType: 'BAN', reason: 'second incident' });
      expect(ban.status).toBe(201);
      const out = await liftSanction(liftTx, actorCtx(compliance, ['USER', 'COMPLIANCE']), s1.body.item.id, 'appeal');
      expect(out.accountRestored).toBe(false);
      await liftTx.query('COMMIT');
    } catch (e) {
      await liftTx.query('ROLLBACK');
      throw e;
    } finally {
      liftTx.release();
    }
    expect(await status(u.id)).toBe('SUSPENDED');
  });
});

describe('sanction lifting guards', () => {
  it('staff cannot lift their own sanction; only ADMIN lifts sanctions on staff', async () => {
    const insider = await createUser(t, { roles: ['COMPLIANCE', 'HOST'] });
    const hold = await call(t, admin, 'POST', '/v1/admin/sanctions', { userId: insider.id, sanctionType: 'PAYOUT_HOLD', reason: 'under investigation' });
    expect(hold.status).toBe(201);
    const self = await call(t, insider, 'POST', `/v1/admin/sanctions/${hold.body.item.id}/lift`, { reason: 'n/a' });
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('SELF_LIFT_FORBIDDEN');
    expect(await holdReason(t.pool, insider.id, [])).toMatch(/^PAYOUT_HOLD_SANCTION/);

    const colleague = await createUser(t, { roles: ['SUPPORT', 'HOST'] });
    const listing = await call(t, admin, 'POST', '/v1/admin/sanctions', { userId: colleague.id, sanctionType: 'LISTING_SUSPENSION', reason: 'policy breach' });
    const byCompliance = await call(t, compliance, 'POST', `/v1/admin/sanctions/${listing.body.item.id}/lift`, { reason: 'looks fine' });
    expect(byCompliance.status).toBe(403);
    expect(byCompliance.body.code).toBe('ROLE_REQUIRED');
    expect((await call(t, admin2, 'POST', `/v1/admin/sanctions/${listing.body.item.id}/lift`, { reason: 'reviewed' })).status).toBe(200);
    expect((await call(t, admin2, 'POST', `/v1/admin/sanctions/${hold.body.item.id}/lift`, { reason: 'cleared' })).status).toBe(200);
  });
});

describe('disputes cannot be used to freeze an arbitrary payee', () => {
  it('OTHER disputes never set a client-chosen counterparty, cannot point at transactions and are capped', async () => {
    const stranger = await createUser(t);
    const victim = await createUser(t, { roles: ['SUPPLIER'] });
    const d = await call(t, stranger, 'POST', '/v1/disputes', { contextType: 'OTHER', contextId: crypto.randomUUID(), reason: 'xxx', counterpartyId: victim.id });
    expect(d.status).toBe(201);
    expect(d.body.item.counterparty_id).toBeNull();
    expect(await holdReason(t.pool, victim.id, [])).toBeNull();
    // the suggestion is kept for staff only
    const staff = await createUser(t, { roles: ['SUPPORT'] });
    const detail = await call(t, staff, 'GET', `/v1/admin/disputes/${d.body.item.id}`);
    expect(detail.body.item.timeline.some((e: any) => e.event_type === 'COUNTERPARTY_NAMED' && e.note.includes(victim.id))).toBe(true);
    expect((await call(t, stranger, 'GET', `/v1/disputes/${d.body.item.id}`)).body.item.timeline.some((e: any) => e.event_type === 'COUNTERPARTY_NAMED')).toBe(false);
    expect((await call(t, victim, 'GET', `/v1/disputes/${d.body.item.id}`)).status).toBe(404);

    // a transaction id must be disputed under its own context (party check), not as OTHER
    const host = await createUser(t, { roles: ['HOST'] });
    const guest = await createUser(t);
    const p = (await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'P','HOUSE') RETURNING id`, [host.id])).rows[0].id;
    const res = (
      await t.pool.query(
        `INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, total_minor, currency, quote_snapshot)
         VALUES ($1,$2,$3,'COMPLETED', current_date - 5, current_date - 2, 100000, 'KRW', '{}') RETURNING id`,
        [p, host.id, guest.id],
      )
    ).rows[0].id;
    const viaOther = await call(t, stranger, 'POST', '/v1/disputes', { contextType: 'OTHER', contextId: res, reason: 'xxx' });
    expect(viaOther.status).toBe(422);
    expect(viaOther.body.code).toBe('USE_TRANSACTION_CONTEXT');
    expect(await holdReason(t.pool, host.id, [res])).toBeNull();

    // cap on open general disputes per opener
    for (let i = 0; i < 2; i++) expect((await call(t, stranger, 'POST', '/v1/disputes', { contextType: 'OTHER', contextId: crypto.randomUUID(), reason: 'again' })).status).toBe(201);
    const fourth = await call(t, stranger, 'POST', '/v1/disputes', { contextType: 'OTHER', contextId: crypto.randomUUID(), reason: 'again' });
    expect(fourth.status).toBe(429);
    expect(fourth.body.code).toBe('TOO_MANY_OPEN_DISPUTES');
  });

  it('a MESSAGE dispute must reference a message sent by the other party', async () => {
    const host = await createUser(t, { roles: ['HOST'] });
    const asker = await createUser(t);
    const conv = (await t.pool.query(`INSERT INTO conversations(context_type, created_by) VALUES ('INQUIRY',$1) RETURNING id`, [asker.id])).rows[0].id;
    await t.pool.query(`INSERT INTO conversation_members(conversation_id, user_id, role) VALUES ($1,$2,'MEMBER'),($1,$3,'MEMBER')`, [conv, asker.id, host.id]);
    const own = (await t.pool.query(`INSERT INTO messages(conversation_id, sender_id, body) VALUES ($1,$2,'is it available?') RETURNING id`, [conv, asker.id])).rows[0].id;
    const r = await call(t, asker, 'POST', '/v1/disputes', { contextType: 'MESSAGE', contextId: own, reason: 'freeze the host' });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('INVALID_COUNTERPARTY');
    expect(await holdReason(t.pool, host.id, [])).toBeNull();
    const theirs = (await t.pool.query(`INSERT INTO messages(conversation_id, sender_id, body) VALUES ($1,$2,'rude reply') RETURNING id`, [conv, host.id])).rows[0].id;
    const ok = await call(t, asker, 'POST', '/v1/disputes', { contextType: 'MESSAGE', contextId: theirs, reason: 'abusive reply' });
    expect(ok.status).toBe(201);
    expect(ok.body.item.counterparty_id).toBe(host.id);
  });
});
