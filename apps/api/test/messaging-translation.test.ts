/**
 * COMMS-01 cross-language messaging + the open-source LibreTranslate provider.
 *
 * Covers the checklist for the feature: happy path (a Korean host and a Vietnamese traveller each read the
 * other in their own language, with the original kept), the degradation paths (flag off, no provider,
 * provider down), the permission negative (a non-member still gets 404, translated or not), and the adapter's
 * own contract against a stub LibreTranslate server.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import type { Translator } from '../src/platform/translate.js';
import { LibreTranslator } from '../src/modules/ai/libre-translator.js';
import { readerLocale } from '../src/modules/messaging/translate.js';

let t: TestApp;
let host: TestUser; // writes Korean
let traveler: TestUser; // reads Vietnamese
let outsider: TestUser;
let propertyId: string;

/** Deterministic stand-in for a provider, so no test needs a network or a key. */
class FakeTranslator implements Translator {
  readonly provider = 'fake';
  readonly model = 'fake-1';
  calls: Array<{ texts: string[]; locale: string }> = [];
  fail = false;
  async translate(texts: string[], targetLocale: string): Promise<string[]> {
    this.calls.push({ texts: [...texts], locale: targetLocale });
    if (this.fail) throw new Error('provider down');
    return texts.map((x) => `[${targetLocale}] ${x}`);
  }
}
const fake = new FakeTranslator();

const enableFlag = () => t.pool.query(`UPDATE feature_flags SET enabled = true WHERE flag_key = 'content.auto_translate'`);
const disableFlag = () => t.pool.query(`UPDATE feature_flags SET enabled = false WHERE flag_key = 'content.auto_translate'`);
const useProvider = (p: Translator | null) => (p ? t.app.ctx.adapters.set('i18n.translator', p) : t.app.ctx.adapters.delete('i18n.translator'));

/** Messages as a given member reads them, in a given language. */
async function readAs(user: TestUser, conversationId: string, locale?: string) {
  const res = await call(t, user, 'GET', `/v1/conversations/${conversationId}/messages${locale ? `?locale=${locale}` : ''}`);
  return res;
}

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
  traveler = await createUser(t);
  outsider = await createUser(t);
  await t.pool.query(`UPDATE users SET locale = 'ko-KR' WHERE id = $1`, [host.id]);
  await t.pool.query(`UPDATE users SET locale = 'vi-VN' WHERE id = $1`, [traveler.id]);
  const p = await t.pool.query(
    `INSERT INTO properties(host_id, title, status, property_type, room_type, country, city, max_guests, currency)
     VALUES ($1, '제주 한옥 독채', 'PUBLISHED', 'HOUSE', 'ENTIRE', 'KR', 'Jeju', 4, 'KRW') RETURNING id`,
    [host.id],
  );
  propertyId = p.rows[0].id;
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.pool.query(`DELETE FROM content_translations`);
  fake.calls = [];
  fake.fail = false;
  useProvider(fake);
  await enableFlag();
});

/** Start an inquiry from the traveller and return its conversation id. */
async function newConversation() {
  const res = await call(t, traveler, 'POST', '/v1/conversations', { targetType: 'PROPERTY', targetId: propertyId });
  expect(res.status).toBe(201);
  return res.body.item.id as string;
}

