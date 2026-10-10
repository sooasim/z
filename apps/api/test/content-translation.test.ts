import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, call, createUser, type TestApp } from './helpers.js';
import { contentLocale, contentTranslation, localize, SUPPORTED_LOCALES } from '../src/platform/content-locale.js';
import { collect, sourceHash, storeTranslations, translatable, translateMany, applyTranslations, type Translator } from '../src/platform/translate.js';
import { TranslationQueue } from '../src/platform/translate-queue.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => t.close());
beforeEach(async () => {
  await t.pool.query(`DELETE FROM content_translations`);
});

/** Records what it was asked for and answers deterministically, so no test needs a provider. */
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

const enable = () => t.pool.query(`UPDATE feature_flags SET enabled = true WHERE flag_key = 'content.auto_translate'`);
const disable = () => t.pool.query(`UPDATE feature_flags SET enabled = false WHERE flag_key = 'content.auto_translate'`);

describe('content locale resolution', () => {
  it('prefers an explicit locale, then Accept-Language, then Korean', () => {
    expect(contentLocale({ headers: {}, query: { locale: 'ja-JP' } })).toBe('ja-JP');
    expect(contentLocale({ headers: { 'accept-language': 'ja,en-US;q=0.9' }, query: {} })).toBe('ja-JP');
    expect(contentLocale({ headers: {} })).toBe('ko-KR');
    // an explicit locale we do not ship must not silently win over a header we do
    expect(contentLocale({ headers: { 'accept-language': 'vi' }, query: { locale: 'de-DE' } })).toBe('vi-VN');
  });

  it('matches on the primary subtag and honours header order', () => {
    expect(contentLocale({ headers: { 'accept-language': 'en-GB' } })).toBe('en-US');
    expect(contentLocale({ headers: { 'accept-language': 'zh-Hant-TW' } })).toBe('zh-CN');
    expect(contentLocale({ headers: { 'accept-language': 'de,fr,ja' } })).toBe('ja-JP');
    expect(contentLocale({ headers: { 'accept-language': 'de,fr' } })).toBe('ko-KR');
  });
});

