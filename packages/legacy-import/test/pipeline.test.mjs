import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import { startFixture } from './fixture-server.mjs';
import { runFixture, snapshotTree, tempDir, UA } from './helpers.mjs';
import { parseCsvForTest } from './csv.mjs';

/**
 * Full pipeline (crawl → download → optimise → publish → import → report) against the local Sixshop-like fixture,
 * into a temp out dir and a temp public dir (never the real apps/web/public/legacy).
 */

let f;
let dir;
let first;
let inv;
let manifest;
let report;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const pageOf = (p) => inv.pages.find((x) => new URL(x.url).pathname + new URL(x.url).search === p);
const cdn = (p) => `${f.cdn}${p}`;

before(async () => {
  f = await startFixture();
  dir = await tempDir();
  // a browser HAR that saw a JavaScript-loaded slide the static HTML never mentions (--extra-media)
  const har = { log: { version: '1.2', pages: [{ id: 'page_1', title: `${f.site}/` }], entries: [
    { pageref: 'page_1', request: { url: `${f.cdn}/uploadedFiles/56465/slider/slide-2.jpg`, headers: [] }, response: { status: 200, content: { mimeType: 'image/jpeg' } } },
    { pageref: 'page_1', request: { url: `${f.site}/app.js`, headers: [] }, response: { status: 200, content: { mimeType: 'application/javascript' } } },
  ] } };
  await writeFile(path.join(dir, 'session.har'), JSON.stringify(har));
  first = await runFixture(f, dir, 'all', { extraMedia: path.join(dir, 'session.har') });
  inv = JSON.parse(await readFile(path.join(first.cfg.outDir, 'inventory.json'), 'utf8'));
  manifest = JSON.parse(await readFile(path.join(first.cfg.outDir, 'manifest.json'), 'utf8'));
  report = first.results.report;
});

after(async () => {
  await f?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});

test('crawl: BFS over links + sitemap, dedupes URL variants, records page data, writes inventory.json + urls.csv', async () => {
  const ok = inv.pages.filter((p) => p.ok && !p.aliasOf && !p.template).map((p) => new URL(p.url).pathname + new URL(p.url).search).sort();
  assert.deepEqual(ok, ['/', '/about_jetpool', '/blogPost/heart_letter_01', '/board/story/1', '/localLife', '/local_guide', '/product/past_trip', '/tour_ticket', '/tour_ticket?idx=1']);
  // /home serves the same bytes as / → alias, not a duplicate page
  assert.equal(pageOf('/home').aliasOf, `${f.site}/`);
  // Sixshop's default editor manual is crawled (links are followed) but flagged as a template page
  assert.equal(pageOf('/guide').template, true);
  assert.ok(ok.every((p) => !pageOf(p).template));
  // /old-about 301 → /about_jetpool is kept as an alias, not a second page
  assert.equal(pageOf('/old-about').aliasOf, `${f.site}/about_jetpool`);
  // ?utm_source and trailing-slash variants of the story are the same page
  assert.equal(inv.pages.filter((p) => p.url.includes('/board/story/1')).length, 1);
  assert.equal(pageOf('/guide').via, 'sitemap', '/guide is only reachable through sitemap.xml');
  const home = pageOf('/');
  assert.equal(home.title, '원트트래블클럽 | WONT Travel Club');
  assert.equal(home.description, '한달살기 맞교환, 전세기 공유 JETPOOL, Local Life — WONT Travel Club');
  assert.equal(home.canonical, `${f.site}/`);
  assert.equal(home.og.image, cdn('/uploadedFiles/56465/og/og-home.jpg'));
  assert.deepEqual(home.headings.map((h) => h.text), ['원하는 곳에서 살아보는 여행', '한달살기 맞교환', '서울의 하루', 'WONT 영상']);
  assert.ok(home.textBlocks.some((b) => b.text === '제주 돌담집에서 한 달, 서울 아파트에서 한 달.\n숙박비 없이 집을 바꿔 살아요.'));
  assert.ok(home.links.some((l) => l.url === 'https://www.instagram.com/wontc'));
  assert.equal(home.jsonLd[0]['@type'], 'Organization');
  // HTML snapshot stored and hashed
  const snap = await readFile(path.join(first.cfg.outDir, home.snapshot));
  assert.equal(sha(snap), home.sha256);
  const csv = parseCsvForTest(await readFile(path.join(first.cfg.outDir, 'urls.csv'), 'utf8'));
  assert.ok(csv.some((r) => r.url === `${f.site}/about_jetpool` && r.ok === 'yes' && r.title.startsWith('JETPOOL')));
  assert.ok(csv.some((r) => r.url === `${f.site}/private/secret` && r.ok === 'skipped' && r.error === 'ROBOTS_DISALLOWED'));
});