describe('COMMS-01 cross-language messaging', () => {
  it('translates a message into every other member’s language and keeps the original', async () => {
    const cid = await newConversation();
    const sent = await call(t, host, 'POST', `/v1/conversations/${cid}/messages`, { body: '체크인은 오후 3시부터 가능합니다.' });
    expect(sent.status).toBe(201);
    // the language it was written in is recorded from the sender's account
    expect(sent.body.item.sourceLocale).toBe('ko-KR');

    // the sender never waits for a translator: the translation lands when the outbox is processed
    await t.drain();
    expect(fake.calls).toEqual([{ texts: ['체크인은 오후 3시부터 가능합니다.'], locale: 'vi-VN' }]);

    const asTraveler = await readAs(traveler, cid, 'vi-VN');
    expect(asTraveler.status).toBe(200);
    const m = asTraveler.body.items.find((x: any) => x.body?.includes('체크인'));
    expect(m.body).toBe('체크인은 오후 3시부터 가능합니다.'); // the original is never replaced
    expect(m.translation).toEqual({ locale: 'vi-VN', text: '[vi-VN] 체크인은 오후 3시부터 가능합니다.' });
    expect(m.sourceLocale).toBe('ko-KR');
  });

  it('translates in both directions — the Korean host reads the traveller in Korean', async () => {
    const cid = await newConversation();
    await call(t, traveler, 'POST', `/v1/conversations/${cid}/messages`, { body: 'Tôi có thể nhận phòng sớm không?' });
    await t.drain();
    expect(fake.calls.map((c) => c.locale)).toEqual(['ko-KR']);

    const asHost = await readAs(host, cid, 'ko-KR');
    const m = asHost.body.items.find((x: any) => x.body?.startsWith('Tôi'));
    expect(m.sourceLocale).toBe('vi-VN');
    expect(m.translation.text).toBe('[ko-KR] Tôi có thể nhận phòng sớm không?');
  });

  it('does not translate into the language the message was already written in', async () => {
    await t.pool.query(`UPDATE users SET locale = 'ko-KR' WHERE id = $1`, [traveler.id]);
    const cid = await newConversation();
    await call(t, host, 'POST', `/v1/conversations/${cid}/messages`, { body: '안녕하세요, 문의 감사합니다.' });
    await t.drain();
    expect(fake.calls).toEqual([]);
    await t.pool.query(`UPDATE users SET locale = 'vi-VN' WHERE id = $1`, [traveler.id]);
  });

  it('serves the original alone when the reader asks for the language it was written in', async () => {
    const cid = await newConversation();
    await call(t, host, 'POST', `/v1/conversations/${cid}/messages`, { body: '주차는 무료입니다.' });
    await t.drain();
    const asKorean = await readAs(host, cid, 'ko-KR');
    const m = asKorean.body.items.find((x: any) => x.body === '주차는 무료입니다.');
    expect(m.translation).toBeNull();
  });

  // Regression: the read path queues its own misses, so asking for a translation of a message already written
  // in the reader's language used to translate vi→vi in the background and then show it back to its author.
  it('never asks for a translation of a message already in the reader’s language', async () => {
    const cid = await newConversation();
    await call(t, traveler, 'POST', `/v1/conversations/${cid}/messages`, { body: 'Tôi sẽ đến vào buổi chiều.' });
    await t.drain();
    fake.calls = [];

    // The traveller re-reads their own thread in their own language. Korean messages from the rest of this
    // conversation are fair game; their OWN Vietnamese one must never be sent to a translator for vi-VN.
    await readAs(traveler, cid, 'vi-VN');
    await readAs(traveler, cid, 'vi-VN');
    const askedFor = fake.calls.filter((c) => c.locale === 'vi-VN').flatMap((c) => c.texts);
    expect(askedFor).not.toContain('Tôi sẽ đến vào buổi chiều.');

    const mine = (await readAs(traveler, cid, 'vi-VN')).body.items.find((m: any) => m.body?.startsWith('Tôi sẽ'));
    expect(mine.sourceLocale).toBe('vi-VN');
    expect(mine.translation).toBeNull();
  });

  it('degrades to the original when the flag is off, no provider is configured, or the provider fails', async () => {
    await disableFlag();
    const cid = await newConversation();
    await call(t, host, 'POST', `/v1/conversations/${cid}/messages`, { body: '수건은 매일 교체해 드립니다.' });
    await t.drain();
    expect(fake.calls).toEqual([]);
    expect((await readAs(traveler, cid, 'vi-VN')).body.items.every((m: any) => m.translation === null)).toBe(true);

    await enableFlag();
    useProvider(null);
    await call(t, host, 'POST', `/v1/conversations/${cid}/messages`, { body: '조식은 포함되어 있지 않습니다.' });
    await t.drain(); // no provider: nothing to do, and nothing thrown
    expect((await readAs(traveler, cid, 'vi-VN')).body.items.every((m: any) => m.translation === null)).toBe(true);

    useProvider(fake);
    fake.fail = true;
    const sent = await call(t, host, 'POST', `/v1/conversations/${cid}/messages`, { body: '애완동물은 동반하실 수 없습니다.' });
    expect(sent.status).toBe(201); // a provider outage never fails the send
    await t.drain().catch(() => {}); // the outbox retries; the message itself is already durable
    const after = await readAs(traveler, cid, 'vi-VN');
    expect(after.body.items.find((m: any) => m.body?.startsWith('애완동물')).body).toBe('애완동물은 동반하실 수 없습니다.');
  });

  it('keeps a non-member out, and never translates a redacted message', async () => {
    const cid = await newConversation();
    await call(t, host, 'POST', `/v1/conversations/${cid}/messages`, { body: '예약 확정 후 주소를 안내드릴게요.' });
    await t.drain();
    expect((await readAs(outsider, cid, 'vi-VN')).status).toBe(404);

    await t.pool.query(`UPDATE messages SET redacted_at = now() WHERE conversation_id = $1`, [cid]);
    const read = await readAs(traveler, cid, 'vi-VN');
    for (const m of read.body.items) {
      expect(m.body).toBeNull();
      expect(m.translation).toBeNull();
    }
  });

  // The SSE route hijacks the reply, which skips the hooks @fastify/cors writes its headers in. Without these
  // the browser blocks the stream and live delivery (including the translation push) silently stops.
  it('keeps CORS headers on the hijacked realtime stream', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/realtime/stream',
      headers: { ...traveler.headers, origin: 'http://localhost:3000' },
      payloadAsStream: true,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    res.stream().destroy();

    // an origin that is not allowlisted is never echoed back
    const bad = await t.app.inject({
      method: 'GET',
      url: '/v1/realtime/stream',
      headers: { ...traveler.headers, origin: 'https://evil.example' },
      payloadAsStream: true,
    });
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    bad.stream().destroy();
  });

  it('normalises an account language to a locale the product translates into', () => {
    expect(readerLocale('vi')).toBe('vi-VN');
    expect(readerLocale('en-GB')).toBe('en-US');
    expect(readerLocale('ko-KR')).toBe('ko-KR');
    expect(readerLocale('de-DE')).toBeNull();
    expect(readerLocale(null)).toBeNull();
  });
});

