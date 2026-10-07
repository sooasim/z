import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { signPayloadWebhook, verifyPayloadSignature } from '../src/modules/cms/external.js';
import { jsonLdFor } from '../src/modules/cms/service.js';

let t: TestApp;
let editor: TestUser, admin: TestUser, user: TestUser;
const SECRET = 'payload-webhook-secret-for-tests';
const URL = '/v1/cms/webhooks/payload';

beforeAll(async () => {
  t = await createTestApp();
  editor = await createUser(t, { roles: ['EDITOR'] });
  admin = await createUser(t, { roles: ['ADMIN'] });
  user = await createUser(t);
});
afterAll(async () => {
  delete process.env.PAYLOAD_WEBHOOK_SECRET;
  await t.close();
});

/** Deliver a webhook exactly as Payload would: signed raw bytes. */
const deliver = (body: unknown, opts: { secret?: string | null; raw?: string; signature?: string } = {}) => {
  const raw = opts.raw ?? JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const sig = opts.signature ?? (opts.secret === null ? undefined : signPayloadWebhook(opts.secret ?? SECRET, raw));
  if (sig) headers['x-payload-signature'] = sig;
  return call(t, null, 'POST', URL, raw, headers);
};

const T0 = Date.now();
const ts = (minutesAgo: number) => new Date(T0 - minutesAgo * 60_000).toISOString();
const destDoc = (over: Record<string, unknown> = {}) => ({
  id: 'dest-busan',
  slug: 'busan',
  title: '부산',
  summary: '바다의 도시',
  bodyMd: '# 부산',
  _status: 'draft',
  updatedAt: ts(30),
  seo: { title: '부산 여행', description: '해운대와 감천', canonical: '/discover/busan', og: { image: '/media/busan.jpg', type: 'place' } },
  data: { lat: 35.1796, lng: 129.0756, region: '부산광역시', touristType: ['Beach lovers'] },
  ...over,
});
const entryFor = async (slug: string, locale = 'ko-KR') => (await t.pool.query(`SELECT * FROM cms_entries WHERE slug = $1 AND locale = $2`, [slug, locale])).rows[0];
const refOf = async (externalId: string) => (await t.pool.query(`SELECT * FROM cms_external_refs WHERE system = 'PAYLOAD' AND external_id = $1`, [externalId])).rows[0];