test('robots.txt disallow rules and exclusion patterns are respected; every request carries the migration UA', () => {
  const skipped = Object.fromEntries(inv.skipped.map((s) => [new URL(s.url).pathname + new URL(s.url).search, s.reason]));
  assert.equal(skipped['/private/secret'], 'ROBOTS_DISALLOWED');
  assert.equal(skipped['/tour_ticket?view=list'], 'ROBOTS_DISALLOWED');
  assert.equal(skipped['/login'], 'EXCLUDED_PATTERN');
  assert.equal(skipped['/cart'], 'EXCLUDED_PATTERN');
  const paths = f.requests.map((r) => r.path);
  for (const forbidden of ['/private/secret', '/tour_ticket?view=list', '/login', '/cart', '/images/secret.jpg', '/uploadedFiles/113/default/image_1460688831888.jpg']) {
    assert.ok(!paths.some((p) => p === forbidden), `${forbidden} must never be requested`);
  }
  assert.ok(!paths.some((p) => /\.(woff2?|ttf)$/.test(p)), 'fonts are not media');
  assert.ok(!paths.some((p) => p.includes('blank.gif')), 'lazy-load placeholders are not fetched');
  const firstSite = f.requests.find((r) => r.server === 'site');
  assert.equal(firstSite.path, '/robots.txt', 'robots.txt is fetched before any page');
  assert.ok(f.requests.every((r) => r.ua === UA));
});

test('extraction: lazy attrs, srcset, picture, CSS (inline/<style>/linked/@import/image-set), og/twitter, icons, video, poster, script JSON, embeds', () => {
  const urls = (p) => new Set(pageOf(p).media.map((m) => m.url));
  const home = urls('/');
  const expectHome = [
    cdn('/uploadedFiles/56465/content/jeju-house.jpg'), // data-src (+ <noscript>)
    cdn('/images/seoul.jpg?w=480'), cdn('/images/seoul.jpg?w=960'), // src + srcset
    cdn('/thumbnails/uploadedFiles/56465/background/image_1000_1600.jpg'), // inline style background
    cdn('/images/flight-share.jpg'), // data-bg
    cdn('/images/banner.webp'), // <style> url()
    cdn('/uploadedFiles/56465/og/og-home.jpg'), // og:image + twitter:image
    cdn('/uploadedFiles/56465/icon/apple-touch-icon.png'), `${f.site}/favicon.ico`,
    `${f.site}/uploads/logo.png`,
    `${f.site}/img/pattern.png`, `${f.site}/img/sprite.png`, `${f.site}/img/sprite@2x.png`, // linked CSS, image-set
    `${f.site}/img/promo-strip.jpg`, // @import-ed CSS
    cdn('/uploadedFiles/56465/gallery/g1.png'), // escaped URL inside inline script JSON
  ];
  for (const u of expectHome) assert.ok(home.has(u), `home is missing ${u}`);
  assert.ok(![...home].some((u) => u.includes('facebook.com') || u.includes('blank.gif') || u.startsWith('data:') || u.includes('/fonts/')));
  const about = urls('/about_jetpool');
  for (const u of [cdn('/images/charter.webp'), cdn('/images/charter.jpg'), cdn('/images/poster.jpg'), cdn('/video/intro.mp4'), cdn('/video/intro.webm')]) assert.ok(about.has(u), `about is missing ${u}`);
  assert.equal(pageOf('/about_jetpool').media.find((m) => m.url === cdn('/images/charter.jpg') && m.via === 'img').caption, '첫 번째 전세기 — 인천에서 오키나와로');
  const ll = urls('/localLife');
  for (const u of [cdn('/uploadedFiles/56465/exchange/busan-home.jpg'), cdn('/uploadedFiles/56465/exchange/seoul-hanok.png'), cdn('/uploadedFiles/56465/exchange/busan-home-large.jpg'), cdn('/images/missing.jpg')]) assert.ok(ll.has(u), `localLife is missing ${u}`);
  assert.deepEqual(pageOf('/').embeds.map((e) => [e.provider, e.videoId, e.title]), [['youtube', 'dQw4w9WgXcQ', 'WONT Travel Club 소개 영상']]);
  assert.deepEqual(pageOf('/board/story/1').embeds.map((e) => e.videoId), ['9bZkp7q19f0']);
  assert.ok(!f.requests.some((r) => r.path.includes('youtube')), 'embedded video streams are not downloaded');
});

