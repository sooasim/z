import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTestApp, createUser, call, idem, type TestApp, type TestUser } from './helpers.js';
import { q, withTx } from '../src/platform/db.js';
import { emit } from '../src/platform/outbox.js';
import { recordRiskEvent, riskScore } from '../src/modules/risk/service.js';
import { sweepMediaRejections } from '../src/modules/risk/consumers.js';
import { ensureConversation, reportMessage, sendMessage } from '../src/modules/messaging/service.js';

let t: TestApp;
let admin: TestUser;
let admin2: TestUser;
let support: TestUser;
let compliance: TestUser;
let plain: TestUser;

beforeAll(async () => {
  t = await createTestApp();
  admin = await createUser(t, { roles: ['ADMIN'] });
  admin2 = await createUser(t, { roles: ['ADMIN'] });
  support = await createUser(t, { roles: ['SUPPORT'] });
  compliance = await createUser(t, { roles: ['COMPLIANCE'] });
  plain = await createUser(t);
});
afterAll(async () => t.close());

const riskRows = (subjectId: string, riskType?: string) =>
  q(t.pool, `SELECT * FROM risk_events WHERE subject_id = $1 AND ($2::text IS NULL OR risk_type = $2) ORDER BY created_at, id`, [subjectId, riskType ?? null]);

async function insertPayment(payerId: string) {
  const { rows } = await t.pool.query(
    `INSERT INTO payments(provider, provider_order_id, payer_id, subject_type, subject_id, status, amount_minor, currency, expires_at)
     VALUES ('MOCK', $1, $2, 'ORDER', $3, 'FAILED', 10000, 'KRW', now() + interval '1 hour') RETURNING id`,
    [`ord_${randomUUID()}`, payerId, randomUUID()],
  );
  return rows[0].id as string;
}

async function paymentFailed(paymentId: string, code = 'REJECT_CARD_COMPANY', createdAt?: string) {
  if (createdAt) {
    await t.pool.query(
      `INSERT INTO outbox_events(aggregate_type, aggregate_id, event_type, payload, correlation_id, created_at)
       VALUES ('payment', $1, 'payment.failed', $2, $3, $4)`,
      [paymentId, JSON.stringify({ paymentId, subjectType: 'ORDER', code, final: true }), `test-${randomUUID()}`, createdAt],
    );
  } else {
    await emit(t.pool, t.ctx(), { aggregateType: 'payment', aggregateId: paymentId, eventType: 'payment.failed', payload: { paymentId, subjectType: 'ORDER', code, final: true } });
  }
}

