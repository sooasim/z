#!/bin/sh
# Entrypoint for the jetpool-api image. The role is written to /tmp so the HEALTHCHECK
# (a separate process) knows whether to probe HTTP (api) or only liveness (worker/migrate).
set -eu
role="${1:-api}"
[ "$#" -gt 0 ] && shift
echo "$role" > /tmp/jetpool-role 2>/dev/null || true
case "$role" in
  api)            cd /app/apps/api && exec node dist/server.js "$@" ;;
  worker)         cd /app/apps/api && exec node dist/worker.js "$@" ;;
  migrate)        cd /app/packages/db && exec node migrate.mjs "$@" ;;
  migrate-verify) cd /app/packages/db && exec node migrate.mjs --verify "$@" ;;
  *)              exec "$role" "$@" ;;
esac
