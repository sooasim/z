#!/usr/bin/env node
/**
 * Media catalog builder: merges the optimised media index, the visual classifications and the photo curation
 * into ONE file the platform reads, and writes every legacy wontc.co.kr page as clean Markdown.
 *
 *   node scripts/legacy/build-catalog.mjs [--raw .legacy/raw] [--check]
 *
 * Inputs (read-only):
 *   data/media/optimized.json                 (scripts/legacy/optimize.mjs) legacy · embeds · photos · nonMedia · excluded
 *   data/media/classify-*.json                visual classification of every legacy image (category, subject, usages)
 *   data/media/photo-curation-*.json          accept/reject + roles + Korean/English subject for every licensed photo
 *   <raw>/legacy-raw/manifest.json + pages/<slug>.html|jpg   (scripts/legacy/capture-site.mjs)
 * Outputs (owned by this script):
 *   data/media/catalog.json                   { generatedAt, legacy{site,pages,assets,embeds,skipped}, photos, usagePlan,
 *                                               usageRoutes, coverage }
 *   data/media/legacy-pages/<slug>.md         clean page content in reading order (Korean preserved), images inline
 *   data/media/legacy-pages/screenshots/<slug>.webp   400px-wide full-page preview of the captured page
 *
 * Rules
 * - Owner-authorised migration: EVERY one of the published legacy images must end up with ≥ 1 usage; the build fails
 *   (exit 1) when an image is unclassified or unused, or a photo without attribution would be shown.
 * - http/https/www/non-www captures of the same path collapse into one page; byte-identical content under a second
 *   path (/home = /) becomes an alias. Sixshop system/template pages are dropped only when they carry no unique media.
 * - Site chrome (header nav, marquee banner, footer company block, Sixshop shipping/return boilerplate, comment
 *   widgets, product-list carousel clones) is stripped from page text; the footer facts are kept once in legacy.site.
 * - Photos: only `accepted` photos get usages (and therefore appear on /credits); rejected ones are kept in the
 *   catalog with their reason but never shown. BY-ND photos never reach this file (optimize.mjs excludes them).
 */
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRY_PATHS, routeFor, slugForPath, normalizeLegacyPath } from '../../packages/legacy-import/src/plan.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n, d) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : d);
const CHECK_ONLY = args.includes('--check');
const RAW = path.resolve(ROOT, opt('raw', process.env.MEDIA_RAW_DIR || '.legacy/raw'));
const MEDIA = path.join(ROOT, 'data/media');
const OUT = path.join(MEDIA, 'catalog.json');
const PAGES_DIR = path.join(MEDIA, 'legacy-pages');
const SHOTS_DIR = path.join(PAGES_DIR, 'screenshots');

const require = createRequire(path.join(ROOT, 'packages/legacy-import/package.json'));
const cheerio = require('cheerio');
let sharp = null;
try {
  sharp = require('sharp');
} catch {
  /* screenshots previews are skipped without sharp */
}

const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const listJson = async (prefix) =>
  (await fs.readdir(MEDIA))
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
    .map((f) => path.join(MEDIA, f));
const uniq = (xs) => [...new Set(xs.filter((x) => x !== undefined && x !== null && x !== ''))];
const sha12 = (s) => s.slice(0, 12);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const clean = (s) =>
  String(s ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t\f\v\u200b\ufeff]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
const oneLine = (s) => clean(s).replace(/\s*\n\s*/g, ' ').trim();

// ───────────────────────────────────────────── inputs ─────────────────────────────────────────────
const optimized = await readJson(path.join(MEDIA, 'optimized.json'));
const LEG = optimized.legacy;
const classifyFiles = await listJson('classify-');
const curationFiles = await listJson('photo-curation-');
const classes = {};
for (const f of classifyFiles) for (const c of await readJson(f)) classes[c.sha] = { ...c, _file: path.basename(f) };
const curation = {};
for (const f of curationFiles) for (const c of await readJson(f)) curation[c.sha] = { ...c, _file: path.basename(f) };
// Sixshop grey placeholders, spacer bars, loader and popup-close icon: archived, never reproduced on WONT pages
const isUiChrome = (sha) => {
  const c = classes[sha];
  return c?.category === 'ui-element' || (c?.category === 'icon' && (c.tags ?? []).includes('sixshop-platform'));
};
const manifestPath = path.join(RAW, 'legacy-raw/manifest.json');
if (!existsSync(manifestPath)) {
  console.error(`missing ${rel(manifestPath)} — run scripts/legacy/capture-site.mjs first (or pass --raw)`);
  process.exit(2);
}
const manifest = await readJson(manifestPath);

// ─────────────────────────────────────── URL → legacy sha ───────────────────────────────────────
const byUrl = new Map();
const addUrl = (u, sha) => {
  if (!u || !LEG[sha]) return;
  for (const v of urlVariants(u)) if (!byUrl.has(v)) byUrl.set(v, sha);
};
function urlVariants(u) {
  const out = [u];
  try {
    const x = new URL(u);
    x.protocol = 'https:';
    out.push(x.href);
    x.search = '';
    out.push(x.href);
  } catch {
    /* relative or broken */
  }
  return out;
}
for (const [u, sha] of Object.entries(manifest.byUrl ?? {})) addUrl(u, sha);
for (const [sha, a] of Object.entries(LEG)) for (const u of a.sourceUrls ?? []) addUrl(u, sha);
for (const e of optimized.embeds ?? []) if (e.thumbnail?.sha) addUrl(e.thumbnail.sourceUrl, e.thumbnail.sha);
// Sixshop serves one upload under several thumbnail widths (image_<id>_500.jpg, _750, _1000, ?width=2500 …).
const byStem = new Map();
const stemOf = (u) => String(u).match(/(image_\d+|video_\d+)/)?.[1] ?? null;
for (const [u, sha] of byUrl) {
  const st = stemOf(u);
  if (!st) continue;
  if (!byStem.has(st)) byStem.set(st, new Set());
  byStem.get(st).add(sha);
}
const unresolvedUrls = new Map();
function shaForUrl(u, pageUrl) {
  if (!u || u.startsWith('data:')) return null;
  let abs = u;
  try {
    abs = new URL(u.replace(/&amp;/g, '&'), pageUrl).href;
  } catch {
    return null;
  }
  for (const v of urlVariants(abs)) if (byUrl.has(v)) return byUrl.get(v);
  const st = stemOf(abs);
  if (st && byStem.has(st)) {
    // widest rendition of the same upload
    return [...byStem.get(st)].sort((a, b) => (LEG[b].width ?? 0) - (LEG[a].width ?? 0))[0];
  }
  if (/\.(jpe?g|png|gif|webp|svg|ico)(\?|$)/i.test(abs) || /sixshop/.test(abs)) unresolvedUrls.set(abs, pageUrl);
  return null;
}

