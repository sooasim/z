#!/usr/bin/env node
// `typecheck` for this plain-ESM package: parse every module with `node --check` and import the library modules.
import { readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
const walk = (d) => {
  for (const e of readdirSync(d)) {
    if (e === 'node_modules' || e === 'out' || e === 'fixture-site') continue;
    const p = path.join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.mjs')) files.push(p);
  }
};
walk(root);
files.push(path.resolve(root, '../db/seed-legacy.mjs'));
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed++;
    console.error(r.stderr);
  }
}
for (const f of files.filter((x) => x.includes(`${path.sep}src${path.sep}`))) await import(pathToFileURL(f).href);
console.log(`check-syntax: ${files.length} module(s), ${failed} error(s)`);
process.exit(failed ? 1 : 0);