test('download: magic bytes + content-type verified, retries, duplicates by sha256, CDN originals preferred, provenance kept', async () => {
  const st = JSON.parse(await readFile(path.join(first.cfg.outDir, 'state', 'assets.json'), 'utf8'));
  const dl = JSON.parse(await readFile(path.join(first.cfg.outDir, 'state', 'downloads.json'), 'utf8'));
  assert.equal(dl.urls[cdn('/images/missing.jpg')].error, 'HTTP_404');
  assert.equal(dl.urls[cdn('/uploadedFiles/56465/product/soft404.jpg')].error, 'NOT_MEDIA text/html');
  assert.equal(dl.urls[cdn('/uploadedFiles/56465/content/flaky.jpg')].status, 'ok', '503 is retried');
  assert.equal(f.requests.filter((r) => r.path === '/uploadedFiles/56465/content/flaky.jpg').length, 2);
  // duplicate bytes under two URLs → one asset
  const jeju = Object.values(st.assets).find((a) => a.sourceUrls.includes(cdn('/uploadedFiles/56465/content/jeju-house.jpg')));
  assert.deepEqual(jeju.sourceUrls, [cdn('/uploadedFiles/56465/content/jeju-house.jpg'), cdn('/uploadedFiles/56465/copy/jeju-house-copy.jpg')].sort());
  assert.deepEqual(jeju.pageUrls.sort(), [`${f.site}/`, `${f.site}/about_jetpool`, `${f.site}/board/story/1`].sort());
  assert.ok(jeju.alts.includes('제주 한달살기 집') && jeju.alts.includes('제주 숙소'));
  assert.equal(jeju.mime, 'image/jpeg');
  assert.equal(sha(await readFile(path.join(first.cfg.outDir, jeju.staging))), jeju.sha256);
  // ?w=480 rendition resolves to the stripped original; Sixshop thumbnail resolves to /uploadedFiles original
  const ref = (u) => st.refs.find((r) => r.url === u);
  assert.equal(st.assets[ref(cdn('/images/seoul.jpg?w=480')).sha256].width, 2000);
  assert.equal(ref(cdn('/images/seoul.jpg?w=480')).variants.length, 1);
  const hero = st.assets[ref(cdn('/thumbnails/uploadedFiles/56465/background/image_1000_1600.jpg')).sha256];
  assert.equal(hero.width, 2400);
  assert.ok(hero.sourceUrls.includes(cdn('/uploadedFiles/56465/background/image_1000.jpg')));
  assert.equal(report.assets.duplicateGroups, 1);
  // video probe (ffprobe present in CI image; otherwise duration is skipped)
  const mp4 = Object.values(st.assets).find((a) => a.mime === 'video/mp4');
  if (first.cfg.ffprobe) assert.ok(Math.abs(mp4.durationMs - 3000) < 200, `duration ${mp4.durationMs}`);
  else assert.equal(mp4.durationMs, null);
});

