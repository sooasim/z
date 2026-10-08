import { mkdtemp, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildConfig } from '../src/config.mjs';
import { runPipeline } from '../src/pipeline.mjs';

export const UA = 'JETPOOL-Migration/1.0 (+owner-authorised)';

export function quietLog() {
  const warnings = [];
  return { info() {}, warn: (m) => warnings.push(m), error: (m) => warnings.push(m), warnings };
}

export async function tempDir(prefix = 'legacy-import-') {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Config pointing the migrator at the fixture (fast politeness settings, no proxy). */
export function fixtureConfig(f, dir, extra = {}) {
  return buildConfig({
    startUrls: [`${f.site}/`, `${f.site}/about_jetpool`],
    siteHosts: [f.siteHost],
    assetHosts: [f.cdnHost],
    outDir: path.join(dir, 'out'),
    publicDir: path.join(dir, 'web', 'legacy'),
    delayMs: 2,
    retryBaseMs: 10,
    useProxy: false,
    ...extra,
  });
}

export async function runFixture(f, dir, command = 'all', extra = {}) {
  const log = quietLog();
  const cfg = fixtureConfig(f, dir, extra);
  const r = await runPipeline(command, cfg, { log });
  return { ...r, cfg, log };
}

/** { relativePath: { size, mtimeMs } } for every file below dir */
export async function snapshotTree(dir) {
  const out = {};
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        const s = await stat(p);
        out[path.relative(dir, p)] = { size: s.size, mtimeMs: s.mtimeMs };
      }
    }
  };
  await walk(dir);
  return out;
}
