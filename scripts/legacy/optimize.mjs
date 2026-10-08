#!/usr/bin/env node
/**
 * Media pipeline: turn the raw legacy capture (www.wontc.co.kr, owner-authorised migration) and the
 * openly-licensed Openverse photo set into web-ready, size-budgeted static files + one data file.
 *
 *   node scripts/legacy/optimize.mjs [--raw .legacy/raw] [--public apps/web/public]
 *        [--out data/media/optimized.json] [--force] [--concurrency 3] [--budget-mb 350] [--max-video-mb 95]
 *
 * Inputs (read-only):
 *   <raw>/legacy-raw/manifest.json + assets/<sha>.<ext> + pages/<slug>.html   (scripts/legacy/capture-site.mjs)
 *   <raw>/photos-raw/manifest.json + files/<sha>.<ext>                       (scripts/legacy/fetch-photos.mjs)
 * Outputs (owned by this script; stale <sha12> dirs are pruned):
 *   <public>/legacy/<sha12>/original.<ext>, <w>.webp, poster.{jpg,webp}
 *   <public>/photos/<sha12>/<w>.webp
 *   <out> — { params, legacy, embeds, photos, nonMedia, excluded, failures, totals }
 *
 * Rules
 * - Every legacy asset is sniffed by magic bytes. text/html bodies (captured error/soft-404 pages), unknown
 *   bytes and anything that fails a full decode go to `nonMedia` with their source URLs — never published.
 * - Raster images: original kept, webp ladder [480, 960, 1600, 2400] capped at the source width (never
 *   upscaled); when the source is narrower than 480, or > 20% wider than the largest ladder step, a variant
 *   at the native width is added too. `variants` keys are the real pixel width of each file.
 *   EXIF orientation is applied, all metadata stripped (sharp default), quality 78 / effort 5.
 *   Placeholder: 24px-wide webp data URI. `color` = sharp stats().dominant, `colorAvg` = mean colour.
 * - Animated GIF/WebP, SVG and ICO originals are published as-is (no webp ladder).
 * - MP4: copied (stream-copy remux with +faststart) when < max-video-mb and browser-playable, otherwise
 *   transcoded to H.264 ≤720p CRF 26 +faststart. Poster = frame at 1s (jpg + webp), duration via ffprobe.
 * - Photos: licenses forbidding derivatives (any "-nd") are excluded; the rest get the same webp ladder +
 *   placeholder (no originals published) and keep full attribution.
 * - Budget: if public/legacy + public/photos exceed --budget-mb, the photo 2400 variants are dropped first,
 *   then native-width photo variants above 1600.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const flag = (n) => args.includes(`--${n}`);

const RAW = path.resolve(ROOT, opt('raw', process.env.MEDIA_RAW_DIR || '.legacy/raw'));
const PUB = path.resolve(ROOT, opt('public', process.env.MEDIA_PUBLIC_DIR || 'apps/web/public'));
const OUT = path.resolve(ROOT, opt('out', process.env.MEDIA_OUT || 'data/media/optimized.json'));
const CONCURRENCY = Math.max(1, Number(opt('concurrency', Math.max(1, Math.min(4, os.cpus().length - 1)))));
const BUDGET_BYTES = Number(opt('budget-mb', 350)) * 1024 * 1024;
const MAX_VIDEO_BYTES = Number(opt('max-video-mb', 95)) * 1024 * 1024;
let FORCE = flag('force');

const LADDER = [480, 960, 1600, 2400];
const NATIVE_EXTRA_RATIO = 1.2;
const WEBP = { quality: 78, effort: 5 };
const PLACEHOLDER = { width: 24, maxHeight: 96, quality: 40 };
const WEBP_MAX_DIM = 16383;
const PIPELINE_VERSION = 1; // bump to force a full re-encode
const PARAMS = { version: PIPELINE_VERSION, ladder: LADDER, nativeExtraRatio: NATIVE_EXTRA_RATIO, webp: WEBP, placeholder: PLACEHOLDER };
const PARAMS_SIG = createHash('sha256').update(JSON.stringify(PARAMS)).digest('hex').slice(0, 16);

const LEGACY_DIR = path.join(PUB, 'legacy');
const PHOTOS_DIR = path.join(PUB, 'photos');
const RAW_LEGACY = path.join(RAW, 'legacy-raw');
const RAW_PHOTOS = path.join(RAW, 'photos-raw');

async function loadSharp() {
  try {
    return (await import('sharp')).default;
  } catch {
    return createRequire(path.join(ROOT, 'packages/legacy-import/package.json'))('sharp');
  }
}
const sharp = await loadSharp();
sharp.cache(false);
sharp.concurrency(1); // parallelism comes from the worker pool below

// ---------------------------------------------------------------------------------------------- helpers
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const EXT = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', svg: 'svg', ico: 'ico', avif: 'avif', mp4: 'mp4', mov: 'mov' };
const RASTER = new Set(['jpeg', 'png', 'gif', 'webp', 'avif']);
const DECLARED = { 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

/** Identify a body by its magic bytes (never by the declared Content-Type). */
function sniff(buf) {
  if (!buf || buf.length < 4) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG)) return 'png';
  if (buf.length >= 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  if (buf.length >= 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    const brand = buf.toString('latin1', 8, 12);
    if (/^avi[fs]$/.test(brand)) return 'avif';
    if (/^(heic|heix|mif1|msf1)$/.test(brand)) return 'heic';
    return brand === 'qt  ' ? 'mov' : 'mp4';
  }
  if (buf.length >= 22 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1 && buf.readUInt16LE(4) > 0 && buf.readUInt16LE(4) < 256) return 'ico';
  const head = buf.subarray(0, 4096).toString('utf8').replace(/^﻿/, '').trimStart().toLowerCase();
  if (/^(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/.test(head)) return 'svg';
  if (/^(<!doctype html|<html|<head|<body|<meta|<script|<title|<!--)/.test(head) || /<html[\s>]/.test(head)) return 'html';
  return null;
}

const sha12 = (sha) => sha.slice(0, 12);
const hex = ({ r, g, b }) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const webPath = (abs) => '/' + path.relative(PUB, abs).split(path.sep).join('/');
const round4 = (n) => Math.round(n * 1e4) / 1e4;
const fileSize = async (p) => (await fs.stat(p).catch(() => null))?.size ?? 0;
const hasFile = async (p) => (await fileSize(p)) > 0;

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  let done = 0;
  const tick = items.length > 40 ? Math.ceil(items.length / 10) : 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k], k);
        if (tick && ++done % tick === 0) console.log(`  … ${done}/${items.length}`);
      }
    }),
  );
  return out;
}