describe('OPS-03 Payload webhook: authenticity (invariant 4)', () => {
  it('is refused when no secret is configured', async () => {
    delete process.env.PAYLOAD_WEBHOOK_SECRET;
    const r = await deliver({ collection: 'destinations', doc: destDoc() });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('WEBHOOK_NOT_CONFIGURED');
  });

  it('rejects missing, wrong and tampered signatures before validating the body', async () => {
    process.env.PAYLOAD_WEBHOOK_SECRET = SECRET;
    const body = { collection: 'destinations', doc: destDoc() };
    expect((await deliver(body, { secret: null })).body.code).toBe('INVALID_SIGNATURE');
    expect((await deliver(body, { secret: 'wrong-secret' })).body.code).toBe('INVALID_SIGNATURE');
    expect((await deliver(body, { signature: 'sha256=zz' })).status).toBe(401);
    const raw = JSON.stringify(body);
    const sig = signPayloadWebhook(SECRET, raw);
    expect((await deliver(null, { raw: raw.replace('부산', '서울'), signature: sig })).status).toBe(401);
    // unsigned garbage gets 401 (not a schema error)
    expect((await deliver(null, { raw: '{"nope":1}', signature: 'sha256=' + '0'.repeat(64) })).status).toBe(401);
    // signed but malformed / invalid bodies are 400
    expect((await deliver(null, { raw: '{not json' })).status).toBe(400);
    expect((await deliver({ collection: 'destinations', doc: { id: 'x' } })).status).toBe(400);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM cms_entries`)).rows[0].n).toBe(0);
    expect(verifyPayloadSignature(SECRET, raw, sig.replace('sha256=', ''))).toBe(true);
    expect(verifyPayloadSignature(SECRET, raw, [sig])).toBe(true);
  });
});

describe('OPS-03 Payload webhook: upsert lifecycle', () => {
  beforeAll(() => {
    process.env.PAYLOAD_WEBHOOK_SECRET = SECRET;
  });

  it('creates a DRAFT entry + external ref; drafts stay private', async () => {
    const r = await deliver({ event: 'afterChange', operation: 'create', collection: 'destinations', doc: destDoc() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: true, action: 'CREATED', status: 'DRAFT' });
    const e = await entryFor('busan');
    expect(e).toMatchObject({ entry_type: 'DESTINATION', status: 'DRAFT', title: '부산', author_id: null });
    expect(e.seo.og).toEqual({ image: '/media/busan.jpg', type: 'place' });
    const ref = await refOf('destinations:dest-busan:ko-KR');
    expect(ref.entry_id).toBe(e.id);
    expect(new Date(ref.source_updated_at).toISOString()).toBe(destDoc().updatedAt);
    expect((await call(t, null, 'GET', '/v1/content/destination/busan')).status).toBe(404);
  });

  it('replays of the same revision are idempotent (no second write)', async () => {
    const body = { operation: 'update', collection: 'destinations', doc: destDoc() };
    const before = (await t.pool.query(`SELECT count(*)::int AS n FROM audit_logs`)).rows[0].n;
    const r = await deliver(body);
    expect(r.body).toEqual({ received: true, duplicate: true });
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM audit_logs`)).rows[0].n).toBe(before);
    // concurrent duplicate deliveries of a new revision: exactly one applies
    const next = { operation: 'update', collection: 'destinations', doc: destDoc({ updatedAt: ts(25), title: '부산 (개정)' }) };
    const res = await Promise.all([deliver(next), deliver(next), deliver(next)]);
    expect(res.every((x) => x.status === 200)).toBe(true);
    expect(res.filter((x) => x.body.duplicate)).toHaveLength(2);
    expect(res.filter((x) => x.body.action === 'UPDATED')).toHaveLength(1);
  });

  it('a published revision publishes the entry (content.published) and exposes JSON-LD hints', async () => {
    const r = await deliver({ collection: 'destinations', doc: destDoc({ _status: 'published', updatedAt: ts(20) }) });
    expect(r.body).toMatchObject({ action: 'UPDATED', status: 'PUBLISHED' });
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'content.published' ORDER BY created_at, id`);
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0].payload).toMatchObject({ slug: 'busan', path: '/discover/busan' });

    const pub = await call(t, null, 'GET', '/v1/content/destination/busan');
    expect(pub.status).toBe(200);
    expect(pub.body.item.seo).toMatchObject({ title: '부산 여행', canonical: '/discover/busan' });
    const ld = pub.body.item.data.jsonLd;
    expect(ld).toMatchObject({
      '@context': 'https://schema.org',
      '@type': 'TouristDestination',
      name: '부산',
      description: '해운대와 감천',
      url: 'http://localhost:3000/discover/busan',
      image: 'http://localhost:3000/media/busan.jpg',
      inLanguage: 'ko-KR',
      geo: { '@type': 'GeoCoordinates', latitude: 35.1796, longitude: 129.0756 },
      touristType: ['Beach lovers'],
      containedInPlace: { '@type': 'Place', name: '부산광역시' },
    });
    expect(pub.body.item.data.lat).toBe(35.1796);
    const list = await call(t, null, 'GET', '/v1/content/destinations');
    expect(list.body.items[0].data.jsonLd['@type']).toBe('TouristDestination');
  });

  it('out-of-order (older) revisions are ignored', async () => {
    const r = await deliver({ collection: 'destinations', doc: destDoc({ title: 'STALE', _status: 'draft', updatedAt: ts(28) }) });
    expect(r.body).toMatchObject({ received: true, ignored: 'STALE_REVISION' });
    expect((await entryFor('busan')).title).toBe('부산');
    expect((await entryFor('busan')).status).toBe('PUBLISHED');
    const we = await t.pool.query(`SELECT process_error, processed_at FROM webhook_events WHERE provider = 'PAYLOAD' AND process_error = 'STALE_REVISION'`);
    expect(we.rows).toHaveLength(1);
  });

  it('editing a live document re-announces content.published; unpublishing returns it to DRAFT', async () => {
    await deliver({ collection: 'destinations', doc: destDoc({ _status: 'published', title: '부산 2026', updatedAt: ts(15) }) });
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'content.published' ORDER BY created_at, id`);
    expect(ev.rows).toHaveLength(2);
    expect(ev.rows[1].payload).toMatchObject({ slug: 'busan', republished: true });
    expect((await call(t, null, 'GET', '/v1/content/destination/busan')).body.item.title).toBe('부산 2026');

    const d = await deliver({ collection: 'destinations', doc: destDoc({ _status: 'draft', updatedAt: ts(14) }) });
    expect(d.body.status).toBe('DRAFT');
    expect((await call(t, null, 'GET', '/v1/content/destination/busan')).status).toBe(404);
    const trans = await t.pool.query(`SELECT from_state, to_state FROM state_transitions WHERE aggregate_type = 'CmsEntry' AND aggregate_id = $1 ORDER BY id`, [(await entryFor('busan')).id]);
    expect(trans.rows.map((x) => `${x.from_state}>${x.to_state}`)).toEqual(['DRAFT>PUBLISHED', 'PUBLISHED>DRAFT']);
  });

  it('delete archives the entry; a later publish restores it', async () => {
    const del = await deliver({ event: 'afterDelete', operation: 'delete', collection: 'destinations', doc: destDoc({ updatedAt: ts(14) }) });
    expect(del.body).toMatchObject({ action: 'ARCHIVED', status: 'ARCHIVED' });
    expect((await entryFor('busan')).status).toBe('ARCHIVED');
    expect((await deliver({ operation: 'delete', collection: 'destinations', doc: destDoc({ id: 'never-synced', updatedAt: ts(1) }) })).body.ignored).toBe('UNKNOWN_DOCUMENT');
    const back = await deliver({ collection: 'destinations', doc: destDoc({ _status: 'published', updatedAt: ts(10) }) });
    expect(back.body.status).toBe('PUBLISHED');
    expect((await call(t, null, 'GET', '/v1/content/destination/busan')).status).toBe(200);
  });

  it('localized documents map to per-locale entries', async () => {
    const r = await deliver({ collection: 'destinations', locale: 'en-US', doc: destDoc({ title: 'Busan', _status: 'published', updatedAt: ts(9) }) });
    expect(r.body.action).toBe('CREATED');
    expect(await refOf('destinations:dest-busan:en-US')).toBeTruthy();
    expect((await call(t, null, 'GET', '/v1/content/destination/busan?locale=en-US')).body.item.title).toBe('Busan');
  });

  it('adopts an editor-created entry with the same slug; refuses to steal a live mapping', async () => {
    const created = await call(t, editor, 'POST', '/v1/admin/cms/entries', { type: 'STORY', slug: 'jeju-trail', title: 'Draft by editor' });
    const r = await deliver({ collection: 'stories', doc: { id: 77, slug: 'jeju-trail', title: '올레길', _status: 'published', updatedAt: ts(5) } });
    expect(r.body).toMatchObject({ action: 'LINKED', entryId: created.body.item.id, status: 'PUBLISHED' });
    const clash = await deliver({ collection: 'stories', doc: { id: 78, slug: 'jeju-trail', title: 'Other doc', _status: 'draft', updatedAt: ts(4) } });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe('SLUG_CONFLICT');
    expect((await entryFor('jeju-trail')).title).toBe('올레길');
  });

  it('invalid documents fail without consuming the revision (a fixed retry applies); unknown collections are ignored', async () => {
    const bad = { collection: 'faqs', doc: { id: 'faq-1', slug: 'Bad Slug!', title: 'Q', _status: 'draft', updatedAt: ts(3) } };
    const r = await deliver(bad);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('INVALID_SLUG');
    const fixed = await deliver({ ...bad, doc: { ...bad.doc, slug: 'refund-policy' } });
    expect(fixed.body.action).toBe('CREATED');
    const unk = await deliver({ collection: 'authors', doc: { id: 1, slug: 'kim', title: 'Kim', updatedAt: ts(2) } });
    expect(unk.body).toEqual({ received: true, ignored: 'UNKNOWN_COLLECTION' });
  });

  it('maps @payloadcms/plugin-seo meta fields when no seo group is sent', async () => {
    await deliver({ collection: 'pages', doc: { id: 'p1', slug: 'about', title: 'About', updatedAt: ts(2), meta: { title: 'About JETPOOL', description: 'Who we are', image: { url: 'https://cdn.example.com/a.jpg' } } } });
    expect((await entryFor('about')).seo).toEqual({ title: 'About JETPOOL', description: 'Who we are', og: { image: 'https://cdn.example.com/a.jpg' } });
  });
});

