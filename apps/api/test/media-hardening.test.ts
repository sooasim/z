/**
 * QA round 1 — STAY-02 media pipeline regressions: metadata (EXIF/GPS) stripping before CDN promotion, publishing
 * exactly the verified bytes, single-reader claim for concurrent completes, and no permanently stuck PROCESSING.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, call, type TestApp, type TestUser } from './helpers.js';
import { stripMetadata } from '../src/modules/media/sanitize.js';
import { releaseStaleProcessing } from '../src/modules/media/service.js';
import { STORAGE_ADAPTER } from '../src/modules/media/storage.js';

let t: TestApp;
let host: TestUser;

const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const u32 = (n: number) => Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const seg = (marker: number, payload: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), u16(payload.length + 2), payload]);

/** Big-endian EXIF APP1 with IFD0 {Orientation, GPSInfo} and a GPS IFD {N 37/1 34/1 5736/100, E 126/1 58/1 5880/100}. */
function exifApp1(orientation: number) {
  // TIFF layout: header(8) IFD0 @8: 2 entries (2+24+4=30) → GPS IFD @38: 4 entries (2+48+4=54) → data @92
  const gpsIfd = 38, data = 92;
  const rationals = (vals: number[][]) => Buffer.concat(vals.map(([n, d]) => Buffer.concat([u32(n), u32(d)])));
  const entry = (tag: number, type: number, count: number, value: Buffer) => Buffer.concat([u16(tag), u16(type), u32(count), value]);
  const tiff = Buffer.concat([
    Buffer.from('MM'), u16(42), u32(8),
    u16(2), entry(0x0112, 3, 1, Buffer.concat([u16(orientation), u16(0)])), entry(0x8825, 4, 1, u32(gpsIfd)), u32(0),
    u16(4),
    entry(0x0001, 2, 2, Buffer.from('N\0\0\0', 'latin1')), entry(0x0002, 5, 3, u32(data)),
    entry(0x0003, 2, 2, Buffer.from('E\0\0\0', 'latin1')), entry(0x0004, 5, 3, u32(data + 24)), u32(0),
    rationals([[37, 1], [34, 1], [5736, 100]]), rationals([[126, 1], [58, 1], [5880, 100]]),
  ]);
  return seg(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
}
const GPS_LAT = Buffer.concat([u32(37), u32(1), u32(34), u32(1), u32(5736), u32(100)]);

function jpegWithGps(orientation = 6) {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])),
    exifApp1(orientation),
    seg(0xe1, Buffer.from('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta><exif:GPSLatitude>37,34.956N</exif:GPSLatitude></x:xmpmeta>', 'latin1')),
    seg(0xed, Buffer.from('Photoshop 3.0\x008BIM IPTC-SECRET-LOCATION', 'latin1')),
    seg(0xfe, Buffer.from('COMMENT-SECRET', 'latin1')),
    seg(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    seg(0xc0, Buffer.from([0x08, 0x03, 0x00, 0x04, 0x00, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01])),
    seg(0xda, Buffer.from([0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00])),
    Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]),
    Buffer.from([0xff, 0xd9]),
    Buffer.from('TRAILER-MPF-SECRET', 'latin1'),
  ]);
}
function png(w = 640, h = 480) {
  const b = Buffer.alloc(97);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
async function startUpload(user: TestUser, bytes: Buffer, mime: string, purpose = 'PROPERTY') {
  const r = await call(t, user, 'POST', '/v1/media/upload-url', { purpose, mimeType: mime, byteSize: bytes.length });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const u = new URL(r.body.upload.url);
  const put = await t.app.inject({ method: 'PUT', url: u.pathname + u.search, payload: bytes, headers: { 'content-type': mime } });
  expect(put.statusCode).toBe(200);
  return r.body.media.id as string;
}
const publicBytes = async (url: string) => (await t.app.inject({ method: 'GET', url: new URL(url).pathname })).rawPayload;
const storage = () => t.app.ctx.adapters.get(STORAGE_ADAPTER) as any;

beforeAll(async () => {
  t = await createTestApp();
  host = await createUser(t, { roles: ['HOST'] });
});
afterAll(async () => t.close());

describe('#6 public media is published without EXIF/GPS and other metadata', () => {
  it('JPEG: GPS/XMP/IPTC/comments/trailers removed, orientation kept, image intact', async () => {
    const original = jpegWithGps(6);
    expect(original.includes(GPS_LAT)).toBe(true);
    const id = await startUpload(host, original, 'image/jpeg');
    const c = await call(t, host, 'POST', `/v1/media/${id}/complete`);
    expect(c.status).toBe(200);
    expect(c.body.item).toMatchObject({ status: 'READY', visibility: 'PUBLIC', width: 1024, height: 768 });
    const pub = await publicBytes(c.body.item.publicUrl);
    expect(pub.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(pub.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    expect(pub.includes(GPS_LAT)).toBe(false);
    for (const secret of ['GPSLatitude', 'IPTC-SECRET', 'COMMENT-SECRET', 'TRAILER-MPF-SECRET', 'xmpmeta']) expect(pub.includes(Buffer.from(secret)), secret).toBe(false);
    // orientation survives as a one-tag EXIF block (no GPS pointer)
    expect(pub.includes(Buffer.from([0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, 0x06]))).toBe(true);
    expect(pub.includes(Buffer.from([0x88, 0x25]))).toBe(false);
    // coding segments untouched
    expect(pub.includes(Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x03, 0x00, 0x04, 0x00]))).toBe(true);
    expect(pub.includes(Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0xff, 0xd0, 0x78]))).toBe(true);
  });

  it('private (VERIFICATION) media is not rewritten', async () => {
    const original = jpegWithGps(1);
    const id = await startUpload(host, original, 'image/jpeg', 'VERIFICATION');
    const c = await call(t, host, 'POST', `/v1/media/${id}/complete`);
    expect(c.body.item).toMatchObject({ status: 'READY', visibility: 'PRIVATE', publicUrl: null });
  });

  it('PNG: eXIf / tEXt / iTXt / tIME chunks and trailing data are dropped', () => {
    const chunk = (type: string, data: Buffer) => Buffer.concat([u32(data.length), Buffer.from(type, 'latin1'), data, u32(0)]);
    const ihdr = chunk('IHDR', Buffer.concat([u32(10), u32(10), Buffer.from([8, 6, 0, 0, 0])]));
    const src = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr,
      chunk('eXIf', Buffer.concat([Buffer.from('MM'), GPS_LAT])), chunk('tEXt', Buffer.from('GPS\0secret-place', 'latin1')),
      chunk('iTXt', Buffer.from('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>', 'latin1')), chunk('tIME', Buffer.alloc(7)),
      chunk('IDAT', Buffer.from([1, 2, 3, 4])), chunk('IEND', Buffer.alloc(0)), Buffer.from('TRAILER'),
    ]);
    const out = stripMetadata(src, 'image/png');
    expect(out.includes(GPS_LAT)).toBe(false);
    for (const s of ['eXIf', 'tEXt', 'iTXt', 'tIME', 'secret-place', 'TRAILER']) expect(out.includes(Buffer.from(s)), s).toBe(false);
    expect(out.includes(ihdr)).toBe(true);
    expect(out.includes(chunk('IDAT', Buffer.from([1, 2, 3, 4])))).toBe(true);
    expect(out.subarray(-12)).toEqual(chunk('IEND', Buffer.alloc(0)));
    // a plain PNG without metadata is byte-identical
    expect(stripMetadata(png(), 'image/png')).toEqual(png());
  });

  it('WebP: EXIF / XMP chunks dropped, VP8X flags cleared, RIFF size fixed', () => {
    const chunk = (fourcc: string, data: Buffer) => {
      const h = Buffer.alloc(8);
      h.write(fourcc, 0, 'latin1');
      h.writeUInt32LE(data.length, 4);
      return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const vp8x = Buffer.alloc(10);
    vp8x[0] = 0x10 | 0x08 | 0x04; // alpha + EXIF + XMP
    const body = Buffer.concat([chunk('VP8X', vp8x), chunk('VP8L', Buffer.from([0x2f, 1, 2, 3, 4])), chunk('EXIF', Buffer.concat([Buffer.from('MM'), GPS_LAT])), chunk('XMP ', Buffer.from('<x:xmpmeta/>'))]);
    const head = Buffer.alloc(12);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(4 + body.length, 4);
    head.write('WEBP', 8, 'latin1');
    const out = stripMetadata(Buffer.concat([head, body]), 'image/webp');
    expect(out.includes(GPS_LAT)).toBe(false);
    expect(out.includes(Buffer.from('xmpmeta'))).toBe(false);
    expect(out.readUInt32LE(4)).toBe(out.length - 8);
    expect(out[20]).toBe(0x10); // VP8X flags: only alpha left
    expect(out.includes(Buffer.from('VP8L'))).toBe(true);
  });

  it('MP4: moov/udta (©xyz location) and moov/meta are neutralised in place (offsets unchanged)', () => {
    const box = (type: string | Buffer, ...children: Buffer[]) => {
      const payload = Buffer.concat(children);
      return Buffer.concat([u32(8 + payload.length), typeof type === 'string' ? Buffer.from(type, 'latin1') : type, payload]);
    };
    const xyz = box(Buffer.from([0xa9, 0x78, 0x79, 0x7a]), Buffer.from('\0\x12\x15\xc7+37.5826+126.9830/', 'latin1'));
    const src = Buffer.concat([
      box('ftyp', Buffer.from('isom\0\0\0\0isomiso2mp41', 'latin1')),
      box('moov', box('mvhd', Buffer.alloc(20)), box('udta', xyz), box('meta', Buffer.from('\0\0\0\0com.apple.quicktime.location.ISO6709 +37.58', 'latin1')), box('trak', box('tkhd', Buffer.alloc(16)), box('udta', box('loci', Buffer.from('home', 'latin1'))))),
      box('mdat', Buffer.from('VIDEO-PAYLOAD')),
    ]);
    const out = stripMetadata(src, 'video/mp4');
    expect(out.length).toBe(src.length);
    for (const s of ['+37.5826', 'ISO6709', 'loci', 'udta']) expect(out.includes(Buffer.from(s, 'latin1')), s).toBe(false);
    expect(out.includes(Buffer.from('VIDEO-PAYLOAD'))).toBe(true);
    expect(out.indexOf(Buffer.from('mdat'))).toBe(src.indexOf(Buffer.from('mdat')));
  });

  it('AVIF: Exif item payload is zeroed through iloc (image data untouched)', () => {
    const box = (type: string, ...children: Buffer[]) => {
      const payload = Buffer.concat(children);
      return Buffer.concat([u32(8 + payload.length), Buffer.from(type, 'latin1'), payload]);
    };
    const full = (type: string, version: number, ...children: Buffer[]) => box(type, Buffer.from([version, 0, 0, 0]), ...children);
    const image = Buffer.from('AV1-IMAGE-DATA');
    const exif = Buffer.concat([Buffer.from('\0\0\0\0MM', 'latin1'), GPS_LAT]);
    const build = (imgOff: number, exifOff: number) => {
      const iinf = full('iinf', 0, u16(2), full('infe', 2, u16(1), u16(0), Buffer.from('av01'), Buffer.from('\0')), full('infe', 2, u16(2), u16(0), Buffer.from('Exif'), Buffer.from('\0')));
      const iloc = full('iloc', 0, Buffer.from([0x44, 0x00]), u16(2), u16(1), u16(0), u16(1), u32(imgOff), u32(image.length), u16(2), u16(0), u16(1), u32(exifOff), u32(exif.length));
      return Buffer.concat([box('ftyp', Buffer.from('avif\0\0\0\0avifmif1', 'latin1')), full('meta', 0, full('hdlr', 0, Buffer.alloc(20)), iinf, iloc)]);
    };
    const head = build(0, 0);
    const mdatStart = head.length + 8;
    const file = Buffer.concat([build(mdatStart, mdatStart + image.length), box('mdat', image, exif)]);
    expect(file.includes(GPS_LAT)).toBe(true);
    const out = stripMetadata(file, 'image/avif');
    expect(out.length).toBe(file.length);
    expect(out.includes(GPS_LAT)).toBe(false);
    expect(out.includes(image)).toBe(true);
  });
});