// ------------------------------------------------------------------------------------------------ service contract
describe('recordRiskEvent / riskScore contract', () => {
  it('records, emits risk.detected, dedupes, and notifies admins only for HIGH/CRITICAL', async () => {
    const subject = `203.0.113.${Math.floor(Math.random() * 200)}`;
    const ctx = t.ctx();
    const low = await recordRiskEvent(t.pool, ctx, { subjectType: 'IP', subjectId: subject, riskType: 'RATE_LIMIT', severity: 'LOW' });
    const high = await recordRiskEvent(t.pool, ctx, {
      subjectType: 'IP',
      subjectId: subject,
      riskType: 'impossible_travel',
      severity: 'HIGH',
      detail: { from: 'KR', to: 'BR', password: 'hunter2', nested: { accessToken: 'x', ok: 1 } },
      dedupeKey: `test:${subject}`,
    });
    const again = await recordRiskEvent(t.pool, ctx, { subjectType: 'IP', subjectId: subject, riskType: 'IMPOSSIBLE_TRAVEL', severity: 'HIGH', dedupeKey: `test:${subject}` });
    expect(again).toBe(high);
    const rows = await riskRows(subject);
    expect(rows.map((r) => [r.risk_type, r.severity, r.score, r.status])).toEqual([
      ['RATE_LIMIT', 'LOW', 10, 'OPEN'],
      ['IMPOSSIBLE_TRAVEL', 'HIGH', 60, 'OPEN'],
    ]);
    // secrets never persist in detail
    expect(rows[1].detail).toEqual({ from: 'KR', to: 'BR', nested: { ok: 1 } });
    const evs = await q(t.pool, `SELECT payload FROM outbox_events WHERE event_type = 'risk.detected' AND aggregate_id = ANY($1::text[])`, [[low, high]]);
    expect(evs).toHaveLength(2);
    const notes = await q(t.pool, `SELECT user_id, category, data FROM notifications WHERE dedupe_key = $1`, [`risk:${high}`]);
    expect(notes.map((n) => n.user_id).sort()).toEqual([admin.id, admin2.id].sort());
    expect(notes.every((n) => n.category === 'SECURITY')).toBe(true);
    expect((await q(t.pool, `SELECT 1 FROM notifications WHERE dedupe_key = $1`, [`risk:${low}`])).length).toBe(0);
    await t.drain();
  });

  it('riskScore sums non-false-positive scores in the window, capped at 100', async () => {
    const u = await createUser(t);
    const ctx = t.ctx();
    expect(await riskScore(t.pool, 'USER', u.id)).toBe(0);
    await recordRiskEvent(t.pool, ctx, { subjectType: 'USER', subjectId: u.id, riskType: 'ABUSE', severity: 'MEDIUM' });
    const fp = await recordRiskEvent(t.pool, ctx, { subjectType: 'USER', subjectId: u.id, riskType: 'MANUAL', severity: 'LOW', score: 25 });
    expect(await riskScore(t.pool, 'USER', u.id)).toBe(55);
    await withTx(t.pool, async (tx) => {
      const { changeRiskStatus } = await import('../src/modules/risk/service.js');
      await changeRiskStatus(tx, { ...t.ctx(), actor: { userId: admin.id, sessionId: admin.sessionId, roles: ['USER', 'ADMIN'], aal: 'aal2', status: 'ACTIVE' } }, fp, { status: 'FALSE_POSITIVE', note: 'test' });
    });
    expect(await riskScore(t.pool, 'USER', u.id)).toBe(30);
    // an old event falls out of the window
    await t.pool.query(`UPDATE risk_events SET created_at = now() - interval '2 hours' WHERE subject_id = $1 AND risk_type = 'ABUSE'`, [u.id]);
    expect(await riskScore(t.pool, 'USER', u.id)).toBe(0);
    expect(await riskScore(t.pool, 'USER', u.id, 180)).toBe(30);
    await recordRiskEvent(t.pool, ctx, { subjectType: 'USER', subjectId: u.id, riskType: 'MANUAL', severity: 'CRITICAL' });
    await recordRiskEvent(t.pool, ctx, { subjectType: 'USER', subjectId: u.id, riskType: 'MANUAL', severity: 'CRITICAL' });
    expect(await riskScore(t.pool, 'USER', u.id)).toBe(100);
    await t.drain();
  });

  it('validates input', async () => {
    const ctx = t.ctx();
    await expect(recordRiskEvent(t.pool, ctx, { subjectType: 'PLANET' as any, subjectId: 'x', riskType: 'MANUAL', severity: 'LOW' })).rejects.toMatchObject({ code: 'INVALID_SUBJECT_TYPE' });
    await expect(recordRiskEvent(t.pool, ctx, { subjectType: 'USER', subjectId: 'x', riskType: 'no spaces!', severity: 'LOW' })).rejects.toMatchObject({ code: 'INVALID_RISK_TYPE' });
    await expect(recordRiskEvent(t.pool, ctx, { subjectType: 'USER', subjectId: 'x', riskType: 'MANUAL', severity: 'HUGE' as any })).rejects.toMatchObject({ code: 'INVALID_SEVERITY' });
    await expect(recordRiskEvent(t.pool, ctx, { subjectType: 'USER', subjectId: '', riskType: 'MANUAL', severity: 'LOW' })).rejects.toMatchObject({ code: 'INVALID_SUBJECT_ID' });
  });
});

