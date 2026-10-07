import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { normalizePath } from '../src/modules/cms/service.js';

let t: TestApp;
let editor: TestUser, admin: TestUser, user: TestUser;

beforeAll(async () => {
  t = await createTestApp();
  editor = await createUser(t, { roles: ['EDITOR'] });
  admin = await createUser(t, { roles: ['ADMIN'] });
  user = await createUser(t);
});
afterAll(async () => t.close());

describe('OPS-03 CMS', () => {
  let id: string;
  it('editors (AAL2) create drafts; others cannot', async () => {
    const body = { type: 'DESTINATION', slug: 'jeju', title: '제주', summary: '바다와 오름', bodyMd: '# 제주' };
    expect((await call(t, user, 'POST', '/v1/admin/cms/entries', body)).status).toBe(403);
    const aal1 = await createUser(t, { roles: ['EDITOR'], aal: 'aal1' });
    expect((await call(t, aal1, 'POST', '/v1/admin/cms/entries', body)).body.code).toBe('AAL2_REQUIRED');
    const r = await call(t, editor, 'POST', '/v1/admin/cms/entries', body);
    expect(r.status).toBe(201);
    expect(r.body.item.status).toBe('DRAFT');
    id = r.body.item.id;
    expect((await call(t, editor, 'POST', '/v1/admin/cms/entries', body)).status).toBe(409);
  });

  it('drafts are invisible publicly; publish makes them visible; archive hides again', async () => {
    expect((await call(t, null, 'GET', '/v1/content/destination/jeju')).status).toBe(404);
    expect((await call(t, null, 'GET', '/v1/content/destination')).body.items).toHaveLength(0);
    const p = await call(t, editor, 'POST', `/v1/admin/cms/entries/${id}/publish`, { reason: 'reviewed' });
    expect(p.body.item.status).toBe('PUBLISHED');
    expect(p.body.item.path).toBe('/discover/jeju');
    const pub = await call(t, null, 'GET', '/v1/content/destination/jeju');
    expect(pub.body.item.title).toBe('제주');
    const ev = await t.pool.query(`SELECT payload FROM outbox_events WHERE event_type = 'content.published'`);
    expect(ev.rows[0].payload.slug).toBe('jeju');
    const audit = await t.pool.query(`SELECT 1 FROM audit_logs WHERE category = 'CONTENT' AND resource_id = $1`, [id]);
    expect(audit.rows.length).toBeGreaterThanOrEqual(2);
    // invalid transition: PUBLISHED -> PUBLISHED
    expect((await call(t, editor, 'POST', `/v1/admin/cms/entries/${id}/publish`)).body.code).toBe('INVALID_STATE_TRANSITION');
  });

  it('falls back to ko-KR when the requested locale is missing, prefers the locale when present', async () => {
    expect((await call(t, null, 'GET', '/v1/content/destination/jeju?locale=en-US')).body.item.locale).toBe('ko-KR');
    const en = await call(t, editor, 'POST', '/v1/admin/cms/entries', { type: 'DESTINATION', slug: 'jeju', locale: 'en-US', title: 'Jeju' });
    await call(t, editor, 'POST', `/v1/admin/cms/entries/${en.body.item.id}/publish`);
    expect((await call(t, null, 'GET', '/v1/content/destination/jeju?locale=en-US')).body.item.title).toBe('Jeju');
    const list = await call(t, null, 'GET', '/v1/content/destinations?locale=en-US');
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].title).toBe('Jeju');
    await call(t, editor, 'POST', `/v1/admin/cms/entries/${id}/archive`);
    expect((await call(t, null, 'GET', '/v1/content/destination/jeju')).status).toBe(404);
    expect((await call(t, null, 'GET', '/v1/content/unknown-type')).status).toBe(404);
  });

  it('sitemap lists published listings and content only', async () => {
    const host = await createUser(t, { roles: ['HOST'] });
    await t.pool.query(`INSERT INTO properties(host_id, slug, title, property_type, status) VALUES ($1,'seoul-hanok','H','HANOK','PUBLISHED'),($1,'draft-one','D','HOUSE','DRAFT')`, [host.id]);
    const s = await call(t, null, 'GET', '/v1/seo/sitemap');
    const locs = s.body.items.map((i: any) => i.loc);
    expect(locs).toContain('http://localhost:3000/stay/seoul-hanok');
    expect(locs.some((l: string) => l.includes('draft-one'))).toBe(false);
    expect(locs).toContain('http://localhost:3000/discover/jeju'); // en-US version still published
  });
});

describe('OPS-03 SEO redirects', () => {
  it('normalizes paths', () => {
    expect(normalizePath('https://wont.kr/shop/item/12/?a=1#top')).toBe('/shop/item/12?a=1');
    expect(normalizePath('board//notice/')).toBe('/board/notice');
    expect(normalizePath('/')).toBe('/');
  });

  it('bulk import by an editor stays unapproved until an admin approves; resolve counts hits', async () => {
    const r = await call(t, editor, 'POST', '/v1/admin/seo/redirects/bulk', {
      items: [
        { legacyPath: '/shop/item/12/', targetPath: '/stay/seoul-hanok', approved: true },
        { legacyPath: '/board/notice', targetPath: '/stories/notice' },
        { legacyPath: '/evil', targetPath: 'https://evil.example.com' },
        { legacyPath: '/loop', targetPath: '/loop' },
      ],
    });
    expect(r.body.inserted).toBe(2);
    expect(r.body.errors.map((e: any) => e.error)).toEqual(['UNSAFE_REDIRECT_TARGET', 'REDIRECT_LOOP']);
    expect((await call(t, null, 'GET', '/v1/seo/redirects?path=/shop/item/12')).status).toBe(404);
    expect((await call(t, editor, 'POST', '/v1/admin/seo/redirects/approve', { paths: ['/shop/item/12'] })).status).toBe(403);
    expect((await call(t, admin, 'POST', '/v1/admin/seo/redirects/approve', { paths: ['/shop/item/12'] })).body.updated).toBe(1);
    const res = await call(t, null, 'GET', `/v1/seo/redirects?path=${encodeURIComponent('/shop/item/12/?utm=x')}`);
    expect(res.body.item).toEqual({ legacyPath: '/shop/item/12', targetPath: '/stay/seoul-hanok', statusCode: 301 });
    await call(t, null, 'GET', '/v1/seo/redirects?path=/shop/item/12');
    const hits = await t.pool.query(`SELECT hits FROM seo_redirects WHERE legacy_path = '/shop/item/12'`);
    expect(hits.rows[0].hits).toBe(2);
  });

  it('admin upsert can approve directly; changing a target by an editor clears approval', async () => {
    await call(t, admin, 'PUT', '/v1/admin/seo/redirects', { legacyPath: '/about', targetPath: '/p/about', approved: true });
    expect((await call(t, null, 'GET', '/v1/seo/redirects?path=/about')).status).toBe(200);
    await call(t, editor, 'PUT', '/v1/admin/seo/redirects', { legacyPath: '/about', targetPath: '/p/company' });
    expect((await call(t, null, 'GET', '/v1/seo/redirects?path=/about')).status).toBe(404);
    expect((await call(t, editor, 'DELETE', '/v1/admin/seo/redirects?path=/about')).status).toBe(200);
    expect((await call(t, editor, 'GET', '/v1/admin/seo/redirects?approved=false')).body.items.map((r: any) => r.legacy_path)).toEqual(['/board/notice']);
  });
});
