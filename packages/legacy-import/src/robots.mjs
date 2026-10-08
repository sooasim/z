import { gunzipSync } from 'node:zlib';

/**
 * robots.txt (RFC 9309): groups by user-agent, Allow/Disallow with '*' and '$', longest match wins, Allow wins ties.
 * Unreachable robots (5xx / network) ⇒ complete disallow; 4xx ⇒ allow all.
 */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let cur = null;
  let lastWasAgent = false;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [], crawlDelay: null };
        groups.push(cur);
      }
      if (value) cur.agents.push(value.toLowerCase()); // an empty agent must not match every crawler
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (!cur) continue;
    if (key === 'allow' || key === 'disallow') {
      if (key === 'disallow' && value === '') continue; // empty Disallow = allow everything
      cur.rules.push({ allow: key === 'allow', path: value });
    } else if (key === 'crawl-delay') {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) cur.crawlDelay = n;
    }
  }
  return { groups, sitemaps };
}

function ruleRegex(pattern) {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

function decodeSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** The group that applies to `userAgent` (product token match, else '*'), merged when several groups match. */
export function groupFor(robots, userAgent) {
  const token = String(userAgent).split('/')[0].trim().toLowerCase();
  const specific = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && (token.includes(a) || a.includes(token))));
  const chosen = specific.length ? specific : robots.groups.filter((g) => g.agents.includes('*'));
  return {
    rules: chosen.flatMap((g) => g.rules),
    crawlDelay: chosen.map((g) => g.crawlDelay).filter((x) => x !== null).sort((a, b) => b - a)[0] ?? null,
  };
}

/** true when `pathWithQuery` may be fetched. */
export function isAllowed(robots, userAgent, pathWithQuery) {
  if (robots.disallowAll) return false;
  const { rules } = groupFor(robots, userAgent);
  if (!rules.length) return true;
  const target = decodeSafe(pathWithQuery || '/');
  let best = null;
  for (const r of rules) {
    if (!ruleRegex(decodeSafe(r.path)).test(target)) continue;
    const len = r.path.replace(/\*|\$$/g, '').length;
    if (!best || len > best.len || (len === best.len && r.allow && !best.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

/** Per-origin robots cache backed by a Fetcher. */
export class RobotsCache {
  constructor(fetcher, { userAgent, log, enabled = true } = {}) {
    this.fetcher = fetcher;
    this.userAgent = userAgent ?? fetcher.userAgent;
    this.log = log;
    this.enabled = enabled;
    this.cache = new Map();
  }

  async forOrigin(origin) {
    if (!this.cache.has(origin)) {
      this.cache.set(
        origin,
        (async () => {
          const res = await this.fetcher.get(`${origin}/robots.txt`, { accept: 'text/plain,*/*', maxBytes: 512 * 1024, retries: 2 });
          let robots;
          let status;
          if (res.ok) {
            robots = parseRobots(res.body.toString('utf8'));
            status = 'OK';
          } else if (res.status >= 400 && res.status < 500) {
            robots = { groups: [], sitemaps: [] };
            status = `ABSENT_${res.status}`;
          } else {
            robots = { groups: [], sitemaps: [], disallowAll: true, error: res.error ?? `HTTP_${res.status}`, message: res.message ?? null };
            status = `UNREACHABLE_${res.error ?? res.status}`;
            this.log?.warn(`robots.txt unreachable for ${origin} (${res.error ?? res.status}) — treating as disallow-all (RFC 9309)`);
          }
          const delay = groupFor(robots, this.userAgent).crawlDelay;
          if (delay) this.fetcher.setHostDelay(new URL(origin).host, delay * 1000);
          return { ...robots, status, origin, crawlDelay: delay };
        })(),
      );
    }
    return this.cache.get(origin);
  }

  /**
   * true | 'ROBOTS_DISALLOWED' (a rule forbids it — permanent) | 'ROBOTS_UNREACHABLE <error>' (robots.txt could not
   * be fetched, e.g. PROXY_403 — retryable once the host is reachable)
   */
  async check(url) {
    if (!this.enabled) return true;
    const u = new URL(url);
    if (u.pathname === '/robots.txt') return true;
    const robots = await this.forOrigin(u.origin);
    if (robots.disallowAll) return `ROBOTS_UNREACHABLE ${robots.error ?? ''}`.trim();
    return isAllowed(robots, this.userAgent, u.pathname + u.search) ? true : 'ROBOTS_DISALLOWED';
  }

  summary() {
    return Promise.all([...this.cache.values()]).then((all) =>
      all.map((r) => ({ origin: r.origin, status: r.status, crawlDelay: r.crawlDelay, sitemaps: r.sitemaps, rules: r.groups.reduce((n, g) => n + g.rules.length, 0) })),
    );
  }
}

/** sitemap.xml / sitemap index (optionally gzip) → { urls:[{loc,lastmod}], sitemaps:[loc] } */
export function parseSitemap(buf) {
  let b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf));
  if (b[0] === 0x1f && b[1] === 0x8b) b = gunzipSync(b);
  const xml = b.toString('utf8');
  const unescape = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const blocks = [...xml.matchAll(isIndex ? /<sitemap\b[\s\S]*?<\/sitemap>/gi : /<url\b[\s\S]*?<\/url>/gi)].map((m) => m[0]);
  const items = blocks
    .map((blk) => ({ loc: unescape(/<loc>([\s\S]*?)<\/loc>/i.exec(blk)?.[1] ?? ''), lastmod: unescape(/<lastmod>([\s\S]*?)<\/lastmod>/i.exec(blk)?.[1] ?? '') || null }))
    .filter((x) => x.loc);
  return isIndex ? { urls: [], sitemaps: items.map((x) => x.loc) } : { urls: items, sitemaps: [] };
}
