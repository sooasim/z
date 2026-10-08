import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import sharp from 'sharp';
import { outPaths } from './config.mjs';
import { extractPosterFrame } from './probe.mjs';
import { svgIsSafe } from './sniff.mjs';
import { ensureDir, fileSize, mapPool, readJson, safeBaseName, sha12, writeJson } from './util.mjs';

sharp.cache(false);

/**
 * Step 4 — image renditions with sharp: webp at the configured widths (480/960/1600/2400) below the original width
 * plus one at the native width when it is smaller than the largest breakpoint (never upscaled), a ~16 px blurred
 * webp placeholder (base64 data URI) and the dominant colour. Originals are kept untouched. Videos are not
 * transcoded; when ffmpeg exists and the page gave no <video poster>, a poster frame is extracted.
 */

export function assetName(a) {
  const src = a.sourceUrls?.[0];
  let base = '';
  if (src) {
    try {
      base = path.posix.basename(new URL(src).pathname);
    } catch {
      /* ignore */
    }
  }
  return safeBaseName(base, a.kind === 'video' ? 'video' : 'image');
}

export function targetWidths(width, widths) {
  if (!width) return [];
  const sorted = [...widths].sort((a, b) => a - b);
  const out = sorted.filter((w) => w < width);
  if (width <= sorted[sorted.length - 1]) out.push(width);
  return out;
}

const SHARP_INPUT = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/tiff', 'image/svg+xml', 'image/heic']);

async function renditions(file, a, dir, name, cfg, rel) {
  const animated = !!a.animated;
  const input = () => sharp(file, { failOn: 'none', animated, limitInputPixels: 268_402_689 });
  const meta = await input().metadata();
  const rotated = (meta.orientation ?? 1) >= 5;
  const h0 = animated && meta.pageHeight ? meta.pageHeight : meta.height;
  const width = rotated ? h0 : meta.width;
  const height = rotated ? meta.width : h0;
  const webp = {};
  for (const w of targetWidths(width, cfg.widths)) {
    const out = path.join(dir, `${name}-${w}.webp`);
    if (!(cfg.resume && existsSync(out))) {
      await input().rotate().resize({ width: w, withoutEnlargement: true }).webp({ quality: 80, effort: 4, smartSubsample: true }).toFile(out);
    }
    const m = await sharp(out, { animated }).metadata();
    webp[String(w)] = { file: rel(out), width: m.width, height: animated && m.pageHeight ? m.pageHeight : m.height, bytes: await fileSize(out) };
  }
  const ph = await sharp(file, { failOn: 'none' }).rotate().resize({ width: 16, height: 16, fit: 'inside' }).webp({ quality: 40 }).toBuffer();
  const { dominant } = await sharp(file, { failOn: 'none' }).rotate().resize({ width: 64, height: 64, fit: 'inside' }).stats();
  const hex = (n) => n.toString(16).padStart(2, '0');
  return {
    width,
    height,
    webp,
    placeholder: `data:image/webp;base64,${ph.toString('base64')}`,
    dominantColor: dominant ? `#${hex(dominant.r)}${hex(dominant.g)}${hex(dominant.b)}` : null,
  };
}

export async function runOptimise(ctx) {
  const { cfg, log } = ctx;
  const paths = outPaths(cfg);
  const st = await readJson(paths.assets);
  if (!st) throw new Error('state/assets.json missing — run the download step first');
  const prev = cfg.resume ? await readJson(paths.optimised, { assets: {} }) : { assets: {} };
  const result = { version: 1, widths: cfg.widths, assets: {} };
  const rel = (p) => path.relative(paths.out, p).split(path.sep).join('/');
  const widthsKey = cfg.widths.join(',');
  let fresh = 0;
  await mapPool(st.order, 2, async (sha) => {
    const a = st.assets[sha];
    const id = sha12(sha);
    const name = assetName(a);
    const dir = path.join(paths.build, id);
    const file = path.join(paths.out, a.staging);
    const old = prev.assets[sha];
    const filesOk = (o) => Object.values(o.webp ?? {}).every((v) => existsSync(path.join(paths.out, v.file))) && (!o.poster || existsSync(path.join(paths.out, o.poster.file)));
    if (old && old.widths === widthsKey && old.name === name && filesOk(old)) {
      result.assets[sha] = old;
      return;
    }
    await ensureDir(dir);
    const rec = { id, name, widths: widthsKey, kind: a.kind, webp: {}, placeholder: null, dominantColor: null };
    try {
      if (a.kind === 'image') {
        if (a.mime === 'image/svg+xml') rec.svgSafe = svgIsSafe(await readFile(file, 'utf8'));
        if (SHARP_INPUT.has(a.mime)) Object.assign(rec, await renditions(file, a, dir, name, cfg, rel));
        else rec.note = `no renditions for ${a.mime} (original kept)`;
      } else if (a.kind === 'video' && !a.posterSha256 && cfg.videoPosters && cfg.ffmpeg) {
        const posterJpg = path.join(dir, `${name}-poster.jpg`);
        if ((cfg.resume && existsSync(posterJpg)) || (await extractPosterFrame(file, posterJpg, cfg.ffmpeg, a.durationMs))) {
          const r = await renditions(posterJpg, { mime: 'image/jpeg' }, dir, `${name}-poster`, { ...cfg, widths: cfg.widths.filter((w) => w <= 1600) }, rel);
          rec.poster = { file: rel(posterJpg), width: r.width, height: r.height, webp: r.webp, placeholder: r.placeholder, dominantColor: r.dominantColor, generated: true };
        } else rec.note = 'poster extraction failed';
      }
    } catch (err) {
      rec.error = String(err?.message ?? err).slice(0, 300);
      log.warn(`optimise failed for ${id} (${a.mime}): ${rec.error}`);
    }
    result.assets[sha] = rec;
    fresh++;
  });
  log.info(`optimise: ${st.order.length} asset(s), ${fresh} processed, ${st.order.length - fresh} reused`);
  await writeJson(paths.optimised, result);
  return result;
}
