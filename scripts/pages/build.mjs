#!/usr/bin/env node
/**
 * Static GitHub Pages build of the REAL apps/web UI (no server):
 *
 *   NEXT_BASE_PATH=/z node scripts/pages/build.mjs        → dist-pages/
 *
 * apps/web is never modified. It is copied to .pages-build/web and, in the copy only:
 *   - app/api/** and middleware.ts are removed (no server at runtime),
 *   - next.config gets output:'export', basePath, trailingSlash, images.unoptimized (headers/rewrites stripped),
 *   - every dynamic route gets generateStaticParams() from the recorded fixture ids (+ id pools for demo-created
 *     bookings/exchanges/orders…) and dynamicParams = false,
 *   - app/layout.tsx loads <basePath>/demo-backend.js synchronously first thing in <head> (packages/demo), which
 *     answers the API and the /api/auth BFF from packages/demo/fixtures/api.json + localStorage,
 *   - root-relative asset URLs and window.location navigations are made basePath-aware,
 *   - the PWA service worker is replaced by a self-unregistering no-op.
 * Build-time server fetches (generateMetadata, sitemap) hit a local fixture server, so prerendered HTML carries
 * real titles. Output: dist-pages/ with .nojekyll and 404.html.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEB = path.join(ROOT, 'apps/web');
const DEMO = path.join(ROOT, 'packages/demo');
const WORK = path.join(ROOT, '.pages-build');
const COPY = path.join(WORK, 'web');
const OUT = path.join(ROOT, 'dist-pages');
const FIXTURES = path.join(DEMO, 'fixtures/api.json');

const rawBase = process.env.NEXT_BASE_PATH ?? process.env.BASE_PATH ?? '/z';
const BASE = rawBase === '/' || rawBase === '' ? '' : '/' + rawBase.replace(/^\/+|\/+$/g, '');
const ORIGIN = (process.env.PAGES_ORIGIN || 'https://sooasim.github.io').replace(/\/+$/, '');
const log = (...a) => console.log('[pages]', ...a);

async function run(cmd, args, opts = {}) {
  await new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: 'inherit', ...opts });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`))));
    p.on('error', reject);
  });
}

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.next' || e.name === 'out') continue;
      await walk(p, out);
    } else out.push(p);
  }
  return out;
}

// ----------------------------------------------------------------------------------------------- fixtures
if (!existsSync(FIXTURES)) {
  console.error(`[pages] missing ${path.relative(ROOT, FIXTURES)} — record it first: bash scripts/pages/record.sh`);
  process.exit(1);
}
const fx = JSON.parse(await readFile(FIXTURES, 'utf8'));
const uniq = (...lists) => [...new Set(lists.flat().filter(Boolean))];
const pool = (k) => fx.idPool?.[k] ?? [];

/** Route (segments before the dynamic param) → values for generateStaticParams. */
function paramValues(routeDir, param) {
  const r = routeDir.replace(/\\/g, '/');
  if (/^auth\/callback$/.test(r)) return ['google', 'kakao', 'naver'];
  if (/^exchange$/.test(r)) return uniq(fx.ids.exchangeIds, pool('exchange'));
  if (/^guide-bookings$/.test(r)) return uniq(fx.ids.guideBookingIds, pool('guideBooking'));
  if (/^guide-requests$/.test(r)) return uniq(fx.ids.guideRequestIds, pool('guideRequest'));
  if (/^guides$/.test(r)) return uniq(fx.ids.guideIds);
  if (/^host\/listings$/.test(r)) return uniq(fx.ids.hostPropertyIds, fx.ids.propertyIds, pool('property'));
  if (/^orders$/.test(r)) return uniq(fx.ids.orderIds, pool('order'));
  if (/^stay$/.test(r)) return uniq(fx.ids.propertySlugs, pool('property').map((id) => `demo-${id.slice(0, 8)}`));
  if (/^stories$/.test(r)) return uniq(fx.ids.storySlugs);
  if (/^travel$/.test(r)) return uniq(fx.ids.travelProductIds);
  if (/^trips$/.test(r)) return uniq(fx.ids.reservationIds, pool('reservation'));
  console.warn(`[pages] WARN no id list for dynamic route /${r}/[${param}] — prerendering a placeholder only`);
  return ['demo'];
}

