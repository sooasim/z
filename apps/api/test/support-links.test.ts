import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { ChatwootSupportDesk, NoopSupportDesk, SUPPORT_DESK_ADAPTER, chatwootConfigFromEnv, supportDeskOf } from '../src/modules/support/desk.js';
import { runDeskSync, syncCaseToDesk } from '../src/modules/support/service.js';
import { withTx } from '../src/platform/db.js';

let t: TestApp;
let user: TestUser, other: TestUser, host: TestUser, agent: TestUser, agent2: TestUser, admin: TestUser;
let reservationId: string, exchangeId: string, conversationId: string, paymentId: string;

beforeAll(async () => {
  t = await createTestApp();
  user = await createUser(t, { email: 'casey.requester@example.com' });
  other = await createUser(t);
  host = await createUser(t, { roles: ['HOST'] });
  agent = await createUser(t, { roles: ['SUPPORT'] });
  agent2 = await createUser(t, { roles: ['SUPPORT'] });
  admin = await createUser(t, { roles: ['ADMIN'] });
  await t.pool.query(`UPDATE users SET phone = '01098765432' WHERE id = $1`, [user.id]);
  const pa = (await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'P','HOUSE') RETURNING id`, [host.id])).rows[0].id;
  const pb = (await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'Q','HOUSE') RETURNING id`, [user.id])).rows[0].id;
  reservationId = (
    await t.pool.query(
      `INSERT INTO reservations(property_id, host_id, guest_id, status, check_in, check_out, total_minor, currency, quote_snapshot)
       VALUES ($1,$2,$3,'CONFIRMED', current_date + 3, current_date + 5, 100000, 'KRW', '{}') RETURNING id`,
      [pa, host.id, user.id],
    )
  ).rows[0].id;
  exchangeId = (
    await t.pool.query(
      `INSERT INTO exchange_requests(requester_id, responder_id, property_a_id, property_b_id, dates_a, dates_b, status)
       VALUES ($1,$2,$3,$4, daterange(current_date + 30, current_date + 33), daterange(current_date + 30, current_date + 33), 'REQUESTED') RETURNING id`,
      [user.id, host.id, pb, pa],
    )
  ).rows[0].id;
  conversationId = (await t.pool.query(`INSERT INTO conversations(context_type, context_id, created_by) VALUES ('RESERVATION',$1,$2) RETURNING id`, [reservationId, user.id])).rows[0].id;
  await t.pool.query(`INSERT INTO conversation_members(conversation_id, user_id, role) VALUES ($1,$2,'GUEST'),($1,$3,'HOST')`, [conversationId, user.id, host.id]);
  paymentId = (
    await t.pool.query(
      `INSERT INTO payments(provider, provider_order_id, payer_id, subject_type, subject_id, status, amount_minor, currency, expires_at)
       VALUES ('MOCK','sl-o1',$1,'RESERVATION',$2,'APPROVED',100000,'KRW',now()) RETURNING id`,
      [user.id, reservationId],
    )
  ).rows[0].id;
});
afterAll(async () => t.close());

const openCase = (who: TestUser, extra: Record<string, unknown> = {}) =>
  call(t, who, 'POST', '/v1/support/cases', { category: 'BOOKING', subject: 'Need help', description: 'Please help with my stay', ...extra });
