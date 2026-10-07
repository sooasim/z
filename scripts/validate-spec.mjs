#!/usr/bin/env node
// G0 — Spec integrity gate.
//
// Errors (exit 1) = the SPEC itself is broken:
//   - a P0 module is missing owner(repo) / API / data / events / UI / acceptance
//   - duplicate module ids, unresolved depends_on references
//   - traceability CSV ids != master spec ids
//   - spec event not declared in the AsyncAPI seed, OpenAPI seed tag referencing an unknown module
//   - release gates G0..G10 missing or diverging from dd/JETPOOL_RELEASE_GATES.yaml
// Warnings (exit 0) = implementation gaps in the codebase:
//   - module id never used as a route tag in apps/api/src (tags: ['<ID>']) nor in the generated contract
//     packages/contracts/openapi.json (per-operation tags), when that file is present
//   - owned table not created by any migration in packages/db/migrations and not satisfied by an entry in
//     docs/SPEC_TABLE_MAPPING.md (fenced yaml `mapping:` of specName: {kind: view|table|column|in-memory, implementation})
//
// Usage: node scripts/validate-spec.mjs [--json <out.json>] [--strict]
//   --strict  also fail on implementation-gap warnings (used for release candidates)
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
const strict = args.includes('--strict');

const errors = [];
const warnings = [];
const info = [];
const err = (m) => errors.push(m);
const warn = (m) => warnings.push(m);

const read = (p) => readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, '');

// ---------- master spec ----------
const spec = parseYaml(read('dd/JETPOOL_MASTER_BUILD_SPEC.yaml'));
const modules = Array.isArray(spec?.modules) ? spec.modules : [];
if (!modules.length) err('master spec has no modules');
const ids = new Set();
for (const m of modules) {
  if (!m.id) { err(`module without id: ${JSON.stringify(m).slice(0, 80)}`); continue; }
  if (ids.has(m.id)) err(`duplicate module id ${m.id}`);
  ids.add(m.id);
}

const nonEmptyList = (v) => Array.isArray(v) ? v.filter((x) => String(x ?? '').trim()).length > 0 : !!String(v ?? '').trim();
const REQUIRED_P0 = [
  ['owner', (m) => m.repo ?? m.owner],
  ['api', (m) => m.api_or_interfaces],
  ['data', (m) => m.owned_or_primary_tables],
  ['events', (m) => m.events],
  ['ui', (m) => m.ui_routes],
  ['acceptance', (m) => m.acceptance],
];
let p0 = 0;
for (const m of modules) {
  if (!['P0', 'P1', 'P2'].includes(m.priority)) err(`${m.id}: invalid priority ${m.priority}`);
  for (const d of m.depends_on ?? []) if (!ids.has(d)) err(`${m.id}: depends_on references unknown module ${d}`);
  if (m.priority !== 'P0') continue;
  p0++;
  for (const [field, get] of REQUIRED_P0) if (!nonEmptyList(get(m))) err(`${m.id} (P0): missing ${field}`);
}
info.push(`${modules.length} modules (${p0} P0)`);

// ---------- release gates ----------
const gatesFile = parseYaml(read('dd/JETPOOL_RELEASE_GATES.yaml'))?.release_gates ?? [];
const gatesSpec = spec.release_gates ?? [];
for (let i = 0; i <= 10; i++) {
  const g = `G${i}`;
  const a = gatesFile.find((x) => x.id === g);
  const b = gatesSpec.find((x) => x.id === g);
  if (!a) err(`release gate ${g} missing from dd/JETPOOL_RELEASE_GATES.yaml`);
  if (!b) err(`release gate ${g} missing from master spec`);
  if (a && b && JSON.stringify(a.criteria) !== JSON.stringify(b.criteria)) err(`release gate ${g} criteria differ between master spec and RELEASE_GATES.yaml`);
  if (a && !(a.criteria ?? []).length) err(`release gate ${g} has no criteria`);
}