// ───────────────────────────── rendition groups (one upload, several sizes) ─────────────────────────────
// Sixshop stores one upload once and serves it as image_<id>.jpg, thumbnails/image_<id>_{500,750,1000,2500}.jpg …;
// the capture keeps every size the site actually loaded (different bytes → different sha). YouTube posters likewise
// come as hqdefault / sddefault / sqp variants of the same video. Group them so a page shows the best one once.
// One sha can carry several upload ids (the same bytes uploaded again), so groups are unions over all source stems.
const stemsOf = (sha) =>
  uniq(
    (LEG[sha].sourceUrls ?? []).map((u) => {
      const sx = String(u).match(/uploadedFiles\/(\d+)\/[\w-]+\/(image_\d+)/);
      if (sx) return `sixshop:${sx[1]}/${sx[2]}`;
      const yt = String(u).match(/i\.ytimg\.com\/vi\/([\w-]{6,})\//);
      return yt ? `youtube:${yt[1]}` : null;
    }),
  );
const parent = new Map();
const find = (x) => {
  while (parent.get(x) !== x) {
    parent.set(x, parent.get(parent.get(x)));
    x = parent.get(x);
  }
  return x;
};
const union = (a, b) => {
  const [ra, rb] = [find(a), find(b)];
  if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
};
for (const sha of Object.keys(LEG)) {
  parent.has(`sha:${sha}`) || parent.set(`sha:${sha}`, `sha:${sha}`);
  for (const st of stemsOf(sha)) {
    parent.has(st) || parent.set(st, st);
    union(`sha:${sha}`, st);
  }
}
const renditionGroups = new Map();
for (const sha of Object.keys(LEG)) {
  const k = find(`sha:${sha}`);
  if (!renditionGroups.has(k)) renditionGroups.set(k, []);
  renditionGroups.get(k).push(sha);
}
// readable, stable key: the first stem (or sha12) of the group's members
const groupKeyById = new Map();
for (const [k, list] of renditionGroups) {
  const stems = uniq(list.flatMap(stemsOf)).sort();
  groupKeyById.set(k, stems[0] ?? `sha:${sha12(list.slice().sort()[0])}`);
}
function renditionKey(sha) {
  return groupKeyById.get(find(`sha:${sha}`));
}
const groupOf = (sha) => renditionGroups.get(find(`sha:${sha}`));
const area = (sha) => (LEG[sha].width ?? 0) * (LEG[sha].height ?? 0);
for (const list of renditionGroups.values()) list.sort((a, b) => area(b) - area(a) || (LEG[b].bytes ?? 0) - (LEG[a].bytes ?? 0) || a.localeCompare(b));
const primaryOf = (sha) => groupOf(sha)[0];

// ─────────────────────────────────── page grouping (collapse hosts) ───────────────────────────────────
const pagePath = (u) => normalizeLegacyPath(new URL(u).pathname);
const groups = new Map();
for (const p of manifest.pages) {
  const k = pagePath(p.url);
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(p);
}
const hostRank = (u) => {
  const x = new URL(u);
  return (x.protocol === 'https:' ? 0 : 2) + (x.hostname.startsWith('www.') ? 0 : 1);
};

// ───────────────────────────────────── DOM → reading-order blocks ─────────────────────────────────────
const SKIP_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'link', 'meta', 'input', 'textarea', 'select', 'button', 'form label',
  'header', 'footer', 'nav', '.site-header-content-group', '#siteHeader', '.top-banner-layout', '#searchOptimizeTextDiv',
  '.marqueeBanner', '[data-itemtype="marqueeBanner"]', '[data-itemtype="header-menu"]', '[data-itemtype="logo"]',
  '[data-itemtype="cartAndCustomer"]', '[data-itemtype="header-sns"]', '[data-itemtype="footer-sns"]',
  '[data-itemtype="footer-menu"]', '[data-itemtype="company-info"]', '[data-itemtype="footer-copyright"]',
  '[data-itemtype="spacer-element"]', '[data-itemtype="shape"]', '[data-itemtype="button"]',
  '#productDetailNavigation', '.relatedProductList-info', '.reviewQna-info', '.js-reviewWrapper', '#restockNoticeDailog',
  '.restockNoticeDialog', '#shopProductImgsThumbDiv', '.shopProductImgMainZoom', '.swiper-button-prev', '.swiper-button-next',
  '.swiper-pagination', '.likeShareButtonWrapper', '#useBlogPostCommentDiv', '.postFoot', '.btn-wrapper', '.blogPostSidebar',
  '#onePageNavigationDiv', '#topButtonArea', '#floatingButton', '#addToCartAtProductList', '.video-thumbnail',
  '#shopProductCartWrapper', '.productDetailOptions', '#productOptionsWrapper', '.shopProductBtnDiv', '#shopProductPrice',
  '.productPriceWrapper', '.customForm-submit', '.boardSearchWrapper', '.paginationWrapper', '.pagination',
  '.product-order-summary-wrapper', '#shopProductQuantityDiv', '.productQuantityDiv', '.snsShareButtonWrapper',
  '#productActionButtonDiv', '#shopProductCartErrorDiv', '.shopProductAdditionalFixedOptionPriceDiv',
];
const BOILERPLATE_RE = [
  /^(배송\s*안내|교환 및 반품\s*안내|유의 사항|관련 상품( 상품 설명)?|상품 설명)$/,
  /^배송 (업체|지역|비용|기간) ㅣ/,
  /^(신청 방법|반품 주소) ㅣ/,
  /^- (주문폭주|기본 배송기간|단순 변심|상품 하자|제품 특성상|네이버페이)/,
  /^(좋아요|공유하기|댓글 \(\d+\)|글쓴이|내용|댓글 쓰기)$/,
  /^전세계 한달살기 맞교환 여행! “크리스마스 in Paris”/,
  /^이용약관 개인정보처리방침$/,
  /^Copyright © 원여행클럽/,
  /^(상호|주소): /,
  /^(Search|검색|Log In|로그인|Cart|장바구니)$/,
  // Sixshop editor filler text left in unfinished sections
  /^(설명글\s*)+$/,
  /^(더블 클릭하여 편집하세요\.?\s*)+$/,
];
const isBoilerplate = (t) => BOILERPLATE_RE.some((re) => re.test(t.trim()));
const CTA_RE = /^(예약\s*문의(하기)?|상담\s*(신청|하기)|자세히\s*보기|더\s*보기|바로\s*가기|구매하기|문의하기|리뷰 보러 가기\s*→?|모든 제품 보기|예시 보기|전화하기)$/;
const bgUrls = (style) => [...String(style ?? '').matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);
const fontPx = (el, $) => {
  let max = 0;
  $(el)
    .find('[style*="font-size"]')
    .addBack('[style*="font-size"]')
    .each((_, x) => {
      const m = String($(x).attr('style')).match(/font-size:\s*([\d.]+)px/);
      if (m) max = Math.max(max, Number(m[1]));
    });
  return max;
};

