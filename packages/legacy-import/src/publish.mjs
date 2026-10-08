import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { outPaths } from './config.mjs';
import { assetName } from './optimise.mjs';
import { copyIfChanged, ensureDir, mostCommon, readJson, sha12, sha256, uniq, writeJson } from './util.mjs';

/**
 * Step 5 — copy originals + renditions to <publicDir>/<sha12>/ and write manifest.json. File paths in the
 * manifest are relative to the web public dir (e.g. "legacy/ab12cd34ef56/photo-960.webp", served at
 * <basePath>/legacy/...). Unchanged files are not rewritten, and an unchanged manifest keeps its generatedAt,
 * so a re-run is byte-for-byte idempotent. Nothing is ever deleted from the public dir (orphans are reported).
 */

const BOILERPLATE_SHARE = 0.6;
const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

export function boilerplate(pages) {
  const n = pages.length;
  const text = new Map();
  for (const p of pages) for (const t of new Set((p.textBlocks ?? []).map((b) => norm(b.text)))) text.set(t, (text.get(t) ?? 0) + 1);
  const isText = (s) => n >= 3 && (text.get(norm(s)) ?? 0) / n >= BOILERPLATE_SHARE;
  return { isText };
}

export async function runPublish(ctx) {
  const { cfg, log } = ctx;
  const paths = outPaths(cfg);
  const inv = await readJson(paths.inventory);
  const st = await readJson(paths.assets);
  const opt = await readJson(paths.optimised, { assets: {} });
  if (!inv || !st) throw new Error('inventory/assets missing — run crawl and download first');
  const prefix = cfg.urlPrefix.replace(/^\//, '');
  const pub = (relInPublic) => (prefix ? `${prefix}/${relInPublic}` : relInPublic);
  await ensureDir(cfg.publicDir);
  const foreign = await foreignPublisherDirs(cfg.publicDir);
  if (foreign.length) {
    log.warn(
      `publish: ${cfg.publicDir} also holds ${foreign.length} asset dir(s) of another publisher (<sha12>/original.<ext> layout, e.g. scripts/legacy/optimize.mjs). ` +
        'A publisher that prunes unknown entries can delete these files — publish to a directory you own (--public-dir … --url-prefix …) or let one pipeline own this one.',
    );
  }

  const assetsOut = {};
  const idOf = (sha) => sha12(sha);
  let copied = 0;
  const pagesOk = (inv.pages ?? []).filter((p) => p.ok && !p.aliasOf && !p.template);
  const nPages = pagesOk.length;
  for (const sha of st.order) {
    const a = st.assets[sha];
    const o = opt.assets[sha] ?? {};
    const id = idOf(sha);
    const name = o.name ?? assetName(a);
    const dir = path.join(cfg.publicDir, id);
    const files = { original: null, webp: {} };
    const unsafeSvg = a.mime === 'image/svg+xml' && o.svgSafe === false;
    if (!unsafeSvg) {
      const dest = path.join(dir, `${name}.${a.ext}`);
      if (await copyIfChanged(path.join(paths.out, a.staging), dest)) copied++;
      files.original = pub(`${id}/${name}.${a.ext}`);
    }
    const renditions = [];
    for (const [w, v] of Object.entries(o.webp ?? {})) {
      const base = path.basename(v.file);
      if (await copyIfChanged(path.join(paths.out, v.file), path.join(dir, base))) copied++;
      files.webp[w] = pub(`${id}/${base}`);
      renditions.push({ width: v.width, height: v.height, bytes: v.bytes, path: pub(`${id}/${base}`) });
    }
    if (o.poster) {
      const base = path.basename(o.poster.file);
      if (await copyIfChanged(path.join(paths.out, o.poster.file), path.join(dir, base))) copied++;
      files.poster = { original: pub(`${id}/${base}`), webp: {} };
      for (const [w, v] of Object.entries(o.poster.webp ?? {})) {
        const b = path.basename(v.file);
        if (await copyIfChanged(path.join(paths.out, v.file), path.join(dir, b))) copied++;
        files.poster.webp[w] = pub(`${id}/${b}`);
      }
    }
    // site chrome: icons, theme-CSS / header / footer-only images, or content repeated on most pages (logos, banners)
    const mainPages = a.mainPageUrls ?? a.pageUrls;
    const chrome =
      a.roles.every((r) => r === 'icon') ||
      (!mainPages.length && !a.roles.includes('poster')) ||
      (nPages >= 3 && mainPages.length / nPages >= BOILERPLATE_SHARE);
    assetsOut[id] = {
      id,
      kind: a.kind,
      sha256: a.sha256,
      mime: a.mime,
      bytes: a.bytes,
      files,
      renditions,
      placeholder: o.placeholder ?? o.poster?.placeholder ?? null,
      dominantColor: o.dominantColor ?? o.poster?.dominantColor ?? null,
      width: o.width ?? a.width ?? null,
      height: o.height ?? a.height ?? null,
      durationMs: a.durationMs ?? null,
      animated: !!a.animated,
      alt: mostCommon(a.alts),
      caption: mostCommon(a.captions) ?? mostCommon(a.titles),
      context: mostCommon(a.contexts),
      roles: a.roles,
      chrome,
      sourceUrls: a.sourceUrls,
      pageUrls: a.pageUrls,
      /** pages that show it as content (not only via theme CSS / header / footer) */
      contentPageUrls: mainPages,
      ...(a.posterSha256 ? { posterAssetId: idOf(a.posterSha256) } : {}),
      ...(a.posterFor?.length ? { posterFor: a.posterFor.map(idOf) } : {}),
      ...(a.mime === 'image/svg+xml' ? { svgSafe: o.svgSafe !== false } : {}),
      ...(o.error ? { optimiseError: o.error } : {}),
      ...(o.note ? { note: o.note } : {}),
    };
  }
  // CDN renditions of the same picture (?w=480, /thumbnails/…_1600): linked to the primary (largest) asset;
  // an asset that never resolves as a primary is an alternate and stays out of page image lists
  const primaries = new Set(st.refs.filter((r) => r.sha256).map((r) => idOf(r.sha256)));
  for (const r of st.refs) {
    if (!r.sha256 || !r.variants?.length) continue;
    const primary = assetsOut[idOf(r.sha256)];
    primary.alternates = uniq([...(primary.alternates ?? []), ...r.variants.map(idOf).filter((v) => !primaries.has(v))]).sort();
    for (const v of r.variants.map(idOf)) if (!primaries.has(v)) assetsOut[v].alternateOf = primary.id;
  }
  for (const a of Object.values(assetsOut)) if (a.alternates && !a.alternates.length) delete a.alternates;
  for (const e of Object.values(st.embeds ?? {})) {
    assetsOut[e.id] = {
      id: e.id, kind: 'embed', provider: e.provider, videoId: e.videoId, embedUrl: e.embedUrl, watchUrl: e.watchUrl,
      thumbnailUrl: e.thumbnailUrl, oembedUrl: e.oembedUrl, title: mostCommon(e.titles), context: mostCommon(e.contexts), pageUrls: e.pageUrls,
    };
  }

  // pages
  const refSha = new Map(st.refs.map((r) => [`${r.pageUrl}#${r.index}`, r.sha256]));
  const bp = boilerplate(pagesOk);
  const pages = [];
  for (const p of pagesOk) {
    const shaOfRef = (i) => refSha.get(`${p.url}#${i}`) ?? null;
    const bestOf = (idx) => {
      const shas = uniq(idx.map(shaOfRef));
      if (!shas.length) return null;
      return shas.reduce((b, s) => ((st.assets[s].width ?? 0) * (st.assets[s].height ?? 0) > (st.assets[b].width ?? 0) * (st.assets[b].height ?? 0) ? s : b), shas[0]);
    };
    const blocks = [];
    const images = [];
    const videos = [];
    const embeds = [];
    for (const b of p.flow ?? []) {
      if (b.zone && b.zone !== 'main') continue;
      if (b.t === 'h' || b.t === 'p') {
        if (bp.isText(b.text)) continue;
        blocks.push(b.t === 'h' ? { type: 'heading', level: b.level, text: b.text } : { type: 'text', text: b.text });
      } else if (b.t === 'media' && b.kind === 'image') {
        const s = bestOf(b.refs);
        if (!s) continue;
        const id = idOf(s);
        if (blocks.some((x) => x.assetId === id)) continue;
        blocks.push({ type: 'image', assetId: id, ...(b.background ? { background: true } : {}) });
      } else if (b.t === 'media' && b.kind === 'video') {
        const s = bestOf(b.refs);
        const ps = bestOf(b.poster ?? []);
        if (!s && !ps) continue;
        blocks.push({ type: 'video', assetId: s ? idOf(s) : null, posterAssetId: ps ? idOf(ps) : s && st.assets[s].posterSha256 ? idOf(st.assets[s].posterSha256) : null, title: b.title ?? null });
      } else if (b.t === 'embed') {
        const e = p.embeds?.[b.embed];
        if (e) blocks.push({ type: 'embed', assetId: `${e.provider}-${e.videoId}` });
      }
    }
    // every downloaded asset referenced by the page (flow order first, then head/css/script refs)
    const ordered = uniq([...blocks.filter((x) => x.type === 'image' || x.type === 'video').flatMap((x) => [x.assetId, x.posterAssetId]), ...(p.media ?? []).map((_, i) => shaOfRef(i)).filter(Boolean).map(idOf)]);
    for (const id of ordered) {
      const a = assetsOut[id];
      if (!a || a.alternateOf) continue;
      if (a.kind === 'video') videos.push(id);
      else images.push(id);
    }
    for (const e of p.embeds ?? []) embeds.push(`${e.provider}-${e.videoId}`);
    const og = p.og ?? {};
    const ogSha = (p.media ?? []).map((m, i) => (m.role === 'og' ? shaOfRef(i) : null)).find(Boolean);
    pages.push({
      url: p.url,
      finalUrl: p.finalUrl,
      path: new URL(p.url).pathname + new URL(p.url).search,
      title: p.title ?? null,
      description: p.description ?? null,
      canonical: p.canonical ?? null,
      lang: p.lang ?? null,
      og: { title: og.title ?? null, description: og.description ?? null, type: og.type ?? null, image: og.image ?? null, imageAssetId: ogSha ? idOf(ogSha) : null },
      headings: p.headings ?? [],
      text: blocks.filter((b) => b.type === 'text' || b.type === 'heading').map((b) => b.text),
      blocks,
      images,
      videos,
      embeds: uniq(embeds),
      snapshotSha256: p.sha256,
      fetchedAt: p.fetchedAt,
      lastmod: p.lastmod ?? null,
      depth: p.depth,
      aliases: (inv.pages ?? []).filter((x) => x.aliasOf === p.url).map((x) => x.url),
    });
  }

  const content = {
    version: 1,
    source: {
      site: new URL(inv.startUrls[0]).origin,
      startUrls: inv.startUrls,
      siteHosts: inv.siteHosts,
      assetHosts: inv.assetHosts,
      crawledAt: inv.generatedAt,
      userAgent: inv.userAgent,
      pageCount: pages.length,
    },
    publicPrefix: cfg.urlPrefix,
    widths: cfg.widths,
    pages,
    assets: assetsOut,
    stats: {
      pages: pages.length,
      images: Object.values(assetsOut).filter((a) => a.kind === 'image').length,
      videos: Object.values(assetsOut).filter((a) => a.kind === 'video').length,
      embeds: Object.values(assetsOut).filter((a) => a.kind === 'embed').length,
      originalBytes: Object.values(assetsOut).reduce((n, a) => n + (a.bytes ?? 0), 0),
      renditionBytes: Object.values(assetsOut).reduce((n, a) => n + (a.renditions ?? []).reduce((m, r) => m + (r.bytes ?? 0), 0), 0),
    },
  };
  const hash = sha256(JSON.stringify(content));
  const prev = await readJson(paths.manifest);
  if (prev?.contentSha256 === hash) {
    log.info(`publish: ${copied} file(s) copied, manifest unchanged`);
    return prev;
  }
  const manifest = { generatedAt: new Date().toISOString(), contentSha256: hash, ...content };
  await writeJson(paths.manifest, manifest);
  const orphans = await findOrphans(cfg.publicDir, new Set(Object.keys(assetsOut)));
  if (orphans.length) log.warn(`publish: ${orphans.length} directory(ies) in ${cfg.publicDir} are not in the manifest (kept; review): ${orphans.slice(0, 5).join(', ')}`);
  log.info(`publish: ${Object.keys(assetsOut).length} asset(s), ${copied} file(s) copied → ${cfg.publicDir}; manifest → ${paths.manifest}`);
  return manifest;
}

/**
 * Directories written by a different publisher (layout `<sha12>/original.<ext>` — this tool never writes that name).
 * Such a publisher may prune entries it does not know, including ours, so the operator is warned.
 */
export async function foreignPublisherDirs(publicDir) {
  if (!existsSync(publicDir)) return [];
  const out = [];
  for (const e of await readdir(publicDir, { withFileTypes: true })) {
    if (!e.isDirectory() || !/^[0-9a-f]{12}$/.test(e.name)) continue;
    const files = await readdir(path.join(publicDir, e.name)).catch(() => []);
    if (files.some((f) => /^original\.[a-z0-9]+$/i.test(f))) out.push(e.name);
  }
  return out;
}

export async function findOrphans(publicDir, ids) {
  if (!existsSync(publicDir)) return [];
  const entries = await readdir(publicDir, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory() && /^[0-9a-f]{12}$/.test(e.name) && !ids.has(e.name)).map((e) => e.name);
}
