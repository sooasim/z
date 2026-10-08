#!/usr/bin/env bash
# Re-record the GitHub Pages demo fixtures from a fresh, ISOLATED database (never touches the 'jetpool' dev DB):
#   1. (re)create database jetpool_demo, migrate, seed-dev (packages/db/seed-dev.mjs — the rich demo data set)
#   2. start a private API (+ worker) on $DEMO_API_PORT (default 4100) against it
#   3. run record-fixtures.mjs --scenario (real bookings with MOCK payments, messages, exchanges, guides, orders)
#   4. stop the private API/worker
# Output: packages/demo/fixtures/api.json (commit it — CI builds the static demo from it without PostgreSQL).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PORT="${DEMO_API_PORT:-4100}"
DB="${DEMO_DB:-jetpool_demo}"
PGHOST="${PGHOST:-localhost}"
PGUSER="${PGUSER:-postgres}"
export DATABASE_URL="postgres://${PGUSER}@${PGHOST}:5432/${DB}"
LOG_DIR="${LOG_DIR:-${TMPDIR:-/tmp}/jetpool-demo-record}"
mkdir -p "$LOG_DIR"
case "$DB" in *_demo) ;; *) echo "DEMO_DB must end in _demo" >&2; exit 1 ;; esac

echo "[record.sh] resetting database $DB"
dropdb -h "$PGHOST" -U "$PGUSER" --if-exists --force "$DB"
createdb -h "$PGHOST" -U "$PGUSER" "$DB"
node "$ROOT/packages/db/migrate.mjs" >/dev/null
NODE_ENV=development node "$ROOT/packages/db/seed-dev.mjs"
# Legacy WONT Travel Club media/content, when its import manifest exists (no-op otherwise; never fatal here).
if [ -f "$ROOT/packages/db/seed-legacy.mjs" ]; then
  NODE_ENV=development node "$ROOT/packages/db/seed-legacy.mjs" ${DEMO_LEGACY_PUBLISH:+--publish} || echo "[record.sh] seed-legacy skipped"
fi

export NODE_ENV=development PAYMENT_PROVIDER=MOCK OAUTH_MOCK=true PORT="$PORT" RATE_LIMIT_PER_MIN=100000 WORKER_METRICS_PORT=off
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done; }
trap cleanup EXIT
(cd "$ROOT/apps/api" && exec ./node_modules/.bin/tsx src/server.ts >"$LOG_DIR/api.log" 2>&1) &
pids+=($!)
(cd "$ROOT/apps/api" && exec ./node_modules/.bin/tsx src/worker.ts >"$LOG_DIR/worker.log" 2>&1) &
pids+=($!)
for i in $(seq 1 90); do curl -fsS -o /dev/null --max-time 2 "http://localhost:$PORT/health" 2>/dev/null && break; sleep 1; done
curl -fsS -o /dev/null "http://localhost:$PORT/health" || { echo "API failed to start, see $LOG_DIR/api.log" >&2; exit 1; }
sleep 5 # let the worker index the seed listings

node "$ROOT/scripts/pages/record-fixtures.mjs" --api "http://localhost:$PORT" --scenario "$@"
echo "[record.sh] done → packages/demo/fixtures/api.json"
