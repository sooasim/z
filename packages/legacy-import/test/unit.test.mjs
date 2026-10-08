import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractPage, parseCssUrls, parseSrcset, scanScriptUrls } from '../src/extract.mjs';
import { canonicalizeSiteUrl, hostMatches, normalizeUrl, originalCandidates, pageKey, parseEmbed, kindFromUrl } from '../src/url.mjs';
import { parseExtraMedia } from '../src/extra-media.mjs';
import { isSixshopTemplate } from '../src/crawl.mjs';
import { isAllowed, parseRobots, parseSitemap } from '../src/robots.mjs';
import { contentTypeAcceptable, sniff, svgIsSafe } from '../src/sniff.mjs';
import { targetWidths } from '../src/optimise.mjs';
import { buildImportPlan, normalizeLegacyPath, routeFor, slugForPath } from '../src/plan.mjs';
import { normalizeLegacyPath as utilNormalize, safeBaseName, toCsv } from '../src/util.mjs';
import { gzipSync } from 'node:zlib';

const UA = 'JETPOOL-Migration/1.0 (+owner-authorised)';

test('normalizeUrl resolves relative / protocol-relative URLs and strips fragments + tracking params', () => {
  const base = 'https://www.wontc.co.kr/board/story/1';
  assert.equal(normalizeUrl('../img/a.jpg#x', base), 'https://www.wontc.co.kr/board/img/a.jpg');
  assert.equal(normalizeUrl('/img/a.jpg', base), 'https://www.wontc.co.kr/img/a.jpg');
  assert.equal(normalizeUrl('//contents.sixshop.com/a.png', base), 'https://contents.sixshop.com/a.png');
  assert.equal(normalizeUrl('/p?utm_source=x&id=3&fbclid=y', base), 'https://www.wontc.co.kr/p?id=3');
  assert.equal(normalizeUrl('HTTPS://WWW.WONTC.CO.KR:443/About', base), 'https://www.wontc.co.kr/About');
  assert.equal(normalizeUrl('javascript:void(0)', base), null);
  assert.equal(normalizeUrl('data:image/png;base64,AAA', base), null);
  assert.equal(normalizeUrl('mailto:a@b.c', base), null);
  assert.equal(normalizeUrl('https:\\/\\/cdn.example\\/x.jpg', base), 'https://cdn.example/x.jpg');
  assert.equal(pageKey('https://a.kr/x/?b=2&a=1'), pageKey('https://a.kr/x?a=1&b=2'));
});

test('hostMatches supports exact hosts, host:port and *.wildcards (subdomains only)', () => {
  const pats = ['www.wontc.co.kr', '*.sixshop.com', '127.0.0.1:8080'];
  assert.ok(hostMatches('https://www.wontc.co.kr/a', pats));
  assert.ok(hostMatches('https://contents.sixshop.com/a', pats));
  assert.ok(!hostMatches('https://sixshop.com/a', pats));
  assert.ok(!hostMatches('https://evilsixshop.com/a', pats));
  assert.ok(hostMatches('http://127.0.0.1:8080/x', pats));
  assert.ok(!hostMatches('http://127.0.0.1:9090/x', pats));
});

test('originalCandidates strips resize params and maps Sixshop thumbnails to originals', () => {
  assert.deepEqual(originalCandidates('https://cdn.example/a.jpg?w=480&v=2'), ['https://cdn.example/a.jpg?v=2']);
  assert.deepEqual(originalCandidates('https://contents.sixshop.com/thumbnails/uploadedFiles/56465/product/image_1588573395788_750.jpg'), [
    'https://contents.sixshop.com/uploadedFiles/56465/product/image_1588573395788.jpg',
  ]);
  assert.deepEqual(originalCandidates('https://contents.sixshop.com/uploadedFiles/56465/a.jpg'), []);
});

