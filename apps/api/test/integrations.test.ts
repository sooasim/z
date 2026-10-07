import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, day, enableFlags, type TestApp, type TestUser } from './helpers.js';
import { buildIcs, isPrivateAddress, parseIcs } from '../src/modules/integrations/ical.js';
import { signWebhook, syncIcalAccount } from '../src/modules/integrations/service.js';

let t: TestApp;
let host: TestUser, other: TestUser;
let propertyId: string;
let feed = '';
const fetched: string[] = [];

const ics = (events: Array<{ uid: string; start: string; end: string; summary?: string }>) =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Airbnb Inc//Hosting Calendar//EN',
    ...events.flatMap((e) => [
      'BEGIN:VEVENT',
      `DTSTART;VALUE=DATE:${e.start.replace(/-/g, '')}`,
      `DTEND;VALUE=DATE:${e.end.replace(/-/g, '')}`,
      `UID:${e.uid}`,
      `SUMMARY:${e.summary ?? 'Reserved'}`,
      'END:VEVENT',
    ]),
    'END:VCALENDAR',
  ].join('\r\n');

beforeAll(async () => {
  t = await createTestApp();
  t.app.ctx.adapters.set('integrations.icalFetcher', async (url: string) => {
    fetched.push(url);
    return feed;
  });
  host = await createUser(t, { roles: ['HOST'] });
  other = await createUser(t, { roles: ['HOST'] });
  const { rows } = await t.pool.query(`INSERT INTO properties(host_id, title, property_type, status) VALUES ($1,'P','HOUSE','PUBLISHED') RETURNING id`, [host.id]);
  propertyId = rows[0].id;
});
afterAll(async () => t.close());