describe('LibreTranslate adapter', () => {
  let server: Server;
  let url: string;
  let seen: any[] = [];
  let reply: (body: any) => { status: number; json: unknown } = (body) => ({
    status: 200,
    json: { translatedText: (body.q as string[]).map((x: string) => `${x}@${body.target}`) },
  });

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw || '{}');
        seen.push({ path: req.url, body });
        const out = reply(body);
        res.writeHead(out.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.json));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  beforeEach(() => {
    seen = [];
  });

  it('posts the documented request and maps BCP-47 to the ISO code', async () => {
    const out = await new LibreTranslator(url).translate(['안녕하세요', '감사합니다'], 'vi-VN');
    expect(out).toEqual(['안녕하세요@vi', '감사합니다@vi']);
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe('/translate');
    // `source: auto` is what makes a conversation translate in both directions
    expect(seen[0].body).toMatchObject({ q: ['안녕하세요', '감사합니다'], source: 'auto', target: 'vi', format: 'text' });
    expect(seen[0].body.api_key).toBeUndefined();
  });

  it('sends the api key when configured and chunks a large batch', async () => {
    await new LibreTranslator(url, { apiKey: 'k1' }).translate(Array.from({ length: 45 }, (_, i) => `문장 ${i}`), 'en-US');
    expect(seen.map((s) => s.body.q.length)).toEqual([20, 20, 5]);
    expect(seen.every((s) => s.body.api_key === 'k1')).toBe(true);
  });

  it('accepts a bare string for a single-item batch', async () => {
    reply = () => ({ status: 200, json: { translatedText: 'xin chào' } });
    expect(await new LibreTranslator(url).translate(['안녕'], 'vi-VN')).toEqual(['xin chào']);
  });

  it('rejects a misaligned response rather than attaching the wrong text', async () => {
    reply = () => ({ status: 200, json: { translatedText: ['only one'] } });
    await expect(new LibreTranslator(url).translate(['a선', 'b선'], 'en-US')).rejects.toThrow(/returned 1 for 2/);
  });

  it('surfaces a provider error and refuses an unsupported locale', async () => {
    reply = () => ({ status: 403, json: { error: 'Invalid API key' } });
    await expect(new LibreTranslator(url).translate(['안녕하세요'], 'en-US')).rejects.toThrow(/libretranslate 403/);
    await expect(new LibreTranslator(url).translate(['안녕하세요'], 'de-DE')).rejects.toThrow(/unsupported target locale/);
    reply = (body) => ({ status: 200, json: { translatedText: (body.q as string[]).map((x: string) => `${x}@${body.target}`) } });
  });
});
