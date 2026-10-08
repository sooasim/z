#!/usr/bin/env node
/**
 * JETPOOL legacy site migrator (MIG-01) — WONT Travel Club (Sixshop) → JETPOOL.
 *
 *   pnpm --filter @jetpool/legacy-import run migrate -- [command] --start https://www.wontc.co.kr/ --start https://www.wontc.co.kr/about_jetpool
 *        [--max-pages 500] [--out packages/legacy-import/out] [--public-dir apps/web/public/legacy] [--resume]
 *
 * See docs/runbooks/legacy-media-import.md. Run only with the site owner's authorisation.
 */
import { buildConfig, resolveUserPath } from '../src/config.mjs';
import { COMMANDS, runPipeline } from '../src/pipeline.mjs';
import { createLogger } from '../src/util.mjs';

const USAGE = `usage: migrate [${COMMANDS.join('|')}] [options]        (default command: all)

  --start <url>            start URL (repeatable; default https://www.wontc.co.kr/ + /about_jetpool)
  --host <host>            extra crawlable site host (repeatable; start URL hosts are always included)
  --asset-host <pattern>   extra media host, e.g. '*.cdn.example.com' (repeatable)
  --asset-hosts <a,b,...>  replace the default media host allowlist
  --max-pages <n>          crawl limit (default 500)        --max-depth <n>   link depth limit (default 10)
  --out <dir>              state/output dir (default packages/legacy-import/out)
  --public-dir <dir>       published assets (default apps/web/public/legacy)
  --url-prefix <path>      URL path the public dir is served at (default /legacy)
  --resume                 continue from saved state; skip finished pages/files
  --retry-failed           with --resume: retry permanently failed downloads (404 etc.) too
  --allow-partial          exit 0 even when media coverage < 100 %
  --concurrency <n>        parallel requests (default 2)    --delay <ms>      per-host delay (default 500)
  --timeout <ms>           page timeout (default 30000)     --retries <n>     retries with backoff (default 3)
  --widths <list>          webp widths (default 480,960,1600,2400)
  --max-image-mb <n>       per-file image cap (default 30)    --max-video-mb <n>   video cap (default 300)
  --cdn-originals <mode>   both | prefer | off — fetch un-resized CDN originals (default both)
  --exclude <regex>        extra URL exclusion pattern (repeatable)
  --extra-media <file>     HAR / JSON / CSV list of media seen in a real browser (JS-loaded), merged at crawl/extract
  --include-template-pages also migrate Sixshop's default "사용 설명서" editor-manual pages (skipped by default)
  --ignore-robots-for-assets   media hosts only (owner-authorised CDN); page crawling always obeys robots.txt
  --no-video-posters       do not extract poster frames with ffmpeg
  --no-proxy               ignore HTTP(S)_PROXY
  --user-agent <ua>        default 'JETPOOL-Migration/1.0 (+owner-authorised)'
  --quiet  --json  --help
Exit codes: 0 ok · 1 error · 2 usage · 3 coverage < 100 % (without --allow-partial)`;

const REPEAT = new Set(['start', 'host', 'asset-host', 'exclude']);
const FLAGS = new Set(['resume', 'retry-failed', 'allow-partial', 'ignore-robots-for-assets', 'include-template-pages', 'no-video-posters', 'no-proxy', 'quiet', 'json', 'help', 'no-ffprobe', 'no-ffmpeg']);

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') continue;
    if (a === '-h') {
      out.help = true;
      continue;
    }
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    let [key, val] = a.slice(2).split(/=(.*)/s, 2);
    if (FLAGS.has(key)) {
      out[key] = val === undefined ? true : !/^(0|false|no)$/i.test(val);
      continue;
    }
    if (val === undefined) {
      val = argv[i + 1];
      if (val === undefined || val.startsWith('--')) throw new Error(`--${key} needs a value`);
      i++;
    }
    if (REPEAT.has(key)) (out[key] ??= []).push(val);
    else out[key] = val;
  }
  return out;
}

const num = (v, name) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`--${name} must be a non-negative number`);
  return n;
};

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const command = args._[0] ?? 'all';
  if (!COMMANDS.includes(command === 'optimize' ? 'optimise' : command)) {
    console.error(`unknown command "${command}"\n\n${USAGE}`);
    process.exit(2);
  }
  if (args['cdn-originals'] && !['both', 'prefer', 'off'].includes(args['cdn-originals'])) {
    console.error('--cdn-originals must be both | prefer | off');
    process.exit(2);
  }
  const defaults = buildConfig({});
  let cfg;
  try {
    cfg = buildConfig({
    startUrls: args.start,
    siteHosts: args.host ? [...defaults.siteHosts, ...args.host] : undefined,
    assetHosts: args['asset-hosts'] ? args['asset-hosts'].split(',').map((s) => s.trim()).filter(Boolean) : args['asset-host'] ? [...defaults.assetHosts, ...args['asset-host']] : undefined,
    maxPages: num(args['max-pages'], 'max-pages'),
    maxDepth: num(args['max-depth'], 'max-depth'),
    outDir: args.out ? resolveUserPath(args.out) : undefined,
    publicDir: args['public-dir'] ? resolveUserPath(args['public-dir']) : undefined,
    urlPrefix: args['url-prefix'],
    resume: !!args.resume,
    retryFailed: !!args['retry-failed'],
    allowPartial: !!args['allow-partial'],
    concurrency: num(args.concurrency, 'concurrency') || undefined,
    delayMs: num(args.delay, 'delay'),
    timeoutMs: num(args.timeout, 'timeout'),
    retries: num(args.retries, 'retries'),
    widths: args.widths ? args.widths.split(',').map((w) => num(w.trim(), 'widths')).filter(Boolean) : undefined,
    cdnOriginals: args['cdn-originals'],
    caps: {
      ...(args['max-image-mb'] ? { image: num(args['max-image-mb'], 'max-image-mb') * 1024 * 1024 } : {}),
      ...(args['max-video-mb'] ? { video: num(args['max-video-mb'], 'max-video-mb') * 1024 * 1024 } : {}),
    },
    exclude: args.exclude,
    extraMedia: args['extra-media'] ? resolveUserPath(args['extra-media']) : undefined,
    includeTemplatePages: !!args['include-template-pages'],
    assetsRespectRobots: !args['ignore-robots-for-assets'],
    videoPosters: !args['no-video-posters'],
    useProxy: !args['no-proxy'],
    ffprobe: args['no-ffprobe'] ? false : undefined,
    ffmpeg: args['no-ffmpeg'] ? false : undefined,
    userAgent: args['user-agent'],
    quiet: !!args.quiet,
    });
  } catch (err) {
    console.error(`${err.message}\n\n${USAGE}`);
    process.exit(2);
  }
  const log = createLogger({ quiet: cfg.quiet });
  log.info(`${command}: start=${cfg.startUrls.join(' ')} out=${cfg.outDir} public=${cfg.publicDir}${cfg.resume ? ' (resume)' : ''}`);
  const { code, results } = await runPipeline(command, cfg, { log });
  if (args.json) {
    const r = results.report;
    console.log(JSON.stringify({ command, code, coveragePct: r?.media.coveragePct ?? null, pages: r?.pages.ok ?? null, assets: r?.assets.unique ?? null, failed: r?.media.failed ?? null, http: results.http }, null, 2));
  }
  if (code === 3) log.warn(`media coverage is below 100 % — see ${cfg.outDir}/report.md (use --allow-partial to accept)`);
  process.exitCode = code;
}

main().catch((err) => {
  console.error(`[legacy-import] ERROR: ${err?.stack ?? err}`);
  process.exit(1);
});
