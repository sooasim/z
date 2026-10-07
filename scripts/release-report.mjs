#!/usr/bin/env node
// Release report: collects evidence produced by CI / scripts/oneclick.sh and renders docs/RELEASE_REPORT.md
// with the G0–G10 table. G9 (legal/business) and G10 (production) are ALWAYS "REQUIRES HUMAN APPROVAL".
//
// Usage: node scripts/release-report.mjs [--reports reports] [--out docs/RELEASE_REPORT.md] [--strict]
//   --strict  exit 1 if any automated gate (G0–G6) is FAIL
//
// Evidence files (all optional; missing evidence => NOT RUN):
//   g0-spec.json                    scripts/validate-spec.mjs --json
//   g1-openapi-lint.json, openapi-report.json, g1-asyncapi.txt
//   g2-migrate-verify*.log, g2-status*.json, g2-invariants*.txt, g2-seed*.txt
//   vitest-api.json                 vitest --reporter=json (unit/integration/E2E/permission-negative)
//   web-build.json                  {"status":"success"|"failure"}
//   gitleaks.json, no-pan.json, pnpm-audit.json, sbom.spdx.json
//   k6-*.json (k6 --summary-export), oversell-check.json (scripts/load/check-oversell.mjs)
//   dr-drill.json (docs/runbooks/db-restore-drill.md), migration-dryrun.json (MIG-01)
//   env JOB_RESULTS = toJSON(needs) from GitHub Actions (fallback status per job)
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const reportsDir = path.resolve(arg('--reports', path.join(root, 'reports')));
const outFile = path.resolve(arg('--out', path.join(root, 'docs/RELEASE_REPORT.md')));
const strict = process.argv.includes('--strict');

const files = existsSync(reportsDir) ? readdirSync(reportsDir) : [];
const has = (f) => files.includes(f);
const readJson = (f) => { try { return JSON.parse(readFileSync(path.join(reportsDir, f), 'utf8')); } catch { return null; } };
const readText = (f) => { try { return readFileSync(path.join(reportsDir, f), 'utf8'); } catch { return null; } };
const matching = (re) => files.filter((f) => re.test(f));
let jobs = {};
try { jobs = JSON.parse(process.env.JOB_RESULTS ?? '{}'); } catch {}
const job = (name) => jobs[name]?.result; // success | failure | cancelled | skipped

const PASS = 'PASS', FAIL = 'FAIL', PARTIAL = 'PARTIAL', NOTRUN = 'NOT RUN', HUMAN = 'REQUIRES HUMAN APPROVAL', NEEDS = 'EVIDENCE OK — NEEDS SIGN-OFF';
const gates = [];
const gate = (id, name, status, evidence) => gates.push({ id, name, status, evidence });

// ---------- tests (shared by G3/G4/G5/G8) ----------
const vt = readJson('vitest-api.json');
const assertions = [];
if (vt?.testResults) for (const f of vt.testResults) for (const a of f.assertionResults ?? []) {
  assertions.push({ file: path.basename(f.name ?? ''), name: a.fullName ?? [...(a.ancestorTitles ?? []), a.title].join(' '), status: a.status });
}
const sel = (re, fileRe) => assertions.filter((a) => (!fileRe || fileRe.test(a.file)) && (!re || re.test(a.name)));
const summarize = (list) => {
  const failed = list.filter((a) => a.status === 'failed').length;
  const passed = list.filter((a) => a.status === 'passed').length;
  return { total: list.length, passed, failed };
};