describe('OPS-03 external refs (admin)', () => {
  let entryId: string;
  beforeAll(async () => {
    entryId = (await call(t, editor, 'POST', '/v1/admin/cms/entries', { type: 'LEGACY_CONTENT', slug: 'old-wont-post', title: 'Old WONT post' })).body.item.id;
  });

  it('editors list refs (filter by system / entry); others cannot', async () => {
    expect((await call(t, user, 'GET', '/v1/admin/cms/external-refs')).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['EDITOR'], aal: 'aal1' });
    expect((await call(t, aal1, 'GET', '/v1/admin/cms/external-refs')).body.code).toBe('AAL2_REQUIRED');
    const all = await call(t, editor, 'GET', '/v1/admin/cms/external-refs?system=PAYLOAD');
    expect(all.body.items.length).toBeGreaterThanOrEqual(4);
    expect(all.body.items.every((x: any) => x.system === 'PAYLOAD')).toBe(true);
    const busan = all.body.items.find((x: any) => x.externalId === 'destinations:dest-busan:ko-KR');
    expect(busan).toMatchObject({ entry: { type: 'DESTINATION', slug: 'busan', locale: 'ko-KR' } });
    const one = await call(t, editor, 'GET', `/v1/admin/cms/entries/${busan.entryId}/refs`);
    expect(one.body.items.map((x: any) => x.externalId)).toEqual(['destinations:dest-busan:ko-KR']);
    expect((await call(t, editor, 'GET', '/v1/admin/cms/external-refs?system=MYSPACE')).status).toBe(400);
  });

  it('legacy WONT / SixShop mappings: idempotent, unique per system, audited + admin.action.performed', async () => {
    const body = { system: 'LEGACY_WONT', externalId: 'wont-123', externalUrl: 'https://wont.example.com/posts/123' };
    expect((await call(t, user, 'PUT', `/v1/admin/cms/entries/${entryId}/refs`, body)).status).toBe(403);
    expect((await call(t, editor, 'PUT', `/v1/admin/cms/entries/${entryId}/refs`, { ...body, system: 'PAYLOAD' })).status).toBe(400);
    expect((await call(t, editor, 'PUT', `/v1/admin/cms/entries/${entryId}/refs`, { ...body, externalUrl: 'javascript:alert(1)' })).status).toBe(400);
    const a = await call(t, editor, 'PUT', `/v1/admin/cms/entries/${entryId}/refs`, body);
    expect(a.status).toBe(201);
    expect(a.body.item).toMatchObject({ entryId, system: 'LEGACY_WONT', externalId: 'wont-123' });
    expect((await call(t, editor, 'PUT', `/v1/admin/cms/entries/${entryId}/refs`, body)).status).toBe(200);
    expect((await call(t, editor, 'PUT', `/v1/admin/cms/entries/${entryId}/refs`, { system: 'SIXSHOP', externalId: 'six-9' })).status).toBe(201);

    const otherEntry = (await call(t, editor, 'POST', '/v1/admin/cms/entries', { type: 'LEGACY_CONTENT', slug: 'other-post', title: 'Other' })).body.item.id;
    expect((await call(t, editor, 'PUT', `/v1/admin/cms/entries/${otherEntry}/refs`, body)).body.code).toBe('EXTERNAL_REF_TAKEN');
    expect((await call(t, editor, 'PUT', `/v1/admin/cms/entries/${entryId}/refs`, { system: 'LEGACY_WONT', externalId: 'wont-999' })).body.code).toBe('ENTRY_ALREADY_MAPPED');
    expect((await call(t, editor, 'PUT', `/v1/admin/cms/entries/00000000-0000-4000-8000-000000000000/refs`, { system: 'SIXSHOP', externalId: 'six-404' })).status).toBe(404);

    const refs = await call(t, editor, 'GET', `/v1/admin/cms/entries/${entryId}/refs`);
    expect(refs.body.items.map((x: any) => x.system).sort()).toEqual(['LEGACY_WONT', 'SIXSHOP']);
    const acts = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'admin.action.performed' AND aggregate_id = $1 AND payload->>'action' = 'cms.external_ref.linked'`, [entryId]);
    expect(acts.rows).toHaveLength(3);
    expect((await t.pool.query(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'cms.external_ref.linked' AND resource_id = $1`, [entryId])).rows[0].n).toBe(3);
  });
});

