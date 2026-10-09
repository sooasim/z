#!/usr/bin/env node
/**
 * Derive the per-module Definition-of-Done status in docs/CHECKLIST.md from the spec + the implementation,
 * so the checklist is evidence-based instead of hand-maintained.
 *
 *   node scripts/module-status.mjs            # print the table and a summary
 *   node scripts/module-status.mjs --write    # rewrite the module table + invariants in docs/CHECKLIST.md
 *   node scripts/module-status.mjs --json reports/module-status.json
 *
 * Columns (legend: [x] done · [~] partial · [ ] not started):
 *   API     every declared interface is reachable: >=1 operation tagged with the module id in the generated
 *           contract (packages/contracts/openapi.json). Modules whose interfaces are all internal/CLI are
 *           satisfied by a script or worker that names the module.
 *   DB      every `owned_or_primary_tables` entry is CREATEd by packages/db/migrations, or is recorded in
 *           docs/SPEC_TABLE_MAPPING.md as a deliberate view/column/in-memory implementation.
 *   Events  every declared event name appears in apps/api/src as an emitted/consumed event type.
 *   AuthZ   every state-changing (POST/PUT/PATCH/DELETE) or /v1/admin route of the module has a `preHandler`
 *           guard. Public GETs, the unauthenticated auth entry points and provider webhooks (which
 *           authenticate by signature inside the handler, see docs/SECURITY.md) are exempt by design.
 *   Tests   apps/api/test contains a test that names the module id.
 *   UI      every `ui_routes` entry resolves to a page in apps/web/app (`{param}` -> `[param]`, `*` -> subtree).
 *
 * The spec lists some of these fields as prose rather than identifiers ("none", "internal", "* domain events",
 * "map components"). Those entries describe an intentional non-artifact and are not counted either way.
 */
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : null);
const read = (p) => readFileSync(path.join(root, p), 'utf8').replace(/^﻿/, '');

const DONE = '[x]';
const PART = '[~]';
const NONE = '[ ]';
const mark = (have, need) => (need === 0 || have >= need ? DONE : have > 0 ? PART : NONE);
/** A real table name, not a prose placeholder such as "none". */
const isIdentifier = (s) => /^[a-z][a-z0-9_]*$/i.test(String(s)) && String(s).toLowerCase() !== 'none';
/** A real event name (`domain.thing.happened`), not "* domain events". */
const isEventName = (s) => /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(String(s));

const spec = parseYaml(read('dd/JETPOOL_MASTER_BUILD_SPEC.yaml'));
const modules = spec.modules ?? [];
const owners = new Map(
  (parseYaml(read('dd/JETPOOL_MASTER_BUILD_SPEC.yaml')).modules ?? []).map((m) => [m.id, m]),
);

// ---------------------------------------------------------------- sources
const walk = (dir, ext, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const f = path.join(dir, e);
    statSync(f).isDirectory() ? walk(f, ext, out) : f.endsWith(ext) && out.push(f);
  }
  return out;
};
const apiFiles = walk(path.join(root, 'apps/api/src'), '.ts');
const apiSrc = apiFiles.map((f) => readFileSync(f, 'utf8')).join('\n');
const testSrc = walk(path.join(root, 'apps/api/test'), '.test.ts').map((f) => readFileSync(f, 'utf8')).join('\n');
const cliSrc = [...walk(path.join(root, 'apps/api/scripts'), '.ts'), ...walk(path.join(root, 'scripts'), '.mjs')]
  .map((f) => readFileSync(f, 'utf8')).join('\n');

// ---------------------------------------------------------------- API (generated contract)
const contract = JSON.parse(read('packages/contracts/openapi.json'));
const opsByTag = new Map();
const routes = []; // { method, path, tags }
for (const [p, ops] of Object.entries(contract.paths ?? {})) {
  for (const [method, op] of Object.entries(ops)) {
    routes.push({ method: method.toUpperCase(), path: p, tags: op.tags ?? [] });
    for (const t of op.tags ?? []) opsByTag.set(t, (opsByTag.get(t) ?? 0) + 1);
  }
}

