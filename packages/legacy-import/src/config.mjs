import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DEFAULT_USER_AGENT } from './http.mjs';

const PKG_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = (() => {
  let d = PKG_DIR;
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(d, 'pnpm-workspace.yaml'))) return d;
    d = path.dirname(d);
  }
  return path.resolve(PKG_DIR, '../..');
})();

export const DEFAULTS = Object.freeze({
  startUrls: ['https://www.wontc.co.kr/', 'https://www.wontc.co.kr/about_jetpool'],
  siteHosts: ['www.wontc.co.kr', 'wontc.co.kr'],
  // Sixshop serves uploads from contents.sixshop.com, resizes via thumb.sixshop.kr and theme files from
  // static.sixshop.com + its S3 bucket (observed on www.wontc.co.kr)
  assetHosts: ['www.wontc.co.kr', 'wontc.co.kr', '*.sixshop.com', '*.sixshop.kr', '*.sixshop.io', 'static-sixshop2.s3.ap-northeast-2.amazonaws.com'],
  maxPages: 500,
  maxDepth: 10,
  concurrency: 2,
  delayMs: 500,
  timeoutMs: 30_000,
  downloadTimeoutMs: 15 * 60_000,
  retries: 3,
  retryBaseMs: 1000,
  userAgent: DEFAULT_USER_AGENT,
  outDir: path.join(REPO_ROOT, 'packages/legacy-import/out'),
  publicDir: path.join(REPO_ROOT, 'apps/web/public/legacy'),
  urlPrefix: '/legacy',
  widths: [480, 960, 1600, 2400],
  caps: { image: 30 * 1024 * 1024, video: 300 * 1024 * 1024, html: 15 * 1024 * 1024, css: 5 * 1024 * 1024 },
  cdnOriginals: 'both',
  /** never crawl account / commerce / search flows (personal data, infinite spaces) */
  exclude: [
    /\/(login|logout|signin|signout|signup|sign-up|join|register|cart|basket|order|orders|checkout|payment|pay|mypage|my-page|myshop|member|members|account|password|wishlist|admin)(\/|$|\?|\.)/i,
    /\/search(\/|$|\?)/i,
    /[?&](q|keyword|keywords|search|query|sort|redirect|returnUrl|return_url)=/i,
    /(\{\{|%7B%7B)/i, // unrendered template tokens in links (e.g. /{{SITEURI}}club_past)
  ],
});

function which(bin) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() || null : null;
}

/** Relative CLI paths resolve against the directory the user invoked pnpm/node from (INIT_CWD), not the package dir. */
export function resolveUserPath(p, base = process.env.INIT_CWD || process.cwd()) {
  return path.isAbsolute(p) ? p : path.resolve(base, p);
}

const hostOf = (u) => new URL(u).host.toLowerCase();

export function buildConfig(opts = {}) {
  const startUrls = (opts.startUrls?.length ? opts.startUrls : DEFAULTS.startUrls).map((u) => new URL(u).toString());
  const siteHosts = [...new Set([...(opts.siteHosts?.length ? opts.siteHosts : DEFAULTS.siteHosts), ...startUrls.map(hostOf)].map((h) => h.toLowerCase()))];
  const assetHosts = [...new Set([...(opts.assetHosts?.length ? opts.assetHosts : DEFAULTS.assetHosts), ...siteHosts].map((h) => h.toLowerCase()))];
  const ffprobe = opts.ffprobe === false ? null : opts.ffprobe ?? which('ffprobe');
  const ffmpeg = opts.ffmpeg === false ? null : opts.ffmpeg ?? which('ffmpeg');
  return {
    ...DEFAULTS,
    ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)),
    startUrls,
    siteHosts,
    assetHosts,
    outDir: path.resolve(opts.outDir ?? DEFAULTS.outDir),
    publicDir: path.resolve(opts.publicDir ?? DEFAULTS.publicDir),
    urlPrefix: ('/' + String(opts.urlPrefix ?? DEFAULTS.urlPrefix).replace(/^\/+|\/+$/g, '')).replace(/^\/$/, ''),
    caps: { ...DEFAULTS.caps, ...(opts.caps ?? {}) },
    exclude: [...DEFAULTS.exclude, ...(opts.exclude ?? []).map((x) => (x instanceof RegExp ? x : new RegExp(x, 'i')))],
    ffprobe,
    ffmpeg,
    respectRobots: opts.respectRobots ?? true,
    assetsRespectRobots: opts.assetsRespectRobots ?? true,
    videoPosters: opts.videoPosters ?? true,
    /** Sixshop's default "사용 설명서" editor-manual pages (sample content of shop 113) are skipped unless asked */
    includeTemplatePages: !!opts.includeTemplatePages,
    /** HAR / URL list of media observed in a real browser (runtime-loaded images a static crawl cannot see) */
    extraMedia: opts.extraMedia ?? null,
    resume: !!opts.resume,
    allowPartial: !!opts.allowPartial,
  };
}

export function outPaths(cfg) {
  const o = cfg.outDir;
  return {
    out: o,
    state: path.join(o, 'state'),
    crawlState: path.join(o, 'state', 'crawl.json'),
    pagesDir: path.join(o, 'state', 'pages'),
    cssDir: path.join(o, 'state', 'css'),
    snapshots: path.join(o, 'snapshots'),
    staging: path.join(o, 'staging'),
    stagingTmp: path.join(o, 'staging', 'tmp'),
    build: path.join(o, 'build'),
    inventory: path.join(o, 'inventory.json'),
    urlsCsv: path.join(o, 'urls.csv'),
    downloads: path.join(o, 'state', 'downloads.json'),
    assets: path.join(o, 'state', 'assets.json'),
    optimised: path.join(o, 'state', 'optimised.json'),
    manifest: path.join(o, 'manifest.json'),
    reportMd: path.join(o, 'report.md'),
    reportJson: path.join(o, 'report.json'),
    importDir: path.join(o, 'import'),
    lock: path.join(o, '.lock'),
  };
}
