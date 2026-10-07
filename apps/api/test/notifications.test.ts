import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { withTx } from '../src/platform/db.js';
import { notify } from '../src/platform/notify.js';
import { NotifierRegistry, NovuProvider, type Notifier, type OutboundMessage } from '../src/modules/notifications/providers.js';
import { deliverPending, fanOutNotification, renderTemplate } from '../src/modules/notifications/service.js';

let t: TestApp;
let user: TestUser;
const sent: OutboundMessage[] = [];
let failNext = 0;

class Recorder implements Notifier {
  name = 'recorder';
  async send(m: OutboundMessage) {
    if (failNext > 0) {
      failNext--;
      throw new Error('provider down');
    }
    sent.push(m);
    return { providerRef: `rec-${sent.length}` };
  }
}

const deliveries = async (id: string) =>
  Object.fromEntries((await t.pool.query(`SELECT channel, status, error, attempts FROM notification_deliveries WHERE notification_id = $1`, [id])).rows.map((r) => [r.channel, r]));

async function create(n: Parameters<typeof notify>[2]) {
  return withTx(t.pool, (tx) => notify(tx, t.ctx(), n));
}

beforeAll(async () => {
  t = await createTestApp();
  const reg = new NotifierRegistry();
  for (const ch of ['EMAIL', 'SMS', 'PUSH', 'KAKAO_ALIMTALK'] as const) reg.register(ch, new Recorder());
  t.app.ctx.adapters.set('notifier', reg);
  user = await createUser(t, { displayName: '민지' });
  await t.pool.query(`UPDATE users SET phone = '+821012345678', locale = 'ko-KR' WHERE id = $1`, [user.id]);
});
afterAll(async () => t.close());

