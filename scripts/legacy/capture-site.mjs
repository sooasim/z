#!/usr/bin/env node
/**
 * MIG-01 legacy capture (owner-authorised): renders every page of the legacy WONT Travel Club site
 * (https://www.wontc.co.kr, Sixshop) in headless Chromium, scrolls to trigger lazy loading, and saves
 * EVERY image / video / poster / background / favicon / embed thumbnail it references or loads.
 *
 *   node scripts/legacy/capture-site.mjs --out legacy-raw [--start URL ...] [--max-pages 400]
 *
 * Output (legacy-raw/):
 *   assets/<sha256>.<ext>        deduplicated originals
 *   pages/<slug>.html|.txt|.jpg  rendered HTML, visible text, full-page screenshot (JPEG)
 *   manifest.json                { pages:[...], assets:{sha:{...}}, embeds:[...], failures:[...] }
 * Requires the `playwright` package and a Chromium (npx playwright install --with-deps chromium).
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const multi = (n) => args.flatMap((a, i) => (a === `--${n}` ? [args[i + 1]] : []));
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const OUT = path.resolve(opt('out', 'legacy-raw'));
const MAX_PAGES = Number(opt('max-pages', 400));
const STARTS = multi('start').length ? multi('start') : ['https://www.wontc.co.kr/', 'https://www.wontc.co.kr/about_jetpool'];
const SITE_HOSTS = new Set(STARTS.map((u) => new URL(u).hostname).flatMap((h) => [h, h.replace(/^www\./, ''), `www.${h.replace(/^www\./, '')}`]));
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 JETPOOL-Migration/1.0 (+owner-authorised)';
const MAX_ASSET_BYTES = 300 * 1024 * 1024;

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');

await mkdir(path.join(OUT, 'assets'), { recursive: true });
await mkdir(path.join(OUT, 'pages'), { recursive: true });

const manifest = { source: STARTS, generatedAt: new Date().toISOString(), pages: [], assets: {}, byUrl: {}, embeds: [], failures: [] };
const extFor = (ct, url) => {
  const m = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov', 'application/vnd.apple.mpegurl': 'm3u8' };
  const base = (ct || '').split(';')[0].trim().toLowerCase();
  if (m[base]) return m[base];
  const e = path.extname(new URL(url).pathname).slice(1).toLowerCase();
  return /^[a-z0-9]{2,5}$/.test(e) ? e : 'bin';
};
const isMediaType = (ct) => /^(image|video)\//i.test(ct || '') || /mpegurl/i.test(ct || '');
const slugOf = (u) => {
  const p = new URL(u);
  const s = (p.pathname + (p.search ? '_' + p.search.slice(1) : '')).replace(/^\/+|\/+$/g, '').replace(/[^a-zA-Z0-9가-힣._-]+/g, '_');
  return (s || 'index').slice(0, 120);
};
const normPage = (u) => {
  const x = new URL(u);
  x.hash = '';
  if (x.pathname.length > 1) x.pathname = x.pathname.replace(/\/+$/, '');
  return x.toString();
};

async function saveAsset(url, body, contentType, ctx) {
  if (!body || body.length === 0) return null;
  if (body.length > MAX_ASSET_BYTES) {
    manifest.failures.push({ url, reason: `too large (${body.length} bytes)` });
    return null;
  }
  const sha = createHash('sha256').update(body).digest('hex');
  const ext = extFor(contentType, url);
  const file = `assets/${sha}.${ext}`;
  if (!manifest.assets[sha]) {
    await writeFile(path.join(OUT, file), body);
    manifest.assets[sha] = { sha256: sha, file, bytes: body.length, contentType: (contentType || '').split(';')[0], sourceUrls: [], pageUrls: [], alts: [], roles: [] };
  }
  const a = manifest.assets[sha];
  if (!a.sourceUrls.includes(url)) a.sourceUrls.push(url);
  if (ctx?.pageUrl && !a.pageUrls.includes(ctx.pageUrl)) a.pageUrls.push(ctx.pageUrl);
  manifest.byUrl[url] = sha;
  return sha;
}

// robots.txt
const disallow = [];
try {
  const r = await fetch(new URL('/robots.txt', STARTS[0]), { headers: { 'user-agent': UA } });
  if (r.ok) {
    let applies = false;
    for (const line of (await r.text()).split(/\r?\n/)) {
      const [k, ...rest] = line.split(':');
      const v = rest.join(':').trim();
      if (/^user-agent$/i.test(k.trim())) applies = v === '*' || /jetpool/i.test(v);
      else if (applies && /^disallow$/i.test(k.trim()) && v) disallow.push(v);
      else if (/^sitemap$/i.test(k.trim()) && v) STARTS.push(v);
    }
  }
} catch {}
const allowed = (u) => !disallow.some((d) => new URL(u).pathname.startsWith(d));

// sitemap(s)
const queue = [];
const seen = new Set();
const enqueue = (u) => {
  try {
    const n = normPage(u);
    const h = new URL(n).hostname;
    if (!SITE_HOSTS.has(h) || seen.has(n) || !allowed(n)) return;
    if (/\.(jpg|jpeg|png|gif|webp|svg|mp4|webm|pdf|zip|css|js|ico|xml)(\?|$)/i.test(new URL(n).pathname)) return;
    seen.add(n);
    queue.push(n);
  } catch {}
};
for (const s of [...STARTS]) {
  if (/sitemap.*\.xml/i.test(s)) {
    try {
      const xml = await (await fetch(s, { headers: { 'user-agent': UA } })).text();
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) enqueue(m[1]);
    } catch {}
  } else enqueue(s);
}
enqueue(new URL('/sitemap.xml', STARTS[0]).toString());

const browser = await chromium.launch();
const context = await browser.newContext({ userAgent: UA, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'ko-KR' });

let pageCount = 0;
while (queue.length && pageCount < MAX_PAGES) {
  const url = queue.shift();
  if (/sitemap.*\.xml/i.test(url)) {
    try {
      const xml = await (await fetch(url, { headers: { 'user-agent': UA } })).text();
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) enqueue(m[1]);
    } catch {}
    continue;
  }
  pageCount++;
  const page = await context.newPage();
  const pending = [];
  page.on('response', (res) => {
    const ct = res.headers()['content-type'] || '';
    const rt = res.request().resourceType();
    if ((rt === 'image' || rt === 'media' || isMediaType(ct)) && res.status() < 400) {
      pending.push(
        res
          .body()
          .then((b) => saveAsset(res.url(), b, ct, { pageUrl: url }))
          .catch(() => {}),
      );
    }
  });
  const rec = { url, slug: slugOf(url), title: '', description: '', ogImage: null, headings: [], text: '', links: [], images: [], videos: [], backgrounds: [], embeds: [] };
  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    rec.status = resp?.status();
    // scroll slowly to the bottom (lazy loading), then back to top
    await page.evaluate(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      let last = -1;
      for (let i = 0; i < 200; i++) {
        window.scrollBy(0, Math.round(window.innerHeight * 0.6));
        await sleep(250);
        const y = window.scrollY + window.innerHeight;
        if (y >= document.body.scrollHeight - 2 && last === y) break;
        last = y;
      }
      window.scrollTo(0, 0);
    });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    // force-load lazy attributes
    await page.evaluate(() => {
      for (const img of document.querySelectorAll('img')) {
        for (const a of ['data-src', 'data-original', 'data-lazy', 'data-lazy-src', 'data-url']) {
          const v = img.getAttribute(a);
          if (v && !img.src.includes(v)) img.src = v;
        }
      }
    });
    await page.waitForTimeout(1500);
    const dom = await page.evaluate(() => {
      const abs = (u) => {
        try { return new URL(u, location.href).toString(); } catch { return null; }
      };
      const srcsetUrls = (s) => (s || '').split(',').map((p) => p.trim().split(/\s+/)[0]).filter(Boolean);
      const images = [];
      for (const img of document.querySelectorAll('img')) {
        const urls = [img.currentSrc, img.src, ...srcsetUrls(img.srcset), ...['data-src', 'data-original', 'data-lazy', 'data-lazy-src', 'data-url', 'data-srcset'].flatMap((a) => srcsetUrls(img.getAttribute(a)))].map(abs).filter(Boolean);
        images.push({ urls: [...new Set(urls)], alt: img.alt || '', w: img.naturalWidth, h: img.naturalHeight, caption: img.closest('figure')?.querySelector('figcaption')?.innerText || '' });
      }
      for (const s of document.querySelectorAll('picture source')) images.push({ urls: srcsetUrls(s.srcset).map(abs).filter(Boolean), alt: '' });
      const videos = [];
      for (const v of document.querySelectorAll('video')) {
        const urls = [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)].map(abs).filter(Boolean);
        videos.push({ urls: [...new Set(urls)], poster: v.poster ? abs(v.poster) : null });
      }
      const backgrounds = new Set();
      for (const el of document.querySelectorAll('*')) {
        const bg = getComputedStyle(el).backgroundImage;
        if (bg && bg !== 'none') for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) { const u = abs(m[1]); if (u && !u.startsWith('data:')) backgrounds.add(u); }
      }
      const embeds = [...document.querySelectorAll('iframe')].map((f) => f.src).filter(Boolean);
      const meta = (n) => document.querySelector(`meta[property="${n}"],meta[name="${n}"]`)?.getAttribute('content') || null;
      const icons = [...document.querySelectorAll('link[rel*="icon"]')].map((l) => abs(l.href)).filter(Boolean);
      const headings = [...document.querySelectorAll('h1,h2,h3')].map((h) => h.innerText.trim()).filter(Boolean).slice(0, 80);
      const links = [...document.querySelectorAll('a[href]')].map((a) => abs(a.getAttribute('href'))).filter(Boolean);
      return { title: document.title, description: meta('description') || meta('og:description'), ogImage: meta('og:image') ? abs(meta('og:image')) : null, images, videos, backgrounds: [...backgrounds], embeds, icons, headings, links, text: document.body.innerText.slice(0, 200000), html: document.documentElement.outerHTML };
    });
    Object.assign(rec, { title: dom.title, description: dom.description, ogImage: dom.ogImage, headings: dom.headings, text: dom.text, images: dom.images, videos: dom.videos, backgrounds: dom.backgrounds, icons: dom.icons });
    for (const l of dom.links) enqueue(l);
    for (const e of dom.embeds) {
      const yt = e.match(/(?:youtube\.com\/embed\/|youtube-nocookie\.com\/embed\/|youtu\.be\/)([\w-]{6,})/);
      const vimeo = e.match(/player\.vimeo\.com\/video\/(\d+)/);
      const emb = { pageUrl: url, src: e, provider: yt ? 'youtube' : vimeo ? 'vimeo' : 'iframe', id: yt?.[1] ?? vimeo?.[1] ?? null };
      rec.embeds.push(emb);
      manifest.embeds.push(emb);
      if (yt) for (const q of ['maxresdefault', 'hqdefault']) pending.push(fetchAndSave(`https://i.ytimg.com/vi/${yt[1]}/${q}.jpg`, url, 'youtube-thumbnail'));
    }
    await writeFile(path.join(OUT, 'pages', `${rec.slug}.html`), dom.html);
    await writeFile(path.join(OUT, 'pages', `${rec.slug}.txt`), dom.text);
    await page.screenshot({ path: path.join(OUT, 'pages', `${rec.slug}.jpg`), fullPage: true, type: 'jpeg', quality: 60 }).catch(() => {});
  } catch (e) {
    rec.error = String(e?.message || e);
    manifest.failures.push({ url, reason: rec.error });
  }
  await Promise.all(pending);
  // explicitly fetch every DOM-referenced media URL the network log did not capture
  const referenced = [
    ...rec.images.flatMap((i) => i.urls.map((u) => [u, 'img', i.alt])),
    ...rec.videos.flatMap((v) => [...v.urls.map((u) => [u, 'video', '']), ...(v.poster ? [[v.poster, 'poster', '']] : [])]),
    ...rec.backgrounds.map((u) => [u, 'background', '']),
    ...(rec.icons || []).map((u) => [u, 'icon', '']),
    ...(rec.ogImage ? [[rec.ogImage, 'og:image', '']] : []),
  ];
  for (const [u, role, alt] of referenced) {
    if (!/^https?:/.test(u)) continue;
    if (!manifest.byUrl[u]) await fetchAndSave(u, url, role);
    const sha = manifest.byUrl[u];
    if (sha) {
      const a = manifest.assets[sha];
      if (!a.roles.includes(role)) a.roles.push(role);
      if (alt && !a.alts.includes(alt)) a.alts.push(alt);
      if (!a.pageUrls.includes(url)) a.pageUrls.push(url);
    }
  }
  rec.assetShas = [...new Set(referenced.map(([u]) => manifest.byUrl[u]).filter(Boolean))];
  manifest.pages.push(rec);
  await page.close();
  console.log(`[${pageCount}] ${url} → ${rec.assetShas.length} media, queue ${queue.length}`);
  await new Promise((r) => setTimeout(r, 400));
}

async function fetchAndSave(u, pageUrl, role) {
  try {
    const r = await context.request.get(u, { headers: { referer: pageUrl }, timeout: 120000 });
    if (!r.ok()) {
      manifest.failures.push({ url: u, pageUrl, reason: `HTTP ${r.status()}` });
      return null;
    }
    const sha = await saveAsset(u, await r.body(), r.headers()['content-type'] || '', { pageUrl });
    if (sha && role && !manifest.assets[sha].roles.includes(role)) manifest.assets[sha].roles.push(role);
    return sha;
  } catch (e) {
    manifest.failures.push({ url: u, pageUrl, reason: String(e?.message || e).slice(0, 200) });
    return null;
  }
}

await browser.close();
manifest.summary = {
  pages: manifest.pages.length,
  assets: Object.keys(manifest.assets).length,
  images: Object.values(manifest.assets).filter((a) => a.contentType.startsWith('image/')).length,
  videos: Object.values(manifest.assets).filter((a) => a.contentType.startsWith('video/')).length,
  embeds: manifest.embeds.length,
  bytes: Object.values(manifest.assets).reduce((s, a) => s + a.bytes, 0),
  failures: manifest.failures.length,
};
await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify(manifest.summary));