const links = async (caseId: string) => (await t.pool.query(`SELECT link_type, link_id, created_by FROM support_case_links WHERE case_id = $1 ORDER BY link_type`, [caseId])).rows;
const adminActions = async (caseId: string) =>
  (await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'admin.action.performed' AND aggregate_id = $1 ORDER BY created_at, id`, [caseId])).rows.map((r) => r.payload.action);

describe('OPS-01 support_case_links: requester context', () => {
  it('a verified requester context auto-creates a link; non-parties are refused and nothing is written', async () => {
    const before = (await t.pool.query(`SELECT count(*)::int AS n FROM support_cases`)).rows[0].n;
    expect((await openCase(other, { contextType: 'RESERVATION', contextId: reservationId })).body.code).toBe('NOT_A_PARTY');
    expect((await openCase(other, { contextType: 'EXCHANGE', contextId: exchangeId })).body.code).toBe('NOT_A_PARTY');
    expect((await openCase(other, { contextType: 'PAYMENT', contextId: paymentId })).body.code).toBe('NOT_A_PARTY');
    expect((await openCase(other, { contextType: 'ACCOUNT', contextId: user.id })).body.code).toBe('NOT_A_PARTY');
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM support_cases`)).rows[0].n).toBe(before);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM support_case_links`)).rows[0].n).toBe(0);

    const r = await openCase(user, { contextType: 'RESERVATION', contextId: reservationId });
    expect(r.status).toBe(201);
    expect(await links(r.body.item.id)).toEqual([{ link_type: 'RESERVATION', link_id: reservationId, created_by: user.id }]);
    // the counterparty (host) is a party of the exchange-side context too
    const ex = await openCase(host, { category: 'EXCHANGE', contextType: 'EXCHANGE', contextId: exchangeId });
    expect(await links(ex.body.item.id)).toEqual([{ link_type: 'EXCHANGE', link_id: exchangeId, created_by: host.id }]);
    const pay = await openCase(user, { category: 'PAYMENT', contextType: 'PAYMENT', contextId: paymentId });
    expect((await links(pay.body.item.id)).map((l) => l.link_type)).toEqual(['PAYMENT']);
  });

  it('ACCOUNT links the requester user; OTHER links nothing', async () => {
    const acc = await openCase(user, { category: 'ACCOUNT', contextType: 'ACCOUNT' });
    expect(await links(acc.body.item.id)).toEqual([{ link_type: 'USER', link_id: user.id, created_by: user.id }]);
    const own = await openCase(user, { category: 'ACCOUNT', contextType: 'ACCOUNT', contextId: user.id });
    expect((await links(own.body.item.id)).map((l) => l.link_type)).toEqual(['USER']);
    const oth = await openCase(user, { category: 'OTHER', contextType: 'OTHER' });
    expect(await links(oth.body.item.id)).toEqual([]);
  });
});

describe('OPS-01 support_case_links: staff link / unlink', () => {
  let caseId: string;
  beforeAll(async () => {
    caseId = (await openCase(user, { contextType: 'RESERVATION', contextId: reservationId })).body.item.id;
  });

  it('only SUPPORT/ADMIN with AAL2 can manage links', async () => {
    const body = { linkType: 'PAYMENT', linkId: paymentId };
    expect((await call(t, user, 'POST', `/v1/admin/support/cases/${caseId}/links`, body)).status).toBe(403);
    expect((await call(t, user, 'GET', `/v1/admin/support/cases/${caseId}/links`)).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['SUPPORT'], aal: 'aal1' });
    expect((await call(t, aal1, 'POST', `/v1/admin/support/cases/${caseId}/links`, body)).body.code).toBe('AAL2_REQUIRED');
    const editor = await createUser(t, { roles: ['EDITOR'] });
    expect((await call(t, editor, 'POST', `/v1/admin/support/cases/${caseId}/links`, body)).status).toBe(403);
    expect((await call(t, user, 'DELETE', `/v1/admin/support/cases/${caseId}/links/RESERVATION/${reservationId}`)).status).toBe(403);
    expect(await links(caseId)).toHaveLength(1);
  });

  it('links are validated, idempotent, audited and emit admin.action.performed', async () => {
    expect((await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/links`, { linkType: 'INVOICE', linkId: paymentId })).status).toBe(400);
    expect((await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/links`, { linkType: 'PAYMENT', linkId: 'nope' })).status).toBe(400);
    expect((await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/links`, { linkType: 'ORDER', linkId: paymentId })).status).toBe(404);
    expect((await call(t, agent, 'POST', `/v1/admin/support/cases/00000000-0000-4000-8000-000000000000/links`, { linkType: 'PAYMENT', linkId: paymentId })).status).toBe(404);

    const a = await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/links`, { linkType: 'PAYMENT', linkId: paymentId });
    expect(a.status).toBe(201);
    expect(a.body.item).toMatchObject({ linkType: 'PAYMENT', linkId: paymentId, createdBy: agent.id, source: 'STAFF' });
    const again = await call(t, agent2, 'POST', `/v1/admin/support/cases/${caseId}/links`, { linkType: 'PAYMENT', linkId: paymentId });
    expect(again.status).toBe(200);
    expect(again.body.item.createdBy).toBe(agent.id);
    expect((await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/links`, { linkType: 'CONVERSATION', linkId: conversationId })).status).toBe(201);
    expect((await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/links`, { linkType: 'USER', linkId: host.id })).status).toBe(201);

    const list = await call(t, agent, 'GET', `/v1/admin/support/cases/${caseId}/links`);
    expect(list.body.items.map((l: any) => `${l.linkType}:${l.source}`).sort()).toEqual(['CONVERSATION:STAFF', 'PAYMENT:STAFF', 'RESERVATION:REQUESTER', 'USER:STAFF']);
    const audit = await t.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'support.case.linked' AND resource_id = $1`, [caseId]);
    expect(audit.rows[0].n).toBe(3);
    expect((await adminActions(caseId)).filter((x) => x === 'support.case.linked')).toHaveLength(3);
  });

  it('staff detail shows links; the requester never sees staff-added links', async () => {
    const staff = await call(t, agent, 'GET', `/v1/admin/support/cases/${caseId}`);
    expect(staff.body.item.links).toHaveLength(4);
    const mine = await call(t, user, 'GET', `/v1/support/cases/${caseId}`);
    expect(mine.body.item.links).toBeUndefined();
    expect(JSON.stringify(mine.body)).not.toContain(host.id);
  });

  it('queue can be filtered by link (all cases about a record)', async () => {
    const q = await call(t, agent, 'GET', `/v1/admin/support/cases?linkType=PAYMENT&linkId=${paymentId}`);
    expect(q.body.items.map((c: any) => c.id)).toContain(caseId);
    const byRes = await call(t, agent, 'GET', `/v1/admin/support/cases?linkType=RESERVATION&linkId=${reservationId}`);
    expect(byRes.body.items.length).toBeGreaterThanOrEqual(2);
    expect((await call(t, agent, 'GET', `/v1/admin/support/cases?linkType=PAYMENT`)).body.code).toBe('LINK_FILTER_INCOMPLETE');
  });

  it('unlink removes the link (404 when absent); closed cases are read-only', async () => {
    const u = await call(t, agent, 'DELETE', `/v1/admin/support/cases/${caseId}/links/USER/${host.id}`);
    expect(u.status).toBe(200);
    expect(u.body.item).toMatchObject({ linkType: 'USER', linkId: host.id });
    expect((await call(t, agent, 'DELETE', `/v1/admin/support/cases/${caseId}/links/USER/${host.id}`)).status).toBe(404);
    expect((await links(caseId)).map((l) => l.link_type)).not.toContain('USER');
    expect(await adminActions(caseId)).toContain('support.case.unlinked');

    await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/status`, { to: 'CLOSED', note: 'done' });
    expect((await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/links`, { linkType: 'USER', linkId: host.id })).body.code).toBe('CASE_CLOSED');
    expect((await call(t, agent, 'DELETE', `/v1/admin/support/cases/${caseId}/links/PAYMENT/${paymentId}`)).body.code).toBe('CASE_CLOSED');
  });

  it('every staff mutation emits admin.action.performed; requester actions do not', async () => {
    const id = (await openCase(user)).body.item.id;
    await call(t, user, 'POST', `/v1/support/cases/${id}/comments`, { body: 'more details' });
    expect(await adminActions(id)).toEqual([]);
    await call(t, agent, 'POST', `/v1/admin/support/cases/${id}/assign`, { assigneeId: agent2.id });
    await call(t, agent2, 'POST', `/v1/admin/support/cases/${id}/notes`, { body: 'internal' });
    await call(t, agent2, 'POST', `/v1/admin/support/cases/${id}/comments`, { body: 'hello' });
    await call(t, agent2, 'POST', `/v1/admin/support/cases/${id}/priority`, { priority: 'HIGH' });
    await call(t, agent2, 'POST', `/v1/admin/support/cases/${id}/status`, { to: 'RESOLVED', note: 'fixed' });
    expect(await adminActions(id)).toEqual(['support.case.assigned', 'support.case.internal_note', 'support.case.replied', 'support.case.priority_changed', 'support.case.status_changed']);
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'admin.action.performed' AND aggregate_id = $1 ORDER BY created_at, id LIMIT 1`, [id]);
    expect(ev.rows[0].payload).toMatchObject({ resourceType: 'support_case', resourceId: id, actorId: agent.id, assigneeId: agent2.id });
    // a failed staff mutation leaves no event behind (same transaction)
    await call(t, agent2, 'POST', `/v1/admin/support/cases/${id}/assign`, { assigneeId: other.id });
    expect((await adminActions(id)).filter((a) => a === 'support.case.assigned')).toHaveLength(1);
  });
});

describe('OPS-01 masking: requester contact data', () => {
  let caseId: string;
  beforeAll(async () => {
    caseId = (await openCase(user, { contextType: 'RESERVATION', contextId: reservationId })).body.item.id;
  });

  it('SUPPORT sees masked email/phone; ADMIN and the requester see them in full', async () => {
    const s = await call(t, agent, 'GET', `/v1/admin/support/cases/${caseId}`);
    expect(s.body.item.contactEmail).toMatch(/^ca\*+@example\.com$/);
    expect(s.body.item.contactPhone).toBe('*******5432');
    expect(s.body.item.contactMasked).toBe(true);
    expect(JSON.stringify(s.body)).not.toContain('01098765432');
    expect(JSON.stringify(s.body)).not.toContain('casey.requester@');

    const a = await call(t, admin, 'GET', `/v1/admin/support/cases/${caseId}`);
    expect(a.body.item).toMatchObject({ contactEmail: 'casey.requester@example.com', contactPhone: '01098765432', contactMasked: false });
    const own = await call(t, user, 'GET', `/v1/support/cases/${caseId}`);
    expect(own.body.item).toMatchObject({ contactEmail: 'casey.requester@example.com', contactPhone: '01098765432', contactMasked: false });
  });

  it('an active case-scoped elevated grant unmasks for that agent only (audited); revoked/expired grants do not', async () => {
    const g = await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/elevated-access`, { conversationId, reason: 'guest reports harassment in chat', durationMinutes: 30 });
    expect(g.status).toBe(201);
    expect(await adminActions(caseId)).toContain('support.case.elevated_access_granted');

    const s = await call(t, agent, 'GET', `/v1/admin/support/cases/${caseId}`);
    expect(s.body.item).toMatchObject({ contactEmail: 'casey.requester@example.com', contactPhone: '01098765432', contactMasked: false });
    const aud = await t.pool.query(`SELECT reason, category, after_state FROM audit_logs WHERE action = 'support.case.contact_viewed' AND resource_id = $1`, [caseId]);
    expect(aud.rows).toHaveLength(1);
    expect(aud.rows[0]).toMatchObject({ category: 'ELEVATED_ACCESS', reason: 'guest reports harassment in chat' });
    expect(aud.rows[0].after_state.grantId).toBe(g.body.item.id);

    // another agent without a grant is still masked; the list view stays masked even for the grant holder
    expect((await call(t, agent2, 'GET', `/v1/admin/support/cases/${caseId}`)).body.item.contactMasked).toBe(true);
    expect((await call(t, agent, 'GET', '/v1/admin/support/cases')).body.items.find((c: any) => c.id === caseId).contactEmail).toMatch(/\*/);
    // a grant on another case does not unmask this one
    const otherCase = (await openCase(user, { category: 'OTHER', contextType: 'OTHER' })).body.item.id;
    expect((await call(t, agent, 'GET', `/v1/admin/support/cases/${otherCase}`)).body.item.contactMasked).toBe(true);

    await t.pool.query(`UPDATE elevated_access_grants SET expires_at = now() - interval '1 second' WHERE id = $1`, [g.body.item.id]);
    expect((await call(t, agent, 'GET', `/v1/admin/support/cases/${caseId}`)).body.item.contactMasked).toBe(true);
    const g2 = await call(t, agent, 'POST', `/v1/admin/support/cases/${caseId}/elevated-access`, { conversationId, reason: 'second look at the chat log' });
    expect((await call(t, agent, 'GET', `/v1/admin/support/cases/${caseId}`)).body.item.contactMasked).toBe(false);
    await t.pool.query(`UPDATE elevated_access_grants SET revoked_at = now() WHERE id = $1`, [g2.body.item.id]);
    expect((await call(t, agent, 'GET', `/v1/admin/support/cases/${caseId}`)).body.item.contactMasked).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Chatwoot desk adapter (stubbed fetch)
// ---------------------------------------------------------------------------------------------------------------
type Req = { url: string; method: string; headers: Record<string, string>; body: any };
let convSeq = 1000;

function chatwootStub(opts: { existingContact?: boolean; failConversation?: boolean; existingConversations?: unknown[] } = {}) {
  const calls: Req[] = [];
  const fn = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    const req: Req = { url: u, method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) }, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(req);
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (req.headers.api_access_token !== 'cw-token') return json(401, { error: 'unauthorized' });
    if (u.includes('/contacts/search')) {
      const ident = new URL(u).searchParams.get('q');
      return json(200, { payload: opts.existingContact ? [{ id: 55, identifier: ident, contact_inboxes: [{ source_id: 'src-existing', inbox: { id: 3 } }] }] : [] });
    }
    if (u.endsWith('/api/v1/accounts/7/contacts') && req.method === 'POST') return json(200, { payload: { contact: { id: 42, identifier: req.body.identifier }, contact_inbox: { source_id: 'src-42' } } });
    if (/\/api\/v1\/accounts\/7\/contacts\/\d+\/conversations$/.test(u) && req.method === 'GET') return json(200, { payload: opts.existingConversations ?? [] });
    if (u.endsWith('/api/v1/accounts/7/conversations') && req.method === 'POST') {
      if (opts.failConversation) return json(500, { error: 'boom' });
      return json(200, { id: ++convSeq, inbox_id: 3, status: 'open' });
    }
    return json(404, { error: 'not found' });
  });
  return { fn, calls };
}

