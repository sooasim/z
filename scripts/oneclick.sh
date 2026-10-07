#!/usr/bin/env bash
# JETPOOL one-click pipeline (local). Mirrors .github/workflows/ci.yml and renders docs/RELEASE_REPORT.md.
#
#   bash scripts/oneclick.sh            # full run
#   SKIP_WEB=1 SKIP_TESTS=1 bash scripts/oneclick.sh
#   RUN_LOAD=1 bash scripts/oneclick.sh # also start api+worker and run the k6 suite (needs k6)
#
# Steps: install → validate-spec (G0) → migrate --verify (G2) → typecheck → tests (G3/G4/G5-neg)
#        → contracts export + lint (G1) → web build → security (G5) → [load (G6)] → release-report
#
# This script NEVER deploys. Staging deploys happen in GitHub Actions after CI on main; production needs the
# protected `production` environment approval (G10). Requires PostgreSQL reachable at DATABASE_URL.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"
R="$ROOT/reports"
rm -rf "$R"; mkdir -p "$R"
export DATABASE_URL="${DATABASE_URL:-postgres://postgres@localhost:5432/jetpool}"
export TEST_DATABASE_URL="${TEST_DATABASE_URL:-$DATABASE_URL}"
export NEXT_TELEMETRY_DISABLED=1

declare -a SUMMARY=()
failed=0
step() { # <name> <cmd...>
  local name="$1"; shift
  printf '\n\033[1m▶ %s\033[0m\n' "$name"
  local t0=$SECONDS
  if "$@"; then SUMMARY+=("ok    $name ($((SECONDS - t0))s)"); return 0
  else SUMMARY+=("FAIL  $name ($((SECONDS - t0))s)"); failed=1; return 1; fi
}
skip() { SUMMARY+=("skip  $1"); }

# ---------------------------------------------------------------- install
step "install (frozen lockfile)" pnpm install --frozen-lockfile

# ---------------------------------------------------------------- G0
step "G0 validate-spec" node scripts/validate-spec.mjs --json "$R/g0-spec.json"

# ---------------------------------------------------------------- G2
pg_ok() { node -e "const pg=require('$ROOT/packages/db/node_modules/pg');const c=new pg.Client({connectionString:process.env.DATABASE_URL.replace(/\/[^/]*$/,'/postgres')});c.connect().then(()=>c.end()).then(()=>process.exit(0),()=>process.exit(1))"; }
if pg_ok; then
  g2() {
    node packages/db/migrate.mjs --verify 2>&1 | tee "$R/g2-migrate-verify-local.log"
    [[ ${PIPESTATUS[0]} -eq 0 ]] || return 1
    # ensure target DB exists, then apply
    node -e "const pg=require('$ROOT/packages/db/node_modules/pg');const u=new URL(process.env.DATABASE_URL);const db=u.pathname.slice(1);u.pathname='/postgres';const c=new pg.Client({connectionString:u.toString()});c.connect().then(()=>c.query('SELECT 1 FROM pg_database WHERE datname=\$1',[db])).then(r=>r.rowCount?null:c.query('CREATE DATABASE \"'+db+'\"')).then(()=>c.end())"
    node packages/db/migrate.mjs
    echo '{"gate":"G2","pg":"local","status":"success"}' > "$R/g2-status-local.json"
    if [[ -f packages/db/seed-dev.mjs ]]; then
      node packages/db/seed-dev.mjs >/dev/null && node packages/db/seed-dev.mjs >/dev/null && echo "seed ran twice without error" > "$R/g2-seed-local.txt"
    fi
  }
  step "G2 migrations verify + apply" g2
else
  echo "PostgreSQL not reachable at $DATABASE_URL — skipping DB steps"; skip "G2 migrations (no PostgreSQL)"; failed=1
fi

# ---------------------------------------------------------------- typecheck + tests
step "api typecheck" pnpm --filter @jetpool/api typecheck
if [[ -z "${SKIP_TESTS:-}" ]] && pg_ok; then
  step "G3/G4 api tests (vitest)" bash -c "cd apps/api && npx vitest run --reporter=default --reporter=json --outputFile.json='$R/vitest-api.json'"
else skip "api tests"; fi

# ---------------------------------------------------------------- G1
g1() {
  pnpm contracts:generate || return 1
  cp packages/contracts/openapi.json packages/contracts/openapi-report.json "$R/" 2>/dev/null || true
  local code=0
  npx --yes @redocly/cli@1 lint packages/contracts/openapi.json --format=stylish > "$R/g1-openapi-lint.txt" 2>&1 || code=$?
  tail -n 15 "$R/g1-openapi-lint.txt"
  echo "{\"gate\":\"G1\",\"check\":\"openapi-lint\",\"exitCode\":$code}" > "$R/g1-openapi-lint.json"
  return $code
}
step "G1 contracts export + lint" g1

# ---------------------------------------------------------------- web
if [[ -z "${SKIP_WEB:-}" && -f apps/web/package.json ]]; then
  web() { pnpm --filter @jetpool/web typecheck && pnpm --filter @jetpool/web build; }
  if step "web typecheck + build" web; then echo '{"status":"success"}' > "$R/web-build.json"; else echo '{"status":"failure"}' > "$R/web-build.json"; fi
else skip "web build"; fi

# ---------------------------------------------------------------- G5
step "G5 PAN/CVC guard" node scripts/check-no-pan.mjs --json "$R/no-pan.json"
if command -v gitleaks >/dev/null; then
  step "G5 secret scan (gitleaks)" gitleaks detect --source . --config .gitleaks.toml --redact --no-banner --report-format json --report-path "$R/gitleaks.json"
else skip "gitleaks (not installed — runs in CI)"; fi
pnpm audit --json > "$R/pnpm-audit.json" 2>/dev/null || true
step "G5 SCA (pnpm audit --audit-level=high, advisory)" bash -c "pnpm audit --audit-level=high || { echo 'advisories found (see reports/pnpm-audit.json)'; exit 0; }"

# ---------------------------------------------------------------- G6 (optional)
if [[ -n "${RUN_LOAD:-}" ]] && pg_ok; then
  g6() {
    pnpm --filter @jetpool/api build || return 1
    (cd apps/api && NODE_ENV=test PAYMENT_PROVIDER=MOCK RATE_LIMIT_PER_MIN=1000000 node dist/server.js > "$R/api.log" 2>&1 & echo $! > /tmp/jetpool-oneclick-api.pid)
    for _ in $(seq 1 60); do curl -fsS http://localhost:4000/ready >/dev/null 2>&1 && break; sleep 1; done
    BASE_URL=http://localhost:4000 bash scripts/load/run-all.sh "$R"; local rc=$?
    kill "$(cat /tmp/jetpool-oneclick-api.pid)" 2>/dev/null || true
    return $rc
  }
  step "G6 load + no-oversell (k6)" g6
else skip "G6 load (set RUN_LOAD=1)"; fi

# ---------------------------------------------------------------- report
step "release report" node scripts/release-report.mjs --reports "$R" --out docs/RELEASE_REPORT.md >/dev/null

printf '\n\033[1mOne-click summary\033[0m\n'
printf '  %s\n' "${SUMMARY[@]}"
echo
grep -E '^\| G[0-9]+ ' docs/RELEASE_REPORT.md | awk -F'|' '{printf "  %-4s %-26s %s\n", $2, $3, $4}'
echo
echo "Report: docs/RELEASE_REPORT.md  ·  evidence: reports/"
echo "Next: push to main → CI → deploy-staging (auto). Production: run deploy-production with verified digests (manual approval)."
exit $failed
