import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { withTx } from '../src/platform/db.js';
import { ensureConversation, maskContactInfo, postSystemMessage, sendMessage } from '../src/modules/messaging/service.js';
import { startMessageBridge } from '../src/modules/messaging/index.js';

let t: TestApp;
let host: TestUser, guest: TestUser, stranger: TestUser, admin: TestUser;
let propertyId: string;
let convId: string;

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
  guest = await createUser(t);
  stranger = await createUser(t);
  admin = await createUser(t, { roles: ['ADMIN'] });
  const { rows } = await t.pool.query(
    `INSERT INTO properties(host_id, title, property_type, status, city) VALUES ($1,'Hanok','HANOK','PUBLISHED','서울') RETURNING id`,
    [host.id],
  );
  propertyId = rows[0].id;
});
afterAll(async () => t.close());

describe('COMMS-01 messaging', () => {
  it('creates an INQUIRY to a host and is idempotent per member set', async () => {
    const a = await call(t, guest, 'POST', '/v1/conversations', { targetType: 'PROPERTY', targetId: propertyId, message: '안녕하세요, 11월에 가능할까요?' });
    expect(a.status).toBe(201);
    convId = a.body.item.id;
    const b = await call(t, guest, 'POST', '/v1/conversations', { targetType: 'PROPERTY', targetId: propertyId });
    expect(b.body.item.id).toBe(convId);
    const list = await call(t, host, 'GET', '/v1/conversations');
    expect(list.body.items[0].id).toBe(convId);
    expect(list.body.items[0].unreadCount).toBe(1);
    expect(list.body.items[0].lastMessage.body).toContain('11월');
  });

  it('rejects inquiries to yourself and to unknown/unpublished targets', async () => {
    expect((await call(t, host, 'POST', '/v1/conversations', { targetType: 'PROPERTY', targetId: propertyId })).body.code).toBe('CANNOT_MESSAGE_SELF');
    const { rows } = await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'Draft','HOUSE') RETURNING id`, [host.id]);
    expect((await call(t, guest, 'POST', '/v1/conversations', { targetType: 'PROPERTY', targetId: rows[0].id })).status).toBe(404);
    expect((await call(t, guest, 'POST', '/v1/conversations', { targetType: 'GUIDE', targetId: stranger.id })).status).toBe(404);
  });

  it('non-members cannot read, post, mark read or report', async () => {
    expect((await call(t, stranger, 'GET', `/v1/conversations/${convId}/messages`)).status).toBe(404);
    expect((await call(t, stranger, 'POST', `/v1/conversations/${convId}/messages`, { body: 'hi' })).status).toBe(404);
    expect((await call(t, stranger, 'POST', `/v1/conversations/${convId}/read`)).status).toBe(404);
    const msgs = await call(t, host, 'GET', `/v1/conversations/${convId}/messages`);
    expect((await call(t, stranger, 'POST', `/v1/messages/${msgs.body.items[0].id}/report`, { reason: 'spam spam' })).status).toBe(404);
    expect((await call(t, null, 'GET', `/v1/conversations`)).status).toBe(401);
  });

  it('masks contact info before a confirmed booking, with a notice', async () => {
    const r = await call(t, host, 'POST', `/v1/conversations/${convId}/messages`, {
      body: '연락주세요 010-1234-5678 또는 host@example.com, https://evil.example.com/pay 가격은 150000원',
    });
    expect(r.status).toBe(201);
    expect(r.body.item.body).not.toContain('010-1234-5678');
    expect(r.body.item.body).not.toContain('host@example.com');
    expect(r.body.item.body).not.toContain('evil.example.com');
    expect(r.body.item.body).toContain('150000원');
    expect(r.body.item.metadata.contactInfoMasked).toBe(true);
    expect(r.body.item.metadata.maskedKinds).toEqual(['EMAIL', 'PHONE', 'URL']);
    expect(r.body.item.metadata.notice).toBeTruthy();
    expect(maskContactInfo('카톡 아이디: jetpool123').kinds).toContain('MESSENGER_ID');
    expect(maskContactInfo('11월 3일~7일 2명').masked).toBe(false);
  });

  it('does not mask once the reservation context is CONFIRMED', async () => {
    const ctx = t.ctx();
    const { rows } = await t.pool.query(
      `INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, total_minor, currency, quote_snapshot)
       VALUES ($1,$2,$3,'CONFIRMED', current_date + 10, current_date + 12, 100000, 'KRW', '{}') RETURNING id`,
      [propertyId, host.id, guest.id],
    );
    const id = await withTx(t.pool, (tx) =>
      ensureConversation(tx, ctx, { contextType: 'RESERVATION', contextId: rows[0].id, members: [{ userId: guest.id, role: 'GUEST' }] }),
    );
    // idempotent by context, adds missing members
    const again = await withTx(t.pool, (tx) =>
      ensureConversation(tx, ctx, { contextType: 'RESERVATION', contextId: rows[0].id, members: [{ userId: guest.id, role: 'GUEST' }, { userId: host.id, role: 'HOST' }] }),
    );
    expect(again).toBe(id);
    const members = await t.pool.query(`SELECT count(*)::int AS n FROM conversation_members WHERE conversation_id = $1`, [id]);
    expect(members.rows[0].n).toBe(2);
    const r = await call(t, host, 'POST', `/v1/conversations/${id}/messages`, { body: '체크인 문의는 010-1234-5678' });
    expect(r.body.item.body).toContain('010-1234-5678');
    const sys = await withTx(t.pool, (tx) => postSystemMessage(tx, ctx, id, '예약이 확정되었습니다'));
    expect(sys.type).toBe('SYSTEM');
  });

  it('client_message_id makes posting idempotent; body limits are enforced', async () => {
    const body = { body: 'same message', clientMessageId: 'c-123' };
    const a = await call(t, guest, 'POST', `/v1/conversations/${convId}/messages`, body);
    const b = await call(t, guest, 'POST', `/v1/conversations/${convId}/messages`, body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.replayed).toBe(true);
    expect(b.body.item.id).toBe(a.body.item.id);
    const n = await t.pool.query(`SELECT count(*)::int AS n FROM messages WHERE client_message_id = 'c-123'`);
    expect(n.rows[0].n).toBe(1);
    expect((await call(t, guest, 'POST', `/v1/conversations/${convId}/messages`, { body: 'x'.repeat(4001) })).status).toBe(400);
    expect((await call(t, guest, 'POST', `/v1/conversations/${convId}/messages`, { body: '   ' })).body.code).toBe('EMPTY_MESSAGE');
  });

  it('keyset paginates messages and tracks read state', async () => {
    const p1 = await call(t, host, 'GET', `/v1/conversations/${convId}/messages?limit=2`);
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.nextCursor).toBeTruthy();
    const p2 = await call(t, host, 'GET', `/v1/conversations/${convId}/messages?limit=2&cursor=${p1.body.nextCursor}`);
    const ids = new Set([...p1.body.items, ...p2.body.items].map((m: any) => m.id));
    expect(ids.size).toBe(p1.body.items.length + p2.body.items.length);
    await call(t, host, 'POST', `/v1/conversations/${convId}/read`);
    const list = await call(t, host, 'GET', '/v1/conversations');
    expect(list.body.items.find((c: any) => c.id === convId).unreadCount).toBe(0);
  });

  it('reports a message once and emits message.reported', async () => {
    const msgs = await call(t, guest, 'GET', `/v1/conversations/${convId}/messages`);
    const hostMsg = msgs.body.items.find((m: any) => m.senderId === host.id);
    expect((await call(t, guest, 'POST', `/v1/messages/${hostMsg.id}/report`, { reason: 'off-platform payment' })).status).toBe(201);
    expect((await call(t, guest, 'POST', `/v1/messages/${hostMsg.id}/report`, { reason: 'off-platform payment' })).status).toBe(200);
    const own = msgs.body.items.find((m: any) => m.senderId === guest.id);
    expect((await call(t, guest, 'POST', `/v1/messages/${own.id}/report`, { reason: 'mine mine' })).status).toBe(400);
    const ev = await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'message.reported'`);
    expect(ev.rows[0].n).toBe(1);
  });

  describe('invariant 10: staff access requires audited elevation', () => {
    let disputeId: string;
    beforeAll(async () => {
      const { rows } = await t.pool.query(
        `INSERT INTO disputes(opened_by, context_type, context_id, reason) VALUES ($1,'MESSAGE',$2,'harassment') RETURNING id`,
        [guest.id, convId],
      );
      disputeId = rows[0].id;
    });

    it('denies staff without a grant (and audits the denial); denies AAL1 staff and non-staff', async () => {
      const r = await call(t, admin, 'GET', `/v1/admin/conversations/${convId}/messages`);
      expect(r.status).toBe(403);
      expect(r.body.code).toBe('ELEVATED_ACCESS_REQUIRED');
      const a = await t.pool.query(`SELECT * FROM audit_logs WHERE action = 'conversation.read.denied' AND resource_id = $1`, [convId]);
      expect(a.rows[0].category).toBe('ELEVATED_ACCESS');
      const aal1 = await createUser(t, { roles: ['ADMIN'], aal: 'aal1' });
      expect((await call(t, aal1, 'GET', `/v1/admin/conversations/${convId}/messages`)).body.code).toBe('AAL2_REQUIRED');
      expect((await call(t, guest, 'GET', `/v1/admin/conversations/${convId}/messages`)).status).toBe(403);
      // staff are not members either
      expect((await call(t, admin, 'GET', `/v1/conversations/${convId}/messages`)).status).toBe(404);
    });

    it('denies an expired or revoked grant and a grant for another conversation', async () => {
      await t.pool.query(
        `INSERT INTO elevated_access_grants(admin_id, case_type, case_id, resource_type, resource_id, reason, expires_at, created_at)
         VALUES ($1,'DISPUTE',$2,'CONVERSATION',$3,'dispute investigation', now() - interval '1 hour', now() - interval '2 hours')`,
        [admin.id, disputeId, convId],
      );
      await t.pool.query(
        `INSERT INTO elevated_access_grants(admin_id, case_type, case_id, resource_type, resource_id, reason, expires_at, revoked_at)
         VALUES ($1,'DISPUTE',$2,'CONVERSATION',$3,'dispute investigation', now() + interval '1 hour', now())`,
        [admin.id, disputeId, convId],
      );
      await t.pool.query(
        `INSERT INTO elevated_access_grants(admin_id, case_type, case_id, resource_type, resource_id, reason, expires_at)
         VALUES ($1,'DISPUTE',$2,'CONVERSATION',gen_random_uuid(),'dispute investigation', now() + interval '1 hour')`,
        [admin.id, disputeId],
      );
      expect((await call(t, admin, 'GET', `/v1/admin/conversations/${convId}/messages`)).status).toBe(403);
    });

    it('allows a live grant holder and audits every read', async () => {
      await t.pool.query(
        `INSERT INTO elevated_access_grants(admin_id, case_type, case_id, resource_type, resource_id, reason, expires_at)
         VALUES ($1,'DISPUTE',$2,'CONVERSATION',$3,'dispute investigation #1', now() + interval '2 hours')`,
        [admin.id, disputeId, convId],
      );
      const r = await call(t, admin, 'GET', `/v1/admin/conversations/${convId}/messages`);
      expect(r.status).toBe(200);
      expect(r.body.items.length).toBeGreaterThan(0);
      expect(r.body.grant.caseId).toBe(disputeId);
      await call(t, admin, 'GET', `/v1/admin/conversations/${convId}/messages`);
      const a = await t.pool.query(`SELECT * FROM audit_logs WHERE action = 'conversation.read' AND resource_id = $1`, [convId]);
      expect(a.rows).toHaveLength(2);
      expect(a.rows[0].category).toBe('ELEVATED_ACCESS');
      expect(a.rows[0].actor_id).toBe(admin.id);
      expect(a.rows[0].after_state.caseId).toBe(disputeId);
      // another admin with no grant is still denied
      const other = await createUser(t, { roles: ['SUPPORT'] });
      expect((await call(t, other, 'GET', `/v1/admin/conversations/${convId}/messages`)).status).toBe(403);
    });
  });

  describe('realtime', () => {
    it('publishes committed messages to members only (in-process delivery)', async () => {
      const got: Record<string, any[]> = { host: [], guest: [], stranger: [] };
      const unsub = [
        t.app.ctx.realtime.subscribe(`user:${host.id}`, (e) => got.host.push(e)),
        t.app.ctx.realtime.subscribe(`user:${guest.id}`, (e) => got.guest.push(e)),
        t.app.ctx.realtime.subscribe(`user:${stranger.id}`, (e) => got.stranger.push(e)),
      ];
      const r = await call(t, guest, 'POST', `/v1/conversations/${convId}/messages`, { body: 'realtime ping' });
      await new Promise((res) => setTimeout(res, 100));
      unsub.forEach((u) => u());
      expect(got.host.map((e) => e.message.id)).toContain(r.body.item.id);
      expect(got.guest.map((e) => e.message.id)).toContain(r.body.item.id);
      expect(got.stranger).toHaveLength(0);
    });

    it('LISTEN/NOTIFY bridge delivers messages committed by another connection (multi-instance)', async () => {
      const stop = await startMessageBridge(t.app.ctx);
      try {
        const received = new Promise<any>((resolve) => {
          const u = t.app.ctx.realtime.subscribe(`user:${host.id}`, (e) => {
            if (e.message.body === 'via notify') {
              u();
              resolve(e);
            }
          });
        });
        // write directly through the service on a separate tx (as another API instance would)
        await withTx(t.pool, (tx) => sendMessage(tx, t.ctx(), { conversationId: convId, senderId: guest.id, body: 'via notify' }));
        const e = await Promise.race([received, new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), 3000))]);
        expect((e as any).message.conversationId).toBe(convId);
      } finally {
        await stop();
      }
    });

    it('SSE stream rejects missing/invalid tokens', async () => {
      expect((await call(t, null, 'GET', '/v1/realtime/stream')).status).toBe(401);
      expect((await call(t, null, 'GET', '/v1/realtime/stream?token=bogus')).status).toBe(401);
    });

    it('SSE stream over a real socket receives a message (token in query)', async () => {
      const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
      const ac = new AbortController();
      const res = await fetch(`${address}/v1/realtime/stream?token=${host.token}`, { signal: ac.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      const dec = new TextDecoder();
      let buf = '';
      const first = await reader.read();
      buf += dec.decode(first.value);
      expect(buf).toContain('event: ready');
      await call(t, guest, 'POST', `/v1/conversations/${convId}/messages`, { body: 'over sse' });
      const deadline = Date.now() + 3000;
      while (!buf.includes('over sse') && Date.now() < deadline) {
        const c = await reader.read();
        if (c.done) break;
        buf += dec.decode(c.value);
      }
      ac.abort();
      expect(buf).toContain('event: message');
      expect(buf).toContain('over sse');
    });
  });
});