/** Ladder widths for a source of width W (never upscaled). */
function ladderFor(W, H) {
  const ws = LADDER.filter((w) => w <= W);
  if (!ws.length) ws.push(W);
  else if (W < LADDER[LADDER.length - 1] && W > ws[ws.length - 1] * NATIVE_EXTRA_RATIO) ws.push(W);
  // webp cannot encode a side > 16383 px
  return ws.filter((w) => w <= WEBP_MAX_DIM && Math.round((H * w) / W) <= WEBP_MAX_DIM);
}

function pickSrc(variants) {
  const ws = Object.keys(variants).map(Number).sort((a, b) => a - b);
  if (!ws.length) return null;
  const le = ws.filter((w) => w <= 960);
  return variants[String(le.length ? le[le.length - 1] : ws[0])];
}
const srcsetOf = (variants) =>
  Object.keys(variants)
    .map(Number)
    .sort((a, b) => a - b)
    .map((w) => `${variants[w]} ${w}w`)
    .join(', ') || null;

/** Oriented dimensions (EXIF orientation 5–8 swaps the axes). */
function orientedSize(meta) {
  // multi-page (animated) sources: height/autoOrient describe the whole frame strip, use one page
  if ((meta.pages ?? 1) > 1 && meta.pageHeight) return { width: meta.width, height: meta.pageHeight };
  if (meta.autoOrient?.width) return { width: meta.autoOrient.width, height: meta.autoOrient.height };
  return (meta.orientation ?? 1) >= 5 ? { width: meta.height, height: meta.width } : { width: meta.width, height: meta.height };
}

/**
 * Colours. `color` = dominant colour (sharp stats().dominant, the most populated 16-level RGB bin);
 * `colorAvg` = mean colour, usually the better flat placeholder fill for photos (dominant is often a blown
 * sky or a night-black bin). For images with alpha both only count pixels with alpha >= 50% (otherwise the
 * transparent pixels win and every logo reads as black).
 */
async function colorsOf(img, stats, hasAlpha) {
  if (!hasAlpha) {
    const ch = stats.channels.map((c) => c.mean);
    const [r, g, b] = ch.length >= 3 ? ch : [ch[0], ch[0], ch[0]];
    return { color: hex(stats.dominant), colorAvg: hex({ r, g, b }) };
  }
  const { data } = await img
    .clone()
    .resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha()
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  const bins = new Map();
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
    bins.set(k, (bins.get(k) ?? 0) + 1);
    sum[0] += data[i];
    sum[1] += data[i + 1];
    sum[2] += data[i + 2];
    n++;
  }
  if (!n) return { color: null, colorAvg: null }; // fully transparent
  const [k] = [...bins.entries()].reduce((m, e) => (e[1] > m[1] ? e : m));
  return {
    color: hex({ r: ((k >> 8) & 15) * 16 + 8, g: ((k >> 4) & 15) * 16 + 8, b: (k & 15) * 16 + 8 }),
    colorAvg: hex({ r: sum[0] / n, g: sum[1] / n, b: sum[2] / n }),
  };
}

async function placeholderOf(img, W) {
  const buf = await img
    .clone()
    .resize({ width: Math.min(PLACEHOLDER.width, W), height: PLACEHOLDER.maxHeight, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: PLACEHOLDER.quality, effort: 4 })
    .toBuffer();
  return `data:image/webp;base64,${buf.toString('base64')}`;
}

