import * as cheerio from 'cheerio';
import { isTrackerUrl, kindFromUrl, normalizeUrl, parseEmbed } from './url.mjs';

/**
 * HTML page → content record + every media reference. Modelled on Sixshop/site-builder markup:
 * lazy images (data-src/-original/-lazy…), srcset/picture, inline and stylesheet backgrounds, og/twitter images,
 * icons, <video>/<source>/poster, YouTube/Vimeo iframes, media URLs inside inline scripts/JSON (client-rendered data).
 */

const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul', 'label', 'button']);
const NO_TEXT = new Set(['script', 'style', 'noscript', 'template', 'iframe', 'object', 'embed', 'select', 'option', 'textarea', 'canvas', 'svg', 'math', 'video', 'audio', 'head', 'button']);
const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy', 'data-lazy-src', 'data-original-src', 'data-image','data-img', 'data-full', 'data-full-src', 'data-large', 'data-zoom-image', 'data-hi-res', 'data-echo', 'data-normal'];
const LAZY_SRCSET_ATTRS = ['srcset', 'data-srcset', 'data-lazy-srcset', 'data-original-set'];
const BG_ATTRS = ['data-bg', 'data-background', 'data-background-image', 'data-bg-src', 'data-image-src', 'data-bgset'];
const PLACEHOLDER_RE = /(^|\/)(blank|spacer|transparent|pixel|placeholder|loading|loader|lazy|grey|gray|empty)[-_.]?\w*\.(gif|png|svg)$/i;
const ZONE_TOKENS = { nav: ['nav', 'gnb', 'lnb', 'menu', 'navigation', 'navbar'], header: ['header', 'site-header', 'top-bar', 'topbar'], footer: ['footer', 'site-footer', 'copyright', 'company-info'] };

const collapse = (s) =>
  String(s ?? '')
    .replace(/[\s ​﻿]+/g, ' ')
    .replace(/ ?  ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const intAttr = (v) => {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** srcset → [{url, descriptor}] (WHATWG candidate parsing, commas inside URLs tolerated). */
export function parseSrcset(value) {
  const out = [];
  const s = String(value ?? '');
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let start = i;
    while (i < s.length && !/\s/.test(s[i])) i++;
    let url = s.slice(start, i);
    let descriptor = '';
    if (url.endsWith(',')) url = url.replace(/,+$/, '');
    else {
      start = i;
      let depth = 0;
      while (i < s.length) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth <= 0) break;
        i++;
      }
      descriptor = s.slice(start, i).trim();
      i++;
    }
    if (url) out.push({ url, descriptor });
  }
  return out;
}

/** CSS text → { images:[{url, property}], imports:[url] }; @font-face sources are ignored. */
export function parseCssUrls(css, baseUrl) {
  const text = String(css ?? '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/@font-face\s*\{[^}]*\}/gi, '');
  const images = [];
  const imports = [];
  for (const m of text.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?[^;]*;/gi)) {
    const u = normalizeUrl(m[2], baseUrl);
    if (u) imports.push(u);
  }
  const body = text.replace(/@import[^;]*;/gi, '');
  const propBefore = (idx) => {
    const head = body.slice(Math.max(0, idx - 300), idx);
    const m = /([a-z-]+)\s*:[^;{}]*$/i.exec(head);
    return m ? m[1].toLowerCase() : null;
  };
  for (const m of body.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const raw = m[2].trim();
    if (!raw || /^data:/i.test(raw) || raw.startsWith('#')) continue;
    const u = normalizeUrl(raw, baseUrl);
    if (u && kindFromUrl(u) !== 'font') images.push({ url: u, property: propBefore(m.index) });
  }
  // image-set("a.png" 1x, "b.png" 2x) with bare strings
  for (const m of body.matchAll(/image-set\(([^)]*)\)/gi)) {
    for (const s of m[1].matchAll(/(['"])([^'"]+)\1/g)) {
      const u = normalizeUrl(s[2], baseUrl);
      if (u) images.push({ url: u, property: propBefore(m.index) });
    }
  }
  return { images, imports };
}

const SCRIPT_URL_RE = /(?:https?:)?(?:\\?\/){2}[a-z0-9.-]+(?::\d+)?(?:\\?\/[^\s"'<>()\\]*?)+?\.(?:jpe?g|png|gif|webp|avif|svg|mp4|webm|mov|m4v)(?:\?[^\s"'<>\\]*)?(?=["'\s<>),\\]|$)/gi;

/** Absolute media URLs inside inline scripts / JSON (client-side rendered galleries). */
export function scanScriptUrls(text, baseUrl) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(SCRIPT_URL_RE)) {
    const raw = m[0].replace(/\\\//g, '/');
    const u = normalizeUrl(raw.startsWith('//') ? `https:${raw}` : raw, baseUrl);
    if (u) out.add(u);
  }
  return [...out];
}

