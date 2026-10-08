import { open, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { outPaths } from './config.mjs';
import { makeScope, runCrawl, runExtract } from './crawl.mjs';
import { runDownload } from './download.mjs';
import { Fetcher } from './http.mjs';
import { runImport } from './import.mjs';
import { runOptimise } from './optimise.mjs';
import { runPublish } from './publish.mjs';
import { runReport } from './report.mjs';
import { RobotsCache } from './robots.mjs';
import { createLogger, ensureDir } from './util.mjs';

export const STEPS = ['crawl', 'download', 'optimise', 'publish', 'import', 'report'];
const RUNNERS = { crawl: runCrawl, extract: runExtract, download: runDownload, optimise: runOptimise, publish: runPublish, import: runImport, report: runReport };
export const COMMANDS = [...STEPS, 'extract', 'all'];
export const EXIT_PARTIAL = 3;

async function acquireLock(file) {
  await ensureDir(file.replace(/[\\/][^\\/]+$/, ''));
  for (let i = 0; i < 2; i++) {
    try {
      const fh = await open(file, 'wx');
      await fh.writeFile(String(process.pid));
      await fh.close();
      return;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(await readFile(file, 'utf8').catch(() => ''));
      let alive = false;
      try {
        alive = pid > 0 && pid !== process.pid && process.kill(pid, 0);
      } catch {
        alive = false;
      }
      if (alive) throw new Error(`another migration run (pid ${pid}) holds ${file}`);
      await rm(file, { force: true });
    }
  }
}

/**
 * Run one step or the whole pipeline. Returns { code, results } — code is EXIT_PARTIAL (3) when the report's
 * coverage is below 100 % and allowPartial is not set.
 */
export async function runPipeline(command, cfg, { log = createLogger({ quiet: cfg.quiet }) } = {}) {
  const cmd = command === 'optimize' ? 'optimise' : command;
  if (!COMMANDS.includes(cmd)) throw new Error(`unknown command "${command}" (use ${COMMANDS.join(' | ')})`);
  const paths = outPaths(cfg);
  await acquireLock(paths.lock);
  const fetcher = new Fetcher({
    userAgent: cfg.userAgent,
    concurrency: cfg.concurrency,
    delayMs: cfg.delayMs,
    timeoutMs: cfg.timeoutMs,
    retries: cfg.retries,
    retryBaseMs: cfg.retryBaseMs,
    useProxy: cfg.useProxy ?? true,
    log,
  });
  const robots = new RobotsCache(fetcher, { userAgent: cfg.userAgent, log });
  const ctx = { cfg, fetcher, robots, scope: makeScope(cfg), log };
  const results = {};
  let code = 0;
  const onSignal = () => {
    log.warn('interrupted — state is saved per page/file; re-run with --resume to continue');
    rm(paths.lock, { force: true }).finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const steps = cmd === 'all' ? STEPS : [cmd];
    for (const s of steps) {
      const t0 = Date.now();
      results[s] = await RUNNERS[s](ctx);
      log.info(`${s}: done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    }
    if (results.report && !results.report.media.complete && !cfg.allowPartial) code = EXIT_PARTIAL;
    results.http = fetcher.stats;
    return { code, results };
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await fetcher.close();
    if (existsSync(paths.lock)) await rm(paths.lock, { force: true });
  }
}