describe('OPS-03 structured content', () => {
  it('seo supports title/description/canonical/og and rejects unsafe values', async () => {
    const ok = await call(t, editor, 'POST', '/v1/admin/cms/entries', {
      type: 'PAGE',
      slug: 'terms',
      title: 'Terms',
      seo: { title: 'Terms', description: 'Our terms', canonical: 'https://jetpool.kr/p/terms', noindex: false, keywords: ['terms'], og: { title: 'T', description: 'D', image: 'https://cdn.jetpool.kr/og.png', imageAlt: 'logo', type: 'website' } },
    });
    expect(ok.status).toBe(201);
    expect(ok.body.item.seo.og).toEqual({ title: 'T', description: 'D', image: 'https://cdn.jetpool.kr/og.png', imageAlt: 'logo', type: 'website' });
    for (const seo of [
      { canonical: 'javascript:alert(1)' },
      { canonical: '//evil.example.com' },
      { og: { image: 'data:image/png;base64,AAAA' } },
      { og: { type: 'video' } },
      { og: { unknown: 'x' } },
    ]) {
      expect((await call(t, editor, 'POST', '/v1/admin/cms/entries', { type: 'PAGE', slug: 'bad-seo', title: 'x', seo })).status, JSON.stringify(seo)).toBe(400);
    }
    expect((await call(t, editor, 'PATCH', `/v1/admin/cms/entries/${ok.body.item.id}`, { seo: { canonical: '/\\evil' } })).status).toBe(400);
  });

  it('FAQ entries get FAQPage JSON-LD (from data.faqs or the entry itself); other types get none', async () => {
    const faq = await call(t, editor, 'POST', '/v1/admin/cms/entries', {
      type: 'FAQ',
      slug: 'payments',
      title: '결제 FAQ',
      data: { faqs: [{ question: '언제 확정되나요?', answer: '결제 승인 후 서버에서 확정합니다.' }, { q: '환불은?', a: '정책에 따릅니다.' }, { question: 'no answer' }], jsonLd: { '@type': 'Injected' } },
    });
    await call(t, editor, 'POST', `/v1/admin/cms/entries/${faq.body.item.id}/publish`);
    const single = await call(t, editor, 'POST', '/v1/admin/cms/entries', { type: 'FAQ', slug: 'cancel', title: '취소할 수 있나요?', summary: '체크인 7일 전까지 무료입니다.' });
    await call(t, editor, 'POST', `/v1/admin/cms/entries/${single.body.item.id}/publish`);

    const r = await call(t, null, 'GET', '/v1/content/faq/payments');
    const ld = r.body.item.data.jsonLd;
    expect(ld['@type']).toBe('FAQPage');
    expect(ld.url).toBe('http://localhost:3000/faq/payments');
    expect(ld.mainEntity).toEqual([
      { '@type': 'Question', name: '언제 확정되나요?', acceptedAnswer: { '@type': 'Answer', text: '결제 승인 후 서버에서 확정합니다.' } },
      { '@type': 'Question', name: '환불은?', acceptedAnswer: { '@type': 'Answer', text: '정책에 따릅니다.' } },
    ]);
    const c = await call(t, null, 'GET', '/v1/content/faq/cancel');
    expect(c.body.item.data.jsonLd.mainEntity).toEqual([{ '@type': 'Question', name: '취소할 수 있나요?', acceptedAnswer: { '@type': 'Answer', text: '체크인 7일 전까지 무료입니다.' } }]);
    expect((await call(t, null, 'GET', '/v1/content/faqs')).body.items.every((i: any) => i.data.jsonLd['@type'] === 'FAQPage')).toBe(true);

    // admin views keep the raw stored data; non DESTINATION/FAQ types carry no hints
    expect((await call(t, editor, 'GET', '/v1/admin/cms/entries?type=FAQ')).body.items.find((i: any) => i.slug === 'payments').data.jsonLd).toEqual({ '@type': 'Injected' });
    const story = (await call(t, null, 'GET', '/v1/content/story/jeju-trail')).body.item;
    expect(story.data?.jsonLd).toBeUndefined();
    const page = await call(t, editor, 'POST', '/v1/admin/cms/entries', { type: 'PAGE', slug: 'ld-page', title: 'LD', data: { jsonLd: { '@type': 'Injected' }, keep: 1 } });
    await call(t, editor, 'POST', `/v1/admin/cms/entries/${page.body.item.id}/publish`);
    expect((await call(t, null, 'GET', '/v1/content/page/ld-page')).body.item.data).toEqual({ keep: 1 });
    expect(jsonLdFor({ entry_type: 'BANNER', slug: 'x', title: 'x' }, 'https://jetpool.kr')).toBeNull();
  });

  it('admin CMS mutations emit admin.action.performed', async () => {
    const e = await call(t, editor, 'POST', '/v1/admin/cms/entries', { type: 'PROMOTION', slug: 'autumn', title: 'Autumn' });
    await call(t, editor, 'PATCH', `/v1/admin/cms/entries/${e.body.item.id}`, { title: 'Autumn sale' });
    await call(t, editor, 'POST', `/v1/admin/cms/entries/${e.body.item.id}/publish`);
    await call(t, editor, 'POST', `/v1/admin/cms/entries/${e.body.item.id}/archive`);
    const acts = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'admin.action.performed' AND aggregate_id = $1 ORDER BY created_at, id`, [e.body.item.id]);
    expect(acts.rows.map((r) => r.payload.action)).toEqual(['cms.entry.created', 'cms.entry.updated', 'cms.entry.publish', 'cms.entry.archive']);
    expect(acts.rows[0].payload).toMatchObject({ resourceType: 'cms_entry', actorId: editor.id, entryType: 'PROMOTION', slug: 'autumn' });

    await call(t, editor, 'PUT', '/v1/admin/seo/redirects', { legacyPath: '/old/autumn', targetPath: '/promotions/autumn' });
    await call(t, admin, 'POST', '/v1/admin/seo/redirects/approve', { paths: ['/old/autumn'] });
    await call(t, editor, 'DELETE', '/v1/admin/seo/redirects?path=/old/autumn');
    const red = await t.pool.query(`SELECT payload->>'action' AS action FROM outbox_events WHERE event_type = 'admin.action.performed' AND payload->>'resourceType' = 'seo_redirect' ORDER BY created_at, id`);
    expect(red.rows.map((r) => r.action)).toEqual(['seo.redirects.upserted', 'seo.redirects.approved', 'seo.redirect.deleted']);
    // the webhook (no staff actor) never emits admin actions
    const sys = await t.pool.query(`SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'admin.action.performed' AND payload->>'actorId' IS NULL`);
    expect(sys.rows[0].n).toBe(0);
  });
});
