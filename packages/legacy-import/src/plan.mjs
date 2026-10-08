import { createHash } from 'node:crypto';

/**
 * Manifest → platform import plan (pure; no I/O, no dependencies). Used by the `import` step (CSV/JSON inputs for
 * apps/api/scripts/migrate-legacy.ts) and by packages/db/seed-legacy.mjs (DEV seed, direct SQL).
 *
 *  - one CMS entry per legacy page: slug "legacy-<path>", body_md with /legacy/... images, seo from meta/og,
 *    hero = page og:image (unless site-wide) or the first large content image
 *  - 301 candidates legacy path → new path (approved=false until business sign-off)
 *  - page/image contexts (exchange · tour · charter · guide + city) for demo listing assignment
 */

export const LEGACY_SYSTEM = 'LEGACY_WONT';
export const LEGACY_SOURCE = 'WONT';
export const PLAN_VERSION = 1;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** Legacy path → JETPOOL route (first match wins). `target: null` → the entry's own public path. */
export const ROUTE_RULES = [
  { test: /^\/(about[_-]?jetpool|jetpool|charter|flight[_-]?share)(?=\/|$|\?|_)/i, target: '/jetpool-charter', context: 'charter', type: 'PAGE' },
  { test: /^\/(local[_-]?life|locallife|exchange|home[_-]?exchange|house[_-]?swap|month[_-]?stay)(?=\/|$|\?|_)/i, target: '/exchange', context: 'exchange', type: 'PAGE' },
  { test: /^\/(tours?|tour[_-]?ticket|tickets?|travel|activit(y|ies))(?=\/|$|\?|_)/i, target: '/travel', context: 'tour', type: 'PAGE' },
  { test: /^\/(guides?|local[_-]?friends?|friends?)(?=\/|$|\?|_)/i, target: '/guide-friends', context: 'guide', type: 'PAGE' },
  { test: /^\/(board|blog|posts?|story|stories|notice|news|magazine|reviews?|community)(?=\/|$|\?|_)/i, target: null, context: null, type: 'STORY' },
];

/** apps/api cms ENTRY_PATHS (web route per entry type). */
export const ENTRY_PATHS = {
  DESTINATION: (s) => `/discover/${s}`,
  STORY: (s) => `/stories/${s}`,
  LEGACY_CONTENT: (s) => `/stories/${s}`,
  FAQ: (s) => `/faq/${s}`,
  PAGE: (s) => `/p/${s}`,
  PROMOTION: (s) => `/promotions/${s}`,
  BANNER: null,
};

export const CONTEXT_KEYWORDS = {
  exchange: /(한달\s*살기|한\s*달\s*살기|맞교환|집\s*(을\s*)?(바꿔|교환)|홈\s*익스체인지|home\s*exchange|house\s*swap|local\s*life|locallife|로컬\s*라이프|살아\s*보기)/i,
  charter: /(jetpool|젯풀|전세기|charter|플라이트\s*쉐어|flight\s*share)/i,
  tour: /(\btours?\b|투어|tour[_\s-]?ticket|티켓|입장권|액티비티|\bactivit(y|ies)\b)/i,
  guide: /(\bguides?\b|가이드|로컬\s*프렌드|local\s*friends?)/i,
};
export const CITY_KEYWORDS = {
  Seoul: /(서울|seoul)/i,
  Busan: /(부산|busan)/i,
  Jeju: /(제주|jeju)/i,
  Gangneung: /(강릉|gangneung)/i,
  Sokcho: /(속초|sokcho)/i,
  Gyeongju: /(경주|gyeongju)/i,
  Jeonju: /(전주|jeonju)/i,
  Yeosu: /(여수|yeosu)/i,
};

const keywordsIn = (text, table) => Object.entries(table).filter(([, re]) => re.test(text ?? '')).map(([k]) => k);