test('optimise + publish: webp 480/960/1600/2400 without upscaling, blur placeholder, originals kept, unsafe SVG not published', async () => {
  const pub = (p) => path.join(path.dirname(first.cfg.publicDir), ...p.split('/'));
  const byFile = (name) => Object.values(manifest.assets).find((a) => a.files?.original?.endsWith(`/${name}`));
  const charter = byFile('charter.jpg');
  assert.deepEqual(Object.keys(charter.files.webp).map(Number).sort((a, b) => a - b), [480, 960, 1600, 2400]);
  for (const [w, p] of Object.entries(charter.files.webp)) {
    assert.match(p, new RegExp(`^legacy/${charter.id}/charter-${w}\\.webp$`));
    const m = await sharp(pub(p)).metadata();
    assert.equal(m.format, 'webp');
    assert.equal(m.width, Number(w));
  }
  const busan = byFile('busan-home.jpg');
  assert.deepEqual(Object.keys(busan.files.webp).map(Number).sort((a, b) => a - b), [480, 960, 1200], 'no 1600/2400 for a 1200 px original');
  for (const a of Object.values(manifest.assets)) for (const r of a.renditions ?? []) assert.ok(r.width <= a.width, `${a.id} upscaled to ${r.width}`);
  assert.match(charter.placeholder, /^data:image\/webp;base64,[A-Za-z0-9+/=]+$/);
  assert.ok(charter.placeholder.length < 1200);
  assert.match(charter.dominantColor, /^#[0-9a-f]{6}$/);
  // originals are byte-identical copies
  assert.equal(sha(await readFile(pub(charter.files.original))), charter.sha256);
  const unsafe = Object.values(manifest.assets).find((a) => a.mime === 'image/svg+xml' && a.svgSafe === false);
  assert.equal(unsafe.files.original, null, 'SVG with script is never published as-is');
  assert.ok(Object.keys(unsafe.files.webp).length >= 1, 'but a rasterised webp is');
  assert.ok(!existsSync(path.join(first.cfg.publicDir, unsafe.id, 'unsafe.svg')));
  const badge = byFile('badge.svg');
  assert.equal(badge.svgSafe, true);
  const gif = byFile('sparkle.gif');
  assert.equal(gif.animated, true);
  const gm = await sharp(pub(Object.values(gif.files.webp)[0]), { animated: true }).metadata();
  assert.ok(gm.pages > 1, 'animated GIF → animated webp');
  const mp4 = Object.values(manifest.assets).find((a) => a.mime === 'video/mp4');
  const webm = Object.values(manifest.assets).find((a) => a.mime === 'video/webm');
  assert.ok(existsSync(pub(mp4.files.original)) && existsSync(pub(webm.files.original)));
  assert.equal(mp4.posterAssetId, byFile('poster.jpg').id, '<video poster> becomes the poster asset');
  assert.equal(webm.posterAssetId, byFile('poster.jpg').id);
});

test('manifest shape: pages[{url,title,description,headings,text,images,videos,embeds}], assets{id:{kind,sha256,files,placeholder,…}}, files exist', () => {
  assert.ok(Date.parse(manifest.generatedAt));
  assert.equal(manifest.source.site, f.site);
  assert.equal(manifest.pages.length, 9);
  for (const p of manifest.pages) {
    for (const k of ['url', 'title', 'description', 'headings', 'text', 'images', 'videos', 'embeds']) assert.ok(k in p, `${p.url} lacks ${k}`);
    for (const id of [...p.images, ...p.videos, ...p.embeds]) assert.ok(manifest.assets[id], `${p.url} references unknown asset ${id}`);
  }
  const about = manifest.pages.find((p) => p.url === `${f.site}/about_jetpool`);
  assert.deepEqual(about.aliases, [`${f.site}/old-about`]);
  assert.equal(about.videos.length, 2);
  assert.ok(!manifest.pages.find((p) => p.url === `${f.site}/`).text.some((t) => t.includes('사업자등록번호')), 'footer boilerplate is not page text');
  const kinds = { image: 0, video: 0, embed: 0 };
  for (const [id, a] of Object.entries(manifest.assets)) {
    kinds[a.kind]++;
    assert.equal(a.id, id);
    if (a.kind === 'embed') {
      assert.ok(a.videoId && a.watchUrl && 'thumbnailUrl' in a);
      continue;
    }
    assert.equal(id, a.sha256.slice(0, 12));
    for (const k of ['sha256', 'files', 'placeholder', 'width', 'height', 'alt', 'caption', 'sourceUrls', 'pageUrls']) assert.ok(k in a, `${id} lacks ${k}`);
    for (const p of [a.files.original, ...Object.values(a.files.webp ?? {})].filter(Boolean)) {
      assert.ok(p.startsWith(`legacy/${id}/`), p);
      assert.ok(existsSync(path.join(path.dirname(first.cfg.publicDir), p)), `missing published file ${p}`);
    }
  }
  assert.deepEqual(kinds, { image: 35, video: 2, embed: 2 });
  const slide = Object.values(manifest.assets).find((a) => a.files?.original?.endsWith('/slide-2.jpg'));
  assert.ok(slide, 'HAR-only media is migrated');
  assert.ok(manifest.pages.find((p) => p.url === `${f.site}/`).images.includes(slide.id));
  assert.ok(!Object.values(manifest.assets).some((a) => (a.sourceUrls ?? []).some((u) => u.includes('/uploadedFiles/113/'))), 'template sample images are not migrated');
  const logo = Object.values(manifest.assets).find((a) => a.files?.original?.endsWith('/logo.png'));
  assert.equal(logo.chrome, true, 'logo on every page is site chrome');
  const seoulAlt = Object.values(manifest.assets).filter((a) => a.alternateOf);
  assert.equal(seoulAlt.length, 3, 'two ?w= renditions + the Sixshop thumbnail are alternates of their originals');
});

test('report: coverage, failures with reasons, duplicates, bytes; exit code 3 below 100 % unless --allow-partial', async () => {
  assert.equal(first.code, 3);
  assert.equal(report.media.uniqueUrls, 38);
  assert.equal(report.media.resolved, 36);
  assert.equal(report.media.coveragePct, 94.73);
  assert.deepEqual(report.pages.templates.map((t) => new URL(t.url).pathname), ['/guide']);
  assert.deepEqual(Object.keys(report.media.reasons).sort(), ['HTTP_404', 'NOT_MEDIA text/html']);
  assert.ok(report.assets.originalBytes > 0 && report.assets.publishedBytes > report.assets.originalBytes);
  const md = await readFile(path.join(first.cfg.outDir, 'report.md'), 'utf8');
  assert.match(md, /Media coverage: 94\.73%/);
  assert.match(md, /Sixshop template pages/);
  assert.match(md, /missing\.jpg \| HTTP_404/);
  assert.match(md, /ROBOTS_DISALLOWED/);
  const home = report.perPage.find((p) => p.url === `${f.site}/`);
  assert.equal(home.failed, 0);
  assert.equal(report.perPage.find((p) => p.url === `${f.site}/localLife`).failed, 1);
});

test('import inputs: CSVs compatible with apps/api migrate-legacy + plan.json (CMS drafts, 301 candidates, contexts)', async () => {
  const imp = path.join(first.cfg.outDir, 'import');
  const content = parseCsvForTest(await readFile(path.join(imp, 'content.csv'), 'utf8'));
  assert.equal(content.length, 9);
  const about = content.find((r) => r.post_id === 'page:/about_jetpool');
  assert.equal(about.slug, 'legacy-about-jetpool');
  assert.match(about.body_html, /<img src="\/legacy\/[0-9a-f]{12}\/charter-1600\.webp"/);
  const media = parseCsvForTest(await readFile(path.join(imp, 'media.csv'), 'utf8'));
  assert.equal(media.length, 37);
  for (const m of media) {
    assert.ok(existsSync(path.join(first.cfg.publicDir, m.file)), `media.csv file ${m.file} must exist under --media-dir`);
    if (m.sha256) assert.equal(sha(await readFile(path.join(first.cfg.publicDir, m.file))), m.sha256);
  }
  const red = parseCsvForTest(await readFile(path.join(imp, 'redirects.csv'), 'utf8'));
  const map = Object.fromEntries(red.map((r) => [r.legacy_path, r.target_path]));
  assert.equal(map['/about_jetpool'], '/jetpool-charter');
  assert.equal(map['/old-about'], '/jetpool-charter');
  assert.equal(map['/localLife'], '/exchange');
  assert.equal(map['/tour_ticket'], '/travel');
  assert.equal(map['/board/story/1'], '/stories/legacy-board-story-1');
  assert.equal(map['/blogPost/heart_letter_01'], '/stories/legacy-blogpost-heart-letter-01');
  assert.equal(map['/product/past_trip'], '/travel');
  assert.equal(map['/home'], '/');
  assert.ok(!('/guide' in map), 'template pages get no redirect');
  assert.ok(!('/' in map) && !('/favicon.ico' in map));
  const plan = JSON.parse(await readFile(path.join(imp, 'plan.json'), 'utf8'));
  const story = plan.entries.find((e) => e.legacyPath === '/board/story/1');
  assert.equal(story.type, 'STORY');
  assert.equal(story.title, '망원동 ↔ 해운대, 한 달 동안 집을 바꿔 살았습니다');
  assert.match(story.bodyMd, /\[▶ 맞교환 브이로그 보기\]\(https:\/\/www\.youtube\.com\/watch\?v=9bZkp7q19f0\)/);
  for (const u of story.data.legacy.media) assert.ok(existsSync(path.join(path.dirname(first.cfg.publicDir), u)), u);
  const alt = (id) => plan.media.find((m) => m.assetId === id).alt;
  assert.equal(alt(plan.assignments.exchange[0]), '부산 해운대 아파트 거실');
  assert.equal(alt(plan.assignments.charter[0]), '전세기 앞에서 단체 사진');
  assert.equal(alt(plan.assignments.tour[0]), '제주 오름 일출 투어');
  assert.equal(alt(plan.assignments.guide[0]), '서울 골목을 걷는 가이드');
});

test('idempotent re-run with --resume: no network, files untouched, manifest byte-identical; --allow-partial exits 0', async () => {
  const before = await snapshotTree(path.dirname(first.cfg.publicDir));
  const manifestBefore = await readFile(path.join(first.cfg.outDir, 'manifest.json'), 'utf8');
  f.resetLog();
  const again = await runFixture(f, dir, 'all', { resume: true, allowPartial: true });
  assert.equal(again.code, 0);
  assert.deepEqual(f.requests, [], 'resume must not hit the network');
  assert.deepEqual(await snapshotTree(path.dirname(first.cfg.publicDir)), before);
  assert.equal(await readFile(path.join(first.cfg.outDir, 'manifest.json'), 'utf8'), manifestBefore);
  assert.equal(again.results.report.media.coveragePct, 94.73, 'HAR media is remembered across --resume runs');
});

test('single steps can be re-run (extract from snapshots, report) and --resume continues an interrupted download', async () => {
  const dl = path.join(first.cfg.outDir, 'state', 'downloads.json');
  const state = JSON.parse(await readFile(dl, 'utf8'));
  // simulate an interruption: forget two finished downloads
  const lost = [cdn('/images/charter.jpg'), cdn('/uploadedFiles/56465/guide/guide-walk.jpg')];
  for (const u of lost) delete state.urls[u];
  await (await import('../src/util.mjs')).writeJson(dl, state);
  f.resetLog();
  const ex = await runFixture(f, dir, 'extract', { resume: true });
  assert.equal(ex.code, 0);
  assert.equal(f.requests.length, 0, 'extract re-parses stored snapshots offline');
  const d = await runFixture(f, dir, 'download', { resume: true });
  assert.equal(d.code, 0);
  const fetched = f.requests.filter((r) => r.server === 'cdn').map((r) => r.path).sort();
  assert.deepEqual(fetched, ['/images/charter.jpg', '/robots.txt', '/uploadedFiles/56465/guide/guide-walk.jpg'], 'only the missing files are fetched again');
  const rep = await runFixture(f, dir, 'report', { resume: true });
  assert.equal(rep.code, 3);
});

test('an unreachable start origin fails loudly instead of producing an empty "complete" migration', async () => {
  const net = await import('node:net');
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  await new Promise((r) => srv.close(r)); // nothing listens there any more
  const d = await tempDir();
  try {
    const dead = { site: `http://127.0.0.1:${port}`, siteHost: `127.0.0.1:${port}`, cdnHost: f.cdnHost };
    await assert.rejects(runFixture(dead, d, 'crawl', { retries: 0 }), /cannot crawl http:\/\/127\.0\.0\.1:\d+: robots\.txt is unreachable \(ECONNREFUSED/);
  } finally {
    await rm(d, { recursive: true, force: true });
  }
});

test('--cdn-originals prefer fetches the referenced rendition only when the original fails; off never guesses', async () => {
  for (const mode of ['prefer', 'off']) {
    const d = await tempDir();
    try {
      await runFixture(f, d, 'crawl', { cdnOriginals: mode });
      f.resetLog();
      await runFixture(f, d, 'download', { cdnOriginals: mode });
      const got = new Set(f.requests.filter((r) => r.server === 'cdn').map((r) => r.path));
      if (mode === 'prefer') {
        assert.ok(got.has('/images/seoul.jpg') && !got.has('/images/seoul.jpg?w=480') && !got.has('/images/seoul.jpg?w=960'));
        assert.ok(got.has('/uploadedFiles/56465/background/image_1000.jpg') && !got.has('/thumbnails/uploadedFiles/56465/background/image_1000_1600.jpg'));
      } else {
        assert.ok(got.has('/images/seoul.jpg?w=480') && !got.has('/images/seoul.jpg'));
        assert.ok(!got.has('/uploadedFiles/56465/background/image_1000.jpg'));
      }
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  }
});

test('a public dir shared with another publisher is detected, reported and never modified', async () => {
  const { mkdir, writeFile: wf, readFile: rf } = await import('node:fs/promises');
  const foreign = path.join(first.cfg.publicDir, 'abcdefabcdef');
  await mkdir(foreign, { recursive: true });
  await wf(path.join(foreign, 'original.jpg'), 'not ours');
  const pub = await runFixture(f, dir, 'publish', { resume: true });
  assert.ok(pub.log.warnings.some((w) => /another publisher/.test(w)));
  const rep = await runFixture(f, dir, 'report', { resume: true, allowPartial: true });
  assert.equal(rep.results.report.assets.foreignPublisherDirs, 1);
  assert.ok(!rep.results.report.assets.orphans.includes('abcdefabcdef'));
  assert.match(await rf(path.join(first.cfg.outDir, 'report.md'), 'utf8'), /Shared public directory/);
  assert.equal(await rf(path.join(foreign, 'original.jpg'), 'utf8'), 'not ours');
  await rm(foreign, { recursive: true, force: true });
});