function extractBlocks(html, pageUrl) {
  const $ = cheerio.load(html);
  const price = oneLine($('#shopProductPrice .productPriceSpan, #shopProductPrice').first().text()) || null;
  for (const sel of SKIP_SELECTORS) $(sel).remove();
  // call-to-action paragraphs that are only a CTA link ("예약문의", "상담신청", "자세히보기 →")
  $('p').each((_, p) => {
    const a = $(p).find('a');
    const t = oneLine($(p).text());
    if (a.length === 1 && t && t === oneLine(a.text()) && CTA_RE.test(t) && !$(p).find('img').length) $(p).remove();
  });
  const hrefOf = (h) => {
    if (!h || /^(javascript:|#)/.test(h)) return null;
    try {
      const u = new URL(h, pageUrl);
      // the store's own pages are sometimes linked through the Sixshop host (sixshop.com/wontravel/<path>)
      if (/(^|\.)sixshop\.com$/.test(u.hostname) && /^\/wontravel(\/|$)/.test(u.pathname)) return normalizeLegacyPath(u.pathname.replace(/^\/wontravel/, '') || '/');
      return /(^|\.)wontc\.co\.kr$/.test(u.hostname) ? normalizeLegacyPath(u.pathname) : /^https?:$/.test(u.protocol) && !/^\d+$/.test(u.hostname) ? u.href : null;
    } catch {
      return null;
    }
  };
  const date = clean($('#blogPostCreatedDate, .blogPostCreatedDate').first().text()) || null;
  // the visible page is the opened Sixshop page (others are hidden shells); system pages render straight into the canvas
  let root = $('#displayCanvas .page-opened').first();
  if (!root.length) root = $('#displayCanvas').first();
  if (!root.length) root = $('body');
  const blocks = [];
  const seenImg = new Set();
  const pushImg = (u, alt = '', caption = '', href = null) => {
    const found = shaForUrl(u, pageUrl);
    if (!found) return;
    const sha = primaryOf(found);
    if (seenImg.has(sha)) return;
    seenImg.add(sha);
    blocks.push({ t: 'img', sha, found, alt: oneLine(alt), caption: oneLine(caption), href });
  };
  const pushText = (t, kind = 'p', level = 2, href = null) => {
    const s = clean(t);
    if (!s) return;
    const lines = s.split('\n').map((l) => l.trim()).filter((l) => l && !isBoilerplate(l));
    if (!lines.length) return;
    if (kind === 'h') blocks.push({ t: 'h', level, text: lines.join(' '), ...(href ? { href } : {}) });
    else blocks.push({ t: 'p', text: lines.join('\n') });
  };
  // text of an element with <br>/<p> turned into newlines, images excluded
  const textOf = (el) => {
    const c = $(el).clone();
    c.find('br').replaceWith('\n');
    c.find('p, div, li, h1, h2, h3, h4, h5, h6').each((_, x) => {
      $(x).prepend('\n').append('\n');
    });
    c.find('img, iframe, video').remove();
    return clean(c.text());
  };
  const isHeadingP = (el) => {
    const t = oneLine($(el).text());
    // Sixshop authors set whole sentences in 20px+; only short, unpunctuated lines read as headings
    if (!t || t.length > 32 || /[.!?。]$/.test(t)) return false;
    const px = fontPx(el, $);
    const bold = $(el).find('b, strong, [style*="font-weight: bold"], [style*="font-weight:bold"]').length > 0;
    return px >= 20 || (bold && px >= 18);
  };
  const richText = (el) => {
    // ckeditor / text-body: paragraphs + inline images in document order
    const kids = $(el).children();
    if (!kids.length) return pushText(textOf(el));
    let buf = [];
    const flush = () => {
      if (buf.length) pushText(buf.join('\n'));
      buf = [];
    };
    kids.each((_, k) => {
      const imgs = $(k).find('img').addBack('img');
      const frames = $(k).find('iframe').addBack('iframe');
      const t = textOf(k);
      if (t && /^(p|div|span|li|ul|ol|blockquote|table|h\d)$/i.test(k.tagName) && isHeadingP(k) && !imgs.length) {
        flush();
        pushText(t, 'h', 3);
      } else if (t) buf.push(t);
      if (imgs.length || frames.length) {
        flush();
        imgs.each((__, i) => pushImg($(i).attr('src') || $(i).attr('data-src'), $(i).attr('alt')));
        frames.each((__, f) => pushEmbed($(f).attr('src') || $(f).attr('data-src'), $(f).attr('title')));
      }
      for (const u of bgUrls($(k).attr('style'))) pushImg(u);
    });
    flush();
  };
  const pushEmbed = (src, title) => {
    const id = String(src ?? '').match(/(?:youtube(?:-nocookie)?\.com\/embed\/|youtu\.be\/)([\w-]{6,})/)?.[1];
    if (id && !blocks.some((b) => b.t === 'embed' && b.id === id)) blocks.push({ t: 'embed', provider: 'youtube', id, title: oneLine(title) });
  };
  const LIST_KINDS = {
    products: { item: '.shopProductWrapper', name: '.productName', desc: '.description', extra: '.price', date: null },
    gallery: { item: '.galleryWrapper', name: '.galleryCaptionTitle', desc: '.galleryCaptionDescription, .galleryCaptionBody', extra: null, date: null },
    posts: { item: '.blogPostWrapper', name: '.title', desc: '.summary, .description', extra: null, date: '.date' },
  };
  const pushList = (el, kind) => {
    const k = LIST_KINDS[kind];
    const items = [];
    const seen = new Set();
    $(el)
      .find(k.item)
      .each((_, it) => {
        const $it = $(it);
        const name = oneLine($it.find(k.name).first().text());
        const desc = k.desc ? oneLine($it.find(k.desc).first().text()) : '';
        const extra = k.extra ? oneLine($it.find(k.extra).first().text()) : '';
        const date = k.date ? oneLine($it.find(k.date).first().text()) : '';
        const href = hrefOf($it.find('a[href]').first().attr('href') || $it.closest('a[href]').attr('href'));
        const shas = [];
        $it.find('[style*="background-image"], img').each((__, x) => {
          for (const u of x.tagName === 'img' ? [$(x).attr('src') || $(x).attr('data-src')] : bgUrls($(x).attr('style'))) {
            const sha = shaForUrl(u, pageUrl);
            if (sha) shas.push(primaryOf(sha));
          }
        });
        const key = `${name}|${href}|${desc}`;
        if ((!name && !shas.length) || seen.has(key)) return;
        seen.add(key);
        items.push({ name, description: desc || null, status: extra || null, date: date || null, href, shas: uniq(shas) });
      });
    if (!items.length) return;
    const prevNames = new Set(blocks.filter((b) => b.t === 'list').flatMap((b) => b.items.map((i) => `${i.name}|${i.href}`)));
    if (items.every((i) => prevNames.has(`${i.name}|${i.href}`))) return; // the same rail rendered twice (desktop/mobile)
    for (const it of items) for (const s of it.shas) seenImg.add(s);
    blocks.push({ t: 'list', kind, items });
  };

  const visit = (el) => {
    if (el.type === 'text') {
      const t = clean(el.data);
      if (t && t.length > 1) pushText(t);
      return;
    }
    if (el.type !== 'tag') return;
    const $el = $(el);
    const tag = el.tagName.toLowerCase();
    const itemType = $el.attr('data-itemtype');
    const cls = ($el.attr('class') ?? '').split(/\s+/);
    if (cls.includes('hide') && !cls.includes('text-assi')) return;
    // hero caption (custom pages)
    if (cls.includes('heroCaptionWrapper')) {
      pushText($el.find('.heroCaptionTitle').text(), 'h', 2);
      pushText(textOf($el.find('.heroCaptionBody')));
      return;
    }
    if (itemType === 'text-title') {
      const ps = ($el.find('.item-element').children().length ? $el.find('.item-element').children().toArray() : [el]).filter((p) => textOf(p));
      if (!ps.length) return;
      const first = oneLine(textOf(ps[0]));
      const links = $(ps[0]).find('a[href]');
      const href = links.length === 1 && oneLine(links.text()) === first ? hrefOf(links.attr('href')) : null;
      // a "title" element holding a whole sentence is body copy, not a heading
      if (first.length > 40 || /[.。]$/.test(first)) pushText(ps.map((p) => textOf(p)).join('\n'));
      else {
        pushText(first, 'h', 2, href);
        if (ps.length > 1) pushText(ps.slice(1).map((p) => textOf(p)).join('\n'));
      }
      return;
    }
    if (itemType === 'text-body') return richText($el.find('.item-element').first().length ? $el.find('.item-element').first() : el);
    if (itemType === 'image') {
      const href = hrefOf($el.find('a[href]').first().attr('href'));
      $el.find('[style*="background-image"]').each((_, x) => bgUrls($(x).attr('style')).forEach((u) => pushImg(u, '', '', href)));
      $el.find('img').each((_, i) => pushImg($(i).attr('src') || $(i).attr('data-src'), $(i).attr('alt'), '', href));
      const cap = textOf(el);
      if (cap) pushText(cap);
      return;
    }
    if (itemType === 'video') {
      $el.find('iframe').each((_, f) => pushEmbed($(f).attr('src') || $(f).attr('data-src'), $(f).attr('title')));
      return;
    }
    if (itemType === 'productListSlide' || itemType === 'productList') return pushList(el, 'products');
    if (itemType === 'gallery') return pushList(el, 'gallery');
    if (itemType === 'blog') return pushList(el, 'posts');
    if (itemType === 'customForm') {
      const title = oneLine($el.find('[class*="title"]').first().text());
      if (title) pushText(title, 'h', 3);
      blocks.push({ t: 'form' });
      return;
    }
    if (/^h[1-6]$/.test(tag)) return pushText(textOf(el), 'h', Math.max(2, Number(tag[1])));
    if (tag === 'img') return pushImg($el.attr('src') || $el.attr('data-src'), $el.attr('alt'));
    if (tag === 'iframe') return pushEmbed($el.attr('src') || $el.attr('data-src'), $el.attr('title'));
    if (tag === 'video') return;
    if (cls.includes('ckeditor-content') || cls.includes('postContent') || cls.includes('viewDetail')) return richText(el);
    if ($el.attr('id') === 'blogPostTitle' || $el.attr('id') === 'shopProductName') return pushText(textOf(el), 'h', 1);
    if ($el.attr('id') === 'blogPostCreatedDate' || cls.includes('blogPostCreatedDate')) return;
    if (tag === 'p' && !$el.find('img, iframe, [style*="background-image"]').length) {
      if (isHeadingP(el)) return pushText(textOf(el), 'h', 3);
      return pushText(textOf(el));
    }
    for (const u of bgUrls($el.attr('style'))) pushImg(u);
    $el.contents().each((_, c) => visit(c));
  };
  visit(root.get(0));
  // merge consecutive paragraphs; drop exact duplicate text blocks (carousel clones, repeated captions)
  const out = [];
  const seenText = new Set();
  for (const b of blocks) {
    if (b.t === 'p' || b.t === 'h') {
      const key = `${b.t}:${b.text}`;
      if (seenText.has(key)) continue;
      seenText.add(key);
    }
    out.push(b);
  }
  return { blocks: out, date, price };
}

export { extractBlocks };

if (args.includes('--debug-page')) {
  const slug = opt('debug-page');
  const p = manifest.pages.find((x) => x.slug === slug);
  const html = await fs.readFile(path.join(RAW, 'legacy-raw/pages', `${slug}.html`), 'utf8');
  const r = extractBlocks(html, p.url);
  for (const b of r.blocks) console.log(JSON.stringify(b).slice(0, 220));
  console.log('date', r.date, 'unresolved', [...unresolvedUrls.keys()].slice(0, 10));
  process.exit(0);
}

// ─────────────────────────────────────────── site chrome ───────────────────────────────────────────
const SITE_SUFFIX_RE = /\s*\|\s*전세계 살아보기, 비행기공유플랫폼\s*$/;
const TEMPLATE_RE = /사용 설명서|식스샵|sixshop|LIFE FOR US|라이프포어스/i;
const chromeOf = async () => {
  const idx = manifest.pages.find((p) => pagePath(p.url) === '/');
  const html = await fs.readFile(path.join(RAW, 'legacy-raw/pages', `${idx.slug}.html`), 'utf8');
  const $ = cheerio.load(html);
  const nav = [];
  $('.headerMenuListContents.desktop')
    .first()
    .children('li')
    .each((_, li) => {
      const a = $(li).children('a').first();
      const href = (h) => {
        if (!h) return null;
        try {
          const u = new URL(h, idx.url);
          return /wontc\.co\.kr$/.test(u.hostname) ? normalizeLegacyPath(u.pathname) : u.href;
        } catch {
          return h;
        }
      };
      nav.push({
        label: oneLine(a.text()),
        path: href(a.attr('href')),
        children: $(li)
          .find('.subMenuNaviList a')
          .toArray()
          .map((x) => ({ label: oneLine($(x).text()), path: href($(x).attr('href')) })),
      });
    });
  // the marquee repeats one sentence; the captured innerText starts with a single copy of it
  const banner = $('.marqueeBanner').length ? clean(idx.text.split('\n')[0]) : null;
  const footerText = clean(idx.text.split('\n').slice(-6).join('\n'));
  const field = (re) => footerText.match(re)?.[1]?.trim() ?? null;
  return {
    name: '원여행클럽 WON TRAVEL CLUB',
    siteTitle: idx.title,
    origin: 'https://www.wontc.co.kr',
    platform: 'Sixshop',
    nav,
    banner,
    footer: {
      company: field(/상호:\s*([^|]+)/),
      ceo: field(/대표:\s*([^|]+)/),
      privacyOfficer: field(/개인정보관리책임자:\s*([^|]+)/),
      phone: field(/전화:\s*([^|]+)/),
      email: field(/이메일:\s*(\S+)/),
      address: field(/주소:\s*([^|]+)/),
      businessNumber: field(/사업자등록번호:\s*(\S+)/),
      copyright: footerText.match(/Copyright[^\n]+/)?.[0]?.trim() ?? null,
    },
  };
};
const site = await chromeOf();

// ───────────────────────────────────────── build legacy pages ─────────────────────────────────────────
const pagesByAsset = new Map(); // sha → Set(path)
for (const [sha, a] of Object.entries(LEG)) pagesByAsset.set(sha, new Set(a.pages ?? []));
const assetsOnPath = new Map();
for (const [sha, ps] of pagesByAsset) for (const p of ps) (assetsOnPath.get(p) ?? assetsOnPath.set(p, new Set()).get(p)).add(sha);
const SITE_WIDE_MIN_PAGES = 15;
const chromeShas = Object.keys(LEG).filter((s) => pagesByAsset.get(s).size >= SITE_WIDE_MIN_PAGES);

const pageRecords = [];
const skipped = [];
for (const [p, variants] of groups) {
  const ordered = variants.slice().sort((a, b) => hostRank(a.url) - hostRank(b.url));
  const page = ordered[0];
  const htmlFile = path.join(RAW, 'legacy-raw/pages', `${page.slug}.html`);
  const html = existsSync(htmlFile) ? await fs.readFile(htmlFile, 'utf8') : '';
  const { blocks, date, price } = html ? extractBlocks(html, page.url) : { blocks: [], date: null, price: null };
  const title = clean(page.title).replace(SITE_SUFFIX_RE, '') || null;
  const all = [...(assetsOnPath.get(p) ?? [])];
  const unique = all.filter((s) => pagesByAsset.get(s).size === 1);
  const textBlocks = blocks.filter((b) => b.t === 'h' || b.t === 'p');
  const isTemplate = TEMPLATE_RE.test(`${title}\n${textBlocks.map((b) => b.text).join('\n')}`);
  const isSystem = /^\/(signup|login|cart|order|mypage|search|all)$/.test(p) || /\{\{SITEURI\}\}/.test(p);
  const rec = { path: p, page, ordered, blocks, date, price, title, all, unique, isTemplate, isSystem };
  if ((isSystem || isTemplate) && !unique.length) {
    skipped.push({
      path: p,
      legacyUrls: ordered.map((x) => x.url),
      title,
      reason: `Sixshop ${isSystem ? 'system' : 'template'} page without unique media (${all.length ? `only site chrome: ${all.map(sha12).join(', ')}` : 'no media, no text'})`,
      media: all.length,
    });
    continue;
  }
  if (!textBlocks.length && !unique.length && !blocks.some((b) => b.t === 'img' || b.t === 'list' || b.t === 'embed')) {
    skipped.push({
      path: p,
      legacyUrls: ordered.map((x) => x.url),
      title,
      reason: `empty page — no text and no content media${all.length ? ` (only site chrome: ${all.map(sha12).join(', ')})` : ''}`,
      media: all.length,
    });
    continue;
  }
  pageRecords.push(rec);
}
// identical content under two paths (/home ≡ /): keep the shorter path, record the other as alias
const sig = (r) => JSON.stringify(r.blocks.map((b) => (b.t === 'img' ? b.sha : b.t === 'list' ? b.items.map((i) => i.name) : b.text ?? b.id)));
const bySig = new Map();
for (const r of pageRecords) {
  const k = sig(r);
  const prev = bySig.get(k);
  if (prev && r.blocks.length) {
    const [keep, drop] = prev.path.length <= r.path.length ? [prev, r] : [r, prev];
    keep.aliases = [...(keep.aliases ?? []), drop.path, ...(drop.aliases ?? [])];
    keep.aliasUrls = [...(keep.aliasUrls ?? []), ...drop.ordered.map((x) => x.url)];
    keep.all = uniq([...keep.all, ...drop.all]);
    drop.dropped = true;
    bySig.set(k, keep);
    skipped.push({ path: drop.path, legacyUrls: drop.ordered.map((x) => x.url), title: drop.title, reason: `duplicate of ${keep.path} (identical content) — kept as alias`, aliasOf: keep.path, media: drop.all.length });
  } else bySig.set(k, r);
}
const livePages = pageRecords.filter((r) => !r.dropped);

const embedsById = new Map((optimized.embeds ?? []).map((e) => [e.id, e]));
const posterOf = (id) => (embedsById.get(id)?.thumbnail?.sha ? primaryOf(embedsById.get(id).thumbnail.sha) : null); // best captured poster
const kindOf = (p, isTemplate) =>
  /^\/product\//.test(p) ? 'tour-product' : /^\/blogPost\//.test(p) ? 'heart-letter' : isTemplate ? 'sixshop-template' : p === '/' ? 'home' : 'page';
const letterNo = (p) => p.match(/\/blogPost\/hea(?:r)?t_letter_(\d+)/)?.[1] ?? null;
const legacyPages = [];
const pageOfSha = new Map(); // sha → [slug]
const contentShasOf = (blocks) => uniq(blocks.flatMap((b) => (b.t === 'img' ? [b.sha] : b.t === 'list' ? b.items.flatMap((i) => i.shas) : [])));
const contentHome = new Map(); // rendition key → paths that show it as page content
for (const r of livePages) for (const s of contentShasOf(r.blocks)) (contentHome.get(renditionKey(s)) ?? contentHome.set(renditionKey(s), new Set()).get(renditionKey(s))).add(r.path);
for (const r of livePages) {
  const { page, blocks } = r;
  const slug = page.slug;
  const kind = kindOf(r.path, r.isTemplate);
  const route = routeFor(r.path, r.title ?? '');
  const cmsSlug = slugForPath(r.path);
  const entryRoute = ENTRY_PATHS[route.type]?.(cmsSlug) ?? `/stories/${cmsSlug}`;
  const redirectTo = route.target ?? (route.type === 'PAGE' ? null : entryRoute);
  const contentAssets = contentShasOf(blocks);
  const embedIds = uniq(blocks.filter((b) => b.t === 'embed').map((b) => b.id));
  for (const id of embedIds) if (!embedsById.has(id)) console.warn(`warn: embed ${id} on ${r.path} has no captured thumbnail`);
  // every other medium of the page: alternate renditions of shown images, og:image, CSS backgrounds, player chrome
  const ogSha = page.ogImage ? shaForUrl(page.ogImage, page.url) : null;
  const pageOg = ogSha && !chromeShas.includes(ogSha) ? ogSha : null;
  const embedMedia = embedIds.flatMap((id) => {
    const e = embedsById.get(id);
    return e?.thumbnail?.sha ? groupOf(e.thumbnail.sha) : [];
  });
  const rest = r.all.filter((s) => !chromeShas.includes(s));
  const placed = new Set(contentAssets.flatMap((s) => groupOf(s)));
  const alternates = rest.filter((s) => placed.has(s) && !contentAssets.includes(s));
  const embedChrome = embedIds.length ? rest.filter((s) => !placed.has(s) && (embedMedia.includes(s) || /ytimg|ggpht|gstatic\.com\/youtube/.test(LEG[s].sourceUrls.join(' ')))) : [];
  // thumbnails of OTHER pages (related-product rails, cross-links) belong to those pages, not to this one
  // (the page's own og:image is its cover even when another page lists it as a thumbnail)
  const ogKey = pageOg ? renditionKey(pageOg) : null;
  const ogCover = pageOg && !placed.has(pageOg) ? primaryOf(pageOg) : null;
  const related = rest.filter((s) => !placed.has(s) && !embedChrome.includes(s) && renditionKey(s) !== ogKey && [...(contentHome.get(renditionKey(s)) ?? [])].some((q) => q !== r.path));
  const extra = rest.filter((s) => !placed.has(s) && !embedChrome.includes(s) && !related.includes(s) && renditionKey(s) !== ogKey);
  // extras that are renditions of each other → show the best one once
  const extraPrimary = uniq(extra.map((s) => (extra.includes(primaryOf(s)) ? primaryOf(s) : s))).filter((s) => !placed.has(s));
  const ogRenditions = ogCover ? groupOf(ogCover).filter((x) => rest.includes(x) && x !== ogCover) : [];
  // reading order: cover, then images / video posters / list thumbnails as they appear on the page
  const readingOrder = blocks.flatMap((b) => (b.t === 'img' ? [b.sha] : b.t === 'embed' ? [posterOf(b.id)].filter(Boolean) : b.t === 'list' ? b.items.flatMap((i) => i.shas) : []));
  const assets = uniq([...(ogCover ? [ogCover] : []), ...readingOrder, ...extraPrimary, ...embedChrome, ...alternates, ...ogRenditions, ...extra, ...related]);
  const headings = blocks.filter((b) => b.t === 'h').map((b) => b.text).filter((t) => t !== r.title);
  const textLines = [];
  for (const b of blocks) {
    if (b.t === 'h' || b.t === 'p') textLines.push(b.text);
    else if (b.t === 'list') for (const it of b.items) textLines.push([it.name, it.description, it.status].filter(Boolean).join(' · '));
  }
  const coverCandidates = [pageOg, ...contentAssets, ...extraPrimary].filter(Boolean).map(primaryOf).filter((s) => {
    const c = classes[s];
    return c && !isUiChrome(s) && !['icon', 'logo'].includes(c.category) && c.quality !== 'low';
  });
  const shotSrc = path.join(RAW, 'legacy-raw/pages', `${slug}.jpg`);
  const rec = {
    legacyUrl: `${site.origin}${r.path === '/' ? '/' : r.path}`,
    legacyUrls: uniq([...r.ordered.map((x) => x.url), ...(r.aliasUrls ?? [])]),
    path: r.path,
    aliases: r.aliases ?? [],
    slug,
    kind,
    template: r.isTemplate,
    title: r.title,
    description: (() => {
      const d = clean(page.description);
      const flat = (x) => String(x ?? '').replace(/\s+/g, '');
      const all = flat(textLines.join(''));
      if (!d || d === site.siteTitle || all.includes(flat(d))) return null;
      if (textLines.some((l) => flat(l).length >= 8 && flat(d).startsWith(flat(l)))) return null; // auto-generated from the first lines
      return d;
    })(),
    date: r.date,
    price: r.price,
    letterNo: letterNo(r.path),
    headings,
    text: clean(textLines.join('\n')),
    assets,
    contentAssets,
    extraAssets: extraPrimary,
    alternateAssets: uniq([...alternates, ...ogRenditions, ...extra.filter((s) => !extraPrimary.includes(s))]),
    coverAsset: ogCover,
    relatedAssets: related,
    embeds: embedIds,
    ogImage: pageOg,
    cover: coverCandidates[0] ?? null,
    // entryRoute: where the migrated CMS entry lives; redirectTo: 301 target for the legacy URL (plan.mjs rules);
    // targetRoute: the platform page that should render this content (PAGE → its section, else the story entry)
    cms: {
      slug: cmsSlug,
      type: route.type,
      entryRoute,
      redirectTo,
      targetRoute: route.type === 'PAGE' ? route.target ?? '/' : entryRoute,
      context: route.context,
    },
    markdown: rel(path.join(PAGES_DIR, `${slug}.md`)),
    screenshot: existsSync(shotSrc) ? { capture: rel(shotSrc), preview: rel(path.join(SHOTS_DIR, `${slug}.webp`)) } : null,
    _blocks: blocks,
  };
  legacyPages.push(rec);
  for (const s of assets) (pageOfSha.get(s) ?? pageOfSha.set(s, []).get(s)).push(slug);
}
const pageOrder = (p) => (p.kind === 'home' ? 0 : p.kind === 'page' ? 1 : p.kind === 'tour-product' ? 2 : p.kind === 'heart-letter' ? 3 : 4);
legacyPages.sort((a, b) => pageOrder(a) - pageOrder(b) || a.path.localeCompare(b.path, 'en', { numeric: true }));
const pageBySlug = new Map(legacyPages.map((p) => [p.slug, p]));
const pageByPath = new Map(legacyPages.flatMap((p) => [[p.path, p], ...p.aliases.map((a) => [a, p])]));
// list items (product rails, letter lists) → link to the migrated page when titles match
for (const p of legacyPages)
  for (const l of p._blocks.filter((b) => b.t === 'list'))
    for (const it of l.items) {
      const target = (it.href && pageByPath.get(it.href)) || legacyPages.find((q) => q.title && it.name && q.title === it.name);
      it.page = target ? target.slug : null;
    }

// ─────────────────────────────── normalized page content (JSON blocks) ───────────────────────────────
// What the platform renders for a migrated page (the .md file is rendered from the same blocks):
//   heading {level 2|3, text, href?} · paragraph {text} · image {sha, href?, caption?} · embed {provider, id, title, posterSha,
//   watchUrl, embedUrl, dateText} · list {kind, items[{name, description, status, date, href, page, shas}]} · form {label}
// hrefs are platform routes when the target legacy page was migrated, absolute URLs for external links, else omitted.
const navPath = new Map(site.nav.flatMap((n) => [[n.label, n.path], ...n.children.map((c) => [c.label, c.path])]).filter(([, v]) => v));
const routeOfHref = (h) => (!h ? null : pageByPath.get(h)?.cms.targetRoute ?? (/^https?:/.test(h) ? h : null));
function pageContent(p) {
  const src = p._blocks;
  // the legacy site mislinks some tiles (원여행클럽 소개 → /about_ceo); a heading naming a menu entry links where the menu does
  const headingHref = (b) => (b?.t === 'h' && b.href ? navPath.get(b.text) ?? b.href : null);
  const out = [];
  let lastH = null;
  const visible = (sha) => p.template || !isUiChrome(sha);
  src.forEach((b, i) => {
    if (b.t === 'h') {
      if ((b.level === 1 && b.text === p.title) || b.text === lastH) return;
      lastH = b.text;
      const href = routeOfHref(headingHref(b));
      out.push({ type: 'heading', level: b.level <= 2 ? 2 : 3, text: b.text.replace(/#+$/, '').trim(), ...(href ? { href } : {}) });
    } else if (b.t === 'p') {
      if (p.date && b.text === p.date) return;
      out.push({ type: 'paragraph', text: b.text });
    } else if (b.t === 'img') {
      if (!visible(b.sha)) return;
      const href = routeOfHref(headingHref(src[i + 1]) ?? b.href);
      out.push({ type: 'image', sha: b.sha, ...(href ? { href } : {}), ...(b.caption ? { caption: b.caption } : {}) });
    } else if (b.t === 'embed') {
      const e = embedsById.get(b.id);
      out.push({
        type: 'embed',
        provider: 'youtube',
        id: b.id,
        title: e?.title || b.title || 'YouTube',
        posterSha: posterOf(b.id),
        watchUrl: e?.watchUrl ?? `https://www.youtube.com/watch?v=${b.id}`,
        embedUrl: e?.embedUrl ?? `https://www.youtube-nocookie.com/embed/${b.id}`,
        dateText: e?.dateText ?? null,
      });
    } else if (b.t === 'list') {
      const items = b.items.map((it) => {
        const target = it.page ? pageBySlug.get(it.page) : null;
        return {
          name: it.name || null,
          description: it.description,
          status: it.status,
          date: it.date,
          href: target ? target.cms.targetRoute : routeOfHref(it.href),
          page: it.page,
          shas: it.shas.filter(visible),
        };
      });
      out.push({ type: 'list', kind: b.kind, items });
    } else if (b.t === 'form') out.push({ type: 'form', label: '문의 양식' });
  });
  return out;
}
for (const p of legacyPages) {
  p.blocks = pageContent(p);
  p.extraAssets = p.extraAssets.filter((s) => p.template || !isUiChrome(s));
  if (p.cover && !p.template && isUiChrome(p.cover)) p.cover = null;
}
const renderedShas = (p) =>
  uniq([
    ...(p.coverAsset ? [p.coverAsset] : []),
    ...p.blocks.flatMap((b) => (b.type === 'image' ? [b.sha] : b.type === 'embed' ? [b.posterSha] : b.type === 'list' ? b.items.flatMap((i) => i.shas) : [])),
    ...p.extraAssets,
  ]);

// ───────────────────────────────────────────── usages ─────────────────────────────────────────────
const slugify = (s) => String(s).normalize('NFKC').toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '');
const SUGGESTED = {
  'brand-archive': () => ['archive'],
  'home-hero': () => ['home:hero'],
  'about-ceo': () => ['about:ceo'],
  'about-wontc': () => ['about:wontc'],
  'about-jetpool': () => ['about:jetpool'],
  'won-story': () => ['about:won-story'],
  'heart-letter': (v) => ['heart-letter', `heart-letter:${v.match(/(\d+)$/)?.[1] ?? v}`],
  'travel-product': (v) => ['travel:legacy-product', `travel-product:${v}`],
  city: (v) => [`city:${slugify(v)}`],
  'charter-page': () => ['charter'],
  'local-life-exchange': () => ['exchange'],
  'member-stay': () => ['stay:member'],
  'tour-consulting': () => ['travel:consulting'],
  'tour-ticket': () => ['travel:tour-ticket'],
  'premium-lounge': () => ['charter:premium-lounge'],
  logo: () => ['brand:logo'],
  favicon: () => ['brand:favicon'],
};
const PHOTO_ROLE = (role) => {
  const [k, v] = role.split(':');
  if (k === 'city') return [`city:${slugify(v)}`];
  if (k === 'hero-candidate') return ['home:hero'];
  if (k === 'stay-exterior') return ['stay:exterior', `stay:exterior:${slugify(v)}`];
  if (k === 'stay-interior') return ['stay:interior', `stay:interior:${slugify(v)}`];
  if (k === 'guide-cover') return ['guide:cover', `guide:cover:${slugify(v)}`];
  if (k === 'travel') return ['travel:theme', `travel:theme:${slugify(v)}`];
  if (k === 'charter') return ['charter', `charter:${slugify(v)}`];
  return [slugify(role)];
};
// per-page placement keys keep reading order; archive keys keep page order; the rest are galleries (best first)
const ORDERED_PREFIXES = ['legacy-page:', 'archive', 'embed:', 'brand:'];
const usage = new Map(); // key → Set(sha)
const addUse = (key, sha) => (usage.get(key) ?? usage.set(key, new Set()).get(key)).add(sha);
const legacyShas = Object.keys(LEG);
const chromeRole = {};
for (const s of chromeShas) {
  const c = classes[s]?.category;
  const u = LEG[s].sourceUrls.join(' ');
  chromeRole[s] = c === 'logo' && /\.ico/.test(u) ? 'brand:favicon' : c === 'logo' ? 'brand:logo' : LEG[s].roles.includes('og:image') ? 'brand:og-default' : null;
}
// 1. page placement — shown on the migrated legacy page (content images, background/og images, video posters).
//    Sixshop UI chrome (grey placeholders, spacer bars, popup close) is not reproduced on WONT pages.
for (const p of legacyPages) {
  const shown = renderedShas(p);
  for (const s of p.assets) if (!p.template && isUiChrome(s)) addUse('archive:placeholder', s);
  for (const s of shown) addUse(`legacy-page:${p.slug}`, s);
  if (p.kind === 'heart-letter' && p.letterNo) for (const s of shown) addUse(`heart-letter:${p.letterNo}`, s), addUse('heart-letter', s);
  if (p.kind === 'tour-product') for (const s of shown) addUse(`travel-product:${p.path.split('/').pop()}`, s), addUse('travel:legacy-product', s);
  if (p.kind === 'home') for (const s of shown) addUse('home:brand', s);
  if (p.template) for (const s of p.assets) addUse('archive:sixshop-template', s);
  for (const s of p.alternateAssets) addUse('archive:rendition', s);
}
for (const e of optimized.embeds ?? []) if (e.thumbnail?.sha) for (const s of groupOf(e.thumbnail.sha)) addUse(`embed:${e.id}`, s);
// 2. classification suggestions + category rules (semantic galleries use the best rendition of each upload)
for (const s of legacyShas) {
  const c = classes[s];
  if (!c) continue;
  const target = primaryOf(s);
  for (const u of c.suggestedUsages ?? []) {
    const [k, ...rest] = u.split(':');
    const keys = SUGGESTED[k] ? SUGGESTED[k](rest.join(':')) : [u];
    for (const key of keys) addUse(key, key === 'archive' ? s : target);
  }
  if (c.category === 'award-press') addUse('about:press', target);
  if (c.category === 'ceo-portrait') addUse('about:ceo', target);
  if (c.category === 'letter-illustration') addUse('heart-letter', target);
  if (c.category === 'aircraft-charter') addUse('charter', target);
  if (c.category === 'accommodation') addUse('stay:legacy', target);
  if (c.category === 'destination-scenery' && c.quality === 'high') addUse('discover:legacy', target);
  if (chromeShas.includes(s)) {
    addUse('archive:site-chrome', s);
    if (chromeRole[s]) addUse(chromeRole[s], s);
  }
  addUse('archive', s); // brand archive gallery renders every migrated medium with its caption and source page
}
// the template/junk images keep only page + archive placements (they are not WONT brand imagery)
const TEMPLATE_ONLY = new Set(legacyShas.filter((s) => (pageOfSha.get(s) ?? []).length && (pageOfSha.get(s) ?? []).every((slug) => pageBySlug.get(slug)?.template)));
for (const [key, set] of usage)
  if (!key.startsWith('legacy-page:') && !key.startsWith('archive')) for (const s of TEMPLATE_ONLY) set.delete(s);
// 3. photos — accepted only
const PHOTOS = optimized.photos ?? {};
const excludedShas = new Set((optimized.excluded ?? []).map((e) => e.sha));
for (const [s, ph] of Object.entries(PHOTOS)) {
  const cur = curation[s];
  if (!cur?.accepted) continue;
  if (/-nd\b|\bnd\b/i.test(ph.license ?? '') || excludedShas.has(s)) continue;
  for (const r of cur.roles ?? []) for (const k of PHOTO_ROLE(r)) addUse(k, s);
  addUse('credits', s);
}

const QRANK = { high: 4, medium: 3, low: 1 };
const scoreOf = (s, key) => {
  const L = LEG[s];
  const P = PHOTOS[s];
  let q = L ? QRANK[classes[s]?.quality] ?? 2 : curation[s]?.quality ?? 2;
  const w = (L ?? P)?.width ?? 0;
  if (/hero|cover/.test(key)) q += w >= 1600 ? 0.5 : w < 900 ? -1.5 : 0;
  if (L && classes[s]?.isMostlyText && !/heart-letter|legacy-product|travel-product|about:press/.test(key)) q -= 1;
  return q;
};
const posIndex = new Map();
let pos = 0;
for (const p of legacyPages) for (const s of p.assets) if (!posIndex.has(s)) posIndex.set(s, pos++);
for (const s of legacyShas) if (!posIndex.has(s)) posIndex.set(s, pos++);
const usagePlan = {};
for (const key of [...usage.keys()].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
  const list = [...usage.get(key)];
  const ordered = ORDERED_PREFIXES.some((p) => key.startsWith(p));
  if (key.startsWith('legacy-page:')) {
    const pg = pageBySlug.get(key.slice('legacy-page:'.length));
    const order = new Map(pg.assets.map((s, i) => [s, i]));
    list.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
  } else if (ordered) list.sort((a, b) => (posIndex.get(a) ?? 1e9) - (posIndex.get(b) ?? 1e9) || a.localeCompare(b));
  else list.sort((a, b) => scoreOf(b, key) - scoreOf(a, key) || (posIndex.get(a) ?? 1e9) - (posIndex.get(b) ?? 1e9) || a.localeCompare(b));
  usagePlan[key] = list;
}
const usagesOf = new Map();
for (const [k, list] of Object.entries(usagePlan)) for (const s of list) (usagesOf.get(s) ?? usagesOf.set(s, []).get(s)).push(k);

const routeForUsage = (key) => {
  const [k, v, w] = key.split(':');
  const pg = k === 'legacy-page' ? pageBySlug.get(v) : null;
  const R = {
    'legacy-page': () => ({ route: pg.cms.targetRoute, description: `migrated legacy page ${pg.path} (${pg.title ?? pg.slug}) — inline images in reading order` }),
    archive: () => ({
      route: '/stories/legacy-archive',
      description: v ? { 'sixshop-template': 'archive section: Sixshop template/sample media found on the legacy site', rendition: 'archive section: alternate renditions (other sizes) of images shown elsewhere', placeholder: 'archive section: Sixshop grey placeholder / spacer images found on WONT pages', 'site-chrome': 'archive section: legacy site chrome (logo, favicon, default og:image, loader, popup close)' }[v] ?? `archive section ${v}` : 'brand archive gallery — every migrated wontc.co.kr medium with caption and source page',
    }),
    home: () => ({ route: '/', description: v === 'hero' ? 'home hero / large banner candidates (best first)' : 'legacy WONT brand content block on the home page' }),
    about: () => ({
      route: pageByPath.get({ ceo: '/about_ceo', wontc: '/about_wontc', jetpool: '/about_jetpool', 'won-story': '/won_story', press: '/about_ceo' }[v])?.cms.targetRoute ?? '/stories',
      description: { ceo: 'CEO 원치승 — portraits, career, press', wontc: '원여행클럽 소개 — brand/company story', jetpool: 'JETPOOL International (젯풀) — company & host programme', 'won-story': '원스토리 — brand story hub', press: 'awards, broadcasts, patents and press' }[v] ?? `brand story: ${v}`,
    }),
    'heart-letter': () => ({ route: v ? `/stories/${slugForPath(legacyPages.find((p) => p.letterNo === v)?.path ?? `/blogPost/heart_letter_${v}`)}` : '/stories', description: v ? `마음편지 ${v} (heart letter) page images` : '마음편지 (heart letters) series — scans, covers and illustrations' }),
    'travel-product': () => ({ route: '/travel', description: `legacy tour product ${v} (detail images, itinerary sheets)` }),
    travel: () => ({ route: '/travel', description: v === 'theme' ? `travel theme ${w ?? '(all)'} photos` : `travel: ${v}` }),
    city: () => ({ route: '/discover', description: `destination imagery: ${v}` }),
    discover: () => ({ route: '/discover', description: 'high-quality legacy destination scenery' }),
    charter: () => ({ route: '/jetpool-charter', description: v ? `charter: ${v}` : 'JETPOOL charter / flight-share imagery' }),
    exchange: () => ({ route: '/exchange', description: '한달살기 맞교환 (home-exchange month stays) imagery' }),
    stay: () => ({ route: '/stay', description: `stay imagery: ${[v, w].filter(Boolean).join(' / ')}` }),
    guide: () => ({ route: '/guide-friends', description: `guide cover photos: ${w ?? '(all)'}` }),
    embed: () => ({ route: '/stories/legacy-about-ceo', description: `YouTube video poster ${v}` }),
    brand: () => ({ route: null, description: `brand asset: ${v}` }),
    credits: () => ({ route: '/credits', description: 'every licensed photo shown anywhere — attribution list (CC BY / BY-SA requirement)' }),
  };
  return (R[k] ?? (() => ({ route: null, description: key })))();
};
const usageRoutes = Object.fromEntries(Object.keys(usagePlan).map((k) => [k, { ...routeForUsage(k), count: usagePlan[k].length }]));

// ─────────────────────────────────────────── asset records ───────────────────────────────────────────
const CLASS_FIELDS = ['category', 'isMostlyText', 'quality', 'subject', 'subjectEn', 'tags', 'suggestedUsages', 'notes', 'pageTitles'];
const assets = {};
for (const s of legacyShas.slice().sort((a, b) => (posIndex.get(a) ?? 0) - (posIndex.get(b) ?? 0))) {
  const c = classes[s] ?? {};
  const g = groupOf(s);
  assets[s] = {
    collection: 'legacy',
    sha12: sha12(s),
    ...LEG[s],
    ...Object.fromEntries(CLASS_FIELDS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]])),
    subjectKo: c.subject ?? null,
    alt: c.subject ?? (LEG[s].alts ?? [])[0] ?? '',
    classifiedIn: c._file ?? null,
    legacyPages: uniq(pageOfSha.get(s) ?? []),
    renditionGroup: renditionKey(s),
    renditions: g.length > 1 ? g : [],
    primaryRendition: g[0] === s,
    siteChrome: chromeShas.includes(s),
    templateOnly: TEMPLATE_ONLY.has(s),
    usages: usagesOf.get(s) ?? [],
  };
}
const photos = {};
for (const [s, ph] of Object.entries(PHOTOS)) {
  const cur = curation[s] ?? {};
  const shown = (usagesOf.get(s) ?? []).length > 0;
  photos[s] = {
    collection: 'photo',
    sha12: sha12(s),
    ...ph,
    accepted: Boolean(cur.accepted),
    roles: cur.roles ?? [],
    subjectKo: cur.subjectKo ?? null,
    subjectEn: cur.subjectEn ?? null,
    quality: cur.quality ?? null,
    ...(cur.reason ? { reason: cur.reason } : {}),
    alt: cur.subjectKo ?? ph.title ?? '',
    requiresAttribution: !/^(cc0|pdm)$/i.test(ph.license ?? ''),
    shareAlike: /-sa\b|^by-sa$/i.test(ph.license ?? ''),
    credit: {
      ko: `사진: ${ph.creator ?? ph.provider ?? '출처 미상'} · ${ph.licenseLabel ?? ph.license}`,
      en: `“${ph.title ?? 'Untitled'}”${ph.creator ? ` by ${ph.creator}` : ` via ${ph.provider ?? 'unknown source'}`} — ${ph.licenseLabel ?? ph.license}`,
      url: ph.landingUrl ?? null,
      licenseUrl: ph.licenseUrl ?? null,
    },
    curatedIn: cur._file ?? null,
    shown,
    usages: usagesOf.get(s) ?? [],
  };
}
const embeds = (optimized.embeds ?? []).map((e) => ({
  ...e,
  thumbnailSha: e.thumbnail?.sha ?? null,
  posterSha: posterOf(e.id),
  thumbnailRenditions: e.thumbnail?.sha ? groupOf(e.thumbnail.sha) : [],
  legacyPages: legacyPages.filter((p) => p.embeds.includes(e.id)).map((p) => p.slug),
}));

// ───────────────────────────────────────────── markdown ─────────────────────────────────────────────
// CommonMark: escape inline markers and the line-start constructs a sentence can accidentally form
const mdEsc = (l) =>
  String(l)
    .replace(/[\\`*<]/g, '\\$&')
    .replace(/^(\s*)(\d+)\.(\s)/, '$1$2\\.$3')
    .replace(/^(\s*)([#>+-])(\s)/, '$1\\$2$3');
const mdAlt = (s) => String(s ?? '').replace(/[[\]\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
const yamlVal = (v) => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : v === null || v === undefined ? 'null' : JSON.stringify(v));
const imgMd = (s, caption) => {
  const a = assets[s];
  const out = [`![${mdAlt(a.alt)}](${a.src})`];
  if (caption) out.push(`*${mdEsc(caption)}*`);
  return out.join('\n');
};
function pageMarkdown(p) {
  const fm = {
    title: p.title,
    legacyUrl: p.legacyUrl,
    path: p.path,
    aliases: p.aliases,
    kind: p.kind,
    template: p.template,
    date: p.date,
    price: p.price,
    targetRoute: p.cms.targetRoute,
    cmsSlug: p.cms.slug,
    cover: p.cover ? assets[p.cover].src : null,
    media: p.assets.length,
    embeds: p.embeds,
  };
  const out = ['---', ...Object.entries(fm).map(([k, v]) => `${k}: ${yamlVal(v)}`), '---', '', `# ${p.title ?? p.path}`, ''];
  if (p.template) out.push('> 이 페이지는 식스샵(Sixshop) 기본 템플릿/사용 설명서 콘텐츠입니다. 원여행클럽 자체 콘텐츠가 아니며, 보관용으로만 이전했습니다.', '');
  if (p.date) out.push(`*${p.date}*`, '');
  if (p.coverAsset) out.push(imgMd(p.coverAsset), '');
  if (p.description) out.push(mdEsc(p.description), '');
  for (const b of p.blocks) {
    if (b.type === 'heading') {
      const t = mdEsc(b.text);
      if (b.href && /^https?:/.test(b.href)) out.push(`[${t}](${b.href})`, ''); // external call-to-action (partner site)
      else out.push(`${b.level === 2 ? '##' : '###'} ${b.href ? `[${t}](${b.href})` : t}`, '');
    } else if (b.type === 'paragraph') {
      const lines = b.text.split('\n').map(mdEsc);
      out.push(lines.every((l) => l.length <= 60) ? lines.join('  \n') : lines.join('\n\n'), '');
    } else if (b.type === 'image') {
      out.push(b.href ? `[${imgMd(b.sha)}](${b.href})${b.caption ? `\n*${mdEsc(b.caption)}*` : ''}` : imgMd(b.sha, b.caption), '');
    } else if (b.type === 'embed') {
      if (b.posterSha) out.push(`[![${mdAlt(b.title)}](${assets[b.posterSha].src})](${b.watchUrl})`, '');
      out.push(`▶ [${mdEsc(b.title)}](${b.watchUrl})${b.dateText ? ` — ${b.dateText}` : ''}`, '');
    } else if (b.type === 'list') {
      for (const it of b.items) {
        const meta = [it.description, it.status, it.date].filter(Boolean).map(mdEsc).join(' · ');
        const name = it.name ? (it.href ? `[${mdEsc(it.name)}](${it.href})` : `**${mdEsc(it.name)}**`) : '';
        const label = [name, meta].filter(Boolean).join(' — ');
        if (!label) {
          for (const s of it.shas) out.push(imgMd(s), '');
          continue;
        }
        out.push(`- ${label}`);
        for (const s of it.shas) out.push(`  ${imgMd(s)}`);
      }
      out.push('');
    } else if (b.type === 'form') out.push('> [문의 양식 — 새 플랫폼의 상담 신청 기능으로 대체]', '');
  }
  if (p.extraAssets.length) {
    out.push('## 배경·추가 이미지', '', '*이전 사이트에서 섹션 배경, 대표 이미지(og:image) 등으로 쓰인 이미지입니다.*', '');
    for (const s of p.extraAssets) out.push(imgMd(s), '');
  }
  out.push(
    '---',
    '',
    p.template
      ? `*원본: ${p.legacyUrl} · 식스샵 템플릿 샘플 콘텐츠(원여행클럽 사이트에 남아 있던 기본 페이지), 보관용 이전*`
      : `*원본: ${p.legacyUrl} · 원여행클럽(WON TRAVEL CLUB) 소유 콘텐츠, 소유자 승인 하에 이전*`,
    '',
  );
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ─────────────────────────────────────── coverage + validation ───────────────────────────────────────
const errors = [];
const unclassified = legacyShas.filter((s) => !classes[s]);
const unused = legacyShas.filter((s) => !(usagesOf.get(s) ?? []).length);
if (unclassified.length) errors.push(`${unclassified.length} legacy media unclassified: ${unclassified.map(sha12).join(', ')}`);
if (unused.length) errors.push(`${unused.length} legacy media without usage: ${unused.map(sha12).join(', ')}`);
for (const [k, list] of Object.entries(usagePlan))
  for (const s of list) {
    if (!LEG[s] && !PHOTOS[s]) errors.push(`usage ${k}: unknown sha ${sha12(s)}`);
    if (PHOTOS[s]) {
      const ph = photos[s];
      if (!ph.accepted) errors.push(`usage ${k}: photo ${sha12(s)} is not accepted`);
      if (!ph.attribution || !ph.licenseUrl || !ph.landingUrl || (ph.requiresAttribution && !ph.creator)) errors.push(`usage ${k}: photo ${sha12(s)} lacks attribution`);
      if (/nd/i.test(ph.license)) errors.push(`usage ${k}: photo ${sha12(s)} is ${ph.licenseLabel}`);
    }
  }
const shownPhotos = Object.keys(photos).filter((s) => photos[s].shown);
const credited = new Set(usagePlan.credits ?? []);
for (const s of shownPhotos) if (!credited.has(s)) errors.push(`photo ${sha12(s)} shown but missing from credits`);
for (const s of Object.keys(PHOTOS)) if (excludedShas.has(s)) errors.push(`excluded (BY-ND) photo ${sha12(s)} present in photos`);
const missingCuration = Object.keys(PHOTOS).filter((s) => !curation[s]);
if (missingCuration.length) errors.push(`${missingCuration.length} photos without curation: ${missingCuration.map(sha12).join(', ')}`);
const publicDir = path.join(ROOT, optimized.params?.publicDir ?? 'apps/web/public');
const missingFiles = [];
for (const [s, a] of [...Object.entries(assets), ...Object.entries(photos)])
  for (const f of uniq([a.src, ...Object.values(a.variants ?? {})])) if (!existsSync(path.join(publicDir, f))) missingFiles.push(`${sha12(s)}:${f}`);
if (missingFiles.length) errors.push(`${missingFiles.length} published files missing under ${rel(publicDir)}: ${missingFiles.slice(0, 8).join(', ')}`);
for (const p of legacyPages) for (const s of p.assets) if (!LEG[s]) errors.push(`page ${p.slug}: unknown asset ${sha12(s)}`);
const allOnPages = new Set(legacyPages.flatMap((p) => p.assets));
const count = (xs) => Object.fromEntries([...xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map())].sort((a, b) => b[1] - a[1]));
const shownOnPages = new Set(Object.entries(usagePlan).filter(([k]) => k.startsWith('legacy-page:')).flatMap(([, v]) => v));
const coverage = {
  legacyMediaTotal: legacyShas.length,
  classified: legacyShas.length - unclassified.length,
  withUsage: legacyShas.length - unused.length,
  unused,
  onLegacyPages: legacyShas.filter((s) => allOnPages.has(s) || chromeShas.includes(s)).length,
  shownOnLegacyPages: shownOnPages.size,
  archiveOnly: legacyShas.filter((s) => (usagesOf.get(s) ?? []).every((k) => k.startsWith('archive'))),
  alternateRenditions: legacyShas.filter((s) => !assets[s].primaryRendition).length,
  siteChrome: chromeShas,
  byCategory: count(legacyShas.map((s) => classes[s]?.category ?? 'unclassified')),
  byQuality: count(legacyShas.map((s) => classes[s]?.quality ?? 'unclassified')),
  legacyPages: legacyPages.length,
  skippedPages: skipped.length,
  embeds: embeds.length,
  photos: {
    total: Object.keys(photos).length,
    accepted: Object.values(photos).filter((p) => p.accepted).length,
    rejected: Object.values(photos).filter((p) => !p.accepted).length,
    shown: shownPhotos.length,
    credited: credited.size,
    excludedNoDerivatives: excludedShas.size,
    byLicense: count(shownPhotos.map((s) => photos[s].licenseLabel)),
    acceptedByRole: count(Object.values(photos).filter((p) => p.accepted).flatMap((p) => p.roles)),
    acceptedByRoleFamily: count(Object.values(photos).filter((p) => p.accepted).flatMap((p) => uniq(p.roles.map((r) => r.split(':')[0])))),
    acceptedByGroup: count(Object.values(photos).filter((p) => p.accepted).flatMap((p) => p.groups ?? [])),
  },
  unresolvedPageUrls: [...unresolvedUrls.keys()],
  errors,
};

// screenshot previews (400px wide) of every captured page
if (!CHECK_ONLY) await fs.mkdir(SHOTS_DIR, { recursive: true });
if (sharp) {
  if (!CHECK_ONLY && existsSync(SHOTS_DIR)) {
    const keepShots = new Set(legacyPages.map((p) => `${p.slug}.webp`));
    for (const f of await fs.readdir(SHOTS_DIR)) if (!keepShots.has(f)) await fs.rm(path.join(SHOTS_DIR, f));
  }
  for (const p of legacyPages) {
    if (!p.screenshot) continue;
    const src = path.join(ROOT, p.screenshot.capture);
    const dst = path.join(ROOT, p.screenshot.preview);
    if (!CHECK_ONLY && (!existsSync(dst) || (await fs.stat(dst)).mtimeMs < (await fs.stat(src)).mtimeMs))
      await sharp(src, { limitInputPixels: false }).resize({ width: 400 }).webp({ quality: 50, effort: 5 }).toFile(dst);
    if (!existsSync(dst)) continue;
    const meta = await sharp(src).metadata();
    const out = await sharp(dst).metadata();
    Object.assign(p.screenshot, { captureWidth: meta.width, captureHeight: meta.height, width: out.width, height: out.height, bytes: (await fs.stat(dst)).size });
  }
}

// ─────────────────────────────────────────────── write ───────────────────────────────────────────────
const catalog = {
  generatedAt: new Date().toISOString(),
  version: 1,
  readme:
    'Single media catalog for the platform. Look a sha up in legacy.assets (collection "legacy": owner-authorised wontc.co.kr media) or photos (collection "photo"; ' +
    'openly-licensed — show only accepted ones and list every shown photo on /credits with its attribution). usagePlan maps a usage key to shas — ' +
    'galleries are best-first, legacy-page:* keys are in reading order; "archive" lists EVERY migrated legacy medium and must be rendered unfiltered ' +
    '(it is what guarantees that all of them are used). usageRoutes says ' +
    'where each key is meant to appear. File paths are web paths under apps/web/public (prefix the deploy basePath). ' +
    'Rebuild: node scripts/legacy/build-catalog.mjs',
  inputs: {
    optimized: { file: 'data/media/optimized.json', generatedAt: optimized.generatedAt, sig: optimized.params?.sig ?? null },
    classify: classifyFiles.map((f) => rel(f)),
    photoCuration: curationFiles.map((f) => rel(f)),
    capture: { manifest: rel(manifestPath), generatedAt: manifest.generatedAt },
  },
  legacy: {
    site,
    pages: legacyPages.map(({ _blocks, ...p }) => p),
    skipped,
    assets,
    embeds,
    nonMedia: (optimized.nonMedia ?? []).map((n) => ({ sha: n.sha, category: n.category, reason: n.reason, pages: n.pages })),
  },
  photos,
  usagePlan,
  usageRoutes,
  coverage,
};
const stable = (o) => JSON.stringify({ ...o, generatedAt: undefined }, null, 1);
if (CHECK_ONLY) {
  const prev = existsSync(OUT) ? await readJson(OUT) : null;
  const staleMd = [];
  for (const p of legacyPages) {
    const f = path.join(PAGES_DIR, `${p.slug}.md`);
    if (!existsSync(f) || (await fs.readFile(f, 'utf8')) !== pageMarkdown(p)) staleMd.push(rel(f));
  }
  const same = prev && stable(prev) === stable(catalog) && !staleMd.length;
  console.log(same ? 'catalog.json and legacy-pages/*.md are up to date' : `STALE (${[!(prev && stable(prev) === stable(catalog)) && 'catalog.json', ...staleMd].filter(Boolean).join(', ')}) — rerun node scripts/legacy/build-catalog.mjs`);
  process.exit(same && !errors.length ? 0 : 1);
}
const keepMd = new Set(legacyPages.map((p) => `${p.slug}.md`));
for (const f of await fs.readdir(PAGES_DIR)) if (f.endsWith('.md') && !keepMd.has(f)) await fs.rm(path.join(PAGES_DIR, f));
for (const p of legacyPages) await fs.writeFile(path.join(PAGES_DIR, `${p.slug}.md`), pageMarkdown(p));
await fs.writeFile(OUT, `${JSON.stringify(catalog, null, 1)}\n`);

// ─────────────────────────────────────────────── report ───────────────────────────────────────────────
const top = (o, n = 60) => Object.entries(o).slice(0, n).map(([k, v]) => `${k}=${v}`).join(', ');
console.log(`catalog → ${rel(OUT)} (${(Buffer.byteLength(JSON.stringify(catalog, null, 1)) / 1024).toFixed(0)} KB)`);
console.log(`legacy media: ${coverage.legacyMediaTotal} · classified ${coverage.classified} · with usage ${coverage.withUsage} · unused ${unused.length} · shown on legacy pages ${coverage.shownOnLegacyPages} · archive-only ${coverage.archiveOnly.length} · alternate renditions ${coverage.alternateRenditions}`);
console.log(`by category: ${top(coverage.byCategory)}`);
console.log(`pages: ${legacyPages.length} written to ${rel(PAGES_DIR)} · skipped ${skipped.length}: ${skipped.map((s) => `${s.path} (${s.reason.split(' (')[0]})`).join('; ')}`);
console.log(`photos: ${coverage.photos.total} · accepted ${coverage.photos.accepted} · rejected ${coverage.photos.rejected} · credited ${coverage.photos.credited}`);
console.log(`accepted photos by role family: ${top(coverage.photos.acceptedByRoleFamily)}`);
console.log(`accepted photos by role: ${top(coverage.photos.acceptedByRole, 80)}`);
const legacyCount = (k) => usagePlan[k].filter((s) => LEG[s]).length;
console.log(`usages (${Object.keys(usagePlan).length} keys):`);
for (const k of Object.keys(usagePlan)) console.log(`  ${k.padEnd(34)} ${String(usagePlan[k].length).padStart(4)}  (legacy ${legacyCount(k)}, photos ${usagePlan[k].length - legacyCount(k)})`);
if (coverage.unresolvedPageUrls.length) console.log(`unresolved image URLs in page HTML: ${coverage.unresolvedPageUrls.length}`);
if (errors.length) {
  console.error(`\nFAILED (${errors.length}):\n- ${errors.join('\n- ')}`);
  process.exit(1);
}
console.log('OK — every legacy medium classified and used; every shown photo credited.');
