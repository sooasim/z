#!/usr/bin/env bash
# Start a local demo stack (idempotent): PostgreSQL (if a local cluster exists), API :4000, worker, Web :3000.
# Uses the 'jetpool' database (migrated + seeded). Logs: ${LOG_DIR:-/tmp/jetpool-dev}/*.log
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="${LOG_DIR:-/tmp/jetpool-dev}"
mkdir -p "$LOG_DIR"
export DATABASE_URL="${DATABASE_URL:-postgres://postgres@localhost:5432/jetpool}"
export NODE_ENV=development PAYMENT_PROVIDER=MOCK OAUTH_MOCK=true NEXT_TELEMETRY_DISABLED=1
export CORS_ORIGINS="${CORS_ORIGINS:-http://localhost:3000}" NEXT_PUBLIC_API_URL="${NEXT_PUBLIC_API_URL:-http://localhost:4000}"
export WORKER_METRICS_PORT=off

if ! pg_isready -h localhost -q 2>/dev/null; then
  PGB=/usr/lib/postgresql/16/bin
  if [ -d /tmp/pg/data ]; then
    rm -f /tmp/pg/data/postmaster.pid
    su postgres -c "$PGB/pg_ctl -D /tmp/pg/data -l /tmp/pg/log -o '-p 5432 -k /tmp -c max_connections=300' start" >/dev/null
    sleep 2
  fi
fi
node "$ROOT/packages/db/migrate.mjs" >/dev/null
node "$ROOT/packages/db/seed-dev.mjs" >/dev/null

up() { curl -fsS -o /dev/null --max-time 3 "$1" 2>/dev/null; }
if ! up http://localhost:4000/health; then
  (cd "$ROOT/apps/api" && nohup npx tsx src/server.ts >"$LOG_DIR/api.log" 2>&1 &)
fi
if ! pgrep -f "tsx src/worker.ts" >/dev/null; then
  (cd "$ROOT/apps/api" && nohup npx tsx src/worker.ts >"$LOG_DIR/worker.log" 2>&1 &)
fi
if ! up http://localhost:3000/; then
  (cd "$ROOT/apps/web" && nohup npx next dev -p 3000 >"$LOG_DIR/web.log" 2>&1 &)
fi
for i in $(seq 1 90); do up http://localhost:4000/health && break; sleep 1; done
for i in $(seq 1 180); do up http://localhost:3000/ && break; sleep 1; done
up http://localhost:4000/health && echo "api: http://localhost:4000 (docs /docs)" || { echo "api failed, see $LOG_DIR/api.log"; exit 1; }
up http://localhost:3000/ && echo "web: http://localhost:3000" || { echo "web failed, see $LOG_DIR/web.log"; exit 1; }
echo "demo logins (password Jetpool!2026dev): guest@jetpool.dev, host.seoul@jetpool.dev, host.jeju@jetpool.dev, exchange.busan@jetpool.dev, friend.guide@jetpool.dev, pro.guide@jetpool.dev, supplier@jetpool.dev, admin@jetpool.dev (staff actions need MFA enrollment)"