test('Sixshop thumb.sixshop.kr resize proxy maps to the contents.sixshop.com original; site URL variants fold onto the start origin', () => {
  assert.deepEqual(originalCandidates('https://thumb.sixshop.kr/uploadedFiles/248845/default/image_1695063413467.jpg?width=2500'), [
    'https://contents.sixshop.com/uploadedFiles/248845/default/image_1695063413467.jpg',
    'https://thumb.sixshop.kr/uploadedFiles/248845/default/image_1695063413467.jpg',
  ]);
  const o = 'https://www.wontc.co.kr';
  assert.equal(canonicalizeSiteUrl('http://wontc.co.kr/guide?x=1', o), 'https://www.wontc.co.kr/guide?x=1');
  assert.equal(canonicalizeSiteUrl('http://www.wontc.co.kr/a.jpg', o), 'https://www.wontc.co.kr/a.jpg');
  assert.equal(canonicalizeSiteUrl('https://contents.sixshop.com/a.jpg', o), 'https://contents.sixshop.com/a.jpg');
  assert.equal(canonicalizeSiteUrl('http://127.0.0.1:9/a', 'http://127.0.0.1:8'), 'http://127.0.0.1:9/a');
});

test('--extra-media accepts HAR, JSON arrays and CSV/plain lists', () => {
  const har = JSON.stringify({ log: { pages: [{ id: 'p1', title: 'https://www.wontc.co.kr/' }], entries: [
    { pageref: 'p1', request: { url: 'https://contents.sixshop.com/a.jpg', headers: [] }, response: { status: 200, content: { mimeType: 'image/jpeg' } } },
    { pageref: 'p1', request: { url: 'https://contents.sixshop.com/b.js', headers: [] }, response: { status: 200, content: { mimeType: 'text/javascript' } } },
    { request: { url: 'https://contents.sixshop.com/c.mp4', headers: [{ name: 'Referer', value: 'https://www.wontc.co.kr/x' }] }, response: { status: 200, content: { mimeType: 'video/mp4' } } },
    { request: { url: 'https://contents.sixshop.com/gone.jpg', headers: [] }, response: { status: 404, content: { mimeType: 'image/jpeg' } } },
  ] } });
  assert.deepEqual(parseExtraMedia(har), [
    { url: 'https://contents.sixshop.com/a.jpg', pageUrl: 'https://www.wontc.co.kr/' },
    { url: 'https://contents.sixshop.com/c.mp4', pageUrl: 'https://www.wontc.co.kr/x' },
  ]);
  assert.deepEqual(parseExtraMedia('["https://a.kr/1.jpg", {"url":"https://a.kr/2.jpg","pageUrl":"https://a.kr/p"}]'), [
    { url: 'https://a.kr/1.jpg', pageUrl: null },
    { url: 'https://a.kr/2.jpg', pageUrl: 'https://a.kr/p' },
  ]);
  assert.deepEqual(parseExtraMedia('page_url,media_url\nhttps://a.kr/p,https://a.kr/3.jpg\nhttps://a.kr/4.jpg\n'), [
    { url: 'https://a.kr/3.jpg', pageUrl: 'https://a.kr/p' },
    { url: 'https://a.kr/4.jpg', pageUrl: null },
  ]);
  assert.throws(() => parseExtraMedia('{"nope":1}'), /HAR file or a JSON array/);
});

test('Sixshop default editor-manual pages are recognised as templates', () => {
  assert.ok(isSixshopTemplate({ title: 'Q&A - 사용 설명서', textBlocks: [] }));
  assert.ok(isSixshopTemplate({ title: 'x', textBlocks: [{ text: '식스샵 편집 도구 사용 설명서' }] }));
  assert.ok(isSixshopTemplate({ title: 'NOTICE - 사용 설명서 | 전세계 살아보기, 비행기공유플랫폼', textBlocks: [] }));
  assert.ok(!isSixshopTemplate({ title: '한달살기 맞교환 여행', textBlocks: [{ text: '설명서를 읽어 보세요' }] }));
});