describe('#13 the CDN copy is exactly the verified bytes', () => {
  it('overwriting the private object during processing does not change what is published', async () => {
    const benign = png();
    const swapped = Buffer.concat([Buffer.from('<html>prohibited payload</html>'), Buffer.alloc(benign.length - 31, 0x20)]);
    expect(swapped.length).toBe(benign.length);
    const id = await startUpload(host, benign, 'image/png');
    const key = (await t.pool.query(`SELECT storage_key FROM media_assets WHERE id = $1`, [id])).rows[0].storage_key;
    t.app.ctx.adapters.set('media.moderator', {
      async moderate(_a: unknown, bytes: Buffer) {
        await storage().writePrivate(key, swapped); // the uploader re-PUTs to the still-valid presigned URL
        return { decision: bytes.includes(Buffer.from('prohibited')) ? 'REJECTED' : 'APPROVED' };
      },
    });
    try {
      const c = await call(t, host, 'POST', `/v1/media/${id}/complete`);
      expect(c.status).toBe(200);
      const pub = await publicBytes(c.body.item.publicUrl);
      expect(pub).toEqual(benign);
      expect(pub.includes(Buffer.from('prohibited'))).toBe(false);
    } finally {
      t.app.ctx.adapters.delete('media.moderator');
    }
  });
});

