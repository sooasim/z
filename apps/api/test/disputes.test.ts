import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { withTx } from '../src/platform/db.js';
import { assertElevatedAccess } from '../src/modules/disputes/service.js';
import type { Ctx } from '../src/platform/context.js';
import type { Actor } from '../src/platform/auth.js';

let t: TestApp;
let host: TestUser, guest: TestUser, stranger: TestUser, agent: TestUser, admin: TestUser, compliance: TestUser;
let propertyId: string, reservationId: string, conversationId: string, otherConversationId: string;

const actorCtx = (u: TestUser, roles: Actor['roles'], aal: 'aal1' | 'aal2' = 'aal2'): Ctx => ({ ...t.ctx(), actor: { userId: u.id, sessionId: u.sessionId, roles, aal, status: 'ACTIVE' } });

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
  guest = await createUser(t);
  stranger = await createUser(t);
  agent = await createUser(t, { roles: ['SUPPORT'] });
  admin = await createUser(t, { roles: ['ADMIN'] });
  compliance = await createUser(t, { roles: ['COMPLIANCE'] });
  propertyId = (await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'P','HOUSE') RETURNING id`, [host.id])).rows[0].id;
  reservationId = (
    await t.pool.query(
      `INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, total_minor, currency, quote_snapshot)
       VALUES ($1,$2,$3,'CONFIRMED', current_date + 3, current_date + 5, 100000, 'KRW', '{}') RETURNING id`,
      [propertyId, host.id, guest.id],
    )
  ).rows[0].id;
  conversationId = (await t.pool.query(`INSERT INTO conversations(context_type, context_id, created_by) VALUES ('RESERVATION',$1,$2) RETURNING id`, [reservationId, guest.id])).rows[0].id;
  await t.pool.query(`INSERT INTO conversation_members(conversation_id, user_id, role) VALUES ($1,$2,'GUEST'),($1,$3,'HOST')`, [conversationId, guest.id, host.id]);
  await t.pool.query(`INSERT INTO messages(conversation_id, sender_id, body) VALUES ($1,$2,'private text')`, [conversationId, host.id]);
  otherConversationId = (await t.pool.query(`INSERT INTO conversations(context_type, created_by) VALUES ('INQUIRY',$1) RETURNING id`, [stranger.id])).rows[0].id;
  await t.pool.query(`INSERT INTO conversation_members(conversation_id, user_id, role) VALUES ($1,$2,'MEMBER'),($1,$3,'MEMBER')`, [otherConversationId, stranger.id, host.id]);
});
afterAll(async () => t.close());

async function openDispute(by: TestUser = guest) {
  const r = await call(t, by, 'POST', '/v1/disputes', { contextType: 'RESERVATION', contextId: reservationId, reason: 'Listing not as described', description: 'Photos misleading' });
  return r;
}

describe('TRUST-03 disputes', () => {
  let disputeId: string;

  it('only parties can open; counterparty derived; dispute.opened emitted; duplicate open refused', async () => {
    expect((await call(t, stranger, 'POST', '/v1/disputes', { contextType: 'RESERVATION', contextId: reservationId, reason: 'nosy person' })).status).toBe(403);
    const r = await openDispute();
    expect(r.status).toBe(201);
    disputeId = r.body.item.id;
    expect(r.body.item.counterparty_id).toBe(host.id);
    expect(r.body.item.status).toBe('OPEN');
    expect((await openDispute()).body.code).toBe('DISPUTE_ALREADY_OPEN');
    const { rows } = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'dispute.opened' AND aggregate_id = $1`, [disputeId]);
    expect(rows[0].payload).toMatchObject({ contextType: 'RESERVATION', contextId: reservationId, counterpartyId: host.id });
    // counterparty sees it; strangers get 404
    expect((await call(t, host, 'GET', `/v1/disputes/${disputeId}`)).status).toBe(200);
    expect((await call(t, stranger, 'GET', `/v1/disputes/${disputeId}`)).status).toBe(404);
    expect((await call(t, host, 'GET', '/v1/disputes')).body.items.map((d: any) => d.id)).toContain(disputeId);
  });

  it('evidence is hashed server-side and append-only', async () => {
    const text = 'The pool was empty';
    const ev = await call(t, host, 'POST', `/v1/disputes/${disputeId}/evidence`, { evidenceType: 'TEXT', content: text });
    expect(ev.status).toBe(201);
    expect(ev.body.item.sha256).toBe(createHash('sha256').update(text).digest('hex'));
    expect((await call(t, stranger, 'POST', `/v1/disputes/${disputeId}/evidence`, { evidenceType: 'TEXT', content: 'x' })).status).toBe(404);
    await expect(t.pool.query(`UPDATE dispute_evidence SET content = 'tampered' WHERE id = $1`, [ev.body.item.id])).rejects.toThrow(/append-only/);
    // media evidence must be the submitter's own upload and match its hash
    const sha = 'a'.repeat(64);
    const { rows: m } = await t.pool.query(`INSERT INTO media_assets(owner_id, storage_key, mime_type, byte_size, sha256, purpose) VALUES ($1,'k/1','image/png',10,$2,'EVIDENCE') RETURNING id`, [guest.id, sha]);
    expect((await call(t, host, 'POST', `/v1/disputes/${disputeId}/evidence`, { evidenceType: 'MEDIA', mediaId: m[0].id })).body.code).toBe('MEDIA_NOT_OWNED');
    expect((await call(t, guest, 'POST', `/v1/disputes/${disputeId}/evidence`, { evidenceType: 'MEDIA', mediaId: m[0].id, sha256: 'b'.repeat(64) })).body.code).toBe('EVIDENCE_HASH_MISMATCH');
    const ok = await call(t, guest, 'POST', `/v1/disputes/${disputeId}/evidence`, { evidenceType: 'MEDIA', mediaId: m[0].id });
    expect(ok.body.item.sha256).toBe(sha);
  });

  it('workbench: role/AAL checks, assign, internal notes hidden from parties, awaiting party, resolve', async () => {
    expect((await call(t, guest, 'GET', '/v1/admin/disputes')).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['SUPPORT'], aal: 'aal1' });
    expect((await call(t, aal1, 'GET', '/v1/admin/disputes')).body.code).toBe('AAL2_REQUIRED');
    const q = await call(t, agent, 'GET', '/v1/admin/disputes');
    expect(q.body.items.map((d: any) => d.id)).toContain(disputeId);
    expect((await call(t, compliance, 'GET', `/v1/admin/disputes/${disputeId}`)).status).toBe(200);
    expect((await call(t, compliance, "POST", `/v1/admin/disputes/${disputeId}/assign`)).status).toBe(403); // read-only role
    expect((await call(t, agent, 'POST', `/v1/admin/disputes/${disputeId}/assign`, { assigneeId: guest.id })).body.code).toBe('ASSIGNEE_NOT_STAFF');
    const asg = await call(t, agent, 'POST', `/v1/admin/disputes/${disputeId}/assign`);
    expect(asg.body.item.status).toBe('IN_REVIEW');
    expect(asg.body.item.assignee_id).toBe(agent.id);
    await call(t, agent, 'POST', `/v1/admin/disputes/${disputeId}/notes`, { note: 'host has prior complaints' });
    const partyView = await call(t, guest, 'GET', `/v1/disputes/${disputeId}`);
    expect(partyView.body.item.timeline.some((e: any) => e.note === 'host has prior complaints')).toBe(false);
    const staffView = await call(t, agent, 'GET', `/v1/admin/disputes/${disputeId}`);
    expect(staffView.body.item.timeline.some((e: any) => e.note === 'host has prior complaints')).toBe(true);
    // awaiting party -> a party reply moves it back to review
    expect((await call(t, agent, 'POST', `/v1/admin/disputes/${disputeId}/status`, { to: 'AWAITING_PARTY', note: 'please send photos' })).body.item.status).toBe('AWAITING_PARTY');
    await call(t, guest, 'POST', `/v1/disputes/${disputeId}/evidence`, { evidenceType: 'TEXT', content: 'photos attached' });
    expect((await call(t, agent, 'GET', `/v1/admin/disputes/${disputeId}`)).body.item.status).toBe('IN_REVIEW');
    const esc = await call(t, agent, 'POST', `/v1/admin/disputes/${disputeId}/escalate`, { reason: 'needs manager', severity: 'HIGH' });
    expect(esc.body.item.status).toBe('ESCALATED');
    const res = await call(t, admin, 'POST', `/v1/admin/disputes/${disputeId}/resolve`, { outcome: 'RESOLVED', resolution: 'Partial refund recommended', detail: { refundPct: 30 } });
    expect(res.body.item.status).toBe('RESOLVED');
    const { rows } = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'dispute.resolved' AND aggregate_id = $1`, [disputeId]);
    expect(rows[0].payload.detail).toEqual({ refundPct: 30 });
    // terminal
    expect((await call(t, admin, 'POST', `/v1/admin/disputes/${disputeId}/escalate`, { reason: 'reopen pls' })).body.code).toBe('INVALID_STATE_TRANSITION');
    expect((await call(t, guest, 'POST', `/v1/disputes/${disputeId}/evidence`, { evidenceType: 'TEXT', content: 'late' })).body.code).toBe('DISPUTE_CLOSED');
    const { rows: tr } = await t.pool.query(`SELECT to_state FROM state_transitions WHERE aggregate_type = 'dispute' AND aggregate_id = $1 ORDER BY id`, [disputeId]);
    expect(tr.map((r) => r.to_state)).toEqual(['OPEN', 'IN_REVIEW', 'AWAITING_PARTY', 'IN_REVIEW', 'ESCALATED', 'RESOLVED']);
  });
});

describe('TRUST-03 elevated access (invariant 10)', () => {
  let disputeId: string;
  beforeAll(async () => {
    disputeId = (await openDispute(host)).body.item.id;
  });

  it('staff cannot read without a grant; grant requires reason>=10, <=24h, related conversation', async () => {
    await expect(assertElevatedAccess(t.pool, actorCtx(agent, ['USER', 'SUPPORT']), conversationId)).rejects.toMatchObject({ code: 'ELEVATED_ACCESS_REQUIRED' });
    await expect(assertElevatedAccess(t.pool, actorCtx(guest, ['USER']), conversationId)).rejects.toMatchObject({ code: 'ELEVATED_ACCESS_REQUIRED' });
    const url = `/v1/admin/disputes/${disputeId}/elevated-access`;
    expect((await call(t, agent, 'POST', url, { conversationId, reason: 'short' })).status).toBe(400);
    expect((await call(t, agent, 'POST', url, { conversationId, reason: 'reviewing the dispute', durationMinutes: 24 * 60 + 1 })).status).toBe(400);
    expect((await call(t, agent, 'POST', url, { conversationId: otherConversationId, reason: 'reviewing the dispute' })).body.code).toBe('CONVERSATION_NOT_IN_CASE');
    expect((await call(t, guest, 'POST', url, { conversationId, reason: 'reviewing the dispute' })).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['SUPPORT'], aal: 'aal1' });
    expect((await call(t, aal1, 'POST', url, { conversationId, reason: 'reviewing the dispute' })).body.code).toBe('AAL2_REQUIRED');
  });

  it('grant allows audited reads by that staff member only, until expiry or revocation', async () => {
    const g = await call(t, agent, 'POST', `/v1/admin/disputes/${disputeId}/elevated-access`, { conversationId, reason: 'reviewing the dispute evidence', durationMinutes: 30 });
    expect(g.status).toBe(201);
    const grant = await assertElevatedAccess(t.pool, actorCtx(agent, ['USER', 'SUPPORT']), conversationId);
    expect(grant).toMatchObject({ caseType: 'DISPUTE', caseId: disputeId });
    await assertElevatedAccess(t.pool, actorCtx(agent, ['USER', 'SUPPORT']), conversationId);
    const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'conversation.read_elevated' AND category = 'ELEVATED_ACCESS' AND resource_id = $1`, [conversationId]);
    expect(rows[0].n).toBe(2);
    // a different admin has no grant; AAL1 session is refused even with a grant
    await expect(assertElevatedAccess(t.pool, actorCtx(admin, ['USER', 'ADMIN']), conversationId)).rejects.toMatchObject({ code: 'ELEVATED_ACCESS_REQUIRED' });
    await expect(assertElevatedAccess(t.pool, actorCtx(agent, ['USER', 'SUPPORT'], 'aal1'), conversationId)).rejects.toMatchObject({ code: 'AAL2_REQUIRED' });
    // only the grant's conversation
    await expect(assertElevatedAccess(t.pool, actorCtx(agent, ['USER', 'SUPPORT']), otherConversationId)).rejects.toMatchObject({ code: 'ELEVATED_ACCESS_REQUIRED' });
    // expiry
    await t.pool.query(`UPDATE elevated_access_grants SET expires_at = now() - interval '1 second' WHERE id = $1`, [g.body.item.id]);
    await expect(assertElevatedAccess(t.pool, actorCtx(agent, ['USER', 'SUPPORT']), conversationId)).rejects.toMatchObject({ code: 'ELEVATED_ACCESS_REQUIRED' });
    // revocation
    const g2 = await call(t, agent, 'POST', `/v1/admin/disputes/${disputeId}/elevated-access`, { conversationId, reason: 'second look at messages' });
    expect((await call(t, agent, 'GET', '/v1/admin/elevated-access')).body.items).toHaveLength(1);
    expect((await call(t, agent, 'DELETE', `/v1/admin/elevated-access/${g2.body.item.id}`)).status).toBe(204);
    await expect(assertElevatedAccess(t.pool, actorCtx(agent, ['USER', 'SUPPORT']), conversationId)).rejects.toMatchObject({ code: 'ELEVATED_ACCESS_REQUIRED' });
    const { rows: g24 } = await t.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'elevated_access.granted' AND category = 'ELEVATED_ACCESS'`);
    expect(g24[0].n).toBe(2);
  });

  it('the DB refuses grants longer than 24h', async () => {
    await expect(
      t.pool.query(
        `INSERT INTO elevated_access_grants(admin_id, case_type, case_id, resource_type, resource_id, reason, expires_at) VALUES ($1,'DISPUTE',$2,'CONVERSATION',$3,'long enough reason', now() + interval '25 hours')`,
        [agent.id, disputeId, conversationId],
      ),
    ).rejects.toThrow();
  });

  it('no elevation on closed cases', async () => {
    await call(t, admin, 'POST', `/v1/admin/disputes/${disputeId}/resolve`, { outcome: 'REJECTED', resolution: 'Not substantiated' });
    expect((await call(t, agent, 'POST', `/v1/admin/disputes/${disputeId}/elevated-access`, { conversationId, reason: 'reviewing the dispute' })).body.code).toBe('CASE_CLOSED');
  });
});

describe('TRUST-03 sanctions & safety reports', () => {
  it('ACCOUNT_SUSPENSION suspends + revokes sessions; restore is blocked until the sanction is lifted', async () => {
    const bad = await createUser(t);
    expect((await call(t, agent, 'POST', '/v1/admin/sanctions', { userId: bad.id, sanctionType: 'ACCOUNT_SUSPENSION', reason: 'fraud ring' })).status).toBe(403); // SUPPORT: warnings only
    const w = await call(t, agent, 'POST', '/v1/admin/sanctions', { userId: bad.id, sanctionType: 'WARNING', reason: 'rude messages' });
    expect(w.status).toBe(201);
    const s = await call(t, compliance, 'POST', '/v1/admin/sanctions', { userId: bad.id, sanctionType: 'ACCOUNT_SUSPENSION', reason: 'fraud ring' });
    expect(s.status).toBe(201);
    expect((await call(t, bad, 'GET', '/v1/me')).status).toBe(401); // session revoked
    const { rows } = await t.pool.query(`SELECT status FROM users WHERE id = $1`, [bad.id]);
    expect(rows[0].status).toBe('SUSPENDED');
    const restore = await call(t, admin, 'POST', `/v1/admin/users/${bad.id}/restore`, { reason: 'appeal' });
    expect(restore.body.code).toBe('ACTIVE_SANCTION');
    const lift = await call(t, compliance, 'POST', `/v1/admin/sanctions/${s.body.item.id}/lift`, { reason: 'appeal granted' });
    expect(lift.body.item.accountRestored).toBe(true);
    expect((await t.pool.query(`SELECT status FROM users WHERE id = $1`, [bad.id])).rows[0].status).toBe('ACTIVE');
    expect((await call(t, compliance, 'POST', `/v1/admin/sanctions/${s.body.item.id}/lift`, { reason: 'again' })).body.code).toBe('ALREADY_LIFTED');
    const { rows: ev } = await t.pool.query(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at`, [bad.id]);
    expect(ev.map((e) => e.event_type)).toEqual(expect.arrayContaining(['sanction.applied', 'user.suspended', 'sanction.lifted', 'user.restored']));
    const { rows: a } = await t.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE resource_id = $1 AND category = 'PERMISSION'`, [bad.id]);
    expect(a[0].n).toBeGreaterThanOrEqual(4);
    expect((await call(t, admin, 'POST', '/v1/admin/sanctions', { userId: admin.id, sanctionType: 'WARNING', reason: 'myself' })).body.code).toBe('SELF_SANCTION_FORBIDDEN');
  });

  it('time-boxed suspensions are restored by the sweep job', async () => {
    const u = await createUser(t);
    const s = await call(t, admin, 'POST', '/v1/admin/sanctions', { userId: u.id, sanctionType: 'ACCOUNT_SUSPENSION', reason: 'cool-off period', endsAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(s.status).toBe(201);
    await t.pool.query(`UPDATE sanctions SET ends_at = now() - interval '1 second' WHERE id = $1`, [s.body.item.id]);
    await t.runJobs();
    expect((await t.pool.query(`SELECT status FROM users WHERE id = $1`, [u.id])).rows[0].status).toBe('ACTIVE');
  });

  it('safety reports: create, transaction party check, staff triage FSM', async () => {
    expect((await call(t, stranger, 'POST', '/v1/safety-reports', { subjectType: 'RESERVATION', subjectId: reservationId, category: 'FRAUD' })).status).toBe(403);
    expect((await call(t, guest, 'POST', '/v1/safety-reports', { subjectType: 'USER', subjectId: guest.id, category: 'FRAUD' })).body.code).toBe('INVALID_SUBJECT');
    const r = await call(t, guest, 'POST', '/v1/safety-reports', { subjectType: 'USER', subjectId: host.id, category: 'HARASSMENT', description: 'threatening messages', urgent: true });
    expect(r.status).toBe(201);
    expect((await call(t, guest, 'GET', '/v1/safety-reports')).body.items).toHaveLength(1);
    const q = await call(t, agent, 'GET', '/v1/admin/safety-reports?urgent=true');
    expect(q.body.items.map((x: any) => x.id)).toContain(r.body.item.id);
    expect((await call(t, agent, 'POST', `/v1/admin/safety-reports/${r.body.item.id}/status`, { to: 'TRIAGED' })).body.item.status).toBe('TRIAGED');
    // elevated access on a safety report where reporter and subject share the conversation
    const g = await call(t, agent, 'POST', `/v1/admin/safety-reports/${r.body.item.id}/elevated-access`, { conversationId, reason: 'checking the threatening messages' });
    expect(g.status).toBe(201);
    expect((await call(t, agent, 'POST', `/v1/admin/safety-reports/${r.body.item.id}/status`, { to: 'CLOSED' })).body.item.status).toBe('CLOSED');
    expect((await call(t, agent, 'POST', `/v1/admin/safety-reports/${r.body.item.id}/status`, { to: 'TRIAGED' })).body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('message disputes: only conversation members, counterparty is the sender', async () => {
    const { rows } = await t.pool.query(`SELECT id FROM messages WHERE conversation_id = $1 LIMIT 1`, [conversationId]);
    expect((await call(t, stranger, 'POST', '/v1/disputes', { contextType: 'MESSAGE', contextId: rows[0].id, reason: 'not mine' })).status).toBe(403);
    const d = await call(t, guest, 'POST', '/v1/disputes', { contextType: 'MESSAGE', contextId: rows[0].id, reason: 'abusive message' });
    expect(d.body.item.counterparty_id).toBe(host.id);
    // conversation of a MESSAGE dispute is elevatable
    const g = await call(t, agent, 'POST', `/v1/admin/disputes/${d.body.item.id}/elevated-access`, { conversationId, reason: 'verify abusive message' });
    expect(g.status).toBe(201);
    await withTx(t.pool, (tx) => assertElevatedAccess(tx, actorCtx(agent, ['USER', 'SUPPORT']), conversationId));
  });
});