// ----------------------------------------------------------------------------------------------- fixture server
/** Anonymous recorded responses for build-time server fetches (serverGet in generateMetadata / sitemap). */
function startFixtureServer() {
  const byPath = new Map();
  for (const [k, r] of Object.entries(fx.responses)) {
    if (!k.startsWith('anon|GET ')) continue;
    const rest = k.slice('anon|GET '.length);
    const q = rest.indexOf('?');
    const p = q < 0 ? rest : rest.slice(0, q);
    if (!byPath.has(p)) byPath.set(p, []);
    byPath.get(p).push({ params: new URLSearchParams(q < 0 ? '' : rest.slice(q + 1)), r });
  }
  const prefix = (v) => (typeof v === 'string' ? (/^\/(placeholder|art|icons)\//.test(v) ? BASE + v : v) : Array.isArray(v) ? v.map(prefix) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, prefix(x)])) : v);
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const cands = byPath.get(u.pathname) ?? [];
    let best = null;
    let bs = -Infinity;
    for (const c of cands) {
      let s = 0;
      for (const [k, v] of u.searchParams) s += c.params.get(k) === v ? 3 : c.params.has(k) ? -2 : -0.2;
      for (const [k] of c.params) if (!u.searchParams.has(k)) s -= 0.5;
      if (s > bs) (bs = s), (best = c);
    }
    if (!best) {
      res.writeHead(404, { 'content-type': 'application/problem+json' });
      return res.end(JSON.stringify({ status: 404, code: 'NOT_FOUND' }));
    }
    res.writeHead(best.r.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(prefix(fx.bodies[best.r.body])));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ----------------------------------------------------------------------------------------------- main
log(`basePath "${BASE || '/'}", origin ${ORIGIN}`);

// 1) demo runtime bundle
await run(process.execPath, [path.join(DEMO, 'build.mjs')], { cwd: DEMO });

// 2) fresh copy of apps/web (node_modules is symlinked, never reinstalled)
await rm(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
await mkdir(COPY, { recursive: true });
await cp(WEB, COPY, {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(WEB, src).replace(/\\/g, '/');
    return !/^(node_modules|\.next|out|test|coverage)(\/|$)/.test(rel) && !/\.tsbuildinfo$/.test(rel) && !/\.test\.tsx?$/.test(rel);
  },
});
await symlink(path.join(WEB, 'node_modules'), path.join(COPY, 'node_modules'), 'dir');
log('copied apps/web →', path.relative(ROOT, COPY));

// 3) no server at runtime
await rm(path.join(COPY, 'app/api'), { recursive: true, force: true });
await rm(path.join(COPY, 'middleware.ts'), { force: true });
await rm(path.join(COPY, 'middleware.js'), { force: true });

// 4) next.config: keep the real config, strip what a static export cannot do
const { build: esbuild } = await import(pathToFileURL(path.join(DEMO, 'node_modules/esbuild/lib/main.js')).href);
const cfgSrc = ['next.config.ts', 'next.config.mjs', 'next.config.js'].map((f) => path.join(COPY, f)).find((f) => existsSync(f));
if (cfgSrc) {
  await esbuild({ entryPoints: [cfgSrc], outfile: path.join(COPY, 'next.config.base.mjs'), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'error' });
  await rm(cfgSrc);
}
await writeFile(
  path.join(COPY, 'next.config.mjs'),
  `// Generated by scripts/pages/build.mjs for the GitHub Pages static demo.
import base from './next.config.base.mjs';
const UNSUPPORTED = ['headers', 'rewrites', 'redirects', 'serverExternalPackages', 'serverActions', 'i18n'];
const real = typeof base === 'function' ? await base('phase-export', {}) : base ?? {};
const kept = Object.fromEntries(Object.entries(real).filter(([k]) => !UNSUPPORTED.includes(k)));
export default {
  ...kept,
  output: 'export',
  basePath: ${JSON.stringify(BASE)},
  trailingSlash: true,
  images: { ...(kept.images ?? {}), unoptimized: true },
  typescript: { ...(kept.typescript ?? {}), ignoreBuildErrors: true },
  eslint: { ...(kept.eslint ?? {}), ignoreDuringBuilds: true },
  experimental: { ...(kept.experimental ?? {}) },
};
`,
);

// 5) source patches (copy only)
// Root-relative URLs of anything served from public/ (/art/…, /fonts/…, /icons/…, /manifest.webmanifest, …) must carry
// the basePath; next/link and the router add it themselves, plain strings in TS/CSS do not.
const publicEntries = existsSync(path.join(COPY, 'public')) ? (await readdir(path.join(COPY, 'public'), { withFileTypes: true })) : [];
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const pubDirs = publicEntries.filter((e) => e.isDirectory()).map((e) => esc(e.name));
const pubFiles = publicEntries.filter((e) => e.isFile()).map((e) => esc(e.name));
const dirRe = pubDirs.length ? new RegExp(`(['"\`(])\\/(${pubDirs.join('|')})\\/`, 'g') : null;
const fileRe = pubFiles.length ? new RegExp(`(['"\`(])\\/(${pubFiles.join('|')})(?=['"\`)?#])`, 'g') : null;
const files = (await walk(COPY)).filter((f) => /\.(tsx?|css)$/.test(f) && !f.includes(`${path.sep}node_modules${path.sep}`));
let patchedAssets = 0;
let patchedLoc = 0;
for (const f of files) {
  let s = await readFile(f, 'utf8');
  const before = s;
  if (BASE) {
    if (dirRe) s = s.replace(dirRe, (_, q, d) => `${q}${BASE}/${d}/`);
    if (fileRe) s = s.replace(fileRe, (_, q, n) => `${q}${BASE}/${n}`);
  }
  if (s !== before) patchedAssets++;
  if (/\.tsx?$/.test(f)) {
    const b2 = s;
    s = s.replace(/\bwindow\.location\.(href|pathname|assign|replace)\b/g, (_, k) => `((window as any).__jpLoc || window.location).${k}`);
    if (s !== b2) patchedLoc++;
    // route segment config a static export cannot honour
    s = s.replace(/^export const (dynamic|revalidate|fetchCache|runtime|preferredRegion) = [^;]+;?\s*$/gm, '');
  }
  if (s !== before) await writeFile(f, s);
}
log(`basePath-aware assets in ${patchedAssets} files, location helpers in ${patchedLoc} files`);

for (const meta of ['sitemap.ts', 'robots.ts', 'manifest.ts']) {
  const f = path.join(COPY, 'app', meta);
  if (existsSync(f)) await writeFile(f, `export const dynamic = 'force-static';\n` + (await readFile(f, 'utf8')));
}

// 6) generateStaticParams for every dynamic route
const appDir = path.join(COPY, 'app');
const pages = (await walk(appDir)).filter((f) => /[\\/]page\.(tsx|ts|jsx|js)$/.test(f) && /\[[^\]]+\]/.test(path.relative(appDir, f)));
let prerender = 0;
for (const f of pages) {
  const rel = path.relative(appDir, path.dirname(f)).replace(/\\/g, '/');
  const segs = rel.split('/');
  const dyn = segs.map((s, i) => [s, i]).filter(([s]) => /^\[[^\]]+\]$/.test(s));
  if (dyn.some(([s]) => s.startsWith('[...') || s.startsWith('[[...'))) {
    console.warn(`[pages] WARN catch-all route ${rel} skipped`);
    continue;
  }
  if (dyn.length !== 1) throw new Error(`unsupported nested dynamic route: ${rel}`);
  const [seg, idx] = dyn[0];
  const param = seg.slice(1, -1);
  const values = paramValues(segs.slice(0, idx).filter((s) => !/^\(.*\)$/.test(s)).join('/'), param);
  prerender += values.length;
  let src = await readFile(f, 'utf8');
  if (/^\s*['"]use client['"]/.test(src)) throw new Error(`${rel}/page is a client component; cannot add generateStaticParams`);
  if (!/export (async )?function generateStaticParams|export const generateStaticParams/.test(src)) {
    src += `\n\n// --- added by scripts/pages/build.mjs (static demo) ---\nexport function generateStaticParams() {\n  return ${JSON.stringify(values.map((v) => ({ [param]: v })))};\n}\nexport const dynamicParams = false;\n`;
    await writeFile(f, src);
  }
}
log(`generateStaticParams added to ${pages.length} dynamic pages (${prerender} prerendered paths)`);

// 7) demo runtime first thing in <head>
const layoutPath = ['layout.tsx', 'layout.jsx', 'layout.js'].map((x) => path.join(appDir, x)).find((x) => existsSync(x));
let layout = await readFile(layoutPath, 'utf8');
// Cache-busting: GitHub Pages serves with max-age=600, so a redeploy must not mix an old runtime with new fixtures.
const fixturesJson = JSON.stringify(fx);
const runtimeJs = await readFile(path.join(DEMO, 'dist/demo-backend.js'), 'utf8');
const ver = createHash('sha256').update(runtimeJs).update(fixturesJson).digest('hex').slice(0, 10);
const runtimeSrc = `${BASE}/demo-backend.js?v=${ver}`;
const fixturesSrc = `${BASE}/demo-fixtures.json?v=${ver}`;
const tag = `<script src="${runtimeSrc}" data-jetpool-demo="" data-fixtures="${fixturesSrc}" />`;
if (/<head(\s[^>]*)?>/.test(layout)) layout = layout.replace(/<head(\s[^>]*)?>/, (m) => `${m}\n        ${tag}`);
else if (/<html[^>]*>/.test(layout)) layout = layout.replace(/<html[^>]*>/, (m) => `${m}\n      <head>${tag}</head>`);
else throw new Error('could not find <head> or <html> in app/layout');
await writeFile(layoutPath, layout);

// 8) public/: runtime, fixtures, no-op service worker
const pub = path.join(COPY, 'public');
await mkdir(pub, { recursive: true });
await cp(path.join(DEMO, 'dist/demo-backend.js'), path.join(pub, 'demo-backend.js'));
await writeFile(path.join(pub, 'demo-fixtures.json'), fixturesJson);
await writeFile(
  path.join(pub, 'sw.js'),
  `/* Static demo: no offline cache. Removes any previously installed JETPOOL service worker. */\nself.addEventListener('install', () => self.skipWaiting());\nself.addEventListener('activate', (e) => e.waitUntil(self.registration.unregister().then(() => self.clients.matchAll()).then((cs) => cs.forEach((c) => c.navigate && c.navigate(c.url)))));\n`,
);

// 9) next build (static export) with a fixture server for build-time fetches
const server = await startFixtureServer();
const port = server.address().port;
log(`fixture server for build-time fetches on :${port}`);
const env = {
  ...process.env,
  NODE_ENV: 'production',
  NEXT_TELEMETRY_DISABLED: '1',
  NEXT_PUBLIC_API_URL: `${ORIGIN}${BASE}/__demo_api`,
  NEXT_PUBLIC_SITE_URL: `${ORIGIN}${BASE}`,
  API_INTERNAL_URL: `http://127.0.0.1:${port}`,
  NEXT_PUBLIC_DEMO: '1',
};
try {
  await run(process.execPath, [path.join(COPY, 'node_modules/next/dist/bin/next'), 'build'], { cwd: COPY, env });
} finally {
  server.close();
}

// 10) dist-pages
const outDir = path.join(COPY, 'out');
await rm(OUT, { recursive: true, force: true });
await cp(outDir, OUT, { recursive: true });
await writeFile(path.join(OUT, '.nojekyll'), '');
if (!existsSync(path.join(OUT, '404.html'))) {
  for (const c of ['404/index.html', '_not-found/index.html', '_not-found.html']) {
    if (existsSync(path.join(OUT, c))) {
      await cp(path.join(OUT, c), path.join(OUT, '404.html'));
      break;
    }
  }
}
// The runtime must run before any Next chunk: put a parser-blocking copy at the very top of every <head>
// (React 19 skips unknown head nodes on hydration; the layout's own tag then no-ops thanks to the boot guard).
let injected = 0;
for (const f of (await walk(OUT)).filter((x) => x.endsWith('.html'))) {
  const html = await readFile(f, 'utf8');
  if (html.includes('data-jetpool-demo-early')) continue;
  const next = html.replace(/<head>/, `<head><script src="${runtimeSrc}" data-jetpool-demo-early="" data-fixtures="${fixturesSrc}"></script>`);
  if (next !== html) {
    await writeFile(f, next);
    injected++;
  }
}
log(`runtime injected at the top of <head> in ${injected} HTML files`);
const all = await walk(OUT);
let bytes = 0;
for (const f of all) bytes += (await stat(f)).size;
log(`dist-pages/: ${all.filter((f) => f.endsWith('.html')).length} HTML pages, ${all.length} files, ${(bytes / 1048576).toFixed(1)} MB`);
log(`preview: node scripts/pages/serve.mjs  →  http://localhost:4173${BASE}/`);