describe('COMMS-02 notifications', () => {
  it('renders {{var}} templates safely', () => {
    expect(renderTemplate('안녕 {{displayName}} {{a.b}} {{missing}}', { displayName: 'X', a: { b: 1 } })).toBe('안녕 X 1 ');
  });

  it('fans out TRANSACTIONAL per defaults, renders templates and delivers via adapters', async () => {
    const id = await create({ userId: user.id, templateKey: 'reservation.confirmed', title: '예약 확정', body: 'b', data: { code: 'ABC123' }, dedupeKey: 'r1' });
    await t.drain();
    const d = await deliveries(id!);
    expect(d.IN_APP.status).toBe('SENT');
    expect(d.EMAIL.status).toBe('QUEUED');
    expect(d.KAKAO_ALIMTALK.status).toBe('QUEUED');
    expect(d.SMS.status).toBe('SUPPRESSED');
    await deliverPending(t.app.ctx);
    const email = sent.find((m) => m.notificationId === id && m.channel === 'EMAIL')!;
    expect(email.subject).toBe('[JETPOOL] 예약이 확정되었습니다 (ABC123)');
    expect(email.body).toContain('민지님');
    expect((await deliveries(id!)).EMAIL.status).toBe('SENT');
    const ev = await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'notification.delivered' AND payload->>'notificationId' = $1`, [id]);
    expect(ev.rows[0].n).toBe(3); // EMAIL + PUSH + KAKAO_ALIMTALK
  });

  it('dedupes: replaying notify or the fan-out creates no duplicate notifications/deliveries', async () => {
    const again = await create({ userId: user.id, templateKey: 'reservation.confirmed', title: '예약 확정', body: 'b', dedupeKey: 'r1' });
    expect(again).toBeNull();
    const { rows } = await t.pool.query(`SELECT id FROM notifications WHERE dedupe_key = 'r1'`);
    await withTx(t.pool, (tx) => fanOutNotification(tx, t.ctx(), t.app.ctx, rows[0].id));
    const n = await t.pool.query(`SELECT count(*)::int AS n FROM notification_deliveries WHERE notification_id = $1`, [rows[0].id]);
    expect(n.rows[0].n).toBe(5);
    const before = sent.length;
    await deliverPending(t.app.ctx);
    expect(sent.length).toBe(before);
  });

  it('respects preferences but never disables mandatory channels', async () => {
    const off = await call(t, user, 'PATCH', '/v1/notification-preferences', {
      preferences: [
        { category: 'TRANSACTIONAL', channel: 'EMAIL', enabled: false },
        { category: 'TRANSACTIONAL', channel: 'KAKAO_ALIMTALK', enabled: false },
      ],
    });
    expect(off.status).toBe(200);
    const bad = await call(t, user, 'PATCH', '/v1/notification-preferences', { preferences: [{ category: 'SECURITY', channel: 'EMAIL', enabled: false }] });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('MANDATORY_CHANNEL');
    expect((await call(t, user, 'PATCH', '/v1/notification-preferences', { preferences: [{ category: 'TRANSACTIONAL', channel: 'IN_APP', enabled: false }] })).status).toBe(422);
    const prefs = await call(t, user, 'GET', '/v1/notification-preferences');
    expect(prefs.body.items.find((p: any) => p.category === 'TRANSACTIONAL' && p.channel === 'EMAIL').enabled).toBe(false);

    const tx = await create({ userId: user.id, templateKey: 'payment.approved', title: '결제', body: 'b', dedupeKey: 'p1' });
    const sec = await create({ userId: user.id, templateKey: 'security.new_login', title: '로그인', body: 'b', category: 'SECURITY', dedupeKey: 's1' });
    await t.drain();
    const dt = await deliveries(tx!);
    expect(dt.EMAIL.status).toBe('SUPPRESSED');
    expect(dt.EMAIL.error).toBe('PREFERENCE_DISABLED');
    expect(dt.IN_APP.status).toBe('SENT');
    expect((await deliveries(sec!)).EMAIL.status).toBe('QUEUED');
  });

  it('MARKETING requires opt-in consent for every channel', async () => {
    const m1 = await create({ userId: user.id, templateKey: 'marketing.promotion', title: '가을 특가', body: 'b', category: 'MARKETING', dedupeKey: 'm1' });
    await t.drain();
    const d1 = await deliveries(m1!);
    expect(Object.values(d1).every((d: any) => d.status === 'SUPPRESSED' && d.error === 'NO_MARKETING_CONSENT')).toBe(true);
    const inbox = await call(t, user, 'GET', '/v1/notifications');
    expect(inbox.body.items.some((n: any) => n.id === m1)).toBe(false);

    await t.pool.query(`INSERT INTO user_preferences(user_id, marketing_opt_in) VALUES ($1, true)`, [user.id]);
    const m2 = await create({ userId: user.id, templateKey: 'marketing.promotion', title: '겨울 특가', body: 'b', category: 'MARKETING', dedupeKey: 'm2' });
    await t.drain();
    expect((await deliveries(m2!)).EMAIL.status).toBe('QUEUED');
  });

  it('retries failed deliveries with backoff, then marks FAILED', async () => {
    const id = await create({ userId: user.id, templateKey: 'security.new_login', title: 'x', body: 'b', category: 'SECURITY', dedupeKey: 'retry' });
    await t.drain();
    await t.pool.query(`UPDATE notification_deliveries SET status = 'SUPPRESSED' WHERE status = 'QUEUED' AND notification_id <> $1`, [id]);
    failNext = 100;
    for (let i = 0; i < 5; i++) {
      await t.pool.query(`UPDATE notification_deliveries SET next_attempt_at = now() WHERE notification_id = $1`, [id]);
      await deliverPending(t.app.ctx);
    }
    failNext = 0;
    const d = await deliveries(id!);
    expect(d.EMAIL.status).toBe('FAILED');
    expect(d.EMAIL.attempts).toBe(5);
    expect(d.EMAIL.error).toBe('provider down');
  });

  it('inbox: list, unread filter, read, read-all, ownership', async () => {
    const list = await call(t, user, 'GET', '/v1/notifications?unread=true&limit=2');
    expect(list.body.items).toHaveLength(2);
    expect(list.body.nextCursor).toBeTruthy();
    const id = list.body.items[0].id;
    const other = await createUser(t);
    expect((await call(t, other, 'POST', `/v1/notifications/${id}/read`)).status).toBe(404);
    expect((await call(t, user, 'POST', `/v1/notifications/${id}/read`)).body.item.readAt).toBeTruthy();
    const all = await call(t, user, 'POST', '/v1/notifications/read-all');
    expect(all.body.updated).toBeGreaterThan(0);
    expect((await call(t, user, 'GET', '/v1/notifications?unread=true')).body.unreadCount).toBe(0);
  });

  it('new messages create a coalesced in-app notification for the other members', async () => {
    const host = await createUser(t, { roles: ['HOST'] });
    const { rows } = await t.pool.query(`INSERT INTO properties(host_id, title, property_type, status) VALUES ($1,'P','HOUSE','PUBLISHED') RETURNING id`, [host.id]);
    const c = await call(t, user, 'POST', '/v1/conversations', { targetType: 'PROPERTY', targetId: rows[0].id, message: 'hello' });
    await call(t, user, 'POST', `/v1/conversations/${c.body.item.id}/messages`, { body: 'second' });
    await t.drain();
    const n = await t.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND template_key = 'message.received'`, [host.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('Novu adapter calls the trigger endpoint with ApiKey auth', async () => {
    let captured: any;
    const fake: typeof fetch = async (url, init) => {
      captured = { url, init };
      return new Response(JSON.stringify({ data: { transactionId: 'tx1' } }), { status: 201 });
    };
    const novu = new NovuProvider('k_test', fake);
    const r = await novu.send({ notificationId: 'n1', channel: 'EMAIL', templateKey: 'reservation.confirmed', category: 'TRANSACTIONAL', to: { userId: 'u1', email: 'a@b.c', locale: 'ko-KR' }, body: 'b', data: {} });
    expect(captured.url).toBe('https://api.novu.co/v1/events/trigger');
    expect(captured.init.headers.authorization).toBe('ApiKey k_test');
    expect(JSON.parse(captured.init.body).to.subscriberId).toBe('u1');
    expect(r.providerRef).toBe('tx1');
  });
});