// ---------------------------------------------------------------- AuthZ (preHandler per route, from source)
/** `r.get('/v1/x', { ... }, handler)` -> the text of the options object. */
const guarded = new Map(); // "METHOD /path" -> boolean
for (const f of apiFiles) {
  const src = readFileSync(f, 'utf8');
  const re = /\b(?:r|sub(?:\.withTypeProvider<[^>]*>\(\))?|app)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2\s*,/g;
  for (const m of src.matchAll(re)) {
    let i = src.indexOf('{', m.index + m[0].length - 1);
    if (i < 0) continue;
    let depth = 0, end = i;
    for (; end < src.length; end++) {
      if (src[end] === '{') depth++;
      else if (src[end] === '}' && --depth === 0) { end++; break; }
    }
    const opts = src.slice(i, end);
    const key = m[1].toUpperCase() + ' ' + m[3].replace(/:([A-Za-z_]+)/g, '{$1}');
    guarded.set(key, guarded.get(key) || /preHandler\s*:/.test(opts));
  }
}
// Routes registered through a local helper (e.g. booking's `lifecycle(...)`) keep the helper's guard; treat a
// route the scan never saw as unknown rather than unguarded.
//
// Unauthenticated by design: the auth entry points (there is no session yet) and provider webhooks, which
// authenticate by signature in the handler rather than by actor — see docs/SECURITY.md.
const PUBLIC_BY_DESIGN = [
  /^\/v1\/auth\/(login|signup|refresh|logout)$/,
  /^\/v1\/auth\/(otp|oauth|password\/reset)\//,
  /\/webhooks(\/|$)/,
  /^\/v1\/analytics\/events$/, // anonymous client telemetry; the server never trusts its contents
  /^\/v1\/charter\/requests$/, // public lead-capture form (rate-limited + honeypot), no payment
  // JET-01 keeps paid charter OFF until G9: these handlers are a feature-flag scope gate that always
  // answers 501 before touching any state, so the flag is the authorization.
  /^\/v1\/charter\/bookings/,
  /^\/v1\/charter\/flight-shares\/\{id\}\/seats$/,
];
const needsGuard = (r) =>
  (r.method !== 'GET' || r.path.startsWith('/v1/admin')) && !PUBLIC_BY_DESIGN.some((re) => re.test(r.path));

// ---------------------------------------------------------------- DB (migrations + mapping doc)
const created = new Set();
for (const f of readdirSync(path.join(root, 'packages/db/migrations')).filter((x) => x.endsWith('.sql'))) {
  const sql = readFileSync(path.join(root, 'packages/db/migrations', f), 'utf8');
  for (const m of sql.matchAll(/CREATE\s+(?:TABLE|VIEW|MATERIALIZED\s+VIEW)(?:\s+IF\s+NOT\s+EXISTS)?\s+"?([a-z0-9_]+)"?/gi))
    created.add(m[1].toLowerCase());
}
// Deliberate non-table implementations, from the same fenced `mapping:` block that validate-spec (G0) reads.
const mapped = new Set();
if (existsSync(path.join(root, 'docs/SPEC_TABLE_MAPPING.md'))) {
  for (const f of read('docs/SPEC_TABLE_MAPPING.md').matchAll(/^```ya?ml[^\n]*\n([\s\S]*?)^```/gm)) {
    let doc;
    try { doc = parseYaml(f[1]); } catch { continue; }
    if (doc && typeof doc === 'object' && doc.mapping) {
      for (const name of Object.keys(doc.mapping)) mapped.add(String(name).toLowerCase());
      break;
    }
  }
}

// ---------------------------------------------------------------- Tests (module ids named by tests)
// Tests label themselves with their module id, including the `GUIDE-02/03` shorthand for a test that
// covers two neighbouring modules.
const testedIds = new Set();
for (const m of testSrc.matchAll(/\b([A-Z]{2,8})-(\d+(?:\/\d+)*)\b/g)) {
  for (const n of m[2].split('/')) testedIds.add(`${m[1]}-${n.padStart(2, '0')}`);
}

// ---------------------------------------------------------------- UI (Next.js app dir)
const webApp = path.join(root, 'apps/web/app');
const uiRouteExists = (route) => {
  const segs = route.split('/').filter(Boolean);
  let dir = webApp;
  for (const [i, seg] of segs.entries()) {
    if (seg === '*') return existsSync(dir); // wildcard: the subtree root must exist
    const want = seg.replace(/^\{(.+)\}$/, '[$1]');
    if (!existsSync(dir)) return false;
    const entries = readdirSync(dir);
    let hit = entries.find((e) => e === want);
    if (!hit && /^\[.+\]$/.test(want)) hit = entries.find((e) => /^\[.+\]$/.test(e));
    if (!hit && !/^\[.+\]$/.test(want)) hit = entries.find((e) => /^\[.+\]$/.test(e) && i === segs.length - 1);
    if (!hit) return false;
    dir = path.join(dir, hit);
  }
  return ['page.tsx', 'page.ts', 'route.ts'].some((f) => existsSync(path.join(dir, f)));
};

