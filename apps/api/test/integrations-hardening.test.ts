import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, day, enableFlags, type TestApp, type TestUser } from './helpers.js';
import { defaultIcalFetcher, isPrivateAddress, parseIcs } from '../src/modules/integrations/ical.js';
import { allowHttpFeeds, signWebhook } from '../src/modules/integrations/service.js';
import { assertDateRange } from '../src/platform/inventory.js';

/** Regression tests for the INT-01 r1 findings (SSRF, malformed feeds, time zones, sync/webhook races). */

let t: TestApp;
let host: TestUser;
let propertyId: string;
let nyPropertyId: string;

// a local "internal service" the SSRF guard must never reach
let internal: http.Server;
let internalPort: number;
let hits: Array<{ url: string; host: string | undefined }> = [];
let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;

const VCAL = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';
const ics = (events: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', ...events, 'END:VCALENDAR'].join('\r\n');
const vevent = (uid: string, start: string, end: string, extra = '') =>
  ['BEGIN:VEVENT', `UID:${uid}`, `DTSTART${start.includes('T') ? '' : ';VALUE=DATE'}${extra}:${start}`, `DTEND${end.includes('T') ? '' : ';VALUE=DATE'}${extra}:${end}`, 'END:VEVENT'].join('\r\n');
const compact = (d: string) => d.replace(/-/g, '');

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
  const p = await t.pool.query(`INSERT INTO properties(host_id, title, property_type, status) VALUES ($1,'P','HOUSE','PUBLISHED') RETURNING id`, [host.id]);
  propertyId = p.rows[0].id;
  const ny = await t.pool.query(`INSERT INTO properties(host_id, title, property_type, status, timezone, country) VALUES ($1,'NY loft','APARTMENT','PUBLISHED','America/New_York','US') RETURNING id`, [host.id]);
  nyPropertyId = ny.rows[0].id;
  await enableFlags(t, 'integrations.pms');
  respond = (_req, res) => res.writeHead(200, { 'content-type': 'text/calendar' }).end(VCAL);
  internal = http.createServer((req, res) => {
    hits.push({ url: req.url ?? '', host: req.headers.host });
    respond(req, res);
  });
  await new Promise<void>((r) => internal.listen(0, '127.0.0.1', () => r()));
  internalPort = (internal.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((r) => internal.close(() => r()));
  await t.close();
});