/**
 * Decode a raster fully (fails on truncation), write the webp ladder into outDir and return its description.
 * `animated` sources are not re-encoded (variants = {}), only measured from their first frame.
 */
async function processRaster(buf, outDir, { format, writeVariants = true, dropWidths = [] }) {
  const meta = await sharp(buf, { animated: true }).metadata();
  const animated = (meta.pages ?? 1) > 1;
  const { width: W, height: H } = orientedSize(meta);
  if (!W || !H) throw new Error('no dimensions');
  const img = sharp(buf, { failOn: 'truncated', limitInputPixels: 0x3fff * 0x3fff * 2 }).rotate();
  const stats = await img.clone().stats(); // full decode of the first frame → catches truncated/corrupt bodies
  const variants = {};
  const variantBytes = {};
  if (!animated && writeVariants) {
    for (const w of ladderFor(W, H)) {
      if (dropWidths.includes(w)) continue;
      const file = path.join(outDir, `${w}.webp`);
      if (FORCE || !(await hasFile(file))) {
        await img
          .clone()
          .resize({ width: w, withoutEnlargement: true })
          .webp({ ...WEBP, smartSubsample: format === 'png' || format === 'gif' })
          .toFile(file);
      }
      variants[w] = webPath(file);
      variantBytes[w] = await fileSize(file);
    }
  }
  return {
    width: W,
    height: H,
    aspect: round4(W / H),
    ...(await colorsOf(img, stats, !!meta.hasAlpha)),
    hasAlpha: !!meta.hasAlpha,
    animated,
    frames: animated ? meta.pages : undefined,
    placeholder: await placeholderOf(img, W),
    variants,
    variantBytes,
  };
}

/** Parse an ICO directory; throws when the file is truncated. */
function parseIco(buf) {
  const count = buf.readUInt16LE(4);
  if (6 + 16 * count > buf.length) throw new Error('truncated ico directory');
  const entries = [];
  for (let i = 0; i < count; i++) {
    const o = 6 + 16 * i;
    const size = buf.readUInt32LE(o + 8);
    const offset = buf.readUInt32LE(o + 12);
    if (!size || offset + size > buf.length) throw new Error(`truncated ico image #${i}`);
    const png = buf.subarray(offset, offset + 8).equals(PNG_SIG);
    if (!png && buf.readUInt32LE(offset) !== 40) throw new Error(`ico image #${i} is neither PNG nor BMP`);
    entries.push({ width: buf[o] || 256, height: buf[o + 1] || 256, bpp: buf.readUInt16LE(o + 6), bytes: size, png, offset });
  }
  return entries;
}

const SVG_UNSAFE = /<script|\son[a-z]+\s*=|javascript:|<foreignObject|<iframe|<embed|<object/i;

async function ffprobe(file) {
  const { stdout } = await execFileP('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { maxBuffer: 16 << 20 });
  return JSON.parse(stdout);
}

async function processVideo(srcFile, srcBytes, outDir) {
  const probe = await ffprobe(srcFile);
  const v = probe.streams?.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('no video stream');
  const duration = Number(probe.format?.duration ?? v.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('no duration');
  const hasAudio = !!probe.streams.find((s) => s.codec_type === 'audio');
  const playable = ['h264', 'vp9', 'av1'].includes(v.codec_name) && (!hasAudio || probe.streams.some((s) => s.codec_type === 'audio' && ['aac', 'mp3', 'opus'].includes(s.codec_name)));
  const original = path.join(outDir, 'original.mp4');
  let transcoded = false;
  let crf = null;
  if (FORCE || !(await hasFile(original))) {
    if (srcBytes < MAX_VIDEO_BYTES && playable) {
      try {
        await execFileP('ffmpeg', ['-y', '-v', 'error', '-i', srcFile, '-map', '0', '-c', 'copy', '-movflags', '+faststart', original]);
      } catch {
        await fs.copyFile(srcFile, original);
      }
    } else {
      transcoded = true;
      for (crf = 26; crf <= 36; crf += 2) {
        await execFileP('ffmpeg', [
          '-y', '-v', 'error', '-i', srcFile,
          '-vf', "scale=-2:'min(720,ih)'", '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-pix_fmt', 'yuv420p',
          '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', original,
        ], { maxBuffer: 16 << 20 });
        if ((await fileSize(original)) < MAX_VIDEO_BYTES) break;
      }
    }
  } else {
    transcoded = srcBytes >= MAX_VIDEO_BYTES || !playable;
  }
  const outProbe = await ffprobe(original);
  const ov = outProbe.streams.find((s) => s.codec_type === 'video');
  const rot = Math.abs(Number(ov.side_data_list?.find((d) => d.rotation != null)?.rotation ?? ov.tags?.rotate ?? 0)) % 180 === 90;
  const posterJpg = path.join(outDir, 'poster.jpg');
  const posterWebp = path.join(outDir, 'poster.webp');
  const at = duration > 1.2 ? 1 : duration / 2;
  if (FORCE || !(await hasFile(posterJpg))) {
    await execFileP('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', original, '-frames:v', '1', '-q:v', '3', posterJpg]);
  }
  const pbuf = await fs.readFile(posterJpg);
  const pimg = sharp(pbuf, { failOn: 'truncated' });
  if (FORCE || !(await hasFile(posterWebp))) await pimg.clone().webp(WEBP).toFile(posterWebp);
  const pm = await pimg.metadata();
  const stats = await pimg.clone().stats();
  return {
    width: rot ? ov.height : ov.width,
    height: rot ? ov.width : ov.height,
    duration: Math.round(duration * 1000) / 1000,
    codec: ov.codec_name,
    hasAudio,
    transcoded,
    crf: transcoded ? crf : undefined,
    ...(await colorsOf(pimg, stats, false)),
    placeholder: await placeholderOf(pimg, pm.width),
    poster: { jpg: webPath(posterJpg), webp: webPath(posterWebp), width: pm.width, height: pm.height, at },
    outputBytes: (await fileSize(original)) + (await fileSize(posterJpg)) + (await fileSize(posterWebp)),
  };
}

/** Normalised site path for a captured page URL (http/https/www variants collapse to one). */
const pagePath = (u) => {
  try {
    const x = new URL(u);
    return (x.pathname.replace(/\/+$/, '') || '/') + x.search;
  } catch {
    return u;
  }
};
const uniq = (xs) => [...new Set(xs)];

async function dirBytes(dir) {
  let total = 0;
  let files = 0;
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const r = await dirBytes(p);
      total += r.bytes;
      files += r.files;
    } else {
      total += (await fs.stat(p)).size;
      files++;
    }
  }
  return { bytes: total, files };
}