describe('#21 concurrent completes read the object once', () => {
  it('only the claim winner buffers the upload; the others get 409 MEDIA_PROCESSING (or the READY replay)', async () => {
    const id = await startUpload(host, png(), 'image/png');
    const s = storage();
    const orig = s.read;
    let reads = 0;
    s.read = async (k: string) => {
      reads++;
      await new Promise((r) => setTimeout(r, 50));
      return orig.call(s, k);
    };
    try {
      const res = await Promise.all(Array.from({ length: 8 }, () => call(t, host, 'POST', `/v1/media/${id}/complete`)));
      expect(reads).toBe(1);
      expect(res.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
      for (const r of res) if (r.status !== 200) expect([r.status, r.body.code]).toEqual([409, 'MEDIA_PROCESSING']);
    } finally {
      s.read = orig;
    }
    expect((await call(t, host, 'GET', `/v1/media/${id}`)).body.item.status).toBe('READY');
  });
});

describe('#22 media can never get stuck in PROCESSING', () => {
  it('oversized PNG dimensions are rejected (not a 500 + permanent PROCESSING)', async () => {
    const id = await startUpload(host, png(0x80000000, 10), 'image/png');
    const c = await call(t, host, 'POST', `/v1/media/${id}/complete`);
    expect(c.status).toBe(422);
    expect(c.body.code).toBe('MEDIA_DIMENSIONS_INVALID');
    expect((await call(t, host, 'GET', `/v1/media/${id}`)).body.item.status).toBe('REJECTED');
  });

  it('a transient processing failure releases the claim; the retry succeeds', async () => {
    const id = await startUpload(host, png(), 'image/png');
    t.app.ctx.adapters.set('media.moderator', {
      async moderate() {
        throw new Error('moderation service unavailable');
      },
    });
    try {
      const c = await call(t, host, 'POST', `/v1/media/${id}/complete`);
      expect(c.status).toBe(503);
      expect(c.body.code).toBe('MEDIA_PROCESSING_FAILED');
    } finally {
      t.app.ctx.adapters.delete('media.moderator');
    }
    expect((await call(t, host, 'GET', `/v1/media/${id}`)).body.item.status).toBe('UPLOADING');
    const retry = await call(t, host, 'POST', `/v1/media/${id}/complete`);
    expect(retry.status).toBe(200);
    expect(retry.body.item.status).toBe('READY');
  });

  it('the sweeper releases a PROCESSING claim abandoned by a crashed worker', async () => {
    const id = await startUpload(host, png(), 'image/png');
    await t.pool.query(`UPDATE media_assets SET status = 'PROCESSING', processing_started_at = now() - interval '1 hour' WHERE id = $1`, [id]);
    expect((await call(t, host, 'POST', `/v1/media/${id}/complete`)).body.code).toBe('MEDIA_PROCESSING');
    expect(await releaseStaleProcessing(t.ctx())).toBeGreaterThanOrEqual(1);
    expect((await call(t, host, 'POST', `/v1/media/${id}/complete`)).body.item.status).toBe('READY');
  });
});