// ---------------------------------------------------------------- per module
const rows = modules.map((m) => {
  const id = m.id;
  const internalOnly = (m.api_or_interfaces ?? []).length > 0 &&
    (m.api_or_interfaces ?? []).every((a) => /internal|cli/i.test(a));
  const api = internalOnly
    ? (cliSrc.includes(id) || apiSrc.includes(id) ? DONE : NONE)
    : mark(opsByTag.get(id) ?? 0, 1);

  const tables = (m.owned_or_primary_tables ?? []).map((t) => String(t).toLowerCase()).filter(isIdentifier);
  const haveTables = tables.filter((t) => created.has(t) || mapped.has(t));
  const db = mark(haveTables.length, tables.length);

  const events = (m.events ?? []).filter(isEventName);
  const haveEvents = events.filter((e) => apiSrc.includes(`'${e}'`) || apiSrc.includes(`"${e}"`) || apiSrc.includes(`\`${e}\``));
  const ev = mark(haveEvents.length, events.length);

  const mine = routes.filter((r) => r.tags.includes(id)).filter(needsGuard);
  const known = mine.filter((r) => guarded.has(r.method + ' ' + r.path));
  const authz = mine.length === 0 ? DONE : mark(known.filter((r) => guarded.get(r.method + ' ' + r.path)).length, known.length || 1);

  const tests = testedIds.has(id) ? DONE : NONE;

  const ui = (m.ui_routes ?? []).filter((r) => String(r).startsWith('/'));
  const haveUi = ui.filter(uiRouteExists);
  const uiMark = mark(haveUi.length, ui.length);

  return {
    id, name: m.name, priority: m.priority, api, db, events: ev, authz, tests, ui: uiMark,
    acceptance: m.acceptance ?? '',
    detail: {
      operations: opsByTag.get(id) ?? 0,
      tables: `${haveTables.length}/${tables.length}`,
      missingTables: tables.filter((t) => !haveTables.includes(t)),
      eventNames: `${haveEvents.length}/${events.length}`,
      missingEvents: events.filter((e) => !haveEvents.includes(e)),
      guardedRoutes: `${known.filter((r) => guarded.get(r.method + ' ' + r.path)).length}/${mine.length}`,
      unguarded: mine.filter((r) => guarded.has(r.method + ' ' + r.path) && !guarded.get(r.method + ' ' + r.path))
        .map((r) => r.method + ' ' + r.path),
      uiRoutes: `${haveUi.length}/${ui.length}`,
      missingUi: ui.filter((r) => !haveUi.includes(r)),
    },
  };
});

// ---------------------------------------------------------------- invariants (I1..I12 referenced by tests)
const INVARIANTS = [
  'PostgreSQL SoT; search/realtime/AI non-authoritative',
  'Independent Stay/Exchange/Guide FSMs',
  'Browser success URL never confirms payment',
  'Webhooks signature-validated, replay-safe, idempotent',
  'Inventory recheck in tx + durable hold before payment',
  'Exchange confirm blocks both homes atomically',
  'Paid publication denied until compliance predicates pass',
  'No hard-coded universal tax/legal rule',
  'No PAN/CVC storage',
  'No global admin read of private messages',
  'Ledger append-only, double-entry balanced',
  'Production deploy needs explicit approval',
];
// I12 is a delivery property, not a runtime one: the production job must sit behind a GitHub Environment
// whose reviewers approve the deploy. Everything else is verified by a test that names the invariant.
const prodWorkflow = 'github/workflows/deploy-production.yml';
const prodGated = existsSync(path.join(root, '.' + prodWorkflow)) &&
  /environment:\s*\n\s*name:\s*production/.test(read('.' + prodWorkflow));
const invariants = INVARIANTS.map((text, i) => {
  const n = i + 1;
  if (n === 12) return { id: 'I12', text, covered: prodGated, by: `.${prodWorkflow} (environment: production)` };
  const covered = new RegExp(`invariants?\\s*(?:\\d+\\s*(?:,|and|&)\\s*)*${n}\\b`, 'i').test(testSrc);
  return { id: `I${n}`, text, covered, by: 'apps/api/test' };
});

// ---------------------------------------------------------------- output
const checklistFile = path.join(root, 'docs/CHECKLIST.md');
const checklist = existsSync(checklistFile) ? readFileSync(checklistFile, 'utf8') : '';
/** Agent ownership is a planning decision (docs/PLAN.md §5) — keep whatever the checklist already says. */
const agents = new Map();
for (const m of checklist.matchAll(/^\|\s*([A-Z]{2,8}-\d+)\s*\|[^|]*\|[^|]*\|\s*([^|]*?)\s*\|/gm)) agents.set(m[1], m[2]);

