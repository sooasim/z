/** URL normalisation, host allowlists and media-kind inference. */

const TRACKING_PARAMS = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|yclid|mc_eid|mc_cid|_ga|_gl|igshid|n_media|n_query|n_rank|n_ad_group|n_ad|n_keyword_id|n_keyword|n_campaign_type|n_ad_group_type|ref_src)$/i;

/**
 * Resolve `raw` against `base` and normalise: http(s) only, lowercase host, default port dropped, fragment and
 * tracking params removed. Returns null for data:/javascript:/mailto: and unparsable input.
 */
export function normalizeUrl(raw, base) {
  if (raw === undefined || raw === null) return null;
  let s = String(raw).trim().replace(/^['"]|['"]$/g, '');
  if (!s || /^(data|javascript|mailto|tel|sms|about|blob|intent|kakaotalk|fb):/i.test(s) || s.startsWith('#')) return null;
  // undo HTML/JSON escaping that survives in attributes and inline scripts
  s = s.replace(/&amp;/g, '&').replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/');
  let u;
  try {
    u = new URL(s, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) u.port = '';
  if (u.search) {
    const keep = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k));
    u.search = '';
    for (const [k, v] of keep) u.searchParams.append(k, v);
  }
  return u.toString();
}

/** Dedupe key for pages: normalised URL without trailing slash (except root) and with sorted query. */
export function pageKey(url) {
  const u = new URL(url);
  let p = u.pathname.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  const params = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const qs = params.length ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
  return `${u.host}${p}${qs}`;
}

/**
 * Host allowlist match. Patterns: 'www.wontc.co.kr' (any port), '127.0.0.1:8080' (exact host:port),
 * '*.sixshop.com' (any subdomain, not the apex).
 */
export function hostMatches(urlOrHost, patterns) {
  let host;
  let hostname;
  try {
    const u = typeof urlOrHost === 'string' && /^https?:/i.test(urlOrHost) ? new URL(urlOrHost) : new URL(`http://${urlOrHost}`);
    host = u.host.toLowerCase();
    hostname = u.hostname.toLowerCase();
  } catch {
    return false;
  }
  for (const raw of patterns ?? []) {
    const p = String(raw).trim().toLowerCase();
    if (!p) continue;
    if (p.startsWith('*.')) {
      const suffix = p.slice(1); // ".sixshop.com"
      const [sfx, port] = suffix.split(':');
      if (hostname.endsWith(sfx) && hostname.length > sfx.length && (!port || host.endsWith(`:${port}`))) return true;
    } else if (p.includes(':')) {
      if (host === p) return true;
    } else if (hostname === p) return true;
  }
  return false;
}

export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'png', 'apng', 'gif', 'webp', 'avif', 'svg', 'ico', 'cur', 'bmp', 'tif', 'tiff', 'heic', 'heif']);
export const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'ogv', 'mkv']);
export const STREAM_EXT = new Set(['m3u8', 'mpd']);
export const FONT_EXT = new Set(['woff', 'woff2', 'ttf', 'otf', 'eot']);
export const DOC_EXT = new Set(['pdf', 'zip', 'hwp', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'csv', 'txt', 'json', 'xml', 'js', 'css', 'mp3', 'wav', 'm4a']);