describe('translation cache', () => {
  it('skips text that is not worth translating', () => {
    for (const v of ['', ' ', 'a', '42', '   ', null, undefined, 123, {}]) expect(translatable(v as any), String(v)).toBe(false);
    expect(translatable('한옥 독채')).toBe(true);
    expect(translatable('x'.repeat(20_001))).toBe(false);
  });

  it('returns cached translations keyed by the source text, and nothing else', async () => {
    await storeTranslations(t.pool, [{ source: '바다 전망', translated: 'Ocean view' }], 'en-US', 'fake', 'fake-1');
    const map = await translateMany({ db: t.pool }, ['바다 전망', '산 전망'], 'en-US');
    expect(map.get('바다 전망')).toBe('Ocean view');
    expect(map.has('산 전망')).toBe(false); // caller keeps the source
  });

  it('is keyed by the source text, so editing the source invalidates the translation', async () => {
    await storeTranslations(t.pool, [{ source: '조용한 한옥', translated: 'A quiet hanok' }], 'en-US', 'fake', 'fake-1');
    const edited = await translateMany({ db: t.pool }, ['조용한 한옥입니다'], 'en-US');
    expect(edited.size).toBe(0);
  });

  it('never stores an empty or unchanged translation', async () => {
    const n = await storeTranslations(
      t.pool,
      [
        { source: '한옥', translated: '' },
        { source: '정원이 있는 집', translated: '정원이 있는 집' },
        { source: '정원이 있는 집', translated: 'A house with a garden' },
      ],
      'en-US',
      'fake',
      'fake-1',
    );
    expect(n).toBe(1);
    expect((await t.pool.query(`SELECT translated FROM content_translations`)).rows).toEqual([{ translated: 'A house with a garden' }]);
  });

  it('is idempotent under a race on the same text', async () => {
    const entry = [{ source: '조용한 동네', translated: 'A quiet neighbourhood' }];
    await Promise.all([
      storeTranslations(t.pool, entry, 'en-US', 'fake', 'fake-1'),
      storeTranslations(t.pool, entry, 'en-US', 'fake', 'fake-1'),
    ]);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM content_translations`)).rows[0].n).toBe(1);
  });

  it('collects and applies across a row set without touching untranslated fields', () => {
    const rows = [{ title: '한옥', summary: null }, { title: '빌라', summary: '바다 앞' }];
    expect(collect(rows, ['title', 'summary'])).toEqual(['한옥', '빌라', '바다 앞']);
    const map = new Map([['한옥', 'Hanok']]);
    const out = rows.map((r) => applyTranslations(r, ['title', 'summary'], map));
    expect(out[0].title).toBe('Hanok');
    expect(out[1].title).toBe('빌라'); // untranslated stays
    expect(out[1]).toBe(rows[1]); // and the object is not needlessly copied
  });
});

describe('background filling', () => {
  it('queues misses, translates them once, and serves them on the next read', async () => {
    const fake = new FakeTranslator();
    const queue = new TranslationQueue(t.app.ctx, fake);
    const deps = { db: t.pool, translator: fake, queue: (x: string[], l: string) => queue.add(x, l) };

    const first = await translateMany(deps, ['서촌 한옥', '서촌 한옥', '망원동 집'], 'ja-JP');
    expect(first.size).toBe(0); // the reader is not kept waiting
    await queue.drain();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].texts.sort()).toEqual(['망원동 집', '서촌 한옥']); // de-duplicated
    const second = await translateMany(deps, ['서촌 한옥'], 'ja-JP');
    expect(second.get('서촌 한옥')).toBe('[ja-JP] 서촌 한옥');
  });

  it('does not call the provider again for text already cached', async () => {
    const fake = new FakeTranslator();
    const queue = new TranslationQueue(t.app.ctx, fake);
    const deps = { db: t.pool, translator: fake, queue: (x: string[], l: string) => queue.add(x, l) };
    await translateMany(deps, ['정원 있는 집'], 'ja-JP');
    await queue.drain();
    await translateMany(deps, ['정원 있는 집'], 'ja-JP');
    await queue.drain();
    expect(fake.calls).toHaveLength(1);
  });

  it('survives a provider failure: nothing cached, reader still gets the source', async () => {
    const fake = new FakeTranslator();
    fake.fail = true;
    const queue = new TranslationQueue(t.app.ctx, fake);
    await translateMany({ db: t.pool, translator: fake, queue: (x, l) => queue.add(x, l) }, ['실패하는 문장'], 'ja-JP');
    await queue.drain();
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM content_translations`)).rows[0].n).toBe(0);
  });
});

describe('localize()', () => {
  it('walks dotted and array paths, leaving everything else alone', async () => {
    await storeTranslations(
      t.pool,
      [
        { source: '서촌 한옥', translated: 'Seochon hanok' },
        { source: '흡연 금지', translated: 'No smoking' },
        { source: '한옥 전문 호스트', translated: 'A hanok specialist host' },
      ],
      'en-US',
      'fake',
      'fake-1',
    );
    const deps = { db: t.pool };
    const body = {
      item: { title: '서촌 한옥', city: 'Seoul', houseRules: { extraRules: '흡연 금지' }, host: { about: '한옥 전문 호스트', displayName: '소담' } },
      items: [{ title: '서촌 한옥' }, { title: '번역 없는 집' }],
    };
    const out = await localize(deps, body, ['item.title', 'item.houseRules.extraRules', 'item.host.about', 'items[].title'], 'en-US');
    expect(out.item.title).toBe('Seochon hanok');
    expect(out.item.houseRules.extraRules).toBe('No smoking');
    expect(out.item.host.about).toBe('A hanok specialist host');
    expect(out.item.host.displayName).toBe('소담'); // a name is not copy
    expect(out.item.city).toBe('Seoul');
    expect(out.items[0].title).toBe('Seochon hanok');
    expect(out.items[1].title).toBe('번역 없는 집');
  });

  it('is a no-op without deps or on missing branches', async () => {
    const body = { item: { title: '한옥' } };
    expect(await localize(null, body, ['item.title'], 'en-US')).toBe(body);
    await expect(localize({ db: t.pool }, body, ['nope.deep.title', 'items[].title'], 'en-US')).resolves.toBe(body);
  });
});