// ------------------------------------------------------------------------------------------------ derived detections
describe('detections derived from existing events', () => {
  it('refresh-token reuse (identity.session.compromised) → SESSION_COMPROMISED HIGH + admin notification', async () => {
    const victim = await createUser(t);
    const login = await call(t, null, 'POST', '/v1/auth/login', { email: victim.email, password: victim.password });
    expect(login.status).toBe(200);
    const rotated = await call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: login.body.refreshToken });
    expect(rotated.status).toBe(200);
    // replayed after the benign two-tab race window (REFRESH_REUSE_GRACE_SEC): treated as theft
    await t.pool.query(`UPDATE session_refresh_history SET rotated_at = rotated_at - interval '1 minute' WHERE session_id = $1`, [login.body.sessionId]);
    const reuse = await call(t, null, 'POST', '/v1/auth/refresh', { refreshToken: login.body.refreshToken });
    expect(reuse.body.code).toBe('REFRESH_TOKEN_REUSED');
    await t.drain();
    await t.drain(); // replay safety
    const rows = await riskRows(victim.id, 'SESSION_COMPROMISED');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject_type: 'USER', severity: 'HIGH', status: 'OPEN' });
    expect(rows[0].source_event_id).toBeTruthy();
    const notes = await q(t.pool, `SELECT user_id FROM notifications WHERE dedupe_key = $1`, [`risk:${rows[0].id}`]);
    expect(notes.map((n) => n.user_id)).toContain(admin.id);
    expect(JSON.stringify(rows[0].detail)).not.toContain(login.body.refreshToken);
  });

  it('≥5 declined payments by one payer within 10 minutes → one CARD_TESTING HIGH', async () => {
    const payer = await createUser(t);
    const ids = await Promise.all(Array.from({ length: 7 }, () => insertPayment(payer.id)));
    for (const id of ids.slice(0, 4)) await paymentFailed(id);
    await paymentFailed(ids[4], 'EXPIRED'); // not a decline
    await t.drain();
    expect(await riskRows(payer.id, 'CARD_TESTING')).toHaveLength(0);
    await paymentFailed(ids[5]);
    await t.drain();
    let rows = await riskRows(payer.id, 'CARD_TESTING');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ subject_type: 'USER', severity: 'HIGH', score: 60 });
    expect(rows[0].detail).toMatchObject({ failureCount: 5, windowMinutes: 10, lastPaymentId: ids[5] });
    // further failures in the burst update the open event instead of raising duplicates
    await paymentFailed(ids[6]);
    await t.drain();
    rows = await riskRows(payer.id, 'CARD_TESTING');
    expect(rows).toHaveLength(1);
    expect(rows[0].detail.failureCount).toBe(6);
    expect((await q(t.pool, `SELECT 1 FROM notifications WHERE dedupe_key = $1`, [`risk:${rows[0].id}`])).length).toBe(2);
  });

  it('failures spread beyond the 10-minute window do not trigger CARD_TESTING', async () => {
    const payer = await createUser(t);
    for (let i = 0; i < 6; i++) {
      const id = await insertPayment(payer.id);
      await paymentFailed(id, 'REJECT_CARD_COMPANY', new Date(Date.now() - i * 4 * 60_000).toISOString());
    }
    await t.drain();
    expect(await riskRows(payer.id, 'CARD_TESTING')).toHaveLength(0);
  });

  it('message.reported → CONTACT_LEAK / ABUSE MEDIUM against the sender (no message body stored)', async () => {
    const sender = await createUser(t);
    const r1 = await createUser(t);
    const r2 = await createUser(t);
    const ctx = t.ctx();
    const { messageId } = await withTx(t.pool, async (tx) => {
      const conversationId = await ensureConversation(tx, ctx, {
        contextType: 'SUPPORT',
        contextId: randomUUID(),
        members: [{ userId: sender.id, role: 'MEMBER' }, { userId: r1.id, role: 'MEMBER' }, { userId: r2.id, role: 'MEMBER' }],
      });
      const m = await sendMessage(tx, ctx, { conversationId, senderId: sender.id, body: 'call me at 010-0000-0000, pay me directly' });
      await reportMessage(tx, ctx, { messageId: m.message.id, reporterId: r1.id, reason: 'Shared phone number to pay outside the platform' });
      await reportMessage(tx, ctx, { messageId: m.message.id, reporterId: r2.id, reason: 'rude and insulting' });
      return { messageId: m.message.id };
    });
    await t.drain();
    const rows = await riskRows(sender.id);
    expect(rows.map((r) => [r.risk_type, r.severity]).sort()).toEqual([
      ['ABUSE', 'MEDIUM'],
      ['CONTACT_LEAK', 'MEDIUM'],
    ]);
    for (const r of rows) {
      expect(r.detail.messageId).toBe(messageId);
      expect(JSON.stringify(r.detail)).not.toContain('010-0000-0000');
    }
    // MEDIUM does not page admins
    expect((await q(t.pool, `SELECT 1 FROM notifications WHERE dedupe_key = ANY($1::text[])`, [rows.map((r) => `risk:${r.id}`)])).length).toBe(0);
  });

  it('media rejections (state_transitions sweep + media.rejected event) → one UPLOAD_REJECTED per asset', async () => {
    const owner = await createUser(t);
    const mk = async () => {
      const { rows } = await t.pool.query(
        `INSERT INTO media_assets(owner_id, storage_key, mime_type, byte_size, status, moderation_status) VALUES ($1,$2,'image/jpeg',100,'REJECTED','REJECTED') RETURNING id`,
        [owner.id, `test/${randomUUID()}`],
      );
      await t.pool.query(
        `INSERT INTO state_transitions(aggregate_type, aggregate_id, from_state, to_state, actor_type, reason, correlation_id)
         VALUES ('MEDIA', $1, 'PROCESSING', 'REJECTED', 'SYSTEM', 'MEDIA_MODERATION_REJECTED', $2)`,
        [rows[0].id, `test-${randomUUID()}`],
      );
      return rows[0].id as string;
    };
    const m1 = await mk();
    const m2 = await mk();
    await t.runJobs();
    await sweepMediaRejections(t.app.ctx); // idempotent re-run
    await emit(t.pool, t.ctx(), { aggregateType: 'media', aggregateId: m1, eventType: 'media.rejected', payload: { mediaId: m1, ownerId: owner.id, reason: 'X' } });
    await t.drain();
    const rows = await riskRows(owner.id, 'UPLOAD_REJECTED');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.detail.mediaId).sort()).toEqual([m1, m2].sort());
    expect(rows[0]).toMatchObject({ subject_type: 'USER', severity: 'LOW', score: 10 });
    expect(rows[0].detail.reason).toBe('MEDIA_MODERATION_REJECTED');
    // a third rejection after the watermark is still picked up
    const m3 = await mk();
    await sweepMediaRejections(t.app.ctx);
    expect((await riskRows(owner.id, 'UPLOAD_REJECTED')).map((r) => r.detail.mediaId)).toContain(m3);
    expect(await riskScore(t.pool, 'USER', owner.id)).toBe(30);
  });
});