async function prune(dir, keep) {
  const removed = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (!keep.has(e.name)) {
      await fs.rm(path.join(dir, e.name), { recursive: true, force: true });
      removed.push(e.name);
    }
  }
  return removed;
}

async function pruneFiles(dir, keepNames) {
  for (const f of await fs.readdir(dir).catch(() => [])) if (!keepNames.has(f)) await fs.rm(path.join(dir, f), { force: true });
}

function assertUniquePrefixes(shas, label) {
  const seen = new Map();
  for (const s of shas) {
    const p = sha12(s);
    if (seen.has(p) && seen.get(p) !== s) throw new Error(`${label}: sha12 collision ${p}`);
    seen.set(p, s);
  }
}

// ---------------------------------------------------------------------------------------------- main
const t0 = Date.now();
const legacyManifest = JSON.parse(await fs.readFile(path.join(RAW_LEGACY, 'manifest.json'), 'utf8'));
const photoManifest = JSON.parse(await fs.readFile(path.join(RAW_PHOTOS, 'manifest.json'), 'utf8'));
const prev = JSON.parse(await fs.readFile(OUT, 'utf8').catch(() => 'null'));
if (prev?.params?.sig && prev.params.sig !== PARAMS_SIG) {
  console.log(`params changed (${prev.params.sig} → ${PARAMS_SIG}): re-encoding everything`);
  FORCE = true;
}
await fs.mkdir(LEGACY_DIR, { recursive: true });
await fs.mkdir(PHOTOS_DIR, { recursive: true });
await fs.mkdir(path.dirname(OUT), { recursive: true });

const assets = Object.values(legacyManifest.assets).sort((a, b) => a.sha256.localeCompare(b.sha256));
assertUniquePrefixes(assets.map((a) => a.sha256), 'legacy');
const photosIn = Object.values(photoManifest.photos).sort((a, b) => a.sha256.localeCompare(b.sha256));
assertUniquePrefixes(photosIn.map((p) => p.sha256), 'photos');

// ---- legacy assets
console.log(`legacy: ${assets.length} captured assets → ${path.relative(ROOT, LEGACY_DIR)} (concurrency ${CONCURRENCY})`);
const legacy = {};
const nonMedia = [];
const integrity = [];

