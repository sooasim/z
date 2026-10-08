import path from 'node:path';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extractPage, parseCssUrls } from './extract.mjs';
import { parseSitemap } from './robots.mjs';
import { hostMatches, isLikelyPage, normalizeUrl, pageKey } from './url.mjs';
import { outPaths } from './config.mjs';
import { atomicWrite, ensureDir, mapPool, readJson, removeIfExists, sha12, sha256, toCsv, writeJson } from './util.mjs';

/**
 * Step 1 — polite BFS crawl. Level-synchronous BFS (each level is sorted before fetching), so the inventory is
 * deterministic regardless of response timing. Each page record is persisted as soon as it is fetched
 * (state/pages/<key>.json + snapshots/<sha256>.html), so an interrupted crawl resumes with --resume.
 */

export function decodeHtml(buf, contentTypeHeader) {
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return new TextDecoder('utf-8').decode(buf.subarray(3));
  let cs = /charset=([^;]+)/i.exec(contentTypeHeader ?? '')?.[1]?.trim().replace(/["']/g, '');
  if (!cs) cs = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_-]+)/i.exec(buf.subarray(0, 4096).toString('latin1'))?.[1];
  try {
    return new TextDecoder(cs || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

const pageFile = (p, key) => path.join(p.pagesDir, `${sha12(sha256(key))}.json`);

export function makeScope(cfg) {
  const isSiteHost = (u) => hostMatches(u, cfg.siteHosts);
  const isAssetHost = (u) => hostMatches(u, cfg.assetHosts) || isSiteHost(u);
  const excluded = (u) => cfg.exclude.some((re) => re.test(new URL(u).pathname + new URL(u).search));
  return { isSiteHost, isAssetHost, excluded };
}

async function fetchStylesheet(url, ctx, cache, depth = 0) {
  if (cache.has(url)) return cache.get(url);
  const { cfg, fetcher, robots, scope, paths } = ctx;
  const file = path.join(paths.cssDir, `${sha12(sha256(url))}.json`);
  const p = (async () => {
    if (cfg.resume && existsSync(file)) return readJson(file);
    let rec;
    if (!scope.isAssetHost(url)) rec = { url, ok: false, error: 'HOST_NOT_ALLOWED', images: [], imports: [] };
    else {
      const res = await fetcher.get(url, {
        accept: 'text/css,*/*;q=0.1',
        maxBytes: cfg.caps.css,
        allowUrl: async (u) => (scope.isAssetHost(u) ? (cfg.assetsRespectRobots ? robots.check(u) : true) : 'HOST_NOT_ALLOWED'),
      });
      if (!res.ok) rec = { url, ok: false, status: res.status, error: res.error, images: [], imports: [] };
      else {
        const css = decodeHtml(res.body, res.headers['content-type']);
        const { images, imports } = parseCssUrls(css, res.url);
        await atomicWrite(path.join(paths.snapshots, 'css', `${res.sha256}.css`), res.body);
        rec = { url, finalUrl: res.url, ok: true, status: res.status, sha256: res.sha256, bytes: res.bytes, images, imports };
      }
    }
    await writeJson(file, rec);
    return rec;
  })();
  cache.set(url, p);
  const rec = await p;
  if (depth < 3) for (const imp of rec.imports ?? []) await fetchStylesheet(imp, ctx, cache, depth + 1);
  return rec;
}

/** media refs from linked stylesheets (incl. @import chains) for one page */
async function cssRefsFor(page, ctx, cache) {
  const refs = [];
  const visit = async (url, depth, seen) => {
    if (seen.has(url) || depth > 3) return;
    seen.add(url);
    const rec = await fetchStylesheet(url, ctx, cache);
    for (const im of rec.images ?? []) refs.push({ ...im, stylesheet: url });
    for (const imp of rec.imports ?? []) await visit(imp, depth + 1, seen);
  };
  const seen = new Set();
  for (const s of page.stylesheets ?? []) await visit(s, 0, seen);
  return refs;
}

function appendCssMedia(page, cssRefs) {
  for (const r of cssRefs) {
    if (page.media.some((m) => m.url === r.url && m.via === 'css')) continue;
    page.media.push({
      url: r.url, kind: 'image', via: 'css', role: 'background', zone: 'main', group: `css:${r.url}`, alt: null, title: null, caption: null,
      context: null, width: null, height: null, descriptor: null, implicit: false, stylesheet: r.stylesheet, property: r.property,
    });
  }
}

async function crawlOne(item, ctx, cssCache) {
  const { cfg, fetcher, robots, scope, paths, log } = ctx;
  const res = await fetcher.get(item.url, {
    accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
    maxBytes: cfg.caps.html,
    allowUrl: async (u) => {
      if (!scope.isSiteHost(u)) return 'REDIRECT_OFF_SITE';
      if (scope.excluded(u)) return 'EXCLUDED_PATTERN';
      return cfg.respectRobots ? robots.check(u) : true;
    },
  });
  const base = { key: item.key, url: item.url, depth: item.depth, via: item.via, discoveredFrom: item.from ?? null, lastmod: item.lastmod ?? null, fetchedAt: new Date().toISOString() };
  if (!res.ok) {
    log.warn(`page failed ${item.url}: ${res.error}`);
    return { ...base, ok: false, status: res.status, finalUrl: res.url, error: res.error, redirects: res.redirects ?? [] };
  }
  if (!/html|xml/.test(res.contentType)) return { ...base, ok: false, status: res.status, finalUrl: res.url, error: 'NOT_HTML', contentType: res.contentType };
  const html = decodeHtml(res.body, res.headers['content-type']);
  const snapshot = path.join('snapshots', `${res.sha256}.html`);
  if (!existsSync(path.join(paths.out, snapshot))) await atomicWrite(path.join(paths.out, snapshot), res.body);
  const page = { ...base, ok: true, status: res.status, finalUrl: res.url, finalKey: pageKey(res.url), redirects: res.redirects, contentType: res.contentType, sha256: res.sha256, bytes: res.bytes, snapshot, ...extractPage(html, res.url, { isAssetHost: scope.isAssetHost }) };
  appendCssMedia(page, await cssRefsFor(page, ctx, cssCache));
  return page;
}

function discover(page, scope, cfg) {
  const out = [];
  const cands = [...(page.links ?? []).map((l) => l.url)];
  if (page.canonical) cands.push(page.canonical);
  for (const raw of cands) {
    const u = normalizeUrl(raw);
    if (!u || !scope.isSiteHost(u) || !isLikelyPage(u)) continue;
    out.push(u);
  }
  return out;
}

async function loadSitemaps(ctx) {
  const { cfg, fetcher, robots, scope } = ctx;
  const results = [];
  const urls = [];
  const queue = [];
  const origins = [...new Set(cfg.startUrls.map((u) => new URL(u).origin))];
  for (const origin of origins) {
    const r = await robots.forOrigin(origin);
    for (const s of r.sitemaps ?? []) queue.push(s);
    queue.push(`${origin}/sitemap.xml`);
  }
  const seen = new Set();
  while (queue.length && seen.size < 50) {
    const sm = normalizeUrl(queue.shift());
    if (!sm || seen.has(sm)) continue;
    seen.add(sm);
    if (!scope.isSiteHost(sm)) {
      results.push({ url: sm, ok: false, error: 'HOST_NOT_ALLOWED' });
      continue;
    }
    const res = await fetcher.get(sm, { accept: 'application/xml,text/xml,*/*;q=0.5', maxBytes: 50 * 1024 * 1024, retries: 2, allowUrl: async (u) => (scope.isSiteHost(u) ? (cfg.respectRobots ? robots.check(u) : true) : 'HOST_NOT_ALLOWED') });
    if (!res.ok) {
      results.push({ url: sm, ok: false, status: res.status, error: res.error });
      continue;
    }
    try {
      const parsed = parseSitemap(res.body);
      queue.push(...parsed.sitemaps);
      urls.push(...parsed.urls);
      results.push({ url: sm, ok: true, urls: parsed.urls.length, sitemaps: parsed.sitemaps.length });
    } catch (err) {
      results.push({ url: sm, ok: false, error: `PARSE_ERROR ${err.message}` });
    }
  }
  return { results, urls };
}

export async function runCrawl(ctx) {
  const { cfg, log, robots, scope } = ctx;
  const paths = outPaths(cfg);
  ctx.paths = paths;
  if (!cfg.resume) {
    // fresh crawl: forget previous page records (snapshots are content-addressed and kept)
    await removeIfExists(paths.pagesDir);
    await removeIfExists(paths.cssDir);
    await removeIfExists(paths.crawlState);
  }
  await ensureDir(paths.pagesDir);
  await ensureDir(paths.cssDir);
  let st = cfg.resume ? await readJson(paths.crawlState) : undefined;
  if (st?.finished && cfg.resume) {
    log.info(`crawl: already finished (${st.fetched} pages) — resume skips the network`);
    return writeInventory(cfg, st);
  }
  if (st) {
    st.fetched = (await readdir(paths.pagesDir)).filter((f) => f.endsWith('.json')).length;
    log.info(`crawl: resuming at level ${st.level} with ${st.fetched} page(s) already fetched`);
  }
  if (!st) {
    st = { version: 1, startedAt: new Date().toISOString(), startUrls: cfg.startUrls, frontier: [], seen: [], skipped: [], fetched: 0, level: 0, sitemaps: null, finished: false };
    const push = (url, via, depth, extra = {}) => {
      const u = normalizeUrl(url);
      if (!u) return;
      const key = pageKey(u);
      if (st.seen.includes(key)) return;
      st.seen.push(key);
      st.frontier.push({ url: u, key, via, depth, ...extra });
    };
    for (const u of cfg.startUrls) push(u, 'start', 0);
    const sm = await loadSitemaps({ ...ctx, paths });
    st.sitemaps = sm.results;
    for (const x of sm.urls) push(x.loc, 'sitemap', 1, { lastmod: x.lastmod });
    await writeJson(paths.crawlState, st);
  }
  const seen = new Set(st.seen);
  const cssCache = new Map();
  while (st.frontier.length) {
    const level = st.frontier.filter((x) => x.depth === st.level);
    if (!level.length) {
      st.level++;
      continue;
    }
    const rest = st.frontier.filter((x) => x.depth !== st.level);
    const next = [];
    const todo = [];
    for (const item of level) {
      if (existsSync(pageFile(paths, item.key))) continue; // fetched before an interruption
      if (scope.excluded(item.url)) {
        st.skipped.push({ url: item.url, reason: 'EXCLUDED_PATTERN', from: item.from ?? null });
        continue;
      }
      if (cfg.respectRobots && (await robots.check(item.url)) !== true) {
        st.skipped.push({ url: item.url, reason: 'ROBOTS_DISALLOWED', from: item.from ?? null });
        continue;
      }
      if (item.depth > cfg.maxDepth) {
        st.skipped.push({ url: item.url, reason: 'MAX_DEPTH', from: item.from ?? null });
        continue;
      }
      if (st.fetched + todo.length >= cfg.maxPages) {
        st.skipped.push({ url: item.url, reason: 'MAX_PAGES', from: item.from ?? null });
        continue;
      }
      todo.push(item);
    }
    log.info(`crawl: level ${st.level} — ${todo.length} page(s) to fetch`);
    await mapPool(todo, cfg.concurrency, async (item) => {
      const rec = await crawlOne(item, { ...ctx, paths }, cssCache);
      await writeJson(pageFile(paths, item.key), rec);
      st.fetched++;
    });
    // discovery in deterministic (sorted level) order
    for (const item of [...level].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
      const rec = await readJson(pageFile(paths, item.key));
      if (!rec?.ok) continue;
      if (rec.finalKey && rec.finalKey !== item.key && !seen.has(rec.finalKey)) seen.add(rec.finalKey);
      for (const u of discover(rec, scope, cfg)) {
        const key = pageKey(u);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push({ url: u, key, via: 'link', depth: st.level + 1, from: item.url });
      }
    }
    st.frontier = [...rest, ...next];
    st.seen = [...seen];
    st.level++;
    await writeJson(paths.crawlState, st);
  }
  st.finished = true;
  st.finishedAt = new Date().toISOString();
  st.robots = await robots.summary();
  await writeJson(paths.crawlState, st);
  return writeInventory(cfg, st);
}

/** Re-parse stored snapshots (no network for pages; stylesheets come from the state cache) and rebuild the inventory. */
export async function runExtract(ctx) {
  const { cfg, log } = ctx;
  const paths = outPaths(cfg);
  ctx.paths = paths;
  const st = await readJson(paths.crawlState);
  if (!st) throw new Error('nothing crawled yet — run the crawl step first');
  const files = existsSync(paths.pagesDir) ? (await readdir(paths.pagesDir)).filter((f) => f.endsWith('.json')) : [];
  const cssCache = new Map();
  let n = 0;
  for (const f of files) {
    const rec = await readJson(path.join(paths.pagesDir, f));
    if (!rec?.ok || !rec.snapshot) continue;
    const buf = await readFile(path.join(paths.out, rec.snapshot));
    const html = decodeHtml(buf, rec.contentType);
    const page = { ...rec, ...extractPage(html, rec.finalUrl, { isAssetHost: ctx.scope.isAssetHost }) };
    appendCssMedia(page, await cssRefsFor(page, { ...ctx, paths, cfg: { ...cfg, resume: true } }, cssCache));
    await writeJson(path.join(paths.pagesDir, f), page);
    n++;
  }
  log.info(`extract: re-parsed ${n} snapshot(s)`);
  return writeInventory(cfg, st);
}

export async function loadPages(cfg) {
  const paths = outPaths(cfg);
  if (!existsSync(paths.pagesDir)) return [];
  const files = (await readdir(paths.pagesDir)).filter((f) => f.endsWith('.json'));
  const pages = [];
  for (const f of files) {
    const r = await readJson(path.join(paths.pagesDir, f));
    if (r) pages.push(r);
  }
  return pages.sort((a, b) => a.depth - b.depth || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

async function writeInventory(cfg, st) {
  const paths = outPaths(cfg);
  const pages = await loadPages(cfg);
  // redirect aliases: a URL that redirected to an already-crawled page is kept as an alias of that page
  // (a page fetched at its own URL wins; otherwise the first page that redirected there)
  const byKey = new Map();
  for (const p of pages) if (p.ok && (p.finalKey ?? p.key) === p.key) byKey.set(p.key, p);
  for (const p of pages) if (p.ok && p.finalKey && !byKey.has(p.finalKey)) byKey.set(p.finalKey, p);
  for (const p of pages) {
    const target = p.ok && p.finalKey ? byKey.get(p.finalKey) : null;
    if (target && target !== p) p.aliasOf = target.url;
  }
  const inv = {
    version: 1,
    generatedAt: st.finishedAt ?? new Date().toISOString(),
    startedAt: st.startedAt,
    finished: !!st.finished,
    startUrls: st.startUrls,
    siteHosts: cfg.siteHosts,
    assetHosts: cfg.assetHosts,
    userAgent: cfg.userAgent,
    robots: st.robots ?? [],
    sitemaps: st.sitemaps ?? [],
    stats: {
      pages: pages.length,
      ok: pages.filter((p) => p.ok).length,
      failed: pages.filter((p) => !p.ok).length,
      skipped: st.skipped.length,
      mediaRefs: pages.reduce((n, p) => n + (p.media?.length ?? 0), 0),
      embeds: pages.reduce((n, p) => n + (p.embeds?.length ?? 0), 0),
    },
    pages,
    skipped: st.skipped,
  };
  await writeJson(paths.inventory, inv);
  const rows = pages.map((p) => ({
    url: p.url,
    final_url: p.finalUrl ?? '',
    status: p.status ?? '',
    ok: p.ok ? 'yes' : 'no',
    depth: p.depth,
    via: p.via,
    title: p.title ?? '',
    canonical: p.canonical ?? '',
    sha256: p.sha256 ?? '',
    images: (p.media ?? []).filter((m) => m.kind !== 'video').length,
    videos: (p.media ?? []).filter((m) => m.kind === 'video').length,
    embeds: (p.embeds ?? []).length,
    links: (p.links ?? []).length,
    error: p.error ?? '',
    alias_of: p.aliasOf ?? '',
  }));
  for (const s of st.skipped) rows.push({ url: s.url, ok: 'skipped', error: s.reason, via: 'link', depth: '', title: '', final_url: '', status: '', canonical: '', sha256: '', images: '', videos: '', embeds: '', links: '', alias_of: '' });
  await writeFile(paths.urlsCsv, toCsv(rows, ['url', 'final_url', 'status', 'ok', 'depth', 'via', 'title', 'canonical', 'sha256', 'images', 'videos', 'embeds', 'links', 'error', 'alias_of']));
  return inv;
}