// ------------------------------------------------------------------------------------------------ admin API
describe('admin risk API (PLAT-05)', () => {
  it('requires ADMIN/COMPLIANCE/SUPPORT with AAL2', async () => {
    const adminAal1 = await createUser(t, { roles: ['ADMIN'], aal: 'aal1' });
    const host = await createUser(t, { roles: ['HOST'] });
    const accounting = await createUser(t, { roles: ['ACCOUNTING'] });
    expect((await call(t, null, 'GET', '/v1/admin/risk/events')).status).toBe(401);
    expect((await call(t, plain, 'GET', '/v1/admin/risk/events')).body.code).toBe('ROLE_REQUIRED');
    expect((await call(t, host, 'GET', '/v1/admin/risk/events')).body.code).toBe('ROLE_REQUIRED');
    expect((await call(t, accounting, 'GET', '/v1/admin/security/incidents')).body.code).toBe('ROLE_REQUIRED');
    const aal1 = await call(t, adminAal1, 'GET', '/v1/admin/risk/events');
    expect(aal1.status).toBe(403);
    expect(aal1.body.code).toBe('AAL2_REQUIRED');
    expect((await call(t, plain, 'POST', '/v1/admin/security/incidents', { title: 'x incident', severity: 'SEV3' })).status).toBe(403);
    for (const u of [admin, support, compliance]) {
      expect((await call(t, u, 'GET', '/v1/admin/risk/events')).status).toBe(200);
      expect((await call(t, u, 'GET', '/v1/admin/security/incidents')).status).toBe(200);
    }
  });

  it('lists with filters and exact keyset pagination', async () => {
    const subject = `dev-${randomUUID()}`;
    for (let i = 0; i < 5; i++) {
      await recordRiskEvent(t.pool, t.ctx(), { subjectType: 'DEVICE', subjectId: subject, riskType: 'MANUAL', severity: i % 2 ? 'MEDIUM' : 'LOW' });
    }
    // force identical timestamps (same microsecond) to exercise the id tie-break
    await t.pool.query(`UPDATE risk_events SET created_at = '2026-05-05T05:05:05.555555Z' WHERE subject_id = $1`, [subject]);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res: any = await call(t, support, 'GET', `/v1/admin/risk/events?subjectType=DEVICE&subjectId=${subject}&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((x: any) => x.id));
      cursor = res.body.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    const medium = await call(t, admin, 'GET', `/v1/admin/risk/events?subjectId=${subject}&severity=MEDIUM`);
    expect(medium.body.items).toHaveLength(2);
    expect(medium.body.items[0]).toMatchObject({ subjectType: 'DEVICE', subjectId: subject, riskType: 'MANUAL', severity: 'MEDIUM', status: 'OPEN' });
    expect(medium.body.items[0]).not.toHaveProperty('created_at_cursor');
    expect((await call(t, admin, 'GET', `/v1/admin/risk/events?riskType=manual&subjectId=${subject}`)).body.items).toHaveLength(5);
    expect((await call(t, admin, 'GET', `/v1/admin/risk/events?severity=SEVERE`)).status).toBe(400);
    const score = await call(t, compliance, 'GET', `/v1/admin/risk/score?subjectType=DEVICE&subjectId=${subject}&windowMinutes=${60 * 24 * 365 * 2}`);
    expect(score.status).toBe(400); // window bounded
    const detail = await call(t, compliance, 'GET', `/v1/admin/risk/events/${seen[0]}`);
    expect(detail.body.item.id).toBe(seen[0]);
    expect((await call(t, compliance, 'GET', `/v1/admin/risk/events/${randomUUID()}`)).status).toBe(404);
  });

  it('manual flag: 201, audited, idempotent replay', async () => {
    const target = await createUser(t);
    const key = idem();
    const body = { subjectType: 'USER', subjectId: target.id, severity: 'HIGH', reason: 'chargeback ring linked by support case' };
    const a = await call(t, support, 'POST', '/v1/admin/risk/events', body, key);
    expect(a.status).toBe(201);
    expect(a.body.item).toMatchObject({ riskType: 'MANUAL', severity: 'HIGH', createdBy: support.id, detail: { reason: body.reason } });
    const b = await call(t, support, 'POST', '/v1/admin/risk/events', body, key);
    expect(b.status).toBe(201);
    expect(b.body.item.id).toBe(a.body.item.id);
    expect((await call(t, support, 'POST', '/v1/admin/risk/events', { ...body, severity: 'LOW' }, key)).status).toBe(422);
    expect(await riskRows(target.id)).toHaveLength(1);
    const audits = await q(t.pool, `SELECT category, actor_id FROM audit_logs WHERE action = 'risk_event.flagged' AND resource_id = $1`, [a.body.item.id]);
    expect(audits).toEqual([{ category: 'SECURITY', actor_id: support.id }]);
    const score = await call(t, admin, 'GET', `/v1/admin/risk/score?subjectType=USER&subjectId=${target.id}`);
    expect(score.body.item).toMatchObject({ score: 60, level: 'HIGH', eventCount: 1, maxSeverity: 'HIGH', windowMinutes: 60 });
  });

  it('status triage follows the state machine and is audited', async () => {
    const id = await recordRiskEvent(t.pool, t.ctx(), { subjectType: 'PAYMENT', subjectId: randomUUID(), riskType: 'CARD_TESTING', severity: 'MEDIUM' });
    const ack = await call(t, support, 'POST', `/v1/admin/risk/events/${id}/status`, { status: 'ACKNOWLEDGED', note: 'looking' });
    expect(ack.status).toBe(200);
    expect(ack.body.item.status).toBe('ACKNOWLEDGED');
    const res = await call(t, compliance, 'POST', `/v1/admin/risk/events/${id}/status`, { status: 'RESOLVED', note: 'card blocked' });
    expect(res.body.item).toMatchObject({ status: 'RESOLVED', resolvedBy: compliance.id, resolutionNote: 'card blocked' });
    expect(res.body.item.resolvedAt).toBeTruthy();
    const bad = await call(t, admin, 'POST', `/v1/admin/risk/events/${id}/status`, { status: 'ACKNOWLEDGED' });
    expect(bad.status).toBe(409);
    expect(bad.body.code).toBe('INVALID_STATE_TRANSITION');
    const reopen = await call(t, admin, 'POST', `/v1/admin/risk/events/${id}/status`, { status: 'OPEN', note: 'came back' });
    expect(reopen.body.item).toMatchObject({ status: 'OPEN', resolvedAt: null, resolvedBy: null });
    expect((await call(t, admin, 'POST', `/v1/admin/risk/events/${randomUUID()}/status`, { status: 'RESOLVED' })).status).toBe(404);
    expect((await call(t, admin, 'POST', `/v1/admin/risk/events/${id}/status`, { status: 'DONE' })).status).toBe(400);
    const st = await q(t.pool, `SELECT from_state, to_state, actor_id, actor_type FROM state_transitions WHERE aggregate_type = 'RISK_EVENT' AND aggregate_id = $1 ORDER BY id`, [id]);
    expect(st.map((s) => `${s.from_state}>${s.to_state}`)).toEqual(['OPEN>ACKNOWLEDGED', 'ACKNOWLEDGED>RESOLVED', 'RESOLVED>OPEN']);
    expect(st[1]).toMatchObject({ actor_id: compliance.id, actor_type: 'ADMIN' });
    const audits = await q(t.pool, `SELECT category FROM audit_logs WHERE action = 'risk_event.status_changed' AND resource_id = $1`, [id]);
    expect(audits).toHaveLength(3);
    expect(audits.every((a) => a.category === 'SECURITY')).toBe(true);
    expect((await q(t.pool, `SELECT 1 FROM outbox_events WHERE event_type = 'risk.status_changed' AND aggregate_id = $1`, [id])).length).toBe(3);
  });

  it('concurrent triage of the same event: exactly one wins', async () => {
    const id = await recordRiskEvent(t.pool, t.ctx(), { subjectType: 'IP', subjectId: '198.51.100.7', riskType: 'RATE_LIMIT', severity: 'LOW' });
    const results = await Promise.all(
      [admin, admin2, support, compliance].map((u) => call(t, u, 'POST', `/v1/admin/risk/events/${id}/status`, { status: 'ACKNOWLEDGED' })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(3);
  });
});

describe('security incidents (PLAT-05)', () => {
  let incidentId: string;
  let riskId: string;

  it('opens an incident: 201, idempotent, timeline, audit, event, commander + SEV1/2 admin pages', async () => {
    riskId = await recordRiskEvent(t.pool, t.ctx(), { subjectType: 'USER', subjectId: plain.id, riskType: 'SESSION_COMPROMISED', severity: 'HIGH' });
    const key = idem();
    const body = { title: 'Credential stuffing wave', severity: 'SEV2', summary: 'Login failures spiking from one ASN', commanderId: support.id, relatedRiskEventIds: [riskId] };
    const a = await call(t, admin, 'POST', '/v1/admin/security/incidents', body, key);
    expect(a.status).toBe(201);
    expect(a.body.item).toMatchObject({ title: body.title, severity: 'SEV2', status: 'OPEN', commanderId: support.id, relatedRiskEventIds: [riskId], openedBy: admin.id, version: 1 });
    incidentId = a.body.item.id;
    const replay = await call(t, admin, 'POST', '/v1/admin/security/incidents', body, key);
    expect(replay.status).toBe(201);
    expect(replay.body.item.id).toBe(incidentId);
    expect((await q(t.pool, `SELECT 1 FROM security_incidents WHERE title = $1`, [body.title])).length).toBe(1);

    const detail = await call(t, compliance, 'GET', `/v1/admin/security/incidents/${incidentId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.events).toHaveLength(1);
    expect(detail.body.events[0]).toMatchObject({ type: 'OPENED', toStatus: 'OPEN', actorId: admin.id });

    const audits = await q(t.pool, `SELECT category FROM audit_logs WHERE action = 'security_incident.opened' AND resource_id = $1`, [incidentId]);
    expect(audits).toEqual([{ category: 'SECURITY' }]);
    const evs = await q(t.pool, `SELECT payload FROM outbox_events WHERE event_type = 'security.incident' AND aggregate_id = $1`, [incidentId]);
    expect(evs.map((e) => e.payload.action)).toEqual(['OPENED']);
    const opened = await q(t.pool, `SELECT payload FROM outbox_events WHERE event_type = 'incident.opened' AND aggregate_id = $1`, [incidentId]);
    expect(opened.map((e) => e.payload)).toEqual([{ incidentId, kind: 'SECURITY', severity: 'SEV2', commanderId: support.id, openedBy: admin.id }]);
    const cmd = await q(t.pool, `SELECT category FROM notifications WHERE user_id = $1 AND template_key = 'security.incident_assigned'`, [support.id]);
    expect(cmd).toEqual([{ category: 'SECURITY' }]);
    const paged = await q(t.pool, `SELECT user_id FROM notifications WHERE dedupe_key = $1`, [`incident:${incidentId}:opened`]);
    expect(paged.map((p) => p.user_id)).toContain(admin2.id);
    expect(paged.map((p) => p.user_id)).not.toContain(admin.id); // the opener is not paged
    expect(paged.map((p) => p.user_id)).not.toContain(support.id); // only ADMINs are paged
    await t.drain();
  });

  it('rejects invalid commanders, unknown risk events and bad input', async () => {
    const bad = await call(t, admin, 'POST', '/v1/admin/security/incidents', { title: 'Bad commander', severity: 'SEV3', commanderId: plain.id });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('INVALID_COMMANDER');
    const unknown = await call(t, admin, 'POST', '/v1/admin/security/incidents', { title: 'Unknown risk', severity: 'SEV3', relatedRiskEventIds: [randomUUID()] });
    expect(unknown.body.code).toBe('RISK_EVENT_NOT_FOUND');
    expect((await call(t, admin, 'POST', '/v1/admin/security/incidents', { title: 'x', severity: 'SEV9' })).status).toBe(400);
    expect((await call(t, admin, 'GET', `/v1/admin/security/incidents/${randomUUID()}`)).status).toBe(404);
  });

  it('timeline: notes, severity/commander/risk changes and the status lifecycle', async () => {
    const url = `/v1/admin/security/incidents/${incidentId}/events`;
    const note = await call(t, compliance, 'POST', url, { type: 'NOTE', note: 'Blocked ASN at the WAF' });
    expect(note.status).toBe(201);
    expect(note.body.event).toMatchObject({ type: 'NOTE', note: 'Blocked ASN at the WAF', actorId: compliance.id });

    const sev = await call(t, admin, 'POST', url, { type: 'SEVERITY_CHANGE', severity: 'SEV1', note: 'customer impact confirmed' });
    expect(sev.body.incident.severity).toBe('SEV1');
    expect((await call(t, admin, 'POST', url, { type: 'SEVERITY_CHANGE', severity: 'SEV1' })).body.code).toBe('NO_CHANGE');

    const cmd = await call(t, admin, 'POST', url, { type: 'COMMANDER_CHANGE', commanderId: compliance.id });
    expect(cmd.body.incident.commanderId).toBe(compliance.id);
    expect((await call(t, admin, 'POST', url, { type: 'COMMANDER_CHANGE', commanderId: plain.id })).body.code).toBe('INVALID_COMMANDER');

    const r2 = await recordRiskEvent(t.pool, t.ctx(), { subjectType: 'IP', subjectId: '192.0.2.10', riskType: 'LOGIN_FAILURE_BURST', severity: 'MEDIUM' });
    const link = await call(t, support, 'POST', url, { type: 'RISK_LINKED', riskEventIds: [r2, riskId] });
    expect(link.body.incident.relatedRiskEventIds.sort()).toEqual([riskId, r2].sort());

    for (const status of ['INVESTIGATING', 'MITIGATED', 'RESOLVED']) {
      const res = await call(t, admin, 'POST', url, { type: 'STATUS_CHANGE', status });
      expect(res.status).toBe(201);
      expect(res.body.incident.status).toBe(status);
    }
    const resolved = (await call(t, admin, 'GET', `/v1/admin/security/incidents/${incidentId}`)).body.item;
    expect(resolved.mitigatedAt).toBeTruthy();
    expect(resolved.resolvedAt).toBeTruthy();

    const noUrl = await call(t, admin, 'POST', url, { type: 'STATUS_CHANGE', status: 'POSTMORTEM_DONE' });
    expect(noUrl.status).toBe(422);
    expect(noUrl.body.code).toBe('POSTMORTEM_URL_REQUIRED');
    expect((await call(t, admin, 'POST', url, { type: 'STATUS_CHANGE', status: 'POSTMORTEM_DONE', postmortemUrl: 'http://insecure.example' })).status).toBe(400);
    const done = await call(t, admin, 'POST', url, { type: 'STATUS_CHANGE', status: 'POSTMORTEM_DONE', postmortemUrl: 'https://wiki.jetpool.kr/pm/123' });
    expect(done.body.incident).toMatchObject({ status: 'POSTMORTEM_DONE', postmortemUrl: 'https://wiki.jetpool.kr/pm/123' });

    // closed: only notes
    const closed = await call(t, admin, 'POST', url, { type: 'STATUS_CHANGE', status: 'INVESTIGATING' });
    expect(closed.status).toBe(409);
    expect(closed.body.code).toBe('INCIDENT_CLOSED');
    expect((await call(t, admin, 'POST', url, { type: 'NOTE', note: 'postmortem shared' })).status).toBe(201);

    const detail = (await call(t, admin, 'GET', `/v1/admin/security/incidents/${incidentId}`)).body;
    expect(detail.events.map((e: any) => e.type)).toEqual([
      'OPENED', 'NOTE', 'SEVERITY_CHANGE', 'COMMANDER_CHANGE', 'RISK_LINKED', 'STATUS_CHANGE', 'STATUS_CHANGE', 'STATUS_CHANGE', 'STATUS_CHANGE', 'NOTE',
    ]);
    expect(detail.events.filter((e: any) => e.type === 'STATUS_CHANGE').map((e: any) => `${e.fromStatus}>${e.toStatus}`)).toEqual([
      'OPEN>INVESTIGATING', 'INVESTIGATING>MITIGATED', 'MITIGATED>RESOLVED', 'RESOLVED>POSTMORTEM_DONE',
    ]);
    const evs = await q(t.pool, `SELECT payload->>'action' AS a FROM outbox_events WHERE event_type = 'security.incident' AND aggregate_id = $1 ORDER BY created_at, id`, [incidentId]);
    expect(evs).toHaveLength(10);
    const audits = await q(t.pool, `SELECT DISTINCT category FROM audit_logs WHERE resource_type = 'security_incident' AND resource_id = $1`, [incidentId]);
    expect(audits).toEqual([{ category: 'SECURITY' }]);
    await expect(t.pool.query(`UPDATE security_incident_events SET note = 'x' WHERE incident_id = $1`, [incidentId])).rejects.toThrow(/append-only/);
  });

  it('invalid transition and concurrent status changes', async () => {
    const inc = (await call(t, support, 'POST', '/v1/admin/security/incidents', { title: 'Phishing domain', severity: 'SEV4' })).body.item;
    const url = `/v1/admin/security/incidents/${inc.id}/events`;
    const skip = await call(t, admin, 'POST', url, { type: 'STATUS_CHANGE', status: 'POSTMORTEM_DONE', postmortemUrl: 'https://wiki.jetpool.kr/pm/9' });
    expect(skip.status).toBe(409);
    expect(skip.body.code).toBe('INVALID_STATE_TRANSITION');
    const results = await Promise.all([admin, admin2, compliance].map((u) => call(t, u, 'POST', url, { type: 'STATUS_CHANGE', status: 'INVESTIGATING' })));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409).map((r) => r.body.code)).toEqual(['INVALID_STATE_TRANSITION', 'INVALID_STATE_TRANSITION']);
    const detail = (await call(t, admin, 'GET', `/v1/admin/security/incidents/${inc.id}`)).body;
    expect(detail.item).toMatchObject({ status: 'INVESTIGATING', version: 2 });
    expect(detail.events.filter((e: any) => e.type === 'STATUS_CHANGE')).toHaveLength(1);
  });

  it('lists incidents with filters and pagination', async () => {
    const list = await call(t, support, 'GET', '/v1/admin/security/incidents?limit=1');
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.nextCursor).toBeTruthy();
    const next = await call(t, support, 'GET', `/v1/admin/security/incidents?limit=1&cursor=${list.body.nextCursor}`);
    expect(next.body.items[0].id).not.toBe(list.body.items[0].id);
    const active = await call(t, support, 'GET', '/v1/admin/security/incidents?active=true');
    expect(active.body.items.every((i: any) => !['RESOLVED', 'POSTMORTEM_DONE'].includes(i.status))).toBe(true);
    expect(active.body.items.map((i: any) => i.id)).not.toContain(incidentId);
    const sev1 = await call(t, support, 'GET', '/v1/admin/security/incidents?severity=SEV1');
    expect(sev1.body.items.map((i: any) => i.id)).toEqual([incidentId]);
  });
});