await pool(assets, CONCURRENCY, async (a) => {
  const srcFile = path.join(RAW_LEGACY, a.file);
  const common = { sourceUrls: a.sourceUrls, pageUrls: a.pageUrls, pages: uniq(a.pageUrls.map(pagePath)).sort(), alts: uniq(a.alts.filter(Boolean)), roles: a.roles };
  // category: html | unrecognised | undecodable | unsafe | unsupported | missing
  const reject = (category, reason, extra = {}) => {
    nonMedia.push({ sha: a.sha256, file: a.file, contentType: a.contentType, bytes: a.bytes, category, reason, ...extra, ...common });
  };
  let buf;
  try {
    buf = await fs.readFile(srcFile);
  } catch (e) {
    return reject('missing', `missing raw file (${e.code})`);
  }
  const actualSha = createHash('sha256').update(buf).digest('hex');
  if (actualSha !== a.sha256) integrity.push({ sha: a.sha256, actualSha, file: a.file });
  const detected = sniff(buf);
  const declared = DECLARED[a.contentType] ?? null;

  // magic bytes decide; a declared text/html body is only accepted if it really is media
  if (detected === 'html' || (!detected && /^text\/html/i.test(a.contentType))) {
    const title = buf.toString('utf8').match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || null;
    const selfRef = a.sourceUrls.every((u) => a.pageUrls.some((p) => pagePath(p) === pagePath(u)) || legacyManifest.pages.some((p) => p.url === u));
    const reason = selfRef
      ? `captured error response: HTML document, not media — an <img>${common.alts.length ? ` (alt "${common.alts.join('", "')}")` : ''} with an empty src resolved to the page URL, so the capture stored the page itself`
      : 'captured error response: body is an HTML page, not media';
    return reject('html', reason, { detected: 'html', htmlTitle: title });
  }
  if (!detected && /^video\//i.test(a.contentType)) {
    const probeErr = await ffprobe(srcFile).then(
      () => null,
      (e) => (e.stderr?.toString().trim().split('\n').pop() || e.message).replaceAll(srcFile, a.file),
    );
    return reject(
      'undecodable',
      `undecodable video: no MP4 container header (ftyp/moov) — the capture stored a ${buf.length}-byte mid-file HTTP range chunk, not the file; re-capture the source URL with a full GET`,
      { detected: null, declared: declared, magic: buf.subarray(0, 8).toString('hex'), ffprobe: probeErr },
    );
  }
  if (!detected) return reject('unrecognised', 'unrecognised bytes (no image/video magic number)', { detected: null, magic: buf.subarray(0, 8).toString('hex') });

  const dir = path.join(LEGACY_DIR, sha12(a.sha256));
  await fs.mkdir(dir, { recursive: true });
  const original = path.join(dir, `original.${EXT[detected] ?? 'bin'}`);
  const base = {
    kind: null,
    format: detected,
    declaredType: a.contentType,
    typeMismatch: declared && declared !== detected ? true : undefined,
    original: webPath(original),
    bytes: buf.length,
  };
  try {
    let entry;
    if (RASTER.has(detected)) {
      const r = await processRaster(buf, dir, { format: detected });
      entry = { ...base, kind: r.animated ? 'animated' : 'image', ...r };
    } else if (detected === 'svg') {
      const text = buf.toString('utf8');
      if (SVG_UNSAFE.test(text)) {
        await fs.rm(dir, { recursive: true, force: true });
        return reject('unsafe', 'svg contains script/event handlers — not published', { detected });
      }
      const meta = await sharp(buf).metadata();
      const colors = await colorsOf(sharp(buf), await sharp(buf).stats(), true);
      entry = { ...base, kind: 'svg', width: meta.width, height: meta.height, aspect: round4(meta.width / meta.height), ...colors, hasAlpha: true, placeholder: null, variants: {} };
    } else if (detected === 'ico') {
      const icons = parseIco(buf);
      const big = icons.reduce((m, x) => (x.width * x.height > m.width * m.height ? x : m));
      let colors = { color: null, colorAvg: null };
      const pngEntry = icons.filter((x) => x.png).sort((x, y) => y.width - x.width)[0];
      if (pngEntry) {
        const png = sharp(buf.subarray(pngEntry.offset, pngEntry.offset + pngEntry.bytes));
        colors = await colorsOf(png, await png.clone().stats(), true);
      }
      entry = { ...base, kind: 'icon', width: big.width, height: big.height, aspect: round4(big.width / big.height), ...colors, placeholder: null, variants: {}, sizes: icons.map((x) => `${x.width}x${x.height}`) };
    } else if (detected === 'mp4' || detected === 'mov') {
      const r = await processVideo(srcFile, buf.length, dir);
      entry = { ...base, kind: 'video', original: webPath(path.join(dir, 'original.mp4')), aspect: round4(r.width / r.height), variants: {}, ...r };
    } else {
      await fs.rm(dir, { recursive: true, force: true });
      return reject('unsupported', `unsupported media format ${detected}`, { detected });
    }
    if (entry.kind !== 'video' && (FORCE || !(await hasFile(original)))) await fs.writeFile(original, buf);
    const keep = new Set([entry.original, ...Object.values(entry.variants), entry.poster?.jpg, entry.poster?.webp].filter(Boolean).map((p) => path.basename(p)));
    await pruneFiles(dir, keep);
    const { variantBytes, outputBytes, ...rest } = entry;
    legacy[a.sha256] = {
      ...rest,
      src: pickSrc(entry.variants) ?? entry.poster?.webp ?? entry.original,
      srcset: srcsetOf(entry.variants),
      outputBytes: outputBytes ?? (await fileSize(original)) + Object.values(variantBytes ?? {}).reduce((s, n) => s + n, 0),
      ...common,
    };
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    const reason = detected === 'mp4' || detected === 'mov'
      ? `undecodable video (${(e.stderr?.toString().trim().split('\n').pop() || e.message).replaceAll(srcFile, a.file)}) — body is not a playable file (likely a partial/range response); re-capture the source URL`
      : `undecodable ${detected}: ${e.message}`;
    return reject('undecodable', reason, { detected });
  }
});