describe('INT-01 iCal parsing', () => {
  it('parses DATE and DATE-TIME events, unfolds lines, ignores PII fields', () => {
    const text = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc\r\n 123\r\nDTSTART;VALUE=DATE:20261103\r\nDTEND;VALUE=DATE:20261107\r\nSUMMARY:Kim Minji (HMXYZ)\r\nEND:VEVENT\r\n' +
      'BEGIN:VEVENT\r\nUID:t1\r\nDTSTART:20261110T150000Z\r\nDTEND:20261112T020000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:one\r\nDTSTART;VALUE=DATE:20261120\r\nEND:VEVENT\r\nEND:VCALENDAR';
    expect(parseIcs(text)).toEqual([
      { uid: 'abc123', start: '2026-11-03', end: '2026-11-07', status: null },
      { uid: 't1', start: '2026-11-11', end: '2026-11-12', status: null },
      { uid: 'one', start: '2026-11-20', end: '2026-11-21', status: null },
    ]);
    expect(JSON.stringify(parseIcs(text))).not.toContain('Minji');
  });
  it('flags private addresses for SSRF protection', () => {
    expect(['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.0.0.1'].every(isPrivateAddress)).toBe(true);
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
  it('builds a busy-only feed', () => {
    const out = buildIcs('JETPOOL', [{ uid: 'b1', start: '2026-11-03', end: '2026-11-05' }]);
    expect(out).toContain('DTSTART;VALUE=DATE:20261103');
    expect(out).toContain('UID:b1@jetpool');
    expect(out).toContain('SUMMARY:Not available');
  });
});

describe('INT-01 accounts & sync', () => {
  let accountId: string;

  it('is behind integrations.pms and host-ownership checks', async () => {
    const body = { provider: 'ICAL', propertyId, icalUrl: 'https://www.airbnb.com/calendar/ical/123.ics?s=secret' };
    expect((await call(t, host, 'POST', '/v1/integrations/accounts', body)).body.code).toBe('FEATURE_DISABLED');
    await enableFlags(t, 'integrations.pms');
    expect((await call(t, other, 'POST', '/v1/integrations/accounts', body)).body.code).toBe('NOT_PROPERTY_OWNER');
    expect((await call(t, host, 'POST', '/v1/integrations/accounts', { ...body, icalUrl: 'ftp://x/y.ics' })).body.code).toBe('INVALID_ICAL_URL');
    const r = await call(t, host, 'POST', '/v1/integrations/accounts', body);
    expect(r.status).toBe(201);
    expect(r.body.item.icalHost).toBe('www.airbnb.com');
    expect(JSON.stringify(r.body)).not.toContain('secret');
    accountId = r.body.item.id;
    const row = await t.pool.query(`SELECT secret_ref, config FROM integration_accounts WHERE id = $1`, [accountId]);
    expect(row.rows[0].secret_ref.startsWith('enc:')).toBe(true);
    expect(JSON.stringify(row.rows[0])).not.toContain('s=secret');
    expect((await call(t, other, 'POST', `/v1/integrations/accounts/${accountId}/sync`)).status).toBe(404);
  });

  it('imports external ranges as EXTERNAL blocks; conflicts with JETPOOL reservations are recorded and JETPOOL wins', async () => {
    // existing JETPOOL reservation block on day(20)..day(23)
    const { rows } = await t.pool.query(
      `INSERT INTO inventory_blocks(property_id, stay_range, block_type, source_type) VALUES ($1, daterange($2::date, $3::date), 'RESERVATION', 'RESERVATION') RETURNING id`,
      [propertyId, day(20), day(23)],
    );
    const jetpoolBlock = rows[0].id;
    feed = ics([
      { uid: 'ext-1', start: day(10), end: day(12) },
      { uid: 'ext-2', start: day(22), end: day(25), summary: 'Guest Name' },
      { uid: 'old', start: day(-10), end: day(-8) },
      { uid: `${jetpoolBlock}@jetpool`, start: day(20), end: day(23) },
    ]);
    const r = await call(t, host, 'POST', `/v1/integrations/accounts/${accountId}/sync`);
    expect(r.status).toBe(200);
    expect(r.body.counts).toEqual({ applied: 1, unchanged: 0, conflicts: 1, removed: 0, ignored: 1 });
    expect(fetched[0]).toContain('s=secret');
    const blocks = await t.pool.query(`SELECT block_type, lower(stay_range)::text AS s, state FROM inventory_blocks WHERE property_id = $1 AND state = 'ACTIVE' ORDER BY 2`, [propertyId]);
    expect(blocks.rows.map((b) => [b.block_type, b.s])).toEqual([
      ['EXTERNAL', day(10)],
      ['RESERVATION', day(20)],
    ]);
    const ev = await t.pool.query(`SELECT outcome, payload FROM integration_events WHERE account_id = $1 AND outcome = 'CONFLICT'`, [accountId]);
    expect(ev.rows[0].payload).toMatchObject({ uid: 'ext-2', conflictsWith: 'RESERVATION' });
    expect(JSON.stringify(ev.rows)).not.toContain('Guest Name');
    await t.drain();
    const n = await t.pool.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND template_key = 'integration.conflict'`, [host.id]);
    expect(n.rows[0].n).toBe(1);
    const done = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'integration.sync.completed'`);
    expect(done.rows[0].payload.conflicts).toBe(1);
  });

  it('re-sync is idempotent, moves changed ranges and releases removed events', async () => {
    let r = await syncIcalAccount(t.app.ctx, accountId);
    expect(r.counts).toMatchObject({ applied: 0, unchanged: 1, conflicts: 1 });
    feed = ics([{ uid: 'ext-1', start: day(11), end: day(14) }]);
    r = await syncIcalAccount(t.app.ctx, accountId);
    expect(r.counts).toMatchObject({ applied: 1, unchanged: 0, removed: 0 });
    feed = ics([]);
    r = await syncIcalAccount(t.app.ctx, accountId);
    expect(r.counts.removed).toBe(1);
    const ext = await t.pool.query(`SELECT count(*)::int AS n FROM inventory_blocks WHERE property_id = $1 AND state = 'ACTIVE' AND block_type = 'EXTERNAL'`, [propertyId]);
    expect(ext.rows[0].n).toBe(0);
  });

  it('records fetch errors without leaking the feed URL', async () => {
    t.app.ctx.adapters.set('integrations.icalFetcher', async () => {
      throw new Error('iCal fetch failed with HTTP 500');
    });
    const r = await syncIcalAccount(t.app.ctx, accountId);
    expect(r.status).toBe('ERROR');
    const ev = await t.pool.query(`SELECT payload, detail FROM integration_events WHERE account_id = $1 AND outcome = 'ERROR'`, [accountId]);
    expect(JSON.stringify(ev.rows)).not.toContain('secret');
    t.app.ctx.adapters.set('integrations.icalFetcher', async () => feed);
  });

  it('exports busy dates only (no external echo, no PII) with a per-property token', async () => {
    expect((await call(t, other, 'POST', `/v1/integrations/properties/${propertyId}/ical-export-token`)).status).toBe(403);
    const tok = await call(t, host, 'POST', `/v1/integrations/properties/${propertyId}/ical-export-token`);
    expect(tok.status).toBe(201);
    await t.pool.query(`INSERT INTO inventory_blocks(property_id, stay_range, block_type, source_type) VALUES ($1, daterange($2::date, $3::date), 'EXTERNAL', 'INTEGRATION')`, [propertyId, day(40), day(41)]);
    await t.pool.query(`INSERT INTO availability_days(property_id, day, status) VALUES ($1,$2,'UNAVAILABLE'),($1,$3,'UNAVAILABLE')`, [propertyId, day(50), day(51)]);
    const res = await t.app.inject({ method: 'GET', url: `/v1/integrations/ical/${propertyId}.ics?token=${tok.body.item.token}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/calendar');
    expect(res.body).toContain(`DTSTART;VALUE=DATE:${day(20).replace(/-/g, '')}`);
    expect(res.body).toContain(`DTSTART;VALUE=DATE:${day(50).replace(/-/g, '')}`);
    expect(res.body).toContain(`DTEND;VALUE=DATE:${day(52).replace(/-/g, '')}`);
    expect(res.body).not.toContain(day(40).replace(/-/g, ''));
    expect((await t.app.inject({ method: 'GET', url: `/v1/integrations/ical/${propertyId}.ics?token=${'x'.repeat(40)}` })).statusCode).toBe(401);
  });

  it('generic webhook: HMAC verified, replay-safe, applies blocks', async () => {
    const acct = await call(t, host, 'POST', '/v1/integrations/accounts', { provider: 'GENERIC_WEBHOOK', propertyId });
    const secret = acct.body.webhookSecret as string;
    expect(secret.length).toBeGreaterThan(20);
    const url = `/v1/integrations/webhooks/${acct.body.item.id}`;
    const body = JSON.stringify({ eventId: 'evt-1', type: 'BLOCK_UPSERT', externalId: 'pms-77', start: day(60), end: day(62) });
    const send = (sig: string, payload = body) => t.app.inject({ method: 'POST', url, payload, headers: { 'content-type': 'application/json', 'x-jetpool-signature': sig } });
    expect((await send('t=1,v1=deadbeef')).statusCode).toBe(401);
    expect((await send(signWebhook('wrong-secret', body))).statusCode).toBe(401);
    expect((await send(signWebhook(secret, body, Math.floor(Date.now() / 1000) - 3600))).statusCode).toBe(401);
    const ok = await send(signWebhook(secret, body));
    expect(ok.statusCode).toBe(200);
    expect(ok.json().counts.applied).toBe(1);
    const replay = await send(signWebhook(secret, body));
    expect(replay.json().duplicate).toBe(true);
    const del = JSON.stringify({ eventId: 'evt-2', type: 'BLOCK_DELETE', externalId: 'pms-77' });
    expect((await send(signWebhook(secret, del), del)).json().counts.removed).toBe(1);
  });
});