const openItems = rows.flatMap((r) => {
  const d = r.detail, bits = [];
  if (r.api !== DONE) bits.push('no operation tagged with the module id in the generated contract');
  if (r.db !== DONE) bits.push(`tables ${d.tables} (missing: ${d.missingTables.join(', ')})`);
  if (r.events !== DONE) bits.push(`events ${d.eventNames} — not emitted: ${d.missingEvents.join(', ')}`);
  if (r.authz !== DONE) bits.push(`unguarded state-changing routes: ${d.unguarded.join(', ')}`);
  if (r.tests !== DONE) bits.push('no test names the module id');
  if (r.ui !== DONE) bits.push(`UI routes ${d.uiRoutes} (missing: ${d.missingUi.join(', ')})`);
  return bits.length ? [`- **${r.id}** ${r.name} — ${bits.join('; ')}`] : [];
});

const table = [
  '| Module | Name | P | Agent | API | DB | Events | AuthZ | Tests | UI | Acceptance |',
  '|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.id} | ${r.name} | ${r.priority} | ${agents.get(r.id) ?? '?'} | ${r.api} | ${r.db} | ${r.events} | ${r.authz} | ${r.tests} | ${r.ui} | ${r.acceptance} |`),
].join('\n');

// Release-gate status is owned by docs/RELEASE_REPORT.md (regenerated by `pnpm release:report`); mirror it
// here so one command leaves both documents agreeing.
const gateStatus = new Map();
if (existsSync(path.join(root, 'docs/RELEASE_REPORT.md')))
  for (const m of read('docs/RELEASE_REPORT.md').matchAll(/^\|\s*(G\d+)\s*\|[^|]*\|\s*([^|]*?)\s*\|/gm))
    gateStatus.set(m[1], m[2]);
const syncGates = (md) => md.replace(/^(\|\s*(G\d+)[^|]*\|[^|]*\|[^|]*\|\s*)([^|]*?)(\s*\|)$/gm,
  (line, head, gate, _old, tail) => (gateStatus.has(gate) ? head + gateStatus.get(gate) + tail : line));

const openSection = [
  '## Open items',
  '',
  openItems.length
    ? `Derived by \`node scripts/module-status.mjs\`; every other module column checks out.\n\n${openItems.join('\n')}`
    : 'None — every module column checks out.',
].join('\n');

if (arg('--json')) {
  const out = path.resolve(root, arg('--json'));
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), modules: rows, invariants }, null, 2) + '\n');
}

if (argv.includes('--write')) {
  let md = checklist;
  md = md.replace(/\| Module \| Name \|[\s\S]*?(?=\n\n## )/, table);
  md = md.replace(/## Open items\n\n[\s\S]*?(?=\n## )/, openSection + '\n');
  if (!md.includes('## Open items')) md = md.replace(/\n## Release Gates/, `\n${openSection}\n\n## Release Gates`);
  md = md.replace(/(## Invariants[^\n]*\n\n)([\s\S]*?)(?=\n*$)/, (_, head) =>
    head + invariants.map((i) => `- ${i.covered ? '[x]' : '[ ]'} ${i.id}. ${i.text}`).join('\n') + '\n');
  md = syncGates(md);
  writeFileSync(checklistFile, md);
  console.log('docs/CHECKLIST.md updated');
}

const count = (k, v) => rows.filter((r) => r[k] === v).length;
if (!argv.includes('--quiet')) {
  console.log(table);
  console.log('');
  for (const k of ['api', 'db', 'events', 'authz', 'tests', 'ui'])
    console.log(`${k.padEnd(7)} done ${String(count(k, DONE)).padStart(2)}  partial ${String(count(k, PART)).padStart(2)}  none ${String(count(k, NONE)).padStart(2)}`);
  console.log(`\ninvariants referenced by tests: ${invariants.filter((i) => i.covered).length}/12`);
  const gaps = rows.filter((r) => [r.api, r.db, r.events, r.authz, r.tests, r.ui].includes(NONE) || [r.api, r.db, r.events, r.authz, r.tests, r.ui].includes(PART));
  if (gaps.length) {
    console.log('\nopen items:');
    for (const g of gaps) {
      const d = g.detail;
      const bits = [];
      if (g.api !== DONE) bits.push('no tagged operation');
      if (g.db !== DONE) bits.push(`tables ${d.tables}${d.missingTables.length ? ' (' + d.missingTables.join(', ') + ')' : ''}`);
      if (g.events !== DONE) bits.push(`events ${d.eventNames}${d.missingEvents.length ? ' (' + d.missingEvents.join(', ') + ')' : ''}`);
      if (g.authz !== DONE) bits.push(`guards ${d.guardedRoutes}${d.unguarded.length ? ' (' + d.unguarded.join(', ') + ')' : ''}`);
      if (g.tests !== DONE) bits.push('no test names the module');
      if (g.ui !== DONE) bits.push(`ui ${d.uiRoutes}${d.missingUi.length ? ' (' + d.missingUi.join(', ') + ')' : ''}`);
      console.log(`  ${g.id.padEnd(9)} ${bits.join(' · ')}`);
    }
  }
}