test('a site-wide title suffix (wontc.co.kr: " | 전세계 살아보기, 비행기공유플랫폼") neither routes nor tags pages', () => {
  const S = ' | 전세계 살아보기, 비행기공유플랫폼';
  const page = (path, title) => ({ url: `https://www.wontc.co.kr${path}`, path, title, headings: [], blocks: [{ type: 'text', text: '본문' }], images: [], videos: [], embeds: [], og: {} });
  const plan = buildImportPlan({ contentSha256: 'x', source: { siteHosts: ['www.wontc.co.kr'] }, assets: {}, pages: [
    page('/', '전세계 살아보기, 비행기공유플랫폼'), page('/about_ceo', `CEO 원치승${S}`), page('/untitled-1', `전세기공유플랫폼${S}`), page('/local_life', `한달살기 맞교환 여행${S}`), page('/product/past_x', '[축제] 오페라 페스티벌'),
  ] });
  const by = Object.fromEntries(plan.entries.map((e) => [e.legacyPath, e]));
  assert.equal(by['/about_ceo'].title, 'CEO 원치승');
  assert.equal(by['/about_ceo'].targetPath, '/stories/legacy-about-ceo');
  assert.deepEqual(by['/about_ceo'].contexts, []);
  assert.equal(by['/untitled-1'].targetPath, '/jetpool-charter');
  assert.equal(by['/local_life'].targetPath, '/exchange');
  assert.equal(by['/product/past_x'].targetPath, '/travel');
  assert.equal(by['/'].title, '전세계 살아보기, 비행기공유플랫폼', 'a title that is only the site name is kept');
});

