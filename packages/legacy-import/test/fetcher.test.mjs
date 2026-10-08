import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { Fetcher } from '../src/http.mjs';
import { RobotsCache } from '../src/robots.mjs';
import { PERMANENT_ERRORS } from '../src/download.mjs';
import { tempDir, UA } from './helpers.mjs';

let server;
let base;
const log = [];
const hits = new Map();

before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    log.push({ path: u.pathname, at: Date.now(), ua: req.headers['user-agent'] });
    hits.set(u.pathname, (hits.get(u.pathname) ?? 0) + 1);
    if (u.pathname === '/ok') return res.end('ok');
    if (u.pathname === '/flaky') {
      if (hits.get('/flaky') <= 2) {
        res.writeHead(503, { 'retry-after': '0' });
        return res.end('busy');
      }
      return res.end('finally');
    }
    if (u.pathname === '/big') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(Buffer.alloc(5000, 1));
    }
    if (u.pathname === '/away') {
      res.writeHead(302, { location: 'http://evil.example/x' });
      return res.end();
    }
    if (u.pathname === '/hop') {
      res.writeHead(301, { location: '/ok' });
      return res.end();
    }
    if (u.pathname === '/hang') return; // never answers
    if (u.pathname === '/robots.txt') return res.end('User-agent: *\nDisallow: /nope\nCrawl-delay: 0.05');
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise((r) => server.close(r));
});

test('sends the migration User-Agent and spaces request starts per host (delay) with concurrency cap', async () => {
  const f = new Fetcher({ concurrency: 2, delayMs: 150, useProxy: false });
  await f.get(`${base}/ok`); // warm the connection so arrival times reflect request starts
  log.length = 0;
  const t0 = Date.now();
  await Promise.all([1, 2, 3, 4].map(() => f.get(`${base}/ok`)));
  await f.close();
  assert.equal(log.length, 4);
  assert.ok(log.every((l) => l.ua === UA));
  const starts = log.map((l) => l.at).sort((a, b) => a - b);
  // 4 starts on one host need ≥ 3 delay intervals (connection jitter tolerated per gap)
  assert.ok(starts[3] - t0 >= 3 * 150 - 30, `total ${starts[3] - t0} ms`);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 100, `gap ${starts[i] - starts[i - 1]} ms`);
});

test('retries 5xx with backoff, then succeeds; gives up after the retry budget', async () => {
  hits.delete('/flaky');
  const f = new Fetcher({ retries: 3, retryBaseMs: 5, delayMs: 0, useProxy: false });
  const r = await f.get(`${base}/flaky`);
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
  assert.equal(r.body.toString(), 'finally');
  hits.delete('/flaky');
  const g = await f.get(`${base}/flaky`, { retries: 1 });
  assert.equal(g.ok, false);
  assert.equal(g.error, 'HTTP_503');
  await f.close();
});

test('redirect hops are checked against the allowlist; byte caps and timeouts are enforced', async () => {
  const f = new Fetcher({ delayMs: 0, retries: 0, timeoutMs: 300, useProxy: false });
  const allowUrl = (u) => (new URL(u).hostname === '127.0.0.1' ? true : 'HOST_NOT_ALLOWED');
  const away = await f.get(`${base}/away`, { allowUrl });
  assert.equal(away.ok, false);
  assert.equal(away.error, 'HOST_NOT_ALLOWED');
  const hop = await f.get(`${base}/hop`, { allowUrl });
  assert.equal(hop.ok, true);
  assert.equal(hop.redirects.length, 1);
  assert.equal(hop.url, `${base}/ok`);
  const big = await f.get(`${base}/big`, { maxBytes: 1000 });
  assert.equal(big.error, 'TOO_LARGE');
  const dir = await tempDir();
  const file = path.join(dir, 'big.bin');
  const toFile = await f.get(`${base}/big`, { toFile: file, maxBytes: 10_000 });
  assert.equal(toFile.ok, true);
  assert.equal(toFile.bytes, 5000);
  assert.equal((await readFile(file)).length, 5000);
  const t0 = Date.now();
  const hang = await f.get(`${base}/hang`);
  assert.equal(hang.error, 'TIMEOUT');
  assert.ok(Date.now() - t0 < 3000);
  await f.close();
});

test('robots cache: disallow rules and Crawl-delay raise the per-host delay', async () => {
  const f = new Fetcher({ delayMs: 1, useProxy: false });
  const robots = new RobotsCache(f, { userAgent: UA });
  assert.equal(await robots.check(`${base}/nope/x`), 'ROBOTS_DISALLOWED');
  assert.equal(await robots.check(`${base}/ok`), true);
  assert.equal(f.hostDelay.get(new URL(base).host), 50);
  await f.close();
});

test('unreachable robots.txt (5xx) disallows everything but with a retryable reason, never a permanent one', async () => {
  const srv = http.createServer((req, res) => {
    res.writeHead(req.url === '/robots.txt' ? 503 : 200);
    res.end('x');
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${srv.address().port}`;
  const f = new Fetcher({ delayMs: 0, retries: 0, retryBaseMs: 1, useProxy: false });
  const robots = new RobotsCache(f, { userAgent: UA });
  const r = await robots.check(`${origin}/img/a.jpg`);
  assert.match(r, /^ROBOTS_UNREACHABLE HTTP_503$/);
  assert.ok(!PERMANENT_ERRORS.test(r), 'downloads blocked this way are retried by --resume');
  assert.ok(PERMANENT_ERRORS.test('ROBOTS_DISALLOWED') && PERMANENT_ERRORS.test('HTTP_404') && !PERMANENT_ERRORS.test('PROXY_403'));
  await f.close();
  await new Promise((res) => srv.close(res));
});