/** Same as apps/api normalizePath (seo_redirects.legacy_path). */
export function normalizeLegacyPath(input) {
  let s = String(input).trim();
  try {
    if (/^https?:\/\//i.test(s)) {
      const u = new URL(s);
      s = u.pathname + u.search;
    }
  } catch {
    /* keep raw */
  }
  s = s.split('#')[0];
  const qi = s.indexOf('?');
  let p = qi >= 0 ? s.slice(0, qi) : s;
  const qs = qi >= 0 ? s.slice(qi + 1) : undefined;
  try {
    p = decodeURI(p);
  } catch {
    /* leave encoded */
  }
  if (!p.startsWith('/')) p = `/${p}`;
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return qs ? `${p}?${qs}` : p;
}

export function slugForPath(legacyPath) {
  const p = normalizeLegacyPath(legacyPath);
  const s = p === '/' ? 'home' : p.normalize('NFKC').toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '');
  return `legacy-${s || 'page'}`.slice(0, 120).replace(/-+$/, '');
}

export function routeFor(legacyPath) {
  const p = normalizeLegacyPath(legacyPath);
  if (p === '/') return { target: null, context: null, type: 'PAGE', rule: 'root' };
  for (const r of ROUTE_RULES) if (r.test.test(p)) return { target: r.target, context: r.context, type: r.type, rule: r.test.source };
  return { target: null, context: null, type: 'LEGACY_CONTENT', rule: null };
}

const withSlash = (p) => (p ? `/${String(p).replace(/^\/+/, '')}` : null);

/** Best web rendition: 1600w webp → largest webp → original. */
export function displayPath(asset) {
  if (!asset?.files) return null;
  const w = asset.files.webp ?? {};
  const keys = Object.keys(w).map(Number).sort((a, b) => a - b);
  if (asset.mime === 'image/svg+xml' && asset.files.original) return withSlash(asset.files.original);
  if (w['1600']) return withSlash(w['1600']);
  const below = keys.filter((k) => k <= 1600);
  if (below.length) return withSlash(w[String(below[below.length - 1])]);
  if (keys.length) return withSlash(w[String(keys[0])]);
  return withSlash(asset.files.original);
}