// ---------- traceability CSV ----------
function parseCsv(text) {
  const rows = []; let row = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const csv = parseCsv(read('dd/JETPOOL_MODULE_TRACEABILITY.csv'));
const csvIds = new Set(csv.slice(1).map((r) => r[0].trim()).filter(Boolean));
for (const id of ids) if (!csvIds.has(id)) err(`traceability CSV missing module ${id}`);
for (const id of csvIds) if (!ids.has(id)) err(`traceability CSV has unknown module ${id}`);
const header = csv[0] ?? [];
const pIdx = header.indexOf('Priority');
if (pIdx >= 0) for (const r of csv.slice(1)) {
  const m = modules.find((x) => x.id === r[0]);
  if (m && m.priority !== r[pIdx]) err(`${m.id}: priority mismatch spec=${m.priority} csv=${r[pIdx]}`);
}

// ---------- contract seeds ----------
const asyncapi = parseYaml(read('dd/JETPOOL_ASYNCAPI_SKELETON.yaml'));
const channels = new Set(Object.keys(asyncapi?.channels ?? {}));
for (const m of modules) for (const e of m.events ?? []) {
  if (String(e).includes('*') || /^none$/i.test(e)) continue;
  if (!channels.has(e)) err(`${m.id}: event ${e} not declared in dd/JETPOOL_ASYNCAPI_SKELETON.yaml`);
}
const openapi = parseYaml(read('dd/JETPOOL_OPENAPI_SKELETON.yaml'));
for (const [p, ops] of Object.entries(openapi?.paths ?? {})) for (const [verb, op] of Object.entries(ops ?? {})) {
  for (const t of op?.tags ?? []) if (!ids.has(t)) err(`OpenAPI seed ${verb.toUpperCase()} ${p}: tag ${t} is not a module id`);
}

// ---------- implementation gaps (warnings) ----------
function walk(dir, exts, out = []) {
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (f === 'node_modules' || f === 'dist' || f.startsWith('.')) continue;
    const p = path.join(dir, f);
    if (statSync(p).isDirectory()) walk(p, exts, out);
    else if (exts.some((e) => f.endsWith(e))) out.push(p);
  }
  return out;
}
const usedTags = new Set();
for (const f of walk(path.join(root, 'apps/api/src'), ['.ts', '.js'])) {
  const src = readFileSync(f, 'utf8');
  // constants such as `const TAG_PAY = 'PAY-01'` used as `tags: [TAG_PAY]`
  const consts = new Map([...src.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?::\s*\w+\s*)?=\s*['"`]([A-Z]+-\d+)['"`]/g)].map((m) => [m[1], m[2]]));
  // `tags: TAG` where `const TAG = ['CORE-01']` (or any non-literal tags expression)
  let unresolved = /tags:\s*(?!\[)[A-Za-z_$]/.test(src) || /[{,]\s*tags\s*[,}]/.test(src); // incl. shorthand `{ tags }`
  for (const m of src.matchAll(/tags:\s*\[([^\]]*)\]/g)) {
    for (const t of m[1].matchAll(/['"`]([A-Z]+-\d+)['"`]/g)) usedTags.add(t[1]);
    for (const id of m[1].matchAll(/(?:^|[\s,])([A-Za-z_$][\w$]*)(?=\s*(?:,|$))/g)) {
      if (consts.has(id[1])) usedTags.add(consts.get(id[1]));
      else unresolved = true;
    }
  }
  // tags computed from a variable (e.g. a loop over [path, 'STAY-09']): count module-id literals in that file
  if (unresolved) for (const t of src.matchAll(/['"`]([A-Z]+-\d+)['"`]/g)) usedTags.add(t[1]);
}
const moduleTagCount = () => [...usedTags].filter((t) => ids.has(t)).length;
const sourceTagCount = moduleTagCount();
// The generated contract (apps/api `pnpm contracts:export` → packages/contracts/openapi.json) carries the
// resolved tags of every registered operation, including tags the source scan cannot resolve statically.
const contractPath = 'packages/contracts/openapi.json';
if (existsSync(path.join(root, contractPath))) {
  let contract = null;
  try { contract = JSON.parse(read(contractPath)); } catch (e) { warn(`${contractPath}: not valid JSON (${e.message}); route tags taken from source scan only`); }
  let ops = 0;
  const HTTP_VERBS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
  for (const item of Object.values(contract?.paths ?? {})) for (const [verb, op] of Object.entries(item ?? {})) {
    if (!HTTP_VERBS.has(verb) || !op || typeof op !== 'object') continue;
    ops++;
    for (const t of Array.isArray(op.tags) ? op.tags : []) if (typeof t === 'string' && ids.has(t)) usedTags.add(t);
  }
  if (contract) info.push(`route tags: ${sourceTagCount} module id(s) from apps/api/src scan, ${moduleTagCount()} after ${contractPath} (${ops} operations)`);
}
const NO_ROUTE_EXPECTED = (m) => (m.api_or_interfaces ?? []).every((a) => /internal|cli/i.test(a));
const missingTags = [];
for (const m of modules) {
  if (usedTags.has(m.id)) continue;
  if (NO_ROUTE_EXPECTED(m)) { info.push(`${m.id}: no route tag (internal/CLI interface only)`); continue; }
  missingTags.push(m.id);
  warn(`${m.id} (${m.priority}): no route tagged '${m.id}' in apps/api/src or ${contractPath}`);
}

const migDir = path.join(root, 'packages/db/migrations');
const created = new Set();
for (const f of walk(migDir, ['.sql'])) {
  const sql = readFileSync(f, 'utf8');
  for (const m of sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?(?:MATERIALIZED\s+)?(?:TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"?\w+"?\.)?"?(\w+)"?/gi)) created.add(m[1].toLowerCase());
}
// docs/SPEC_TABLE_MAPPING.md: spec table names implemented under another name / shape. A fenced ```yaml block
// with a top-level `mapping:` of specName: { kind: view|table|column|in-memory, implementation, tables?, source? }.
const MAPPING_DOC = 'docs/SPEC_TABLE_MAPPING.md';
const MAPPING_KINDS = new Set(['view', 'table', 'column', 'in-memory']);
const mapping = new Map(); // specName -> { kind, implementation, satisfied, problem }
if (existsSync(path.join(root, MAPPING_DOC))) {
  const md = read(MAPPING_DOC);
  let block = null;
  for (const f of md.matchAll(/^```ya?ml[^\n]*\n([\s\S]*?)^```/gm)) {
    let doc;
    try { doc = parseYaml(f[1]); } catch (e) { err(`${MAPPING_DOC}: invalid YAML block (${e.message})`); continue; }
    if (doc && typeof doc === 'object' && 'mapping' in doc) { block = doc.mapping; break; }
  }
  if (!block || typeof block !== 'object' || Array.isArray(block)) err(`${MAPPING_DOC}: no fenced yaml block with a 'mapping:' object`);
  const specTables = new Set(modules.flatMap((m) => (m.owned_or_primary_tables ?? []).map((t) => String(t).trim().toLowerCase())));
  for (const [rawName, e] of Object.entries(block ?? {})) {
    const name = rawName.toLowerCase();
    if (!e || typeof e !== 'object' || !MAPPING_KINDS.has(e.kind) || typeof e.implementation !== 'string' || !e.implementation.trim()) {
      err(`${MAPPING_DOC}: mapping '${rawName}' needs kind (${[...MAPPING_KINDS].join('|')}) and a non-empty implementation`);
      continue;
    }
    // real tables backing the entry: explicit `tables`, else the leading identifier of `implementation`
    const tables = Array.isArray(e.tables) ? e.tables.map((x) => String(x).toLowerCase()) : [e.implementation.trim().match(/^[a-z_][a-z0-9_]*/i)?.[0]?.toLowerCase()].filter(Boolean);
    let problem = null;
    if (e.kind === 'in-memory') {
      if (!e.source || !existsSync(path.join(root, String(e.source)))) problem = `in-memory implementation source '${e.source ?? ''}' not found`;
    } else {
      const missing = tables.filter((x) => !created.has(x));
      if (!tables.length) problem = 'no backing table named';
      else if (missing.length) problem = `backing table(s) ${missing.join(', ')} not created by any migration`;
      else if (e.kind === 'view' && !created.has(name)) problem = `mapped as a view but no migration creates view '${name}'`;
      else if (e.migration && !existsSync(path.join(migDir, String(e.migration)))) problem = `migration ${e.migration} not found in packages/db/migrations`;
    }
    if (!specTables.has(name)) info.push(`${MAPPING_DOC}: '${name}' is not an owned table of any spec module (kept for reference)`);
    // a broken entry for a name that is otherwise satisfied (or not a spec table) would never surface below
    if (problem && (created.has(name) || !specTables.has(name))) warn(`${MAPPING_DOC}: mapping '${name}' is stale — ${problem}`);
    mapping.set(name, { kind: e.kind, implementation: e.implementation, tables, satisfied: !problem, problem });
  }
}

const missingTables = [];
const mappedTables = [];
for (const m of modules) for (const t of m.owned_or_primary_tables ?? []) {
  const name = String(t).trim().toLowerCase();
  if (!name || name === 'none') continue;
  const mapped = mapping.get(name);
  if (mapped?.satisfied) {
    mappedTables.push(`${m.id}:${name}`);
    if (!created.has(name)) info.push(`${m.id}: table '${name}' ${mapped.kind === 'in-memory' ? 'implemented as in-process cache (non-authoritative)' : `implemented as ${mapped.kind} of ${mapped.tables.join(', ')}`} — see ${MAPPING_DOC}`);
    continue;
  }
  if (created.has(name)) continue;
  missingTables.push(`${m.id}:${name}`);
  warn(`${m.id} (${m.priority}): table '${name}' not created by any migration${mapped ? ` (${MAPPING_DOC}: ${mapped.problem})` : ''}`);
}

// ---------- output ----------
const result = {
  gate: 'G0',
  ok: errors.length === 0 && (!strict || warnings.length === 0),
  modules: modules.length, p0,
  routeTagsFound: usedTags.size,
  migrationsTables: created.size,
  missingRouteTags: missingTags,
  missingTables,
  mappedTables,
  tableMapping: Object.fromEntries(mapping),
  errors, warnings, info,
  generatedAt: new Date().toISOString(),
};
for (const m of info) console.log(`info  ${m}`);
for (const m of warnings) console.log(`warn  ${m}`);
for (const m of errors) console.log(`ERROR ${m}`);
console.log(`\nG0 spec integrity: ${errors.length} error(s), ${warnings.length} implementation-gap warning(s) — ${result.ok ? 'PASS' : 'FAIL'}`);
if (jsonOut) {
  mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify(result, null, 2));
}
process.exit(result.ok ? 0 : 1);
