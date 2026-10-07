#!/usr/bin/env bash
# Post-deploy smoke test (staging + production canary/promote).
#   infra/scripts/smoke.sh <api_base_url> [web_base_url]
# Env: SMOKE_RETRIES (default 30), SMOKE_INTERVAL (default 5s), EXPECT_PRODUCTION=1 to assert prod hardening,
#      SMOKE_DURATION (seconds; >0 keeps probing /ready and fails on any non-200 — used as canary bake time)
set -euo pipefail
API="${1:?usage: smoke.sh <api_base_url> [web_base_url]}"; API="${API%/}"
WEB="${2:-}"; WEB="${WEB%/}"
RETRIES="${SMOKE_RETRIES:-30}"; INTERVAL="${SMOKE_INTERVAL:-5}"
fail=0
ok()  { printf '  ok   %s\n' "$*"; }
bad() { printf '  FAIL %s\n' "$*"; fail=1; }

wait_200() { # <url>
  for _ in $(seq 1 "$RETRIES"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" || true)"
    [[ "$code" == "200" ]] && return 0
    sleep "$INTERVAL"
  done
  return 1
}

echo "smoke: api=$API web=${WEB:-<none>}"
wait_200 "$API/health" && ok "/health 200" || bad "/health not 200"
ready="$(curl -fsS --max-time 10 "$API/ready" || true)"
[[ "$ready" == *'"status":"ready"'* ]] && ok "/ready $ready" || bad "/ready: ${ready:-no response}"

# /metrics must exist but should NOT be publicly reachable through the edge in production (ALB/WAF rule).
mcode="$(curl -s -o /tmp/metrics.txt -w '%{http_code}' --max-time 10 "$API/metrics" || true)"
if [[ "${EXPECT_PRODUCTION:-}" == "1" ]]; then
  [[ "$mcode" == "403" || "$mcode" == "404" ]] && ok "/metrics blocked at edge ($mcode)" || bad "/metrics publicly reachable ($mcode)"
else
  [[ "$mcode" == "200" ]] && grep -q jetpool_http_request_duration_seconds /tmp/metrics.txt && ok "/metrics exposes jetpool_* series" \
    || echo "  warn /metrics returned $mcode (may be blocked at edge)"
fi

# API docs UI is disabled in production (app.ts registers swagger-ui only when NODE_ENV != production)
if [[ "${EXPECT_PRODUCTION:-}" == "1" ]]; then
  dcode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$API/docs" || true)"
  [[ "$dcode" != "200" ]] && ok "/docs disabled ($dcode)" || bad "/docs exposed in production"
fi

# Problem+json shape and correlation id on a 404
hdrs="$(curl -s -D - -o /tmp/nf.json --max-time 10 "$API/v1/__smoke_not_found__" || true)"
grep -qi '^x-correlation-id:' <<<"$hdrs" && ok "x-correlation-id header" || bad "missing x-correlation-id"
grep -qi 'x-content-type-options: nosniff' <<<"$hdrs" && ok "helmet headers" || bad "missing helmet headers"

# Public read path (search) must not 5xx — Postgres fallback works even if Meilisearch is down.
scode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$API/v1/search/properties?limit=1" || true)"
[[ "$scode" =~ ^[2-4][0-9][0-9]$ ]] && ok "search responds ($scode)" || bad "search returned ${scode:-none}"

# A browser success redirect must never confirm payment (invariant 3): unauthenticated confirm is rejected.
pcode="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST -H 'content-type: application/json' -d '{}' "$API/v1/payments/toss/confirm" || true)"
[[ "$pcode" == "401" || "$pcode" == "400" || "$pcode" == "404" || "$pcode" == "403" ]] && ok "unauthenticated payment confirm rejected ($pcode)" || bad "payment confirm returned $pcode"

if [[ -n "$WEB" ]]; then
  wait_200 "$WEB/" && ok "web / 200" || bad "web / not 200"
  wh="$(curl -s -D - -o /dev/null --max-time 10 "$WEB/" || true)"
  grep -qi '^content-security-policy:' <<<"$wh" && ok "web CSP header" || bad "web missing CSP"
fi

dur="${SMOKE_DURATION:-0}"
if (( dur > 0 )); then
  echo "bake: probing /ready for ${dur}s"
  end=$(( $(date +%s) + dur )); errs=0; n=0
  while (( $(date +%s) < end )); do
    c="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$API/ready" || true)"; n=$((n+1))
    [[ "$c" == "200" ]] || errs=$((errs+1))
    sleep 5
  done
  (( errs == 0 )) && ok "bake ${n} probes, 0 errors" || bad "bake ${errs}/${n} probes failed"
fi

if (( fail )); then echo "SMOKE FAILED"; exit 1; fi
echo "SMOKE PASSED"