test('parseEmbed recognises YouTube and Vimeo forms', () => {
  for (const u of ['https://www.youtube.com/embed/dQw4w9WgXcQ?rel=0', 'https://youtu.be/dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3', '//www.youtube-nocookie.com/embed/dQw4w9WgXcQ']) {
    const e = parseEmbed(u);
    assert.equal(e?.provider, 'youtube', u);
    assert.equal(e.videoId, 'dQw4w9WgXcQ');
    assert.equal(e.thumbnailUrl, 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg');
  }
  assert.equal(parseEmbed('https://player.vimeo.com/video/76979871')?.videoId, '76979871');
  assert.equal(parseEmbed('https://maps.google.com/x'), null);
});

test('robots.txt: groups, longest match, Allow wins ties, wildcards and $', () => {
  const r = parseRobots(`User-agent: *\nDisallow: /private/\nDisallow: /*?view=\nAllow: /private/public\n\nUser-agent: jetpool-migration\nDisallow: /nojet$\nCrawl-delay: 2\nSitemap: https://a.kr/sitemap.xml`);
  assert.deepEqual(r.sitemaps, ['https://a.kr/sitemap.xml']);
  // UA-specific group replaces '*'
  assert.equal(isAllowed(r, UA, '/private/x'), true);
  assert.equal(isAllowed(r, UA, '/nojet'), false);
  assert.equal(isAllowed(r, UA, '/nojet/more'), true);
  const generic = 'OtherBot/1.0';
  assert.equal(isAllowed(r, generic, '/private/x'), false);
  assert.equal(isAllowed(r, generic, '/private/public/page'), true);
  assert.equal(isAllowed(r, generic, '/tour?view=list'), false);
  assert.equal(isAllowed(r, generic, '/tour?idx=1'), true);
  assert.equal(isAllowed({ groups: [], sitemaps: [], disallowAll: true }, UA, '/'), false);
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow:'), UA, '/anything'), true);
});

test('parseSitemap reads urlset, sitemapindex and gzip', () => {
  const set = parseSitemap('<urlset><url><loc>https://a.kr/a?x=1&amp;y=2</loc><lastmod>2025-01-01</lastmod></url></urlset>');
  assert.deepEqual(set.urls, [{ loc: 'https://a.kr/a?x=1&y=2', lastmod: '2025-01-01' }]);
  const idx = parseSitemap(gzipSync('<sitemapindex><sitemap><loc>https://a.kr/s1.xml</loc></sitemap></sitemapindex>'));
  assert.deepEqual(idx.sitemaps, ['https://a.kr/s1.xml']);
});

test('srcset and CSS url() parsing (font-face ignored, @import followed, image-set strings)', () => {
  assert.deepEqual(parseSrcset('a.jpg 480w, b.jpg 960w,c.jpg'), [
    { url: 'a.jpg', descriptor: '480w' },
    { url: 'b.jpg', descriptor: '960w' },
    { url: 'c.jpg', descriptor: '' },
  ]);
  const css = `@import url("x.css"); @font-face{src:url(f.woff2)} .a{background:url('../i/bg.png') no-repeat}
    .b{background-image:image-set("s.png" 1x,"s2.png" 2x)} .c{background:url(data:image/png;base64,AA)}`;
  const r = parseCssUrls(css, 'https://a.kr/css/site.css');
  assert.deepEqual(r.imports, ['https://a.kr/css/x.css']);
  assert.deepEqual(r.images.map((i) => i.url).sort(), ['https://a.kr/css/s.png', 'https://a.kr/css/s2.png', 'https://a.kr/i/bg.png']);
  assert.equal(r.images.find((i) => i.url.endsWith('bg.png')).property, 'background');
  assert.deepEqual(scanScriptUrls('var d={"g":["https:\\/\\/cdn.kr\\/u\\/g1.png"],"v":"//cdn.kr/v.mp4"}', 'https://a.kr/'), ['https://cdn.kr/u/g1.png', 'https://cdn.kr/v.mp4']);
});

test('extractPage: head data, text blocks with <br>, lazy/srcset/picture/video/poster/iframe/background refs', () => {
  const html = `<!doctype html><html lang="ko"><head><title>T | Site</title><meta name="description" content="D">
    <meta property="og:image" content="/og.jpg"><link rel="canonical" href="/c"><link rel="icon" href="/fav.png"></head>
    <body><header><img src="/logo.png" alt="logo"></header><main>
    <h1>제목</h1><p>첫 줄<br>둘째 줄</p>
    <img src="/blank.gif" data-src="/real.jpg" alt="실제">
    <img src="/s.jpg?w=480" srcset="/s.jpg?w=480 480w, /s.jpg?w=960 960w">
    <picture><source srcset="/p.webp"><img src="/p.jpg" alt="P"></picture>
    <figure><img src="/f.jpg"><figcaption>캡션</figcaption></figure>
    <video poster="/poster.jpg"><source src="/v.mp4" type="video/mp4"></video>
    <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>
    <div style="background-image:url(/bg.jpg)"></div><div data-bg="/bg2.jpg"></div>
    <img src="https://www.facebook.com/tr?id=1" width="1" height="1">
    <a href="/next">다음</a><a href="/big.jpg">원본</a></main></body></html>`;
  const p = extractPage(html, 'https://a.kr/page');
  assert.equal(p.title, 'T | Site');
  assert.equal(p.description, 'D');
  assert.equal(p.canonical, 'https://a.kr/c');
  assert.equal(p.lang, 'ko');
  assert.deepEqual(p.headings, [{ level: 1, text: '제목' }]);
  assert.ok(p.textBlocks.some((b) => b.text === '첫 줄\n둘째 줄'));
  const urls = p.media.map((m) => m.url.replace('https://a.kr', ''));
  for (const u of ['/og.jpg', '/fav.png', '/logo.png', '/real.jpg', '/s.jpg?w=480', '/s.jpg?w=960', '/p.webp', '/p.jpg', '/f.jpg', '/poster.jpg', '/v.mp4', '/bg.jpg', '/bg2.jpg', '/big.jpg']) assert.ok(urls.includes(u), `missing ${u}`);
  assert.ok(!urls.some((u) => u.includes('blank.gif') || u.includes('facebook')), 'placeholder/tracker must be ignored');
  assert.equal(p.media.find((m) => m.url.endsWith('/f.jpg')).caption, '캡션');
  assert.equal(p.media.find((m) => m.url.endsWith('/logo.png')).zone, 'header');
  assert.equal(p.media.find((m) => m.url.endsWith('/real.jpg')).context, '제목');
  assert.equal(p.media.find((m) => m.url.endsWith('/v.mp4')).kind, 'video');
  assert.equal(p.embeds[0].videoId, 'dQw4w9WgXcQ');
  assert.ok(p.links.some((l) => l.url === 'https://a.kr/next'));
  const video = p.flow.find((b) => b.t === 'media' && b.kind === 'video');
  assert.equal(p.media[video.poster[0]].url, 'https://a.kr/poster.jpg');
});

test('magic-byte sniffing, content-type checks and SVG safety', () => {
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))?.mime, 'image/jpeg');
  assert.equal(sniff(Buffer.from('89504e470d0a1a0a0000', 'hex'))?.ext, 'png');
  assert.equal(sniff(Buffer.from('GIF89a......'))?.ext, 'gif');
  assert.equal(sniff(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))?.ext, 'webp');
  const ftyp = (brand) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`), Buffer.alloc(12)]);
  assert.equal(sniff(ftyp('isom'))?.mime, 'video/mp4');
  assert.equal(sniff(ftyp('avif'))?.mime, 'image/avif');
  assert.equal(sniff(ftyp('qt  '))?.mime, 'video/quicktime');
  assert.equal(sniff(Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('....webm')]))?.ext, 'webm');
  assert.equal(sniff(Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>'))?.mime, 'image/svg+xml');
  assert.equal(sniff(Buffer.from('<!DOCTYPE html><html>'))?.kind, 'text');
  assert.ok(contentTypeAcceptable('image/jpeg'));
  assert.ok(contentTypeAcceptable('application/octet-stream'));
  assert.ok(!contentTypeAcceptable('text/html'));
  assert.ok(svgIsSafe('<svg><circle r="3"/></svg>'));
  assert.ok(!svgIsSafe('<svg onload="x()"></svg>'));
  assert.ok(!svgIsSafe('<svg><script>x</script></svg>'));
  assert.ok(!svgIsSafe('<svg><a href="javascript:alert(1)"/></svg>'));
});

test('targetWidths never upscales and adds the native width below the largest breakpoint', () => {
  const W = [480, 960, 1600, 2400];
  assert.deepEqual(targetWidths(3000, W), [480, 960, 1600, 2400]);
  assert.deepEqual(targetWidths(2400, W), [480, 960, 1600, 2400]);
  assert.deepEqual(targetWidths(1200, W), [480, 960, 1200]);
  assert.deepEqual(targetWidths(300, W), [300]);
  assert.deepEqual(targetWidths(null, W), []);
});

test('legacy path normalisation matches the API, slugs and route rules', () => {
  for (const p of ['/about_jetpool/', 'https://www.wontc.co.kr/about_jetpool#x', '/about_jetpool?x=1']) assert.equal(normalizeLegacyPath(p), utilNormalize(p));
  assert.equal(normalizeLegacyPath('/%ED%95%9C%EB%8B%AC/'), '/한달');
  assert.equal(slugForPath('/'), 'legacy-index');
  assert.equal(slugForPath('/home'), 'legacy-home');
  assert.equal(slugForPath('/about_jetpool'), 'legacy-about-jetpool');
  assert.equal(slugForPath('/tour_ticket?idx=1'), 'legacy-tour-ticket-idx-1');
  assert.equal(routeFor('/about_jetpool').target, '/jetpool-charter');
  assert.equal(routeFor('/localLife').target, '/exchange');
  assert.equal(routeFor('/tour_ticket').target, '/travel');
  assert.equal(routeFor('/board/story/1').type, 'STORY');
  assert.equal(routeFor('/whatever').type, 'LEGACY_CONTENT');
  // paths observed on www.wontc.co.kr
  assert.equal(routeFor('/local_life').target, '/exchange');
  assert.equal(routeFor('/jetpool').target, '/jetpool-charter');
  assert.equal(routeFor('/member_stay').target, '/stay');
  assert.equal(routeFor('/tour_consulting').target, '/travel');
  assert.deepEqual([routeFor('/product/past_opera').type, routeFor('/product/past_opera').target], ['LEGACY_CONTENT', '/travel']);
  assert.equal(routeFor('/blogPost/heart_letter_02').type, 'STORY');
  assert.equal(routeFor('/won_story').type, 'STORY');
  assert.equal(routeFor('/cs').target, '/support');
  assert.equal(routeFor('/home').target, '/');
  assert.equal(routeFor('/guide').target, null, 'Sixshop /guide is the editor manual, not local guides');
  assert.equal(routeFor('/local_guide').target, '/guide-friends');
  assert.equal(routeFor('/untitled-1', '전세기공유플랫폼').target, '/jetpool-charter', 'title fallback');
  assert.equal(routeFor('/untitled-7', '프리미엄 라운지').target, null);
  assert.equal(safeBaseName('IMG_2024 05 (1).JPG'), 'img-2024-05-1');
  assert.equal(safeBaseName('사진.jpg', 'image'), 'image');
  assert.equal(kindFromUrl('https://a.kr/v.MP4'), 'video');
});

test('toCsv quotes fields and writes a BOM', () => {
  const csv = toCsv([{ a: 'x,y', b: 'say "hi"\nnow' }], ['a', 'b']);
  assert.ok(csv.startsWith('﻿a,b\r\n'));
  assert.ok(csv.includes('"x,y","say ""hi""\nnow"'));
});

test('buildImportPlan: entries, hero, redirects and context assignment from a minimal manifest', () => {
  const asset = (id, extra) => ({ id, kind: 'image', sha256: id.padEnd(64, '0'), mime: 'image/jpeg', bytes: 10, width: 1600, height: 900, files: { original: `legacy/${id}/a.jpg`, webp: { 480: `legacy/${id}/a-480.webp`, 1600: `legacy/${id}/a-1600.webp` } }, renditions: [{ width: 480, height: 270, path: `legacy/${id}/a-480.webp` }], roles: ['content'], chrome: false, pageUrls: [], contentPageUrls: [], sourceUrls: [`https://cdn.kr/${id}.jpg`], ...extra });
  const manifest = {
    contentSha256: 'x',
    source: { siteHosts: ['www.wontc.co.kr'] },
    pages: [
      { url: 'https://www.wontc.co.kr/about_jetpool', path: '/about_jetpool', title: 'JETPOOL | WONT', headings: [{ level: 1, text: 'JETPOOL' }], blocks: [{ type: 'heading', level: 1, text: 'JETPOOL' }, { type: 'image', assetId: 'aaaaaaaaaaaa' }, { type: 'text', text: '전세기 이야기' }], images: ['aaaaaaaaaaaa'], videos: [], embeds: [], og: {} },
      { url: 'https://www.wontc.co.kr/localLife', path: '/localLife', title: 'Local Life | WONT', headings: [], blocks: [{ type: 'image', assetId: 'bbbbbbbbbbbb' }], images: ['bbbbbbbbbbbb'], videos: [], embeds: [], og: {} },
    ],
    assets: {
      aaaaaaaaaaaa: asset('aaaaaaaaaaaa', { alt: '전세기', pageUrls: ['https://www.wontc.co.kr/about_jetpool'], contentPageUrls: ['https://www.wontc.co.kr/about_jetpool'] }),
      bbbbbbbbbbbb: asset('bbbbbbbbbbbb', { alt: '부산 집', pageUrls: ['https://www.wontc.co.kr/localLife'], contentPageUrls: ['https://www.wontc.co.kr/localLife'] }),
    },
  };
  const plan = buildImportPlan(manifest);
  const about = plan.entries.find((e) => e.legacyPath === '/about_jetpool');
  assert.equal(about.type, 'PAGE');
  assert.equal(about.slug, 'legacy-about-jetpool');
  assert.equal(about.title, 'JETPOOL');
  assert.equal(about.heroAssetId, 'aaaaaaaaaaaa');
  assert.match(about.bodyMd, /!\[전세기\]\(\/legacy\/aaaaaaaaaaaa\/a-1600\.webp\)/);
  assert.equal(about.data.coverUrl, '/legacy/aaaaaaaaaaaa/a-1600.webp');
  assert.deepEqual(about.data.legacy.media, ['/legacy/aaaaaaaaaaaa/a-1600.webp']);
  assert.ok(plan.redirects.some((r) => r.legacyPath === '/about_jetpool' && r.targetPath === '/jetpool-charter' && r.approved === false));
  assert.deepEqual(plan.assignments.charter, ['aaaaaaaaaaaa']);
  assert.deepEqual(plan.assignments.exchange, ['bbbbbbbbbbbb']);
  assert.deepEqual(plan.media.find((m) => m.assetId === 'bbbbbbbbbbbb').cities, ['Busan']);
  assert.equal(plan.media[0].storageKey, `legacy/wont/${'aaaaaaaaaaaa'.padEnd(64, '0')}.jpg`);
});
