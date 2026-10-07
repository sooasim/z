import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';

let t: TestApp;
let host: TestUser;
let other: TestUser;

/** Minimal PNG (signature + IHDR) padded to look like a real file. */
function png(w = 640, h = 480, pad = 64) {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  b[24] = 8;
  b[25] = 6;
  return b;
}
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);

async function requestUpload(user: TestUser, body: any) {
  return call(t, user, 'POST', '/v1/media/upload-url', body);
}
async function put(url: string, bytes: Buffer, contentType: string) {
  const u = new URL(url);
  const res = await t.app.inject({ method: 'PUT', url: u.pathname + u.search, payload: bytes, headers: { 'content-type': contentType } });
  return { status: res.statusCode, body: res.json() };
}
async function uploadReady(user: TestUser, purpose = 'PROPERTY', bytes = png()) {
  const r = await requestUpload(user, { purpose, mimeType: 'image/png', byteSize: bytes.length });
  expect(r.status).toBe(201);
  expect((await put(r.body.upload.url, bytes, 'image/png')).status).toBe(200);
  const c = await call(t, user, 'POST', `/v1/media/${r.body.media.id}/complete`);
  expect(c.status).toBe(200);
  return c.body.item;
}

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
  other = await createUser(t);
});
afterAll(async () => t.close());

