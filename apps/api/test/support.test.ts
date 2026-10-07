import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
let user: TestUser, other: TestUser, agent: TestUser, agent2: TestUser, admin: TestUser;
let reservationId: string;

beforeAll(async () => {
  t = await createTestApp();
  user = await createUser(t, { email: 'requester.person@example.com' });
  other = await createUser(t);
  agent = await createUser(t, { roles: ['SUPPORT'] });
  agent2 = await createUser(t, { roles: ['SUPPORT'] });
  admin = await createUser(t, { roles: ['ADMIN'] });
  const host = await createUser(t, { roles: ['HOST'] });
  const { rows: p } = await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'P','HOUSE') RETURNING id`, [host.id]);
  reservationId = (
    await t.pool.query(
      `INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, total_minor, currency, quote_snapshot)
       VALUES ($1,$2,$3,'CONFIRMED', current_date + 3, current_date + 5, 100000, 'KRW', '{}') RETURNING id`,
      [p[0].id, host.id, user.id],
    )
  ).rows[0].id;
});
afterAll(async () => t.close());

describe('OPS-01 support desk', () => {
  let caseId: string;

  it('requester opens a case with SLA by priority; context must be their own', async () => {
    expect((await call(t, other, 'POST', '/v1/support/cases', { category: 'BOOKING', subject: 'Help me', description: 'x', contextType: 'RESERVATION', contextId: reservationId })).body.code).toBe('NOT_A_PARTY');
    const r = await call(t, user, 'POST', '/v1/support/cases', { category: 'BOOKING', subject: 'Change dates', description: 'Can I move my stay?', priority: 'HIGH', contextType: 'RESERVATION', contextId: reservationId });
    expect(r.status).toBe(201);
    caseId = r.body.item.id;
    const due = new Date(r.body.item.slaDueAt).getTime() - new Date(r.body.item.createdAt).getTime();
    expect(Math.round(due / 3600_000)).toBe(8);
    expect(r.body.item.assigneeId).toBeUndefined();
    expect((await call(t, user, 'POST', '/v1/support/cases', { category: 'BOOKING', subject: 'Urgent', description: 'x', priority: 'URGENT' })).status).toBe(400); // URGENT is staff-set only
    const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'support.case.opened' AND aggregate_id = $1`, [caseId]);
    expect(rows[0].n).toBe(1);
    expect((await call(t, other, 'GET', `/v1/support/cases/${caseId}`)).status).toBe(404);
    expect((await call(t, user, 'GET', '/v1/support/cases')).body.items).toHaveLength(1);
  });

  it('staff queue requires SUPPORT/ADMIN with AAL2; contact data masked for SUPPORT', async () => {
    expect((await call(t, user, 'GET', '/v1/admin/support/cases')).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['SUPPORT'], aal: 'aal1' });
    expect((await call(t, aal1, 'GET', '/v1/admin/support/cases')).body.code).toBe('AAL2_REQUIRED');
    const q = await call(t, agent, 'GET', '/v1/admin/support/cases');
    const item = q.body.items.find((c: any) => c.id === caseId);
    expect(item.contactEmail).toMatch(/^re\*+@example\.com$/);
    expect((await call(t, admin, 'GET', '/v1/admin/support/cases')).body.items.find((c: any) => c.id === caseId).contactEmail).toBe('requester.person@example.com');
  });

  it('assignment, internal notes never visible to requester, staff reply notifies, customer reply reopens', async () => {
    expect((await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/assign`, { assigneeId: other.id })).body.code).toBe('ASSIGNEE_NOT_STAFF');
    const asg = await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/assign`, { assigneeId: agent2.id });
    expect(asg.body.item).toMatchObject({ status: 'IN_PROGRESS', assigneeId: agent2.id });
    expect((await call(t, agent2, 'GET', '/v1/admin/support/cases?mine=true')).body.items.map((c: any) => c.id)).toContain(caseId);
    await call(t, agent2, 'POST', `/v1/admin/support/cases/${caseId}/notes`, { body: 'INTERNAL: guest flagged before' });
    expect((await call(t, user, 'POST', `/v1/admin/support/cases/${caseId}/notes`, { body: 'sneaky' })).status).toBe(403);
    await call(t, agent2, 'POST', `/v1/admin/support/cases/${caseId}/comments`, { body: 'Sure, which dates?' });
    const mine = await call(t, user, 'GET', `/v1/support/cases/${caseId}`);
    expect(mine.body.item.events.some((e: any) => e.event_type === 'INTERNAL_NOTE')).toBe(false);
    expect(JSON.stringify(mine.body)).not.toContain('guest flagged before');
    expect(mine.body.item.events.some((e: any) => e.body === 'Sure, which dates?')).toBe(true);
    const staffView = await call(t, agent, 'GET', `/v1/admin/support/cases/${caseId}`);
    expect(staffView.body.item.events.some((e: any) => e.event_type === 'INTERNAL_NOTE')).toBe(true);
    const { rows } = await t.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND template_key = 'support.case.reply'`, [user.id]);
    expect(rows[0].n).toBe(1);
    // pending customer -> customer replies -> back in progress
    expect((await call(t, agent2, 'POST', `/v1/admin/support/cases/${caseId}/status`, { to: 'PENDING_CUSTOMER' })).body.item.status).toBe('PENDING_CUSTOMER');
    await call(t, user, 'POST', `/v1/support/cases/${caseId}/comments`, { body: 'March 3-5 please' });
    expect((await call(t, user, 'GET', `/v1/support/cases/${caseId}`)).body.item.status).toBe('IN_PROGRESS');
    expect((await call(t, other, 'POST', `/v1/support/cases/${caseId}/comments`, { body: 'hijack' })).status).toBe(404);
  });

  it('priority change recomputes SLA; resolve, close (terminal), audit trail', async () => {
    const p = await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/priority`, { priority: 'URGENT' });
    expect(Math.round((new Date(p.body.item.slaDueAt).getTime() - new Date(p.body.item.createdAt).getTime()) / 3600_000)).toBe(4);
    expect((await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/status`, { to: 'RESOLVED', note: 'dates changed' })).body.item.status).toBe('RESOLVED');
    expect((await call(t, user, 'POST', `/v1/support/cases/${caseId}/close`)).body.item.status).toBe('CLOSED');
    expect((await call(t, user, 'POST', `/v1/support/cases/${caseId}/comments`, { body: 'one more' })).body.code).toBe('CASE_CLOSED');
    expect((await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/status`, { to: 'IN_PROGRESS' })).body.code).toBe('INVALID_STATE_TRANSITION');
    const { rows } = await t.pool.query(`SELECT action FROM audit_logs WHERE resource_id = $1 ORDER BY created_at`, [caseId]);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['support.case.opened', 'support.case.assigned', 'support.case.priority_changed', 'support.case.status_changed']));
    expect((await call(t, agent, 'GET', '/v1/admin/support/cases')).body.items.map((c: any) => c.id)).not.toContain(caseId);
  });

  it('overdue filter surfaces SLA breaches', async () => {
    const r = await call(t, other, 'POST', '/v1/support/cases', { category: 'ACCOUNT', subject: 'Login issue', description: 'cannot log in' });
    await t.pool.query(`UPDATE support_cases SET sla_due_at = now() - interval '1 minute' WHERE id = $1`, [r.body.item.id]);
    const q = await call(t, agent, 'GET', '/v1/admin/support/cases?overdue=true');
    const item = q.body.items.find((c: any) => c.id === r.body.item.id);
    expect(item.slaBreached).toBe(true);
  });
});