export function extOf(url) {
  try {
    const p = new URL(url).pathname;
    const m = /\.([a-z0-9]{2,5})$/i.exec(p);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/** 'image' | 'video' | 'stream' | 'font' | 'doc' | 'unknown' from the URL path extension. */
export function kindFromUrl(url) {
  const e = extOf(url);
  if (IMAGE_EXT.has(e)) return 'image';
  if (VIDEO_EXT.has(e)) return 'video';
  if (STREAM_EXT.has(e)) return 'stream';
  if (FONT_EXT.has(e)) return 'font';
  if (DOC_EXT.has(e)) return 'doc';
  return 'unknown';
}

/** Page-like link (crawlable HTML) vs a file download. */
export function isLikelyPage(url) {
  return kindFromUrl(url) === 'unknown';
}

const TRACKER_HOSTS = [
  'facebook.com', 'facebook.net', 'google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googleadservices.com',
  'analytics.naver.com', 'wcs.naver.net', 'wcs.naver.com', 'bat.bing.com', 'stats.g.doubleclick.net', 'pixel.kakao.com',
  't.co', 'analytics.tiktok.com', 'px.ads.linkedin.com', 'ct.pinterest.com', 'mc.yandex.ru', 'hotjar.com', 'clarity.ms',
];

export function isTrackerUrl(url) {
  try {
    const h = new URL(url).hostname;
    return TRACKER_HOSTS.some((t) => h === t || h.endsWith(`.${t}`)) || /\/(tr|pixel|collect|beacon)(\/|\?|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** Resize/quality query params that image CDNs use for derived renditions. */
export const RESIZE_PARAMS = ['w', 'h', 'width', 'height', 'resize', 'size', 'quality', 'q', 'fit', 'crop', 'dpr', 'auto', 'fm', 'format', 'impolicy', 'imwidth', 'imheight', 'scale', 'thumbnail', 'thumb', 'sw', 'sh', 'rw', 'rh'];

/**
 * Candidate "original" URLs for a (possibly resized) CDN rendition, most original first. Rules are heuristics, so the
 * downloader fetches both the candidate and the referenced URL and keeps both when they differ ("keep both if unsure").
 *  - query resize params (?w=480&q=70) are stripped
 *  - Sixshop thumbnails: //contents.sixshop.com/thumbnails/uploadedFiles/<shop>/.../image_<ts>_<w>.<ext>
 *    → //contents.sixshop.com/uploadedFiles/<shop>/.../image_<ts>.<ext>
 */
export function originalCandidates(url, { stripParams = RESIZE_PARAMS } = {}) {
  const out = [];
  let u;
  try {
    u = new URL(url);
  } catch {
    return out;
  }
  const params = [...u.searchParams.keys()];
  const strip = new Set(stripParams.map((p) => p.toLowerCase()));
  if (params.some((k) => strip.has(k.toLowerCase()))) {
    const v = new URL(u.toString());
    v.search = '';
    for (const [k, val] of u.searchParams.entries()) if (!strip.has(k.toLowerCase())) v.searchParams.append(k, val);
    out.push(v.toString());
  }
  {
    // path shape is specific enough to apply on any allowed CDN host (Sixshop also serves via custom domains)
    const m = /^\/thumbnails\/(uploadedFiles\/.+?)(?:_(\d{2,4}))?(\.[a-z0-9]{2,5})$/i.exec(u.pathname);
    if (m) {
      const v = new URL(u.toString());
      v.pathname = `/${m[1]}${m[3]}`;
      v.search = '';
      out.unshift(v.toString());
    }
  }
  return [...new Set(out)].filter((x) => x !== url);
}

/** YouTube / Vimeo embed detection → { provider, videoId, embedUrl, watchUrl, thumbnailUrl } or null. */
export function parseEmbed(url) {
  if (!url) return null;
  let s = String(url).trim();
  if (s.startsWith('//')) s = `https:${s}`;
  const yt = /(?:youtube(?:-nocookie)?\.com\/(?:embed\/|shorts\/|live\/|v\/|watch\?(?:[^#]*&)?v=)|youtu\.be\/)([A-Za-z0-9_-]{11})/i.exec(s);
  if (yt) {
    const id = yt[1];
    return {
      provider: 'youtube',
      videoId: id,
      embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
      watchUrl: `https://www.youtube.com/watch?v=${id}`,
      thumbnailUrl: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  }
  const vm = /(?:player\.vimeo\.com\/video\/|vimeo\.com\/(?:video\/|channels\/[^/]+\/)?)(\d{5,12})/i.exec(s);
  if (vm) {
    const id = vm[1];
    return {
      provider: 'vimeo',
      videoId: id,
      embedUrl: `https://player.vimeo.com/video/${id}`,
      watchUrl: `https://vimeo.com/${id}`,
      thumbnailUrl: null,
      oembedUrl: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(`https://vimeo.com/${id}`)}`,
    };
  }
  return null;
}

/** Pathname + search of a URL (for legacy path mapping). */
export function pathOf(url) {
  const u = new URL(url);
  return u.pathname + u.search;
}
