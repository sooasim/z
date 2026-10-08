#!/usr/bin/env node
/**
 * Tiny static server that mimics GitHub Pages for dist-pages/ (project site under a basePath).
 *   node scripts/pages/serve.mjs [--port 4173] [--base /z]
 * - /<base>/foo/ → dist-pages/foo/index.html, /<base>/foo → 301 to /<base>/foo/ (like Pages)
 * - unknown paths → dist-pages/404.html with status 404; paths outside the base → plain 404
 */
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const PORT = Number(opt('port', process.env.PORT || 4173));
const rawBase = opt('base', process.env.NEXT_BASE_PATH ?? '/z');
const BASE = rawBase === '/' || rawBase === '' ? '' : '/' + rawBase.replace(/^\/+|\/+$/g, '');
const DIR = path.resolve(opt('dir', path.join(ROOT, 'dist-pages')));
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2', '.map': 'application/json' };

function send(res, file, status = 200) {
  res.writeHead(status, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  createReadStream(file).pipe(res);
}

createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  let p = decodeURIComponent(u.pathname);
  if (BASE && p !== BASE && !p.startsWith(BASE + '/')) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end(`404 — outside ${BASE}/ (GitHub Pages would serve the user site here)`);
  }
  p = p.slice(BASE.length) || '/';
  const file = path.join(DIR, p);
  if (!file.startsWith(DIR)) return res.writeHead(400).end();
  if (existsSync(file) && statSync(file).isDirectory()) {
    if (!p.endsWith('/')) {
      res.writeHead(301, { location: `${BASE}${p}/${u.search}` });
      return res.end();
    }
    if (existsSync(path.join(file, 'index.html'))) return send(res, path.join(file, 'index.html'));
  } else if (existsSync(file)) return send(res, file);
  else if (existsSync(file + '.html')) return send(res, file + '.html');
  const nf = path.join(DIR, '404.html');
  if (existsSync(nf)) return send(res, nf, 404);
  res.writeHead(404).end('not found');
}).listen(PORT, () => console.log(`[pages] serving ${path.relative(ROOT, DIR) || DIR} at http://localhost:${PORT}${BASE}/`));