const LISTING = {
  title: '서촌 누하동 한옥 독채',
  summary: '경복궁 서쪽 골목 끝의 조용한 한옥',
  propertyType: 'HANOK',
  roomType: 'ENTIRE',
  maxGuests: 4,
  city: 'Seoul',
  country: 'KR',
  basePriceMinor: 230000,
  currency: 'KRW',
} as const;

/** A listing visible to the public read paths. Publishing runs the compliance gate, which is not what these
 *  tests are about, so the status is set directly — the same shortcut compliance.test.ts uses. */
async function publishedListing(): Promise<string> {
  const host = await createUser(t, { roles: ['HOST'] });
  const created = await call(t, host, 'POST', '/v1/properties', LISTING);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  await t.pool.query(`UPDATE properties SET status = 'PUBLISHED' WHERE id = $1`, [created.body.item.id]);
  return created.body.item.slug;
}

describe('read paths', () => {
  it('translates a published listing for the reader, leaves Korean alone, and fills the cache in the background', async () => {
    await enable();
    const fake = new FakeTranslator();
    t.app.ctx.adapters.set('i18n.translator', fake);
    const slug = await publishedListing();

    // 1. Korean reads the source, and asks for no translation at all.
    const ko = await t.app.inject({ method: 'GET', url: `/v1/properties/by-slug/${slug}` });
    expect(ko.json().item.title).toBe(LISTING.title);
    expect(fake.calls).toHaveLength(0);

    // 2. A Japanese reader gets the source this time — a read never waits for the model — and queues the work.
    const first = await t.app.inject({ method: 'GET', url: `/v1/properties/by-slug/${slug}`, headers: { 'accept-language': 'ja' } });
    expect(first.json().item.title).toBe(LISTING.title);
    await (t.app.ctx.adapters.get('i18n.translateQueue') as TranslationQueue).drain();
    expect(fake.calls.length).toBeGreaterThan(0);
    expect(fake.calls[0].locale).toBe('ja-JP');

    // 3. The next Japanese reader gets it translated; Korean is still untouched.
    const second = await t.app.inject({ method: 'GET', url: `/v1/properties/by-slug/${slug}`, headers: { 'accept-language': 'ja' } });
    expect(second.json().item.title).toBe(`[ja-JP] ${LISTING.title}`);
    expect(second.json().item.summary).toBe(`[ja-JP] ${LISTING.summary}`);
    expect((await t.app.inject({ method: 'GET', url: `/v1/properties/by-slug/${slug}` })).json().item.title).toBe(LISTING.title);
  });

  it('leaves the listing in the source language while the flag is off', async () => {
    await disable();
    const fake = new FakeTranslator();
    t.app.ctx.adapters.set('i18n.translator', fake);
    const slug = await publishedListing();
    await storeTranslations(t.pool, [{ source: LISTING.title, translated: 'Cached anyway' }], 'ja-JP', 'fake', 'fake-1');
    const res = await t.app.inject({ method: 'GET', url: `/v1/properties/by-slug/${slug}`, headers: { 'accept-language': 'ja' } });
    expect(res.json().item.title).toBe(LISTING.title);
    expect(fake.calls).toHaveLength(0);
    await enable();
  });

  it('does nothing while the flag is off', async () => {
    await disable();
    const deps = await contentTranslation(t.ctx(), 'ja-JP');
    expect(deps).toBeNull();
    await enable();
    expect(await contentTranslation(t.ctx(), 'ja-JP')).not.toBeNull();
  });

  it('never translates into the source language', async () => {
    await enable();
    expect(await contentTranslation(t.ctx(), 'ko-KR')).toBeNull();
  });
});

describe('supported locales', () => {
  it('match the web UI languages and the CMS locale format', () => {
    expect([...SUPPORTED_LOCALES]).toEqual(['ko-KR', 'en-US', 'ja-JP', 'zh-CN', 'vi-VN']);
    for (const l of SUPPORTED_LOCALES) expect(l).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
  });

  it('hashes are stable and content-addressed', () => {
    expect(sourceHash('한옥')).toBe(sourceHash('한옥'));
    expect(sourceHash('한옥')).not.toBe(sourceHash('한옥 '));
    expect(sourceHash('한옥')).toHaveLength(64);
  });
});
