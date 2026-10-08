import path from 'node:path';
import { open, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { outPaths } from './config.mjs';
import { imageInfo, videoInfo } from './probe.mjs';
import { contentTypeAcceptable, sniff } from './sniff.mjs';
import { kindFromUrl, originalCandidates } from './url.mjs';
import { ensureDir, mapPool, readJson, uniq, writeJson } from './util.mjs';

/**
 * Steps 2–3 — media references → verified, deduplicated originals in the staging dir.
 * Every referenced URL (plus CDN "original" candidates) is downloaded once; bytes are checked against the
 * Content-Type and magic bytes, capped by kind, and stored content-addressed (staging/<aa>/<sha256>.<ext>).
 * Provenance (source URLs, pages, alt/caption/heading context, declared + real dimensions, duration) is kept.
 */

const PERMANENT = /^(HTTP_4\d\d|HOST_NOT_ALLOWED|REDIRECT_HOST_NOT_ALLOWED|ROBOTS_DISALLOWED|TOO_LARGE|NOT_MEDIA|UNEXPECTED_CONTENT_TYPE|MAGIC_UNSUPPORTED|EMPTY|UNSUPPORTED_STREAM|TOO_MANY_REDIRECTS)/;

/** All media references of the inventory, flattened with page provenance. */
export function collectRefs(inv) {
  const out = [];
  for (const p of inv.pages ?? []) {
    if (!p.ok || p.aliasOf) continue;
    (p.media ?? []).forEach((m, index) => out.push({ ...m, index, pageUrl: p.url, pageKey: p.key }));
  }
  return out;
}

export function candidatesFor(url, policy) {
  if (policy === 'off') return [url];
  return [...originalCandidates(url), url];
}

async function readHead(file, n = 4096) {
  const fh = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await fh.read(Buffer.alloc(n), 0, n, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

async function downloadOne(url, ctx) {
  const { cfg, fetcher, robots, scope, paths } = ctx;
  const fetchedAt = new Date().toISOString();
  const fail = (error, extra = {}) => ({ url, status: 'failed', error, permanent: PERMANENT.test(error), fetchedAt, ...extra });
  if (!scope.isAssetHost(url)) return fail('HOST_NOT_ALLOWED', { host: new URL(url).host });
  if (kindFromUrl(url) === 'stream') return fail('UNSUPPORTED_STREAM');
  await ensureDir(paths.stagingTmp);
  const tmp = path.join(paths.stagingTmp, `${randomBytes(8).toString('hex')}.part`);
  const urlKind = kindFromUrl(url);
  const res = await fetcher.get(url, {
    toFile: tmp,
    timeoutMs: cfg.downloadTimeoutMs,
    accept: urlKind === 'video' ? 'video/*,*/*;q=0.5' : 'image/avif,image/webp,image/apng,image/*,*/*;q=0.5',
    maxBytes: (ct) => (ct.startsWith('image/') ? cfg.caps.image : cfg.caps.video),
    allowUrl: async (u) => (scope.isAssetHost(u) ? (cfg.assetsRespectRobots ? robots.check(u) : true) : 'REDIRECT_HOST_NOT_ALLOWED'),
  });
  if (!res.ok) {
    await rm(tmp, { force: true });
    return fail(res.error ?? 'DOWNLOAD_FAILED', { httpStatus: res.status || null, finalUrl: res.url, attempts: res.attempts, bytes: res.bytes ?? null });
  }
  if (!res.bytes) {
    await rm(tmp, { force: true });
    return fail('EMPTY', { httpStatus: res.status });
  }
  const s = sniff(await readHead(tmp));
  const base = { httpStatus: res.status, finalUrl: res.url, contentType: res.contentType, attempts: res.attempts, bytes: res.bytes };
  if (!s) {
    await rm(tmp, { force: true });
    return fail('MAGIC_UNSUPPORTED', base);
  }
  if (s.kind !== 'image' && s.kind !== 'video') {
    await rm(tmp, { force: true });
    return fail(`NOT_MEDIA ${s.mime}`, base);
  }
  if (!contentTypeAcceptable(res.contentType, s)) {
    await rm(tmp, { force: true });
    return fail(`UNEXPECTED_CONTENT_TYPE ${res.contentType}`, base);
  }
  if (s.kind === 'image' && res.bytes > cfg.caps.image) {
    await rm(tmp, { force: true });
    return fail('TOO_LARGE', base);
  }
  const rel = path.join('staging', res.sha256.slice(0, 2), `${res.sha256}.${s.ext}`);
  const dest = path.join(paths.out, rel);
  if (existsSync(dest)) await rm(tmp, { force: true });
  else {
    await ensureDir(path.dirname(dest));
    await rename(tmp, dest);
  }
  const declaredMismatch = res.contentType && !res.contentType.includes('octet') && res.contentType !== s.mime ? res.contentType : null;
  return { url, status: 'ok', fetchedAt, ...base, sha256: res.sha256, mime: s.mime, ext: s.ext, kind: s.kind, staging: rel, contentTypeMismatch: declaredMismatch };
}

export async function runDownload(ctx) {
  const { cfg, log } = ctx;
  const paths = outPaths(cfg);
  ctx.paths = paths;
  const inv = await readJson(paths.inventory);
  if (!inv) throw new Error('inventory.json missing — run the crawl step first');
  const prev = cfg.resume ? await readJson(paths.downloads, { urls: {} }) : { urls: {} };
  const state = { version: 1, updatedAt: null, urls: { ...prev.urls } };
  const refs = collectRefs(inv).filter((r) => r.kind !== 'font' && r.kind !== 'doc');
  const jobs = uniq(refs.flatMap((r) => candidatesFor(r.url, cfg.cdnOriginals))).sort();
  const reusable = (u) => {
    const d = state.urls[u];
    if (!d) return false;
    if (d.status === 'ok') return existsSync(path.join(paths.out, d.staging));
    return d.permanent && !cfg.retryFailed;
  };
  // 'prefer' policy: fetch the referenced URL only when every original candidate failed
  const deferred = new Set();
  if (cfg.cdnOriginals === 'prefer') for (const r of refs) if (originalCandidates(r.url).length) deferred.add(r.url);
  const first = jobs.filter((u) => !reusable(u) && !deferred.has(u));
  log.info(`download: ${jobs.length} unique media URL(s), ${jobs.length - first.length} already done`);
  let done = 0;
  const flush = async () => {
    state.updatedAt = new Date().toISOString();
    await writeJson(paths.downloads, state);
  };
  const runJobs = async (list) =>
    mapPool(list, cfg.concurrency, async (u) => {
      const r = await downloadOne(u, ctx);
      state.urls[u] = r;
      if (r.status !== 'ok') log.warn(`media failed ${u}: ${r.error}`);
      if (++done % 20 === 0) await flush();
    });
  await runJobs(first);
  if (cfg.cdnOriginals === 'prefer') {
    const second = [...deferred].filter((u) => !reusable(u) && originalCandidates(u).every((c) => state.urls[c]?.status !== 'ok'));
    await runJobs(second);
  }
  await flush();
  const assets = await buildAssets(inv, state, cfg, paths);
  await writeJson(paths.assets, assets);
  await rm(paths.stagingTmp, { recursive: true, force: true });
  return assets;
}

/** Resolve every reference to its best downloaded asset and aggregate provenance per sha256. */
export async function buildAssets(inv, downloads, cfg, paths) {
  const refs = collectRefs(inv);
  const assets = {};
  const order = [];
  const info = async (d) => {
    const a = assets[d.sha256];
    if (a) return a;
    const file = path.join(paths.out, d.staging);
    const probe = d.kind === 'image' ? await imageInfo(file, d.mime) : await videoInfo(file, cfg.ffprobe);
    const rec = {
      sha256: d.sha256, kind: d.kind, mime: d.mime, ext: d.ext, bytes: d.bytes, staging: d.staging,
      width: probe.width ?? null, height: probe.height ?? null, durationMs: probe.durationMs ?? null,
      animated: probe.animated ?? false, codec: probe.codec ?? null, probe: { sharp: probe.sharp ?? null, ffprobe: probe.probed ?? null },
      sourceUrls: [], pageUrls: [], alts: [], captions: [], contexts: [], titles: [], roles: [], vias: [], declared: [], posterFor: [],
    };
    assets[d.sha256] = rec;
    order.push(d.sha256);
    return rec;
  };
  // deterministic: walk downloads in sorted URL order so asset discovery order is stable
  for (const u of Object.keys(downloads.urls).sort()) {
    const d = downloads.urls[u];
    if (d.status === 'ok') (await info(d)).sourceUrls.push(u);
  }
  const resolved = [];
  const groupPrimary = new Map();
  for (const r of refs) {
    const cands = candidatesFor(r.url, cfg.cdnOriginals);
    const ok = cands.map((c) => downloads.urls[c]).filter((d) => d?.status === 'ok');
    const area = (d) => (assets[d.sha256]?.width ?? 0) * (assets[d.sha256]?.height ?? 0);
    const best = ok.length ? ok.reduce((b, d) => (area(d) > area(b) ? d : b), ok[0]) : null;
    const variants = uniq(ok.map((d) => d.sha256).filter((s) => s !== best?.sha256));
    const errors = cands.map((c) => downloads.urls[c]).filter((d) => d && d.status !== 'ok').map((d) => ({ url: d.url, error: d.error }));
    const missing = cands.filter((c) => !downloads.urls[c]);
    resolved.push({
      pageUrl: r.pageUrl, index: r.index, url: r.url, kind: r.kind, via: r.via, role: r.role, zone: r.zone, group: r.group, implicit: !!r.implicit,
      sha256: best?.sha256 ?? null, variants, errors, notAttempted: missing,
    });
    if (best) {
      for (const sha of [best.sha256, ...variants]) {
        const a = assets[sha];
        a.pageUrls.push(r.pageUrl);
        if (r.alt) a.alts.push(r.alt);
        if (r.caption) a.captions.push(r.caption);
        if (r.title) a.titles.push(r.title);
        if (r.context) a.contexts.push(r.context);
        a.roles.push(r.role);
        a.vias.push(r.via);
        if (r.width || r.height) a.declared.push({ width: r.width, height: r.height });
      }
      const gk = `${r.pageUrl}#${r.group}`;
      const cur = groupPrimary.get(gk);
      if (!cur || area(best) > (assets[cur].width ?? 0) * (assets[cur].height ?? 0)) groupPrimary.set(gk, best.sha256);
    }
  }
  // poster ↔ video links (poster group is "<videoGroup>:poster")
  for (const [gk, sha] of groupPrimary) {
    if (!gk.endsWith(':poster')) continue;
    const vid = groupPrimary.get(gk.slice(0, -':poster'.length));
    if (vid && assets[vid]?.kind === 'video') {
      assets[vid].posterSha256 = sha;
      assets[sha].posterFor.push(vid);
    }
  }
  for (const a of Object.values(assets)) {
    for (const k of ['sourceUrls', 'pageUrls', 'roles', 'vias', 'posterFor']) a[k] = uniq(a[k]).sort();
  }
  const embeds = {};
  for (const p of inv.pages ?? []) {
    if (!p.ok || p.aliasOf) continue;
    for (const e of p.embeds ?? []) {
      const id = `${e.provider}-${e.videoId}`;
      embeds[id] ??= { id, provider: e.provider, videoId: e.videoId, embedUrl: e.embedUrl, watchUrl: e.watchUrl, thumbnailUrl: e.thumbnailUrl, oembedUrl: e.oembedUrl ?? null, titles: [], contexts: [], pageUrls: [] };
      if (e.title) embeds[id].titles.push(e.title);
      if (e.context) embeds[id].contexts.push(e.context);
      embeds[id].pageUrls.push(p.url);
    }
  }
  for (const e of Object.values(embeds)) e.pageUrls = uniq(e.pageUrls).sort();
  return { version: 1, generatedAt: new Date().toISOString(), order, assets, refs: resolved, groupPrimary: Object.fromEntries(groupPrimary), embeds };
}
