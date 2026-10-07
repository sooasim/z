#!/usr/bin/env bash
# Runs infra/scripts/restore-verify.sql against a restored database and writes G8 evidence.
#   RESTORED_DATABASE_URL=postgres://... RESTORE_STARTED_AT=<epoch> bash infra/scripts/restore-verify.sh [reports/dr-drill.json]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-reports/dr-drill.json}"
url="${RESTORED_DATABASE_URL:?RESTORED_DATABASE_URL is required}"
case "$url" in *prod*primary*|*jetpool-prod-pg.*) echo "refusing: point this at the RESTORED instance, not the primary"; exit 2 ;; esac
rows="$(psql "$url" -v ON_ERROR_STOP=1 -At -F '|' -f "$here/restore-verify.sql")"
if command -v column >/dev/null; then column -t -s "|" <<<"$rows"; else echo "$rows"; fi
ok=true; json="[]"
while IFS='|' read -r check pass detail; do
  [[ -z "$check" ]] && continue
  [[ "$pass" == "t" ]] || ok=false
  json="$(jq -c --arg c "$check" --arg p "$pass" --arg d "$detail" '. + [{check:$c, ok:($p=="t"), detail:$d}]' <<<"$json")"
done <<<"$rows"
rto=null
[[ -n "${RESTORE_STARTED_AT:-}" ]] && rto=$(( ( $(date +%s) - RESTORE_STARTED_AT ) / 60 ))
mkdir -p "$(dirname "$out")"
jq -n --argjson checks "$json" --argjson ok "$ok" --argjson rto "$rto" --arg date "$(date -u +%FT%TZ)" \
  --arg target "${RESTORE_TARGET_TIME:-unspecified}" \
  '{gate:"G8", check:"restore-drill", ok:$ok, date:$date, restoreTargetTime:$target, rtoMinutes:$rto, checks:$checks}' > "$out"
echo "evidence: $out (ok=$ok)"
$ok