const CW_ENV = { CHATWOOT_BASE_URL: 'https://desk.example.com/', CHATWOOT_API_TOKEN: 'cw-token', CHATWOOT_ACCOUNT_ID: '7', CHATWOOT_INBOX_ID: '3' };

describe('OPS-01 Chatwoot support desk adapter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of Object.keys(CW_ENV)) delete process.env[k];
    t.app.ctx.adapters.delete(SUPPORT_DESK_ADAPTER);
  });

  it('config comes from env; incomplete config falls back to the no-op desk', () => {
    expect(chatwootConfigFromEnv({})).toBeNull();
    expect(chatwootConfigFromEnv({ ...CW_ENV, CHATWOOT_INBOX_ID: '' })).toBeNull();
    expect(chatwootConfigFromEnv({ ...CW_ENV, CHATWOOT_BASE_URL: 'ftp://x' })).toBeNull();
    expect(chatwootConfigFromEnv(CW_ENV)).toMatchObject({ baseUrl: 'https://desk.example.com/', accountId: '7', inboxId: '3' });
    expect(supportDeskOf(t.app.ctx)).toBeInstanceOf(NoopSupportDesk);
    Object.assign(process.env, CW_ENV);
    expect(supportDeskOf(t.app.ctx)).toBeInstanceOf(ChatwootSupportDesk);
  });

  it('creates contact + conversation with api_access_token and never sends contact PII', async () => {
    const stub = chatwootStub();
    const desk = new ChatwootSupportDesk({ ...chatwootConfigFromEnv(CW_ENV)!, fetch: stub.fn as unknown as typeof fetch });
    const out = await desk.createConversation({ id: 'c0ffee00-0000-4000-8000-000000000001', requesterId: user.id, category: 'BOOKING', subject: 'Late check-in', description: 'Arriving at 11pm', priority: 'HIGH', contextType: 'RESERVATION', contextId: reservationId });
    expect(out).toEqual({ externalRef: `chatwoot:7:${convSeq}` });
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /api/v1/accounts/7/contacts/search',
      'POST /api/v1/accounts/7/contacts',
      'POST /api/v1/accounts/7/conversations',
    ]);
    expect(stub.calls.every((c) => c.headers.api_access_token === 'cw-token' && c.url.startsWith('https://desk.example.com/api/v1/'))).toBe(true);
    const conv = stub.calls[2].body;
    expect(conv).toMatchObject({ source_id: 'src-42', inbox_id: 3, contact_id: 42, priority: 'high', custom_attributes: { jetpool_case_id: 'c0ffee00-0000-4000-8000-000000000001', context_type: 'RESERVATION' } });
    expect(conv.message.content).toContain('Late check-in');
    expect(stub.calls[1].body).toEqual({ inbox_id: 3, name: `JETPOOL user ${user.id.slice(0, 8)}`, identifier: `jetpool:user:${user.id}` });
    const wire = JSON.stringify(stub.calls.map((c) => c.body));
    expect(wire).not.toContain('casey.requester');
    expect(wire).not.toContain('01098765432');
  });

  it('reuses an existing contact inbox', async () => {
    const stub = chatwootStub({ existingContact: true });
    const desk = new ChatwootSupportDesk({ ...chatwootConfigFromEnv(CW_ENV)!, fetch: stub.fn as unknown as typeof fetch });
    await desk.createConversation({ id: 'c0ffee00-0000-4000-8000-000000000002', requesterId: user.id, category: 'OTHER', subject: 's', description: 'd', priority: 'NORMAL', contextType: null, contextId: null });
    expect(stub.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      'GET /api/v1/accounts/7/contacts/search',
      'GET /api/v1/accounts/7/contacts/55/conversations',
      'POST /api/v1/accounts/7/conversations',
    ]);
    expect(stub.calls[2].body).toMatchObject({ source_id: 'src-existing', contact_id: 55, priority: 'medium' });
  });

  it('is idempotent: a conversation already mirrored for the case is reused instead of duplicated', async () => {
    const caseId = 'c0ffee00-0000-4000-8000-000000000003';
    const stub = chatwootStub({ existingContact: true, existingConversations: [{ id: 77, custom_attributes: { jetpool_case_id: 'someone-else' } }, { id: 88, custom_attributes: { jetpool_case_id: caseId } }] });
    const desk = new ChatwootSupportDesk({ ...chatwootConfigFromEnv(CW_ENV)!, fetch: stub.fn as unknown as typeof fetch });
    const out = await desk.createConversation({ id: caseId, requesterId: user.id, category: 'OTHER', subject: 's', description: 'd', priority: 'NORMAL', contextType: null, contextId: null });
    expect(out).toEqual({ externalRef: 'chatwoot:7:88' });
    expect(stub.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
  });

  it('support.case.opened is mirrored to Chatwoot once and external_ref is stored (staff-only field)', async () => {
    Object.assign(process.env, CW_ENV);
    const stub = chatwootStub();
    vi.stubGlobal('fetch', stub.fn);
    await t.drain(); // flush earlier events
    await t.pool.query(`UPDATE support_cases SET desk_sync_due_at = NULL`);
    stub.calls.length = 0;
    const id = (await openCase(user, { subject: 'Desk mirror' })).body.item.id;
    await t.drain();
    expect(stub.calls).toHaveLength(0); // the outbox consumer only marks the case: no desk I/O inside dispatch
    expect(await runDeskSync(t.app.ctx)).toBe(1);
    const ref = `chatwoot:7:${convSeq}`;
    const row = await t.pool.query(`SELECT external_ref FROM support_cases WHERE id = $1`, [id]);
    expect(row.rows[0].external_ref).toBe(ref);
    expect(stub.calls.filter((c) => c.url.endsWith('/conversations'))).toHaveLength(1);
    expect((await call(t, agent, 'GET', `/v1/admin/support/cases/${id}`)).body.item.externalRef).toBe(ref);
    expect((await call(t, user, 'GET', `/v1/support/cases/${id}`)).body.item.externalRef).toBeUndefined();
    const aud = await t.pool.query(`SELECT after_state FROM audit_logs WHERE action = 'support.case.desk_linked' AND resource_id = $1`, [id]);
    expect(aud.rows[0].after_state).toMatchObject({ desk: 'chatwoot', externalRef: ref });

    // replay of the handler / job is a no-op (idempotent)
    const again = await withTx(t.pool, (tx) => syncCaseToDesk(tx, t.ctx(), id));
    expect(again).toEqual({ externalRef: ref, skipped: true });
    await t.drain();
    expect(await runDeskSync(t.app.ctx)).toBe(0);
    expect(stub.calls.filter((c) => c.url.endsWith('/conversations'))).toHaveLength(1);
  });

  it('desk failures are retried by the sync job with backoff; the outbox event is not held; nothing is stored until success', async () => {
    const failing = chatwootStub({ failConversation: true });
    t.app.ctx.adapters.set(SUPPORT_DESK_ADAPTER, new ChatwootSupportDesk({ ...chatwootConfigFromEnv(CW_ENV)!, fetch: failing.fn as unknown as typeof fetch }));
    const id = (await openCase(user, { subject: 'Desk down' })).body.item.id;
    await t.drain();
    const ev = await t.pool.query(`SELECT attempts, published_at FROM outbox_events WHERE event_type = 'support.case.opened' AND aggregate_id = $1`, [id]);
    expect(ev.rows[0].attempts).toBe(0);
    expect(ev.rows[0].published_at).not.toBeNull();
    expect(await runDeskSync(t.app.ctx)).toBe(0);
    const row = (await t.pool.query(`SELECT external_ref, desk_sync_attempts, desk_sync_error, desk_sync_due_at > now() AS backoff FROM support_cases WHERE id = $1`, [id])).rows[0];
    expect(row).toMatchObject({ external_ref: null, desk_sync_attempts: 1, backoff: true });
    expect(row.desk_sync_error).toContain('returned 500');
    expect(row.desk_sync_error).not.toContain('cw-token');

    const ok = chatwootStub();
    t.app.ctx.adapters.set(SUPPORT_DESK_ADAPTER, new ChatwootSupportDesk({ ...chatwootConfigFromEnv(CW_ENV)!, fetch: ok.fn as unknown as typeof fetch }));
    await t.pool.query(`UPDATE support_cases SET desk_sync_due_at = now() WHERE id = $1`, [id]);
    expect(await runDeskSync(t.app.ctx)).toBe(1);
    const done = (await t.pool.query(`SELECT external_ref, desk_sync_due_at, desk_sync_error FROM support_cases WHERE id = $1`, [id])).rows[0];
    expect(done).toMatchObject({ external_ref: `chatwoot:7:${convSeq}`, desk_sync_due_at: null, desk_sync_error: null });
  });

  it('a slow or hanging desk never blocks outbox dispatch or the case row', async () => {
    let calls = 0;
    t.app.ctx.adapters.set(SUPPORT_DESK_ADAPTER, { name: 'hanging', createConversation: () => (calls++, new Promise(() => {})) });
    const id = (await openCase(user, { subject: 'Desk hangs' })).body.item.id;
    const started = Date.now();
    await t.drain();
    expect(Date.now() - started).toBeLessThan(5000);
    expect(calls).toBe(0);
    expect((await call(t, user, 'POST', `/v1/support/cases/${id}/comments`, { body: 'any update?' })).status).toBe(201);
    expect((await t.pool.query(`SELECT desk_sync_due_at IS NOT NULL AS due FROM support_cases WHERE id = $1`, [id])).rows[0].due).toBe(true);
    await t.pool.query(`UPDATE support_cases SET desk_sync_due_at = NULL WHERE id = $1`, [id]);
  });

  it('without configuration the no-op desk makes no external calls', async () => {
    const stub = chatwootStub();
    vi.stubGlobal('fetch', stub.fn);
    const id = (await openCase(user, { subject: 'No desk' })).body.item.id;
    await t.drain();
    expect(stub.calls).toHaveLength(0);
    expect((await t.pool.query(`SELECT external_ref FROM support_cases WHERE id = $1`, [id])).rows[0].external_ref).toBeNull();
    const ev = await t.pool.query(`SELECT published_at FROM outbox_events WHERE event_type = 'support.case.opened' AND aggregate_id = $1`, [id]);
    expect(ev.rows[0].published_at).not.toBeNull();
    expect((await t.pool.query(`SELECT desk_sync_due_at FROM support_cases WHERE id = $1`, [id])).rows[0].desk_sync_due_at).toBeNull();
    expect(await runDeskSync(t.app.ctx)).toBe(0);
    expect(stub.calls).toHaveLength(0);
  });
});