// ---------- G0 ----------
{
  const g0 = readJson('g0-spec.json');
  if (!g0) gate('G0', 'Spec integrity', job('spec') === 'success' ? PASS : job('spec') === 'failure' ? FAIL : NOTRUN, 'no g0-spec.json');
  else gate('G0', 'Spec integrity', g0.ok ? PASS : FAIL,
    `${g0.modules} modules (${g0.p0} P0), ${g0.errors.length} spec errors; implementation gaps: ${g0.missingRouteTags.length} modules without route tags, ${g0.missingTables.length} owned tables without migration`);
}
// ---------- G1 ----------
{
  const lint = readJson('g1-openapi-lint.json');
  const rep = readJson('openapi-report.json');
  const parts = [];
  if (rep) parts.push(`${rep.paths} paths / ${rep.operations} operations / ${Object.keys(rep.moduleTags ?? {}).length} module tags; ${rep.seedPathsMissing?.length ?? '?'} seed paths not implemented verbatim`);
  if (lint) parts.push(`redocly lint exit ${lint.exitCode}`);
  if (has('g1-breaking.txt')) parts.push('breaking-change diff attached');
  let s = NOTRUN;
  if (lint) s = lint.exitCode === 0 ? PASS : FAIL;
  else if (job('contracts')) s = job('contracts') === 'success' ? PASS : FAIL;
  if (s === PASS && !rep) s = PARTIAL;
  gate('G1', 'Contracts', s, parts.join('; ') || 'no contract evidence');
}
// ---------- G2 ----------
{
  const logs = matching(/^g2-migrate-verify.*\.log$/);
  const okLogs = logs.filter((f) => /verify ok/.test(readText(f) ?? ''));
  const inv = matching(/^g2-invariants.*\.txt$/).map(readText).join('\n');
  const seeds = matching(/^g2-seed.*\.txt$/);
  const statuses = matching(/^g2-status.*\.json$/).map(readJson).filter(Boolean);
  let s = NOTRUN;
  if (logs.length) s = okLogs.length === logs.length && !statuses.some((x) => x.status !== 'success') ? PASS : FAIL;
  else if (job('db')) s = job('db') === 'success' ? PASS : FAIL;
  if (s === PASS && !seeds.length) s = PARTIAL;
  const exc = inv.match(/exclusion_constraints=(\d+)/)?.[1];
  gate('G2', 'Data', s, `migrate --verify ok on ${okLogs.length}/${logs.length} PG versions; exclusion constraints=${exc ?? '?'}; deterministic seed ${seeds.length ? 'verified' : 'not verified'}`);
}
// ---------- G3 ----------
{
  if (!vt) gate('G3', 'Domain', job('api') ? (job('api') === 'success' ? PASS : FAIL) : NOTRUN, 'no vitest-api.json');
  else {
    const all = summarize(assertions);
    const neg = summarize(sel(/invalid|illegal|transition|reject|stale|denied|cannot|not allowed/i));
    const idem = summarize(sel(/idempot|replay|duplicate/i));
    const ok = vt.success !== false && all.failed === 0 && all.total > 0;
    const s = !ok ? FAIL : neg.total && idem.total ? PASS : PARTIAL;
    gate('G3', 'Domain', s, `${all.passed}/${all.total} tests passed in ${vt.testResults.length} files; transition-negative ${neg.passed}/${neg.total}; idempotency ${idem.passed}/${idem.total}`);
  }
}
// ---------- G4 ----------
{
  const chains = [
    ['Stay paid', /e2e-(stay|booking)/i],
    ['Exchange bilateral', /e2e-exchange/i],
    ['Guide free/paid', /e2e-guide/i],
    ['Travel order', /e2e-(travel|order|commerce)/i],
  ];
  const parts = []; let required = 0, passed = 0, failed = 0;
  for (const [label, re] of chains) {
    const r = summarize(sel(null, re));
    if (!r.total) { parts.push(`${label}: no tests`); if (label !== 'Travel order') required++; continue; }
    if (label !== 'Travel order') required++;
    if (r.failed) failed++; else if (label !== 'Travel order') passed++;
    parts.push(`${label}: ${r.passed}/${r.total}`);
  }
  const s = !vt ? NOTRUN : failed ? FAIL : passed === required ? PASS : passed ? PARTIAL : NOTRUN;
  gate('G4', 'End-to-end', s, parts.join('; '));
}
// ---------- G5 ----------
{
  const parts = []; let s = PASS; let any = false;
  const gl = readJson('gitleaks.json');
  if (Array.isArray(gl)) { any = true; parts.push(`gitleaks ${gl.length} finding(s)`); if (gl.length) s = FAIL; }
  else { parts.push('gitleaks not run'); s = PARTIAL; }
  const np = readJson('no-pan.json');
  if (np) { any = true; parts.push(`PAN/CVC guard ${np.ok ? 'ok' : 'FAILED'}`); if (!np.ok) s = FAIL; } else { parts.push('PAN/CVC guard not run'); if (s === PASS) s = PARTIAL; }
  const au = readJson('pnpm-audit.json');
  const v = au?.metadata?.vulnerabilities;
  if (v) { any = true; parts.push(`SCA high=${v.high ?? 0} critical=${v.critical ?? 0}`); if ((v.high ?? 0) + (v.critical ?? 0) > 0) s = FAIL; }
  else { parts.push('SCA not run'); if (s === PASS) s = PARTIAL; }
  if (has('sbom.spdx.json')) { any = true; parts.push('SBOM present'); } else { parts.push('SBOM missing'); if (s === PASS) s = PARTIAL; }
  parts.push('SAST: CodeQL workflow (see Security tab)');
  if (vt) {
    const perm = summarize(sel(/forbid|permission|unauthori|403|401|not (the )?owner|other user|missing role|deny|denied/i));
    const aal = summarize(sel(/aal2|aal1|mfa|step-?up/i));
    any = true;
    parts.push(`permission-negative ${perm.passed}/${perm.total}; AAL2 ${aal.passed}/${aal.total}`);
    if (perm.failed || aal.failed) s = FAIL; else if ((!perm.total || !aal.total) && s === PASS) s = PARTIAL;
  } else if (s === PASS) s = PARTIAL;
  gate('G5', 'Security', any ? s : NOTRUN, parts.join('; '));
}
// ---------- G6 ----------
{
  const k6 = matching(/^k6-.*\.json$/).map((f) => [f, readJson(f)]).filter(([, j]) => j);
  const over = readJson('oversell-check.json');
  const parts = []; let failed = false;
  for (const [f, j] of k6) {
    const th = Object.entries(j.metrics ?? {}).flatMap(([m, d]) => Object.entries(d.thresholds ?? {}).map(([t, v]) => ({ m, t, ok: v === true || v?.ok === true || v === false ? v !== false : true })));
    // k6 summary-export: thresholds map "expr" -> boolean (true = FAILED in legacy exporter); normalise both shapes
    const bad = Object.entries(j.metrics ?? {}).flatMap(([m, d]) => Object.entries(d.thresholds ?? {}).filter(([, v]) => v === true || v?.ok === false).map(([t]) => `${m}:${t}`));
    const p95 = j.metrics?.http_req_duration?.['p(95)'];
    parts.push(`${f.replace(/^k6-|\.json$/g, '')}: p95=${p95 != null ? Math.round(p95) + 'ms' : '?'}${bad.length ? ' threshold breach ' + bad.join(',') : ''} (${th.length} thresholds)`);
    if (bad.length) failed = true;
  }
  if (over) { parts.push(`no-oversell: ${over.ok ? 'ok' : 'OVERSOLD'} (${over.detail ?? ''})`); if (!over.ok) failed = true; }
  const s = !k6.length && !over ? NOTRUN : failed ? FAIL : k6.length && over ? PASS : PARTIAL;
  gate('G6', 'Performance', s, parts.join('; ') || 'load tests run nightly / on dispatch (ci.yml `load` job)');
}
// ---------- G7 ----------
{
  const d = readJson('migration-dryrun.json');
  if (!d) gate('G7', 'Migration', NOTRUN, 'no migration dry-run evidence (MIG-01, docs/runbooks/legacy-cutover.md)');
  else gate('G7', 'Migration', d.ok === false ? FAIL : d.approvedBy ? PASS : NEEDS,
    `dry-run ${d.ok === false ? 'has deltas' : 'reconciled'}; 301 map ${d.redirectCoverage ?? '?'}; approval: ${d.approvedBy ?? 'pending (migration owner + business)'}`);
}
// ---------- G8 ----------
{
  const rb = ['payment-reconciliation', 'webhook-replay', 'hold-expiry-backlog', 'outbox-dead-letters', 'db-restore-drill', 'incident-response', 'release-and-rollback', 'legacy-cutover'];
  const missing = rb.filter((r) => !existsSync(path.join(root, 'docs/runbooks', `${r}.md`)));
  const alerts = existsSync(path.join(root, 'infra/observability/prometheus/alerts.yml'));
  const dr = readJson('dr-drill.json');
  const recon = vt ? summarize(sel(/reconcil/i)) : null;
  const parts = [`runbooks ${rb.length - missing.length}/${rb.length}${missing.length ? ' (missing ' + missing.join(',') + ')' : ''}`, `alert rules ${alerts ? 'present' : 'missing'}`];
  parts.push(dr ? `restore drill ${dr.ok ? 'ok' : 'FAILED'} ${dr.date ?? ''} (RTO ${dr.rtoMinutes ?? '?'}m)` : 'restore drill: no evidence');
  parts.push(recon ? `payment reconciliation tests ${recon.passed}/${recon.total}` : 'payment reconciliation tests: not run');
  let s = missing.length || !alerts ? FAIL : PARTIAL;
  if (dr?.ok === false || recon?.failed) s = FAIL;
  else if (!missing.length && alerts && dr?.ok && recon?.total) s = PASS;
  gate('G8', 'DR & Ops', s, parts.join('; '));
}
gate('G9', 'Legal/Business approval', HUMAN, 'Accommodation/guide/travel/charter gates, merchant-of-record & settlement policy, published terms/privacy/refund — sign-off by legal/business owners (feature flags stay OFF until then)');
gate('G10', 'Production approval', HUMAN, 'Immutable digest verified on staging + GitHub Environment `production` reviewer approval + canary/smoke/rollback in deploy-production.yml');

