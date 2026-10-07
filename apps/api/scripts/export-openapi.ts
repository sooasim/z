/**
 * G1: export the OpenAPI 3.1 contract generated from live route schemas into packages/contracts,
 * and cross-check it against the seed skeleton (dd/JETPOOL_OPENAPI_SKELETON.yaml).
 * Usage: tsx scripts/export-openapi.ts [--check]
 */
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const out = path.join(root, 'packages/contracts');
mkdirSync(out, { recursive: true });

const app = await buildApp({ logger: false, config: { NODE_ENV: 'test' } as any });
await app.ready();
const spec = app.swagger() as any;
await app.close();

const sorted = { ...spec, paths: Object.fromEntries(Object.entries(spec.paths ?? {}).sort(([a], [b]) => a.localeCompare(b))) };
writeFileSync(path.join(out, 'openapi.json'), JSON.stringify(sorted, null, 2) + '\n');

// Traceability: module tags present in the generated contract
const tags = new Map<string, number>();
for (const ops of Object.values<any>(sorted.paths)) {
  for (const op of Object.values<any>(ops)) for (const t of op?.tags ?? []) tags.set(t, (tags.get(t) ?? 0) + 1);
}
const skeleton = readFileSync(path.join(root, 'dd/JETPOOL_OPENAPI_SKELETON.yaml'), 'utf8');
const seedPaths = [...skeleton.matchAll(/^  (\/[^:]+):$/gm)].map((m) => m[1]);
const normalize = (p: string) => p.replace(/\{[^}]+\}/g, '{}').replace(/:[A-Za-z_]+/g, '{}');
const livePaths = new Set(Object.keys(sorted.paths).map(normalize));
const missing = seedPaths.filter((p) => p.startsWith('/v1/') && !p.includes('{wildcard}') && !livePaths.has(normalize(p)));
const report = {
  generatedAt: new Date().toISOString(),
  operations: Object.values<any>(sorted.paths).reduce((n, ops) => n + Object.keys(ops).length, 0),
  paths: Object.keys(sorted.paths).length,
  moduleTags: Object.fromEntries([...tags.entries()].sort()),
  seedPathsMissing: missing,
};
writeFileSync(path.join(out, 'openapi-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(`openapi: ${report.paths} paths, ${report.operations} operations, ${tags.size} module tags; seed paths not implemented verbatim: ${missing.length}`);
if (process.argv.includes('--check') && missing.length) {
  console.log(missing.map((m) => `  - ${m}`).join('\n'));
}
process.exit(0);