// ---- YouTube embeds (unique ids, thumbnail from the captured i.ytimg.com assets)
const pageHtml = new Map();
async function htmlForPage(pageUrl) {
  const pg = legacyManifest.pages.find((p) => p.url === pageUrl) ?? legacyManifest.pages.find((p) => pagePath(p.url) === pagePath(pageUrl));
  if (!pg) return null;
  if (!pageHtml.has(pg.slug)) pageHtml.set(pg.slug, await fs.readFile(path.join(RAW_LEGACY, 'pages', `${pg.slug}.html`), 'utf8').catch(() => null));
  return pageHtml.get(pg.slug);
}
const stripHtml = (s) =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

function embedContext(html, id) {
  const re = /<iframe\b[^>]*>/gi;
  const frames = [...html.matchAll(re)].filter((m) => m[0].includes('youtube'));
  const k = frames.findIndex((m) => m[0].includes(`/embed/${id}`));
  if (k < 0) return {};
  const tag = frames[k][0];
  const title = tag.match(/\btitle="([^"]*)"/i)?.[1] ?? null;
  // sixshop renders "<heading> <date> <description>" right before each video block
  const from = k > 0 ? frames[k - 1].index + frames[k - 1][0].length : Math.max(0, frames[k].index - 6000);
  let seg = html.slice(from, frames[k].index);
  if (k === 0) seg = seg.slice(seg.indexOf('>') + 1);
  const text = stripHtml(seg);
  const dm = [...text.matchAll(/(\d{4})년\s*(\d{1,2})월(?:\s*(\d{1,2})일)?/g)].at(k === 0 ? -1 : 0);
  let heading = null;
  let date = null;
  let description = null;
  if (dm) {
    const before = text.slice(0, dm.index).trim();
    heading = before.split(/(?<=[.!?。]|다\.)\s+/).pop()?.trim() || null;
    date = `${dm[1]}-${dm[2].padStart(2, '0')}${dm[3] ? '-' + dm[3].padStart(2, '0') : ''}`;
    description = text.slice(dm.index + dm[0].length).trim() || null;
  }
  return { title: title ? stripHtml(title) : null, heading, date, dateText: dm?.[0] ?? null, description };
}

const embedsById = new Map();
for (const e of legacyManifest.embeds ?? []) {
  const cur = embedsById.get(e.id) ?? { provider: e.provider, id: e.id, src: e.src, pageUrls: [] };
  if (!cur.pageUrls.includes(e.pageUrl)) cur.pageUrls.push(e.pageUrl);
  embedsById.set(e.id, cur);
}
const embeds = [];
for (const e of embedsById.values()) {
  let ctx = {};
  for (const u of e.pageUrls) {
    const html = await htmlForPage(u);
    if (html) ctx = embedContext(html, e.id);
    if (ctx.title) break;
  }
  const thumbs = assets
    .filter((a) => a.sourceUrls.some((u) => u.includes(`i.ytimg.com/vi/${e.id}/`) || u.includes(`i.ytimg.com/vi_webp/${e.id}/`)))
    .map((a) => {
      const u = a.sourceUrls.find((x) => x.includes(`/${e.id}/`));
      const name = new URL(u).pathname.split('/').pop();
      const L = legacy[a.sha256];
      return { sha: a.sha256, name, plain: !new URL(u).search, sourceUrl: u, published: !!L, width: L?.width, height: L?.height, src: L?.src, original: L?.original, variants: L?.variants, placeholder: L?.placeholder, color: L?.color };
    })
    .filter((t) => t.published);
  const rank = (t) => (t.name.startsWith('hqdefault') ? 0 : t.name.startsWith('sddefault') ? 1 : 2) * 2 + (t.plain ? 0 : 1);
  thumbs.sort((x, y) => rank(x) - rank(y));
  const failed = (legacyManifest.failures ?? []).filter((f) => f.url.includes(`/vi/${e.id}/`)).map((f) => ({ url: f.url, reason: f.reason }));
  embeds.push({
    provider: e.provider,
    id: e.id,
    title: ctx.title ?? ctx.heading ?? null,
    heading: ctx.heading ?? null,
    date: ctx.date ?? null,
    dateText: ctx.dateText ?? null,
    description: ctx.description ?? null,
    embedUrl: `https://www.youtube-nocookie.com/embed/${e.id}`,
    watchUrl: `https://www.youtube.com/watch?v=${e.id}`,
    capturedSrc: e.src,
    pageUrls: e.pageUrls,
    pages: uniq(e.pageUrls.map(pagePath)),
    thumbnail: thumbs[0] ? (({ name, plain, published, ...t }) => ({ ...t, name }))(thumbs[0]) : null,
    alternates: thumbs.slice(1).map((t) => ({ sha: t.sha, name: t.name, sourceUrl: t.sourceUrl, width: t.width, height: t.height, src: t.src })),
    failedThumbnails: failed,
  });
}
embeds.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.id.localeCompare(b.id));