export function srcsetOf(asset) {
  const r = (asset?.renditions ?? []).slice().sort((a, b) => a.width - b.width);
  return r.length ? r.map((x) => `${withSlash(x.path)} ${x.width}w`).join(', ') : null;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const mdText = (s) =>
  String(s ?? '')
    .split('\n')
    .map((l) => l.replace(/^(\s*)([#>*+-]|\d+\.)(\s)/, '$1\\$2$3'))
    .join('  \n');
const mdAlt = (s) => String(s ?? '').replace(/[[\]\\]/g, '').replace(/\s+/g, ' ').trim();
const truncate = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};

/** Site-wide title suffix such as " | WONT Travel Club" (shared by every page) is stripped from entry titles. */
function commonTitleSuffix(titles) {
  const list = titles.filter(Boolean);
  if (list.length < 2) return null;
  for (const sep of [' | ', ' - ', ' – ', ' — ', ' :: ', ' : ']) {
    const sufs = list.map((t) => (t.includes(sep) ? t.slice(t.lastIndexOf(sep)) : null));
    if (sufs.every((s) => s && s === sufs[0])) return sufs[0];
  }
  return null;
}

/**
 * @param {object} manifest packages/legacy-import/out/manifest.json
 * @returns {{ version:number, manifestSha256:string, media:object[], entries:object[], redirects:object[], assignments:object }}
 */
export function buildImportPlan(manifest) {
  const assets = manifest.assets ?? {};
  const pages = manifest.pages ?? [];
  const suffix = commonTitleSuffix(pages.map((p) => p.title));
  const pageCtx = new Map();
  for (const p of pages) {
    const route = routeFor(p.path);
    const h1 = (p.headings ?? []).filter((h) => h.level <= 2).map((h) => h.text).join(' ');
    const own = route.rule === 'root' ? [] : keywordsIn(`${p.title ?? ''} ${h1} ${p.path}`, CONTEXT_KEYWORDS);
    const contexts = [...new Set([...(route.context ? [route.context] : []), ...own])];
    const cities = route.rule === 'root' ? [] : keywordsIn(`${p.title ?? ''} ${h1}`, CITY_KEYWORDS);
    pageCtx.set(p.url, { route, contexts, cities });
  }

  // ---- media rows (one per downloaded asset)
  const media = [];
  const order = new Map();
  pages.forEach((p, pi) => [...(p.images ?? []), ...(p.videos ?? [])].forEach((id, i) => order.has(id) || order.set(id, pi * 10_000 + i)));
  const fileAssets = Object.values(assets).filter((a) => a.kind === 'image' || a.kind === 'video');
  fileAssets.sort((a, b) => (order.get(a.id) ?? 1e9) - (order.get(b.id) ?? 1e9) || (a.id < b.id ? -1 : 1));
  for (const a of fileAssets) {
    const ownText = `${a.alt ?? ''} ${a.caption ?? ''} ${a.context ?? ''}`;
    const contexts = new Set(keywordsIn(ownText, CONTEXT_KEYWORDS));
    const cities = new Set(keywordsIn(ownText, CITY_KEYWORDS));
    for (const u of a.pageUrls ?? []) {
      const c = pageCtx.get(u);
      if (!c) continue;
      c.contexts.forEach((x) => contexts.add(x));
      c.cities.forEach((x) => cities.add(x));
    }
    const ext = (a.files?.original ?? '').split('.').pop() || (a.mime ?? '').split('/').pop();
    const big = a.kind === 'image' && (a.width ?? 0) >= 600 && (a.height ?? 0) >= 300;
    media.push({
      assetId: a.id,
      kind: a.kind,
      sha256: a.sha256,
      storageKey: `legacy/${LEGACY_SOURCE.toLowerCase()}/${a.sha256}.${ext}`,
      publicUrl: a.kind === 'video' ? withSlash(a.files?.original) : displayPath(a),
      originalPath: withSlash(a.files?.original),
      srcset: srcsetOf(a),
      mime: a.mime,
      bytes: a.bytes,
      width: a.width ?? null,
      height: a.height ?? null,
      durationMs: a.durationMs ?? null,
      alt: a.alt ?? null,
      caption: a.caption ?? null,
      placeholder: a.placeholder ?? null,
      dominantColor: a.dominantColor ?? null,
      sourceUrls: a.sourceUrls ?? [],
      pageUrls: a.pageUrls ?? [],
      posterAssetId: a.posterAssetId ?? null,
      contexts: [...contexts].sort(),
      cities: [...cities].sort(),
      eligible: big && !a.chrome && !(a.roles ?? []).every((r) => r === 'icon'),
    });
  }
  const mediaById = new Map(media.map((m) => [m.assetId, m]));

  // ---- CMS entries
  const entries = [];
  const redirects = [];
  const seenRedirect = new Set();
  const addRedirect = (legacyPath, targetPath, reason) => {
    const lp = normalizeLegacyPath(legacyPath);
    if (!targetPath || lp === '/' || lp === normalizeLegacyPath(targetPath) || seenRedirect.has(lp)) return;
    seenRedirect.add(lp);
    redirects.push({ legacyPath: lp, targetPath, statusCode: 301, approved: false, source: LEGACY_SYSTEM, reason });
  };
  for (const p of pages) {
    const { route, contexts, cities } = pageCtx.get(p.url);
    const legacyPath = normalizeLegacyPath(p.path);
    const slug = slugForPath(legacyPath);
    const type = route.type;
    let title = (p.og?.title || p.title || p.headings?.[0]?.text || legacyPath).trim();
    if (suffix && title.endsWith(suffix) && title.length > suffix.length) title = title.slice(0, -suffix.length).trim();
    const firstText = (p.blocks ?? []).find((b) => b.type === 'text')?.text;
    const summary = truncate(p.description || p.og?.description || firstText || title, 200);

    const imageBlocks = (p.blocks ?? []).filter((b) => b.type === 'image' && mediaById.has(b.assetId));
    const ogAsset = p.og?.imageAssetId && assets[p.og.imageAssetId] && !assets[p.og.imageAssetId].chrome ? p.og.imageAssetId : null;
    const firstBig = imageBlocks.map((b) => b.assetId).find((id) => (assets[id]?.width ?? 0) >= 800 && !assets[id]?.chrome);
    const heroAssetId = ogAsset ?? firstBig ?? imageBlocks.find((b) => !assets[b.assetId]?.chrome)?.assetId ?? p.og?.imageAssetId ?? null;
    const hero = heroAssetId ? mediaById.get(heroAssetId) : null;

    const md = [];
    const html = [];
    const referenced = [];
    for (const b of p.blocks ?? []) {
      if (b.type === 'heading') {
        if (b.level === 1 && b.text.trim() === title) continue;
        const h = b.level <= 2 ? '##' : '###';
        md.push(`${h} ${b.text.replace(/\n/g, ' ')}`);
        html.push(`<h${b.level <= 2 ? 2 : 3}>${esc(b.text)}</h${b.level <= 2 ? 2 : 3}>`);
      } else if (b.type === 'text') {
        md.push(mdText(b.text));
        html.push(`<p>${esc(b.text).replace(/\n/g, '<br>')}</p>`);
      } else if (b.type === 'image') {
        const m = mediaById.get(b.assetId);
        if (!m || assets[b.assetId]?.chrome) continue;
        const alt = mdAlt(m.alt ?? m.caption ?? '');
        md.push(`![${alt}](${m.publicUrl})`);
        if (m.caption && m.caption !== m.alt) md.push(`*${mdAlt(m.caption)}*`);
        html.push(`<figure><img src="${esc(m.publicUrl)}" alt="${esc(m.alt ?? '')}"${m.width ? ` width="${m.width}" height="${m.height}"` : ''}>${m.caption ? `<figcaption>${esc(m.caption)}</figcaption>` : ''}</figure>`);
        referenced.push(m.publicUrl);
      } else if (b.type === 'video') {
        const v = b.assetId ? mediaById.get(b.assetId) : null;
        const poster = b.posterAssetId ? mediaById.get(b.posterAssetId) : null;
        const label = mdAlt(b.title ?? v?.alt ?? '동영상');
        if (v && poster) md.push(`[![${label}](${poster.publicUrl})](${v.publicUrl})`);
        else if (v) md.push(`[▶ ${label}](${v.publicUrl})`);
        else if (poster) md.push(`![${label}](${poster.publicUrl})`);
        if (v) {
          html.push(`<p><a href="${esc(v.publicUrl)}">${esc(label)}</a></p>`);
          referenced.push(v.publicUrl);
        }
        if (poster) referenced.push(poster.publicUrl);
      } else if (b.type === 'embed') {
        const e = assets[b.assetId];
        if (!e) continue;
        const label = mdAlt(e.title ?? `${e.provider === 'youtube' ? 'YouTube' : 'Vimeo'} 동영상`);
        md.push(`[▶ ${label}](${e.watchUrl})`);
        html.push(`<p><a href="${esc(e.watchUrl)}">${esc(label)}</a></p>`);
      }
    }
    md.push('', '---', `*WONT Travel Club 기존 페이지에서 이전된 콘텐츠입니다. 원본: ${p.url}*`);

    const gallery = (p.images ?? [])
      .map((id) => mediaById.get(id))
      .filter((m) => m && m.kind === 'image' && !assets[m.assetId]?.chrome)
      .map((m) => ({ assetId: m.assetId, url: m.publicUrl, srcset: m.srcset, width: m.width, height: m.height, alt: m.alt, caption: m.caption, placeholder: m.placeholder, dominantColor: m.dominantColor }));
    const videos = (p.videos ?? [])
      .map((id) => mediaById.get(id))
      .filter(Boolean)
      .map((v) => ({ assetId: v.assetId, url: v.publicUrl, mime: v.mime, durationMs: v.durationMs, width: v.width, height: v.height, posterUrl: v.posterAssetId ? mediaById.get(v.posterAssetId)?.publicUrl ?? null : null }));
    const embeds = (p.embeds ?? [])
      .map((id) => assets[id])
      .filter(Boolean)
      .map((e) => ({ assetId: e.id, provider: e.provider, videoId: e.videoId, embedUrl: e.embedUrl, watchUrl: e.watchUrl, thumbnailUrl: e.thumbnailUrl, title: e.title }));
    for (const v of videos) if (v.posterUrl) referenced.push(v.posterUrl);

    const ownPath = ENTRY_PATHS[type]?.(slug) ?? null;
    const targetPath = route.target ?? (type === 'PAGE' ? null : ownPath);
    const externalId = `page:${legacyPath}`;
    const seo = {
      title: truncate(p.title ?? title, 300),
      description: truncate(p.description ?? p.og?.description ?? summary, 500),
      ...(targetPath ? { canonical: targetPath } : {}),
      og: {
        title: truncate(p.og?.title ?? title, 300),
        description: truncate(p.og?.description ?? summary, 500),
        type: p.og?.type ?? (type === 'STORY' ? 'article' : 'website'),
        ...(hero?.publicUrl ? { image: hero.publicUrl } : {}),
      },
    };
    const legacy = {
      system: LEGACY_SYSTEM,
      source: LEGACY_SOURCE,
      id: externalId,
      url: p.url,
      path: legacyPath,
      canonical: p.canonical ?? null,
      snapshotSha256: p.snapshotSha256 ?? null,
      fetchedAt: p.fetchedAt ?? null,
      lastmod: p.lastmod ?? null,
      media: [...new Set(referenced)],
    };
    const data = {
      ...(hero?.publicUrl ? { coverUrl: hero.publicUrl } : {}),
      gallery,
      videos,
      embeds,
      tags: ['WONT Travel Club', ...contexts.map((c) => ({ exchange: '한달살기 맞교환', charter: '전세기 공유', tour: '투어·티켓', guide: '가이드 프렌드' })[c])],
      legacy,
    };
    const bodyMd = md.join('\n\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    const importHash = sha256(JSON.stringify({ title, summary, bodyMd, seo, data, heroAssetId }));
    data.legacy.importHash = importHash;
    entries.push({
      legacyPath, legacyUrl: p.url, externalId, type, slug, title: truncate(title, 300), summary, bodyMd, bodyHtml: html.join('\n'), seo, data,
      heroAssetId, targetPath, ownPath, contexts, cities, importHash, aliases: p.aliases ?? [],
    });
    if (targetPath) {
      addRedirect(legacyPath, targetPath, route.rule ? `rule ${route.rule}` : `entry ${type}`);
      for (const al of p.aliases ?? []) addRedirect(new URL(al).pathname + new URL(al).search, targetPath, 'alias');
    }
  }

  // same-host legacy media URLs → new public paths (hotlinked images keep working after DNS cutover)
  const siteHosts = new Set((manifest.source?.siteHosts ?? []).map((h) => h.toLowerCase()));
  for (const m of media) {
    for (const u of m.sourceUrls) {
      try {
        const x = new URL(u);
        if (siteHosts.has(x.host.toLowerCase()) || siteHosts.has(x.hostname.toLowerCase())) addRedirect(x.pathname + x.search, m.kind === 'video' ? m.originalPath : m.publicUrl, 'media');
      } catch {
        /* ignore */
      }
    }
  }

  const assignments = {};
  for (const ctx of Object.keys(CONTEXT_KEYWORDS)) assignments[ctx] = media.filter((m) => m.eligible && m.contexts.includes(ctx)).map((m) => m.assetId);
  return {
    version: PLAN_VERSION,
    manifestSha256: manifest.contentSha256 ?? sha256(JSON.stringify(manifest)),
    system: LEGACY_SYSTEM,
    source: LEGACY_SOURCE,
    media,
    entries,
    redirects,
    assignments,
  };
}