describe('iCal SSRF guard (r1)', () => {
  it('classifies IPv4-mapped IPv6 in hex notation, NAT64, 6to4, site-local and reserved ranges as non-public', () => {
    // the WHATWG URL parser rewrites [::ffff:127.0.0.1] to [::ffff:7f00:1]
    expect(new URL('http://[::ffff:127.0.0.1]/').hostname).toBe('[::ffff:7f00:1]');
    const blocked = [
      '::ffff:7f00:1', // 127.0.0.1
      '::ffff:a9fe:a9fe', // 169.254.169.254
      '::ffff:a00:1', // 10.0.0.1
      '[::ffff:7f00:1]',
      '::ffff:127.0.0.1',
      '64:ff9b::7f00:1', // NAT64
      '2002:7f00:1::', // 6to4
      'fec0::1', // site-local
      'fe90::1', // link-local beyond the literal 'fe80'
      'ff02::1', // multicast
      '::7f00:1', // IPv4-compatible
      '198.18.0.1', // benchmarking
      '0.0.0.0',
      '255.255.255.255',
      'not-an-ip', // fails closed
    ];
    for (const ip of blocked) expect([ip, isPrivateAddress(ip)]).toEqual([ip, true]);
    for (const ip of ['8.8.8.8', '1.1.1.1', '::ffff:8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) expect([ip, isPrivateAddress(ip)]).toEqual([ip, false]);
  });

  it('never connects to an internal address given as an IPv4-mapped IPv6 literal', async () => {
    hits = [];
    const fetcher = defaultIcalFetcher({ allowHttp: true });
    for (const url of [`http://[::ffff:127.0.0.1]:${internalPort}/admin`, `http://[::ffff:7f00:1]:${internalPort}/admin`, `http://127.0.0.1:${internalPort}/ctl.ics`, `http://0x7f.1:${internalPort}/x`]) {
      await expect(fetcher(url)).rejects.toThrow('private address');
    }
    expect(hits).toHaveLength(0);
  });

  it('validates the address at connect time, from a single resolution (no DNS-rebinding window)', async () => {
    hits = [];
    // rebinding resolver: first answer public, every later answer internal
    let calls = 0;
    const rebinding = async () => (++calls === 1 ? ['8.8.8.8'] : ['127.0.0.1']);
    const answers: string[][] = [];
    const strict = defaultIcalFetcher({
      allowHttp: true,
      resolve: async (h) => {
        const a = await rebinding();
        answers.push(a);
        return h === 'feed.invalid' ? a : [];
      },
      timeoutMs: 1500,
    });
    // the first (public) answer is the only one used: the connection goes to 8.8.8.8 (unreachable here) — never to 127.0.0.1
    await expect(strict(`http://feed.invalid:${internalPort}/cal.ics`)).rejects.toThrow();
    expect(calls).toBe(1);
    expect(hits).toHaveLength(0);
    // a name that resolves to an internal address is refused before any connection
    await expect(strict(`http://feed.invalid:${internalPort}/cal.ics`)).rejects.toThrow('private address');
    expect(hits).toHaveLength(0);
    // the socket really connects to the address the lookup validated (system DNS is never consulted for feed.invalid)
    let resolved = 0;
    const pinned = defaultIcalFetcher({ allowHttp: true, resolve: async () => (resolved++, ['127.0.0.1']), isBlocked: () => false });
    await expect(pinned(`http://feed.invalid:${internalPort}/cal.ics`)).resolves.toContain('BEGIN:VCALENDAR');
    expect(resolved).toBe(1);
    expect(hits).toEqual([{ url: '/cal.ics', host: `feed.invalid:${internalPort}` }]);
  });

  it('streams the body with a hard cap, does not follow redirects, and reports non-iCal bodies', async () => {
    const open = defaultIcalFetcher({ allowHttp: true, isBlocked: () => false, maxBytes: 64 * 1024, timeoutMs: 3000 });
    const url = `http://127.0.0.1:${internalPort}/feed.ics`;
    let written = 0;
    respond = (_req, res) => {
      // chunked (no content-length), far more than maxBytes
      res.writeHead(200, { 'content-type': 'text/calendar' });
      const chunk = Buffer.alloc(16 * 1024, 'A');
      const pump = () => {
        while (written < 8 * 1024 * 1024) {
          written += chunk.length;
          if (!res.write(chunk)) return void res.once('drain', pump);
        }
        res.end();
      };
      res.on('error', () => {});
      pump();
    };
    await expect(open(url)).rejects.toThrow('too large');
    expect(written).toBeLessThan(8 * 1024 * 1024);
    respond = (_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${internalPort}/elsewhere` }).end();
    hits = [];
    await expect(open(url)).rejects.toThrow('HTTP 302');
    expect(hits.map((h) => h.url)).toEqual(['/feed.ics']);
    respond = (_req, res) => res.writeHead(200).end('<html>admin</html>');
    await expect(open(url)).rejects.toThrow('not an iCalendar feed');
    respond = (_req, res) => res.writeHead(200, { 'content-type': 'text/calendar' }).end(VCAL);
  });

  it('end to end: a host cannot make the API fetch an internal address via a mapped IPv6 literal', async () => {
    hits = [];
    const r = await call(t, host, 'POST', '/v1/integrations/accounts', { provider: 'ICAL', propertyId, icalUrl: `http://[::ffff:127.0.0.1]:${internalPort}/admin` });
    expect(r.status).toBe(201);
    const s = await call(t, host, 'POST', `/v1/integrations/accounts/${r.body.item.id}/sync`);
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ status: 'ERROR', error: 'iCal host resolves to a private address' });
    expect(hits).toHaveLength(0);
    await call(t, host, 'PATCH', `/v1/integrations/accounts/${r.body.item.id}`, { status: 'PAUSED' });
  });

  it('plain-http feeds are accepted only in development and test (not staging/production)', () => {
    const app = (NODE_ENV: string) => ({ config: { NODE_ENV } }) as any;
    expect(allowHttpFeeds(app('test'))).toBe(true);
    expect(allowHttpFeeds(app('development'))).toBe(true);
    expect(allowHttpFeeds(app('staging'))).toBe(false);
    expect(allowHttpFeeds(app('production'))).toBe(false);
  });
});

describe('iCal parsing robustness (r1)', () => {
  it('skips impossible calendar dates instead of emitting them', () => {
    const text = ics([vevent('good', '20261105', '20261108'), vevent('bad', '20270230', '20270302'), vevent('bad-time', '20261110T250000Z', '20261111T100000Z')]);
    expect(parseIcs(text)).toEqual([{ uid: 'good', start: '2026-11-05', end: '2026-11-08', status: null }]);
    expect(() => assertDateRange('2026-02-30', '2026-03-02')).toThrow('real calendar days');
  });

  it("maps UTC and TZID instants to the property's own time zone (DST-aware), not a fixed +9h", () => {
    // New York listing: check-in Nov 5 16:00 EST (21:00Z), check-out Nov 8 11:00 EST (16:00Z) → nights [Nov 5, Nov 8)
    const utc = ics([vevent('ny', '20261105T210000Z', '20261108T160000Z')]);
    expect(parseIcs(utc, { timeZone: 'America/New_York' })).toEqual([{ uid: 'ny', start: '2026-11-05', end: '2026-11-08', status: null }]);
    // default (Asia/Seoul) is unchanged: 15:00Z → next day in KST
    expect(parseIcs(ics([vevent('kst', '20261110T150000Z', '20261112T020000Z')]))).toEqual([{ uid: 'kst', start: '2026-11-11', end: '2026-11-12', status: null }]);
    // summer time (EDT, UTC-4): 2026-07-01T02:00Z is still June 30 in New York
    expect(parseIcs(ics([vevent('dst', '20260701T020000Z', '20260703T020000Z')]), { timeZone: 'America/New_York' })[0]).toMatchObject({ start: '2026-06-30', end: '2026-07-02' });
    // TZID local time in another zone is re-expressed in the property's zone
    expect(parseIcs(ics([vevent('tz', '20261105T230000', '20261108T230000', ';TZID=Europe/London')]), { timeZone: 'Asia/Seoul' })[0]).toMatchObject({ start: '2026-11-06', end: '2026-11-09' });
    // same-zone and unknown TZIDs keep the wall date
    expect(parseIcs(ics([vevent('same', '20261105T230000', '20261106T110000', ';TZID=Asia/Seoul')]))[0]).toMatchObject({ start: '2026-11-05', end: '2026-11-06' });
    expect(parseIcs(ics([vevent('win', '20261105T230000', '20261106T110000', ';TZID="Eastern Standard Time"')]))[0]).toMatchObject({ start: '2026-11-05', end: '2026-11-06' });
    // an invalid property zone falls back to the default zone instead of throwing
    expect(parseIcs(utc, { timeZone: 'Not/AZone' })[0]).toMatchObject({ start: '2026-11-06' });
  });
});

describe('iCal sync (r1)', () => {
  let feed = '';
  let gate: Promise<void> | null = null;
  let entered: (() => void) | null = null;
  beforeAll(() => {
    t.app.ctx.adapters.set('integrations.icalFetcher', async () => {
      entered?.();
      if (gate) await gate;
      return feed;
    });
  });
  afterAll(() => {
    t.app.ctx.adapters.delete('integrations.icalFetcher');
  });

  const activeExternal = async (pid: string) =>
    (await t.pool.query(`SELECT lower(stay_range)::text AS s, upper(stay_range)::text AS e FROM inventory_blocks WHERE property_id = $1 AND block_type = 'EXTERNAL' AND state = 'ACTIVE' ORDER BY 1`, [pid])).rows;

  it('one malformed event is logged and skipped; the valid events are still imported', async () => {
    const acct = await call(t, host, 'POST', '/v1/integrations/accounts', { provider: 'ICAL', propertyId, icalUrl: 'https://www.example-ota.com/cal/1.ics?s=x' });
    expect(acct.status).toBe(201);
    feed = ics([vevent('good-1', compact(day(10)), compact(day(13))), vevent('bad-1', '20270230', '20270302')]);
    const s = await call(t, host, 'POST', `/v1/integrations/accounts/${acct.body.item.id}/sync`);
    expect(s.status).toBe(200);
    expect(s.body.status).toBe('ACTIVE');
    expect(s.body.counts.applied).toBe(1);
    expect(await activeExternal(propertyId)).toEqual([{ s: day(10), e: day(13) }]);
    const a = await t.pool.query(`SELECT status, last_synced_at FROM integration_accounts WHERE id = $1`, [acct.body.item.id]);
    expect(a.rows[0].status).toBe('ACTIVE');
    expect(a.rows[0].last_synced_at).not.toBeNull();
    await call(t, host, 'PATCH', `/v1/integrations/accounts/${acct.body.item.id}`, { status: 'PAUSED' });
  });

  it('imports UTC events on the nights of the property time zone', async () => {
    const acct = await call(t, host, 'POST', '/v1/integrations/accounts', { provider: 'ICAL', propertyId: nyPropertyId, icalUrl: 'https://www.example-ota.com/cal/ny.ics' });
    // 21:00Z on day(20) is 16:00/17:00 local in New York the same day
    feed = ics([vevent('ny-1', `${compact(day(20))}T210000Z`, `${compact(day(23))}T160000Z`)]);
    const s = await call(t, host, 'POST', `/v1/integrations/accounts/${acct.body.item.id}/sync`);
    expect(s.body.counts.applied).toBe(1);
    expect(await activeExternal(nyPropertyId)).toEqual([{ s: day(20), e: day(23) }]);
    await call(t, host, 'PATCH', `/v1/integrations/accounts/${acct.body.item.id}`, { status: 'PAUSED' });
  });

  it('a pause made while the feed is being fetched is not overwritten (and nothing is applied)', async () => {
    const acct = await call(t, host, 'POST', '/v1/integrations/accounts', { provider: 'ICAL', propertyId, icalUrl: 'https://www.example-ota.com/cal/2.ics' });
    const id = acct.body.item.id;
    feed = ics([vevent('late-1', compact(day(40)), compact(day(42)))]);
    let release!: () => void;
    gate = new Promise<void>((r) => (release = r));
    const inFetch = new Promise<void>((r) => (entered = r));
    const sync = call(t, host, 'POST', `/v1/integrations/accounts/${id}/sync`);
    await inFetch;
    const pause = await call(t, host, 'PATCH', `/v1/integrations/accounts/${id}`, { status: 'PAUSED' });
    expect(pause.body.item.status).toBe('PAUSED');
    release();
    const s = await sync;
    gate = null;
    entered = null;
    expect(s.status).toBe(409);
    expect(s.body.code).toBe('INTEGRATION_PAUSED');
    const row = await t.pool.query(`SELECT status FROM integration_accounts WHERE id = $1`, [id]);
    expect(row.rows[0].status).toBe('PAUSED');
    expect((await activeExternal(propertyId)).some((b) => b.s === day(40))).toBe(false);
    // the periodic job does not pick the paused account up again
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM integration_mappings WHERE account_id = $1`, [id])).rows[0].n).toBe(0);
  });
});

describe('generic webhook (r1)', () => {
  let accountId: string;
  let secret: string;
  const send = (payload: object) => {
    const body = JSON.stringify(payload);
    return t.app.inject({ method: 'POST', url: `/v1/integrations/webhooks/${accountId}`, payload: body, headers: { 'content-type': 'application/json', 'x-jetpool-signature': signWebhook(secret, body) } });
  };
  beforeAll(async () => {
    const p = await t.pool.query(`INSERT INTO properties(host_id, title, property_type, status) VALUES ($1,'W','HOUSE','PUBLISHED') RETURNING id`, [host.id]);
    const acct = await call(t, host, 'POST', '/v1/integrations/accounts', { provider: 'GENERIC_WEBHOOK', propertyId: p.rows[0].id });
    accountId = acct.body.item.id;
    secret = acct.body.webhookSecret;
  });

  it('concurrent upserts for the same external booking never orphan a block', async () => {
    for (let round = 0; round < 4; round++) {
      const ext = `pms-${round}`;
      const b = 60 + round * 10;
      const [a1, a2] = await Promise.all([
        send({ eventId: `${ext}-a`, type: 'BLOCK_UPSERT', externalId: ext, start: day(b), end: day(b + 2) }),
        send({ eventId: `${ext}-b`, type: 'BLOCK_UPSERT', externalId: ext, start: day(b + 4), end: day(b + 6) }),
      ]);
      expect([a1.statusCode, a2.statusCode]).toEqual([200, 200]);
      const del = await send({ eventId: `${ext}-del`, type: 'BLOCK_DELETE', externalId: ext });
      expect(del.json().counts.removed).toBe(1);
    }
    const left = await t.pool.query(`SELECT count(*)::int AS n FROM inventory_blocks WHERE source_id = $1 AND state = 'ACTIVE'`, [accountId]);
    expect(left.rows[0].n).toBe(0);
  });

  it('rejects impossible calendar dates with 400 instead of a 500 from the ::date cast', async () => {
    const r = await send({ eventId: 'bad-date', type: 'BLOCK_UPSERT', externalId: 'pms-x', start: '2026-02-30', end: '2026-03-02' });
    expect(r.statusCode).toBe(400);
  });
});