// ---- licensed photos
const isNoDerivs = (lic) => /(^|-)nd($|-)/i.test(lic ?? '');
const LICENSE_NAMES = { by: 'CC BY', 'by-sa': 'CC BY-SA', 'by-nc': 'CC BY-NC', 'by-nc-sa': 'CC BY-NC-SA', 'by-nd': 'CC BY-ND', 'by-nc-nd': 'CC BY-NC-ND', cc0: 'CC0', pdm: 'Public Domain Mark' };
const licenseLabel = (p) => `${LICENSE_NAMES[p.license] ?? p.license?.toUpperCase()} ${p.licenseVersion ?? ''}`.trim();
const attributionOf = (p) => ({
  title: p.title ?? null,
  creator: p.creator ?? null,
  creatorUrl: p.creatorUrl ?? null,
  license: p.license,
  licenseVersion: p.licenseVersion ?? null,
  licenseLabel: licenseLabel(p),
  licenseUrl: p.licenseUrl ?? null,
  landingUrl: p.landingUrl ?? null,
  provider: p.provider ?? null,
  source: p.source ?? null,
  openverseId: p.openverseId ?? null,
  attribution: p.attribution ?? null,
  groups: p.groups ?? [],
  queries: p.queries ?? [],
});

const excluded = [];
const photos = {};
const photoFailures = [];
const toProcess = [];
for (const p of photosIn) {
  if (isNoDerivs(p.license)) excluded.push({ sha: p.sha256, reason: `license ${licenseLabel(p)} forbids derivatives (resizing/re-encoding)`, ...attributionOf(p) });
  else toProcess.push(p);
}
let dropPhotoWidths = [];
console.log(`photos: ${photosIn.length} in manifest, ${excluded.length} excluded (no-derivatives), ${toProcess.length} to process`);

async function processPhoto(p) {
  const dir = path.join(PHOTOS_DIR, sha12(p.sha256));
  try {
    const buf = await fs.readFile(path.join(RAW_PHOTOS, p.file));
    const detected = sniff(buf);
    if (!detected || !RASTER.has(detected)) throw new Error(`not a raster image (detected ${detected})`);
    await fs.mkdir(dir, { recursive: true });
    const r = await processRaster(buf, dir, { format: detected, dropWidths: dropPhotoWidths });
    if (r.animated) throw new Error('animated photo');
    await pruneFiles(dir, new Set(Object.keys(r.variants).map((w) => `${w}.webp`)));
    photos[p.sha256] = {
      kind: 'photo',
      format: detected,
      variants: r.variants,
      src: pickSrc(r.variants),
      srcset: srcsetOf(r.variants),
      width: r.width,
      height: r.height,
      aspect: r.aspect,
      placeholder: r.placeholder,
      color: r.color,
      colorAvg: r.colorAvg,
      bytes: buf.length,
      outputBytes: Object.values(r.variantBytes).reduce((s, n) => s + n, 0),
      ...attributionOf(p),
    };
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true });
    photoFailures.push({ sha: p.sha256, file: p.file, reason: e.message, landingUrl: p.landingUrl });
  }
}
await pool(toProcess, CONCURRENCY, processPhoto);

// ---- prune stale output dirs (from earlier runs / removed inputs)
const prunedLegacy = await prune(LEGACY_DIR, new Set(Object.keys(legacy).map(sha12)));
const prunedPhotos = await prune(PHOTOS_DIR, new Set(Object.keys(photos).map(sha12)));

// ---- size budget
let sizeLegacy = await dirBytes(LEGACY_DIR);
let sizePhotos = await dirBytes(PHOTOS_DIR);
const budgetSteps = [];
const dropPlan = [[2400], [2400, ...new Set(Object.values(photos).flatMap((x) => Object.keys(x.variants).map(Number)).filter((w) => w > 1600 && w < 2400))]];
for (const drop of dropPlan) {
  if (sizeLegacy.bytes + sizePhotos.bytes <= BUDGET_BYTES) break;
  if (drop.every((w) => dropPhotoWidths.includes(w))) continue;
  dropPhotoWidths = [...new Set([...dropPhotoWidths, ...drop])];
  for (const ph of Object.values(photos)) {
    for (const w of Object.keys(ph.variants).map(Number)) {
      if (!dropPhotoWidths.includes(w) || Object.keys(ph.variants).length <= 1) continue;
      await fs.rm(path.join(PUB, ph.variants[w]), { force: true });
      delete ph.variants[w];
    }
    ph.src = pickSrc(ph.variants);
    ph.srcset = srcsetOf(ph.variants);
  }
  sizePhotos = await dirBytes(PHOTOS_DIR);
  budgetSteps.push({ dropped: drop, totalBytesAfter: sizeLegacy.bytes + sizePhotos.bytes });
}
for (const ph of Object.values(photos)) {
  let b = 0;
  for (const v of Object.values(ph.variants)) b += await fileSize(path.join(PUB, v));
  ph.outputBytes = b;
}

