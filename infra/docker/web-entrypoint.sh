#!/bin/sh
# Starts the Next.js app in whichever mode the image was built with (see apps/web/Dockerfile).
set -eu
cd /app
read -r mode target < /app/.jetpool-web-mode
case "$mode" in
  standalone) cd "$(dirname "$target")" && exec node server.js ;;
  next-start) cd "$target" && exec node node_modules/next/dist/bin/next start -p "${PORT:-3000}" -H "${HOSTNAME:-0.0.0.0}" ;;
  *) echo "unknown web mode: $mode" >&2; exit 1 ;;
esac