// ---------- render ----------
const sha = process.env.GITHUB_SHA ?? (() => { try { return readFileSync(path.join(root, '.git/HEAD'), 'utf8').trim(); } catch { return 'unknown'; } })();
const badge = (s) => ({ [PASS]: '✅ PASS', [FAIL]: '❌ FAIL', [PARTIAL]: '🟡 PARTIAL', [NOTRUN]: '⚪ NOT RUN', [HUMAN]: '🔒 REQUIRES HUMAN APPROVAL', [NEEDS]: '🟡 NEEDS SIGN-OFF' }[s] ?? s);
const auto = gates.filter((g) => ['G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6'].includes(g.id));
const blocking = gates.filter((g) => g.status === FAIL);
const candidate = !blocking.length && auto.every((g) => g.status === PASS) && ['G7', 'G8'].every((id) => gates.find((g) => g.id === id).status === PASS);
const g0 = readJson('g0-spec.json');
const failedTests = assertions.filter((a) => a.status === 'failed').slice(0, 30);

let md = `# JETPOOL Release Report

- Generated: ${new Date().toISOString()}
- Commit: \`${sha}\`${process.env.GITHUB_RUN_ID ? `\n- CI run: ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : ''}
- Evidence directory: \`${path.relative(root, reportsDir) || '.'}\` (${files.length} files)
- **Release candidate: ${candidate ? 'YES — awaiting G9 + G10 human approvals' : 'NO'}**${blocking.length ? ` (blocking: ${blocking.map((g) => g.id).join(', ')})` : ''}

> Production deployment is never automatic. G9 (legal/business) and G10 (GitHub Environment \`production\`
> approval) are always human decisions (AGENTS_MASTER invariant 12).

| Gate | Name | Status | Evidence |
|---|---|---|---|
${gates.map((g) => `| ${g.id} | ${g.name} | ${badge(g.status)} | ${String(g.evidence).replace(/\|/g, '\\|')} |`).join('\n')}
`;
if (failedTests.length) md += `\n## Failing tests (first ${failedTests.length})\n\n${failedTests.map((a) => `- \`${a.file}\` — ${a.name}`).join('\n')}\n`;
if (g0?.missingRouteTags?.length) md += `\n## Implementation gaps (from G0)\n\n- Modules without a tagged route: ${g0.missingRouteTags.join(', ')}\n- Owned tables without migration: ${g0.missingTables.join(', ') || 'none'}\n`;
md += `\n## How each gate is evaluated\n\nSee \`docs/OPERATIONS.md\` §Release gates. Re-generate locally with \`bash scripts/oneclick.sh\` or \`pnpm release:report\`.\n`;

mkdirSync(path.dirname(outFile), { recursive: true });
writeFileSync(outFile, md);
console.log(md);
if (strict && auto.some((g) => g.status === FAIL)) process.exit(1);