// ---- totals + write
const sortObj = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const countBy = (xs, f) => xs.reduce((m, x) => ((m[f(x)] = (m[f(x)] ?? 0) + 1), m), {});
const legacyVals = Object.values(legacy);
const photoVals = Object.values(photos);
// "media" = declared or sniffed as image/video (i.e. everything except HTML bodies and unrecognised bytes)
const mediaByMagic = assets.length - nonMedia.filter((n) => n.category === 'html' || n.category === 'unrecognised').length;
const undecodable = nonMedia.filter((n) => !['html', 'unrecognised'].includes(n.category)).length;
const totals = {
  legacy: {
    captured: assets.length,
    mediaByMagic,
    published: legacyVals.length,
    undecodable,
    allMediaAccountedFor: legacyVals.length + undecodable === mediaByMagic && legacyVals.length + nonMedia.length === assets.length,
    nonMedia: nonMedia.length,
    nonMediaByCategory: countBy(nonMedia, (n) => n.category),
    byKind: countBy(legacyVals, (x) => x.kind),
    byFormat: countBy(legacyVals, (x) => x.format),
    variants: legacyVals.reduce((s, x) => s + Object.keys(x.variants).length, 0),
    videos: legacyVals.filter((x) => x.kind === 'video').length,
    inputBytes: legacyVals.reduce((s, x) => s + x.bytes, 0),
    outputBytes: sizeLegacy.bytes,
    files: sizeLegacy.files,
    integrityMismatches: integrity.length,
    pruned: prunedLegacy.length,
  },
  embeds: { unique: embeds.length, withThumbnail: embeds.filter((e) => e.thumbnail).length },
  photos: {
    inManifest: photosIn.length,
    published: photoVals.length,
    excluded: excluded.length,
    failed: photoFailures.length,
    byLicense: countBy(photoVals, (x) => x.licenseLabel),
    byGroup: photoVals.reduce((m, x) => (x.groups.forEach((g) => (m[g] = (m[g] ?? 0) + 1)), m), {}),
    variants: photoVals.reduce((s, x) => s + Object.keys(x.variants).length, 0),
    variantsByWidth: countBy(photoVals.flatMap((x) => Object.keys(x.variants).map((w) => (LADDER.includes(+w) ? w : 'native'))), (w) => w),
    inputBytes: photoVals.reduce((s, x) => s + x.bytes, 0),
    outputBytes: sizePhotos.bytes,
    files: sizePhotos.files,
    pruned: prunedPhotos.length,
  },
  bytes: sizeLegacy.bytes + sizePhotos.bytes,
  mb: Math.round(((sizeLegacy.bytes + sizePhotos.bytes) / 1048576) * 10) / 10,
  budget: { budgetBytes: BUDGET_BYTES, withinBudget: sizeLegacy.bytes + sizePhotos.bytes <= BUDGET_BYTES, droppedPhotoWidths: dropPhotoWidths, steps: budgetSteps },
  seconds: Math.round((Date.now() - t0) / 100) / 10,
};

const out = {
  generatedAt: new Date().toISOString(),
  params: { ...PARAMS, sig: PARAMS_SIG, publicDir: path.relative(ROOT, PUB), note: 'paths are web paths relative to the public dir; variants keys are real pixel widths' },
  sources: { legacy: { source: legacyManifest.source, generatedAt: legacyManifest.generatedAt }, photos: { source: photoManifest.source, generatedAt: photoManifest.generatedAt } },
  legacy: sortObj(legacy),
  embeds,
  photos: sortObj(photos),
  nonMedia: nonMedia.sort((a, b) => a.sha.localeCompare(b.sha)),
  excluded: excluded.sort((a, b) => a.sha.localeCompare(b.sha)),
  failures: { photos: photoFailures, integrity, capture: legacyManifest.failures ?? [] },
  totals,
};
await fs.writeFile(OUT, JSON.stringify(out, null, 1) + '\n');

console.log(JSON.stringify(totals, null, 2));
console.log(`wrote ${path.relative(ROOT, OUT)}`);
if (nonMedia.length) {
  console.log(`nonMedia (${nonMedia.length}):`);
  for (const n of nonMedia) console.log(`  ${sha12(n.sha)} ${n.contentType} ${n.reason.slice(0, 60)} ← ${n.sourceUrls[0]}${n.sourceUrls.length > 1 ? ` (+${n.sourceUrls.length - 1})` : ''}`);
}
if (photoFailures.length) console.log('photo failures:', photoFailures);
if (!totals.budget.withinBudget) {
  console.error(`OVER BUDGET: ${totals.mb} MB > ${BUDGET_BYTES / 1048576} MB`);
  process.exitCode = 2;
}