function zoneOf(name, attribs, parentZone) {
  if (parentZone !== 'main') return parentZone;
  if (name === 'nav') return 'nav';
  if (name === 'footer') return 'footer';
  if (name === 'header') return 'header';
  const role = (attribs.role ?? '').toLowerCase();
  if (role === 'navigation') return 'nav';
  if (role === 'contentinfo') return 'footer';
  if (role === 'banner') return 'header';
  const tokens = `${attribs.id ?? ''} ${attribs.class ?? ''}`.toLowerCase().split(/\s+/).filter(Boolean);
  for (const [zone, list] of Object.entries(ZONE_TOKENS)) if (tokens.some((t) => list.includes(t))) return zone;
  return parentZone;
}

/**
 * @param {string} html
 * @param {string} pageUrl final URL of the page
 * @param {{ isAssetHost?: (url:string)=>boolean }} [opts]
 */
export function extractPage(html, pageUrl, opts = {}) {
  const $ = cheerio.load(html, { scriptingEnabled: false });
  const isAssetHost = opts.isAssetHost ?? (() => true);
  const baseHref = $('base[href]').attr('href');
  const base = (baseHref && normalizeUrl(baseHref, pageUrl)) || pageUrl;

  const meta = {};
  const og = {};
  const twitter = {};
  $('meta').each((_, el) => {
    const a = el.attribs;
    const key = (a.property ?? a.name ?? a.itemprop ?? '').trim();
    const content = a.content;
    if (!key || content === undefined) return;
    const k = key.toLowerCase();
    if (k.startsWith('og:')) {
      if (og[k.slice(3)] === undefined) og[k.slice(3)] = content.trim();
    } else if (k.startsWith('twitter:')) {
      if (twitter[k.slice(8)] === undefined) twitter[k.slice(8)] = content.trim();
    } else if (meta[k] === undefined) meta[k] = content.trim();
  });
  const title = collapse($('head title').first().text() || $('title').first().text()) || null;
  const canonical = normalizeUrl($('link[rel~="canonical"]').attr('href'), base);
  const lang = $('html').attr('lang') ?? null;
  const jsonLd = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      jsonLd.push(JSON.parse($(el).text()));
    } catch {
      /* invalid JSON-LD is ignored */
    }
  });

  const media = [];
  const embeds = [];
  const otherIframes = [];
  const flow = [];
  const links = new Map();
  const stylesheets = [];
  const inlineCss = [];
  const scriptUrls = new Set();
  let ignoredPlaceholders = 0;
  let ignoredTrackers = 0;
  let groupSeq = 0;
  const state = { lastHeading: null, buf: '' };

  const figcaptionOf = (el) => {
    const fig = $(el).closest('figure');
    return fig.length ? collapse(fig.find('figcaption').first().text()) || null : null;
  };

  /** add one media reference; returns its index or -1 */
  const addRef = (raw, { kind, via, role, el, zone, group, descriptor, implicit, alt } = {}) => {
    const url = normalizeUrl(raw, base);
    if (!url) return -1;
    const a = el?.attribs ?? {};
    const width = intAttr(a.width);
    const height = intAttr(a.height);
    if ((width !== null && width <= 2 && height !== null && height <= 2) || isTrackerUrl(url)) {
      ignoredTrackers++;
      return -1;
    }
    if (PLACEHOLDER_RE.test(new URL(url).pathname) && role !== 'icon') {
      ignoredPlaceholders++;
      return -1;
    }
    const k = kind ?? kindFromUrl(url);
    if (k === 'font' || k === 'doc') return -1;
    media.push({
      url,
      kind: k === 'unknown' ? 'unknown' : k,
      via,
      role: role ?? 'content',
      zone: zone ?? 'main',
      group: group ?? `g${++groupSeq}`,
      alt: alt !== undefined ? alt : a.alt !== undefined ? collapse(a.alt) : null,
      title: a.title ? collapse(a.title) : null,
      caption: el ? figcaptionOf(el) : null,
      context: state.lastHeading,
      width,
      height,
      descriptor: descriptor ?? null,
      implicit: !!implicit,
    });
    return media.length - 1;
  };

  const addCssRefs = (cssText, cssBase, ctx) => {
    const { images, imports } = parseCssUrls(cssText, cssBase);
    for (const u of imports) stylesheets.push(u);
    const idx = [];
    for (const im of images) {
      const i = addRef(im.url, { via: ctx.via, role: 'background', el: ctx.el, zone: ctx.zone, group: ctx.group, kind: kindFromUrl(im.url) === 'unknown' ? 'image' : undefined });
      if (i >= 0) idx.push(i);
    }
    return idx;
  };

  const flush = (tag, zone) => {
    const text = collapse(state.buf);
    state.buf = '';
    if (!text) return;
    if (/^h[1-6]$/.test(tag)) {
      state.lastHeading = text.replace(/\n/g, ' ');
      flow.push({ t: 'h', level: Number(tag[1]), text: state.lastHeading, zone });
    } else flow.push({ t: 'p', tag, text, zone });
  };

  const addLink = (href, el) => {
    const u = normalizeUrl(href, base);
    if (!u) return null;
    if (!links.has(u)) links.set(u, { url: u, text: collapse($(el).text()).slice(0, 200) || null, rel: el.attribs.rel ?? null });
    return u;
  };

  const handleImg = (el, zone, group, alt) => {
    const a = el.attribs;
    const idx = [];
    const push = (i) => i >= 0 && idx.push(i);
    for (const attr of LAZY_ATTRS) if (a[attr]) push(addRef(a[attr], { via: 'lazy', el, zone, group, alt, kind: kindFromUrl(normalizeUrl(a[attr], base) ?? '') === 'unknown' ? 'image' : undefined }));
    for (const attr of LAZY_SRCSET_ATTRS) {
      if (!a[attr]) continue;
      for (const c of parseSrcset(a[attr])) push(addRef(c.url, { via: attr === 'srcset' ? 'srcset' : 'lazy', el, zone, group, alt, descriptor: c.descriptor, kind: 'image' }));
    }
    if (a.src) push(addRef(a.src, { via: 'img', el, zone, group, alt, kind: kindFromUrl(normalizeUrl(a.src, base) ?? '') === 'unknown' ? 'image' : undefined }));
    return idx;
  };

  const walk = (node, ctx) => {
    if (node.type === 'text') {
      if (!ctx.noText) state.buf += node.data;
      return;
    }
    if (node.type !== 'tag' && node.type !== 'script' && node.type !== 'style') return;
    const name = node.name.toLowerCase();
    const a = node.attribs ?? {};
    const zone = zoneOf(name, a, ctx.zone);
    const isBlock = BLOCK.has(name);
    if (isBlock) flush(ctx.block, ctx.zone);
    if (name === 'br') {
      if (!ctx.noText) state.buf += ' ';
      return;
    }
    const hidden = a.hidden !== undefined || /display\s*:\s*none/i.test(a.style ?? '') || a['aria-hidden'] === 'true';
    let recurse = true;

    // inline style / data-bg backgrounds on any element
    if (a.style && /url\(/i.test(a.style)) {
      const idx = addCssRefs(`x{${a.style}}`, base, { via: 'style', el: node, zone, group: `g${++groupSeq}` });
      if (idx.length && zone === 'main') flow.push({ t: 'media', kind: 'image', refs: idx, background: true, zone });
    }
    for (const attr of BG_ATTRS) {
      if (!a[attr]) continue;
      const g = `g${++groupSeq}`;
      const candidates = attr === 'data-bgset' ? parseSrcset(a[attr]).map((c) => c.url) : [a[attr]];
      const idx = candidates.map((u) => addRef(u, { via: 'lazy', role: 'background', el: node, zone, group: g, kind: 'image' })).filter((i) => i >= 0);
      if (idx.length && zone === 'main') flow.push({ t: 'media', kind: 'image', refs: idx, background: true, zone });
    }

    switch (name) {
      case 'script': {
        recurse = false;
        if (!a.src) for (const u of scanScriptUrls($(node).text(), base)) scriptUrls.add(u);
        break;
      }
      case 'style': {
        recurse = false;
        inlineCss.push($(node).text());
        break;
      }
      case 'link': {
        recurse = false;
        break;
      }
      case 'img': {
        const parentPicture = node.parent && node.parent.name === 'picture';
        if (!parentPicture) {
          const g = `g${++groupSeq}`;
          const idx = handleImg(node, zone, g);
          if (idx.length) flow.push({ t: 'media', kind: 'image', refs: idx, zone });
        }
        break;
      }
      case 'picture': {
        recurse = false;
        const g = `g${++groupSeq}`;
        const img = $(node).find('img').get(0);
        const alt = img?.attribs?.alt !== undefined ? collapse(img.attribs.alt) : null;
        const idx = [];
        $(node)
          .find('source')
          .each((_, s) => {
            for (const attr of LAZY_SRCSET_ATTRS) {
              if (!s.attribs[attr]) continue;
              for (const c of parseSrcset(s.attribs[attr])) {
                const i = addRef(c.url, { via: 'picture', el: s, zone, group: g, alt, descriptor: c.descriptor, kind: 'image' });
                if (i >= 0) idx.push(i);
              }
            }
          });
        if (img) idx.push(...handleImg(img, zone, g, alt));
        if (idx.length) flow.push({ t: 'media', kind: 'image', refs: idx, zone });
        break;
      }
      case 'video': {
        recurse = false;
        const g = `g${++groupSeq}`;
        const idx = [];
        const add = (u, el, via) => {
          const i = addRef(u, { via, kind: 'video', role: 'video', el, zone, group: g, alt: a['aria-label'] ?? a.title ?? null });
          if (i >= 0) idx.push(i);
        };
        if (a.src) add(a.src, node, 'video');
        if (a['data-src']) add(a['data-src'], node, 'video');
        $(node)
          .find('source')
          .each((_, s) => {
            const u = s.attribs.src ?? s.attribs['data-src'];
            if (!u) return;
            const t = (s.attribs.type ?? '').toLowerCase();
            if (t && !t.startsWith('video/') && !t.includes('mpegurl') && !t.includes('dash')) return;
            add(u, s, 'source');
          });
        const poster = [];
        if (a.poster || a['data-poster']) {
          const i = addRef(a.poster ?? a['data-poster'], { via: 'poster', kind: 'image', role: 'poster', el: node, zone, group: `${g}:poster`, alt: a.title ?? null });
          if (i >= 0) poster.push(i);
        }
        if (idx.length || poster.length) flow.push({ t: 'media', kind: 'video', refs: idx, poster, zone, title: a.title ?? null });
        break;
      }
      case 'audio':
      case 'select':
      case 'textarea':
      case 'template':
        recurse = false;
        break;
      case 'iframe': {
        recurse = false;
        const src = a.src ?? a['data-src'] ?? a['data-lazy-src'];
        const u = normalizeUrl(src, base);
        const e = parseEmbed(u ?? src);
        if (e) {
          embeds.push({ ...e, title: a.title ? collapse(a.title) : null, context: state.lastHeading, via: 'iframe', zone });
          flow.push({ t: 'embed', embed: embeds.length - 1, zone });
        } else if (u) otherIframes.push({ url: u, title: a.title ?? null });
        break;
      }
      case 'source': {
        // stray <source> outside picture/video (handled by those parents)
        recurse = false;
        break;
      }
      case 'object':
      case 'embed': {
        recurse = false;
        const u = a.data ?? a.src;
        if (u) {
          const k = kindFromUrl(normalizeUrl(u, base) ?? '');
          if (k === 'video' || k === 'image') {
            const i = addRef(u, { via: name, kind: k, role: k === 'video' ? 'video' : 'content', el: node, zone });
            if (i >= 0) flow.push({ t: 'media', kind: k, refs: [i], poster: [], zone });
          }
        }
        break;
      }
      case 'input': {
        if ((a.type ?? '').toLowerCase() === 'image' && a.src) addRef(a.src, { via: 'input', el: node, zone, kind: 'image' });
        break;
      }
      case 'svg': {
        recurse = false;
        $(node)
          .find('image')
          .each((_, im) => {
            const href = im.attribs.href ?? im.attribs['xlink:href'];
            if (href) addRef(href, { via: 'svg', el: im, zone, kind: 'image' });
          });
        break;
      }
      case 'a':
      case 'area': {
        if (a.href) {
          const u = addLink(a.href, node);
          if (u) {
            const e = parseEmbed(u);
            if (e && !embeds.some((x) => x.provider === e.provider && x.videoId === e.videoId)) {
              embeds.push({ ...e, title: collapse($(node).text()) || a.title || null, context: state.lastHeading, via: 'link', zone });
              flow.push({ t: 'embed', embed: embeds.length - 1, zone });
            } else if (!e) {
              const k = kindFromUrl(u);
              if (k === 'image' || k === 'video') addRef(u, { via: 'link', kind: k, role: k === 'video' ? 'video' : 'content', el: node, zone, alt: a.title ?? null });
            }
          }
        }
        break;
      }
      default:
        break;
    }

    if (recurse) {
      const child = { zone, block: isBlock ? name : ctx.block, noText: ctx.noText || hidden || NO_TEXT.has(name) };
      for (const c of node.children ?? []) walk(c, child);
      if (isBlock) flush(name, zone);
    }
  };

  // head: icons, social images, preload images, stylesheets
  $('link[href]').each((_, el) => {
    const rel = (el.attribs.rel ?? '').toLowerCase().split(/\s+/);
    const href = el.attribs.href;
    if (rel.includes('stylesheet')) {
      const u = normalizeUrl(href, base);
      if (u) stylesheets.push(u);
    } else if (rel.some((r) => r === 'icon' || r === 'apple-touch-icon' || r === 'apple-touch-icon-precomposed' || r === 'mask-icon' || r === 'shortcut')) {
      addRef(href, { via: 'icon', kind: 'image', role: 'icon', zone: 'head' });
    } else if (rel.includes('image_src') || (rel.includes('preload') && (el.attribs.as ?? '') === 'image')) {
      addRef(href, { via: 'link', kind: 'image', role: 'content', zone: 'head' });
      if (el.attribs.imagesrcset) for (const c of parseSrcset(el.attribs.imagesrcset)) addRef(c.url, { via: 'link', kind: 'image', role: 'content', zone: 'head', descriptor: c.descriptor });
    }
  });
  const ogAlt = og['image:alt'] ?? twitter['image:alt'] ?? null;
  for (const [k, via] of [['image', 'og'], ['image:url', 'og'], ['image:secure_url', 'og']]) if (og[k]) addRef(og[k], { via, kind: 'image', role: 'og', zone: 'head', alt: ogAlt, group: 'og' });
  for (const k of ['image', 'image:src']) if (twitter[k]) addRef(twitter[k], { via: 'twitter', kind: 'image', role: 'og', zone: 'head', alt: ogAlt, group: 'og' });
  if (meta.image) addRef(meta.image, { via: 'meta', kind: 'image', role: 'og', zone: 'head', group: 'og' });
  if (meta['msapplication-tileimage']) addRef(meta['msapplication-tileimage'], { via: 'icon', kind: 'image', role: 'icon', zone: 'head' });
  if (!media.some((m) => m.role === 'icon')) addRef(new URL('/favicon.ico', base).toString(), { via: 'icon', kind: 'image', role: 'icon', zone: 'head', implicit: true });

  const body = $('body').get(0) ?? $.root().get(0);
  for (const c of body.children ?? []) walk(c, { zone: 'main', block: 'div', noText: false });
  flush('div', 'main');

  for (const css of inlineCss) addCssRefs(css, base, { via: 'css', zone: 'main' });
  for (const u of scriptUrls) {
    if (!isAssetHost(u)) continue;
    if (media.some((m) => m.url === u)) continue;
    addRef(u, { via: 'script', zone: 'main' });
  }

  const headings = flow.filter((b) => b.t === 'h').map((b) => ({ level: b.level, text: b.text }));
  const textBlocks = flow.filter((b) => b.t === 'h' || b.t === 'p').map((b) => ({ tag: b.t === 'h' ? `h${b.level}` : b.tag, text: b.text, zone: b.zone }));
  return {
    title,
    lang,
    canonical,
    description: meta.description ?? og.description ?? null,
    meta,
    og,
    twitter,
    jsonLd,
    headings,
    textBlocks,
    flow,
    links: [...links.values()],
    media,
    embeds,
    otherIframes,
    stylesheets: [...new Set(stylesheets)],
    ignored: { placeholders: ignoredPlaceholders, trackers: ignoredTrackers },
  };
}
