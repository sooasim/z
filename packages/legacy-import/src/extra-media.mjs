/**
 * --extra-media input: media URLs observed in a real browser that a static crawl cannot see (JavaScript-loaded
 * slides, API-driven galleries). Accepted formats:
 *  - HAR (DevTools → Network → "Save all as HAR"): image/* and video/* responses; the page is the HAR page title
 *    (its URL) or the Referer header
 *  - JSON array: ["https://…/a.jpg", { "url": "https://…/b.png", "pageUrl": "https://www.wontc.co.kr/" }]
 *  - text / CSV: one media URL per line, or "page_url,media_url" (a header line is ignored)
 * Returns [{ url, pageUrl|null }]; downloads still go through the allowlist, robots, content checks and dedupe.
 */
export function parseExtraMedia(text, fileName = '') {
  const s = String(text ?? '').replace(/^﻿/, '').trim();
  const out = [];
  const push = (url, pageUrl = null) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url.trim())) out.push({ url: url.trim(), pageUrl: typeof pageUrl === 'string' && /^https?:\/\//i.test(pageUrl) ? pageUrl.trim() : null });
  };
  if (s.startsWith('{') || s.startsWith('[')) {
    let j;
    try {
      j = JSON.parse(s);
    } catch (err) {
      throw new Error(`--extra-media ${fileName}: invalid JSON (${err.message})`);
    }
    if (j?.log?.entries) {
      const pages = new Map((j.log.pages ?? []).map((p) => [p.id, p.title]));
      for (const e of j.log.entries) {
        const mime = String(e.response?.content?.mimeType ?? e.response?.headers?.find?.((h) => /^content-type$/i.test(h.name))?.value ?? '').toLowerCase();
        if (!/^(image|video)\//.test(mime) || (e.response?.status ?? 200) >= 400) continue;
        const referer = e.request?.headers?.find?.((h) => /^referer$/i.test(h.name))?.value ?? null;
        push(e.request?.url, pages.get(e.pageref) ?? referer);
      }
    } else if (Array.isArray(j)) {
      for (const x of j) typeof x === 'string' ? push(x) : push(x?.url, x?.pageUrl ?? x?.page_url ?? null);
    } else throw new Error(`--extra-media ${fileName}: expected a HAR file or a JSON array`);
  } else {
    for (const line of s.split(/\r?\n/)) {
      const cells = line.split(/[,\t ]+/).map((c) => c.trim().replace(/^"|"$/g, '')).filter(Boolean);
      if (cells.length >= 2) push(cells[1], cells[0]);
      else if (cells.length === 1) push(cells[0]);
    }
  }
  const seen = new Set();
  return out.filter((x) => {
    const k = `${x.pageUrl ?? ''} ${x.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