describe('STAY-02 media pipeline', () => {
  it('rejects disallowed mime types, oversize files, wrong purpose and anonymous callers', async () => {
    expect((await requestUpload(host, { purpose: 'PROPERTY', mimeType: 'image/gif', byteSize: 10 })).body.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
    expect((await requestUpload(host, { purpose: 'PROPERTY', mimeType: 'text/html', byteSize: 10 })).status).toBe(422);
    const big = await requestUpload(host, { purpose: 'PROPERTY', mimeType: 'image/jpeg', byteSize: 16 * 1024 * 1024 });
    expect(big.status).toBe(422);
    expect(big.body.code).toBe('MEDIA_TOO_LARGE');
    expect((await requestUpload(host, { purpose: 'PROPERTY', mimeType: 'video/mp4', byteSize: 201 * 1024 * 1024 })).body.code).toBe('MEDIA_TOO_LARGE');
    expect((await requestUpload(host, { purpose: 'AVATAR', mimeType: 'video/mp4', byteSize: 1000 })).body.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
    expect((await requestUpload(host, { purpose: 'PROPERTY', mimeType: 'application/pdf', byteSize: 1000 })).body.code).toBe('MEDIA_TYPE_NOT_ALLOWED');
    expect((await requestUpload(host, { purpose: 'CMS', mimeType: 'image/png', byteSize: 1000 })).status).toBe(403);
    expect((await call(t, null, 'POST', '/v1/media/upload-url', { purpose: 'PROPERTY', mimeType: 'image/png', byteSize: 10 })).status).toBe(401);
  });

  it('dev upload flow: presigned PUT → complete → READY, promoted to the public bucket', async () => {
    const bytes = png(800, 600);
    const r = await requestUpload(host, { purpose: 'PROPERTY', mimeType: 'image/png', byteSize: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    expect(r.body.media).toMatchObject({ status: 'UPLOADING', visibility: 'PRIVATE', publicUrl: null });
    expect(r.body.upload.method).toBe('PUT');
    expect((await put(r.body.upload.url, bytes, 'image/png')).status).toBe(200);
    const c = await call(t, host, 'POST', `/v1/media/${r.body.media.id}/complete`);
    expect(c.status).toBe(200);
    expect(c.body.item).toMatchObject({ status: 'READY', visibility: 'PUBLIC', moderationStatus: 'APPROVED', width: 800, height: 600 });
    expect(c.body.item.publicUrl).toMatch(/\/public\/[0-9a-f-]+\.png$/);
    // idempotent re-complete
    expect((await call(t, host, 'POST', `/v1/media/${r.body.media.id}/complete`)).body.item.status).toBe('READY');
    // dev CDN serves the public copy
    const pub = await t.app.inject({ method: 'GET', url: new URL(c.body.item.publicUrl).pathname });
    expect(pub.statusCode).toBe(200);
    expect(pub.headers['content-type']).toBe('image/png');
    const events = await t.pool.query(`SELECT event_type FROM outbox_events WHERE aggregate_id = $1 ORDER BY created_at`, [r.body.media.id]);
    expect(events.rows.map((e) => e.event_type)).toEqual(['media.uploaded', 'media.ready']);
    const trans = await t.pool.query(`SELECT to_state FROM state_transitions WHERE aggregate_type = 'MEDIA' AND aggregate_id = $1 ORDER BY id`, [r.body.media.id]);
    expect(trans.rows.map((x) => x.to_state)).toEqual(['PROCESSING', 'READY']);
  });

  it('rejects bad tokens, content-type mismatch, other owners and missing objects', async () => {
    const bytes = png();
    const r = await requestUpload(host, { purpose: 'PROPERTY', mimeType: 'image/png', byteSize: bytes.length });
    const u = new URL(r.body.upload.url);
    const bad = await t.app.inject({ method: 'PUT', url: `${u.pathname}?token=1.deadbeefdeadbeef`, payload: bytes, headers: { 'content-type': 'image/png' } });
    expect(bad.statusCode).toBe(403);
    expect((await put(r.body.upload.url, bytes, 'image/jpeg')).status).toBe(400);
    expect((await call(t, host, 'POST', `/v1/media/${r.body.media.id}/complete`)).body.code).toBe('UPLOAD_NOT_FOUND');
    await put(r.body.upload.url, bytes, 'image/png');
    expect((await call(t, other, 'POST', `/v1/media/${r.body.media.id}/complete`)).status).toBe(403);
    expect((await call(t, other, 'GET', `/v1/media/${r.body.media.id}`)).status).toBe(403);
  });

  it('sniffs magic bytes: declared PNG with JPEG content is REJECTED', async () => {
    const bytes = jpeg();
    const r = await requestUpload(host, { purpose: 'PROPERTY', mimeType: 'image/png', byteSize: bytes.length });
    await put(r.body.upload.url, bytes, 'image/png');
    const c = await call(t, host, 'POST', `/v1/media/${r.body.media.id}/complete`);
    expect(c.status).toBe(422);
    expect(c.body.code).toBe('MEDIA_TYPE_MISMATCH');
    const m = await call(t, host, 'GET', `/v1/media/${r.body.media.id}`);
    expect(m.body.item).toMatchObject({ status: 'REJECTED', moderationStatus: 'REJECTED', visibility: 'PRIVATE', publicUrl: null });
  });

  it('rejects size and checksum mismatches', async () => {
    const bytes = png();
    const r = await requestUpload(host, { purpose: 'PROPERTY', mimeType: 'image/png', byteSize: bytes.length + 10 });
    await put(r.body.upload.url, bytes, 'image/png');
    expect((await call(t, host, 'POST', `/v1/media/${r.body.media.id}/complete`)).body.code).toBe('MEDIA_SIZE_MISMATCH');
    const r2 = await requestUpload(host, { purpose: 'PROPERTY', mimeType: 'image/png', byteSize: bytes.length, sha256: 'a'.repeat(64) });
    await put(r2.body.upload.url, bytes, 'image/png');
    expect((await call(t, host, 'POST', `/v1/media/${r2.body.media.id}/complete`)).body.code).toBe('MEDIA_CHECKSUM_MISMATCH');
    // oversized body against declared size is refused at upload time
    const r3 = await requestUpload(host, { purpose: 'PROPERTY', mimeType: 'image/png', byteSize: 40 });
    expect((await put(r3.body.upload.url, bytes, 'image/png')).status).toBe(422);
  });

  it('verification documents stay PRIVATE and can never be attached to a listing', async () => {
    const doc = await uploadReady(host, 'VERIFICATION');
    expect(doc).toMatchObject({ status: 'READY', visibility: 'PRIVATE', publicUrl: null });
    const row = await t.pool.query(`SELECT public_url FROM media_assets WHERE id = $1`, [doc.id]);
    expect(row.rows[0].public_url).toBeNull();
    const { rows } = await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'P','HOUSE') RETURNING id`, [host.id]);
    const res = await call(t, host, 'PUT', `/v1/properties/${rows[0].id}/media`, { items: [{ mediaId: doc.id }] });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('MEDIA_PURPOSE_MISMATCH');
  });

  it('attaches, reorders and removes property media with ownership checks', async () => {
    const { rows } = await t.pool.query(`INSERT INTO properties(host_id, title, property_type) VALUES ($1,'P2','HOUSE') RETURNING id`, [host.id]);
    const pid = rows[0].id;
    const [a, b, c] = [await uploadReady(host), await uploadReady(host), await uploadReady(host)];
    const set1 = await call(t, host, 'PUT', `/v1/properties/${pid}/media`, { items: [{ mediaId: a.id }, { mediaId: b.id, caption: '거실' }, { mediaId: c.id }] });
    expect(set1.status).toBe(200);
    expect(set1.body.items.map((m: any) => m.id)).toEqual([a.id, b.id, c.id]);
    const set2 = await call(t, host, 'PUT', `/v1/properties/${pid}/media`, { items: [{ mediaId: c.id }, { mediaId: a.id }] });
    expect(set2.body.items.map((m: any) => m.id)).toEqual([c.id, a.id]);
    // someone else's property / someone else's media
    expect((await call(t, other, 'PUT', `/v1/properties/${pid}/media`, { items: [] })).status).toBe(403);
    const foreign = await uploadReady(other);
    expect((await call(t, host, 'PUT', `/v1/properties/${pid}/media`, { items: [{ mediaId: foreign.id }] })).body.code).toBe('NOT_MEDIA_OWNER');
    expect((await call(t, host, 'PUT', `/v1/properties/${pid}/media`, { items: [{ mediaId: a.id }, { mediaId: a.id }] })).status).toBe(400);
    // not-yet-processed media cannot be attached
    const pending = await requestUpload(host, { purpose: 'PROPERTY', mimeType: 'image/png', byteSize: 100 });
    expect((await call(t, host, 'PUT', `/v1/properties/${pid}/media`, { items: [{ mediaId: pending.body.media.id }] })).body.code).toBe('MEDIA_NOT_READY');
  });
});
