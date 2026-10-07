#!/usr/bin/env node
// G5 / invariant 9 guard: the schema and SQL in the codebase must not store raw card PAN/CVC.
// Scans packages/db/migrations (column definitions) and apps/api/src (SQL INSERT/UPDATE column lists).
// Usage: node scripts/check-no-pan.mjs [--json out.json]
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const FORBIDDEN = /\b(card_?number|card_?no|pan|primary_account_number|cvc|cvv|cvc2|card_?security_?code|card_?expiry|track_?data)\b/i;

function walk(dir, exts, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const f of readdirSync(dir)) {
    if (['node_modules', 'dist', '.next'].includes(f)) continue;
    const p = path.join(dir, f);
    statSync(p).isDirectory() ? walk(p, exts, acc) : exts.some((e) => f.endsWith(e)) && acc.push(p);
  }
  return acc;
}

const findings = [];
for (const f of walk(path.join(root, 'packages/db/migrations'), ['.sql'])) {
  const lines = readFileSync(f, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.replace(/--.*$/, '');
    // column definition: "<name> <type>" at start of line, or ADD COLUMN <name>
    const m = code.match(/^\s*"?([a-z_][a-z0-9_]*)"?\s+(text|varchar|char|character|bytea|jsonb|json|bigint|integer|numeric)\b/i)
      ?? code.match(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-z_][a-z0-9_]*)"?/i);
    if (m && FORBIDDEN.test(m[1])) findings.push({ file: path.relative(root, f), line: i + 1, column: m[1] });
  });
}
for (const f of walk(path.join(root, 'apps/api/src'), ['.ts'])) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/(INSERT\s+INTO\s+\w+\s*\(([^)]*)\)|UPDATE\s+\w+\s+SET\s+([^`'"]*?)WHERE)/gis)) {
    const cols = (m[2] ?? m[3] ?? '').split(',').map((c) => c.trim().split(/\s|=/)[0]);
    for (const c of cols) if (FORBIDDEN.test(c)) {
      findings.push({ file: path.relative(root, f), line: src.slice(0, m.index).split('\n').length, column: c });
    }
  }
}

const result = { gate: 'G5', check: 'no-pan-cvc-storage', ok: findings.length === 0, findings, scannedAt: new Date().toISOString() };
if (out) { mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); writeFileSync(out, JSON.stringify(result, null, 2)); }
if (findings.length) {
  for (const x of findings) console.log(`FAIL ${x.file}:${x.line} column '${x.column}' looks like raw card data (invariant 9)`);
  process.exit(1);
}
console.log('no PAN/CVC columns found (invariant 9) — PASS');
