#!/usr/bin/env bash
# G6 load suite: fixtures -> search -> quote -> hold race -> DB no-oversell check.
#   BASE_URL=http://localhost:4000 DATABASE_URL=... bash scripts/load/run-all.sh [report_dir]
# Target must be a local/CI or staging-like environment with PAYMENT_PROVIDER=MOCK — never production.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$(mkdir -p "${1:-reports}" && cd "${1:-reports}" && pwd)"
export REPORT_DIR="$out"
[[ "${BASE_URL:-}" == *jetpool.kr* && "${BASE_URL:-}" != *staging* ]] && { echo "refusing to load-test production"; exit 2; }
command -v k6 >/dev/null || { echo "k6 not installed (https://k6.io/docs/get-started/installation/)"; exit 2; }
rc=0
node "$here/fixtures.mjs" "${HOLD_VUS:-50}" > "$out/load-fixture.json" || { echo "fixture creation failed"; exit 1; }
export FIXTURE="$out/load-fixture.json"
k6 run "$here/search.js" || rc=1
k6 run "$here/quote.js" || rc=1
k6 run "$here/hold-concurrency.js" || rc=1
node "$here/check-oversell.mjs" "$FIXTURE" "$out/oversell-check.json" || rc=1
rm -f "$out/load-fixture.json"   # contains short-lived tokens; do not upload
exit $rc
