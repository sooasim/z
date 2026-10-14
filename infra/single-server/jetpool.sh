#!/usr/bin/env bash
# JETPOOL single-server control script. Everything you need on one Ubuntu box.
#
#   ./infra/single-server/jetpool.sh init --domain example.com --email you@example.com
#   ./infra/single-server/jetpool.sh init --ip 203.0.113.10        # no domain yet, plain HTTP
#   ./infra/single-server/jetpool.sh deploy                        # build images, migrate, start, smoke
#   ./infra/single-server/jetpool.sh seed                           # demo content + demo logins
#   ./infra/single-server/jetpool.sh logins                         # print the generated logins
#   ./infra/single-server/jetpool.sh ps | logs [svc] | smoke | backup | update | down
#
# `init` is safe to re-run: it rewrites the public addresses and never regenerates a secret that already
# has a value (rotating JWT_SECRET signs everyone out; rotating DATA_ENCRYPTION_KEY orphans encrypted data).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="$HERE/.env"
COMPOSE_FILE="$HERE/docker-compose.prod.yml"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
log()  { printf '\033[1m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[33m!  %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

dc() {
  [[ -f "$ENV_FILE" ]] || die "no $ENV_FILE — run: $0 init --domain <your-domain> --email <you@example.com>"
  docker compose --project-directory "$HERE" -f "$COMPOSE_FILE" --env-file "$ENV_FILE" "$@"
}

# ------------------------------------------------------------------ env file helpers
get_env() { awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,""); print; exit}' "$ENV_FILE"; }

set_env() { # <key> <value> — replaces the first assignment, appends when absent
  local tmp; tmp="$(mktemp)"
  K="$1" V="$2" awk -F= '
    BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; done = 0 }
    $1 == k && !done { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }' "$ENV_FILE" > "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

rand_hex() { openssl rand -hex "${1:-32}"; }
rand_pw() { # >=10 chars with letters, a digit and a symbol (the API's own password policy)
  printf 'Jp%s!7' "$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | cut -c1-12)"
}

# Fill a key only when it is still AUTO_GENERATE or empty.
fill() { # <key> <generator...>
  local k="$1"; shift
  local cur; cur="$(get_env "$k" || true)"
  if [[ -z "$cur" || "$cur" == "AUTO_GENERATE" ]]; then
    set_env "$k" "$("$@")"
    echo "  generated $k"
  else
    echo "  kept      $k (already set)"
  fi
}

# ------------------------------------------------------------------ init
cmd_init() {
  local mode="" domain="" email="" ip=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --domain) mode=domain; domain="${2:?--domain needs a value}"; shift 2 ;;
      --email)  email="${2:?--email needs a value}"; shift 2 ;;
      --ip)     mode=ip; ip="${2:?--ip needs a value}"; shift 2 ;;
      *) die "unknown flag $1" ;;
    esac
  done
  [[ -n "$mode" ]] || die "pass --domain <example.com> --email <you@example.com>, or --ip <public-ip>"
  command -v openssl >/dev/null || die "openssl is required (apt-get install -y openssl)"

  if [[ ! -f "$ENV_FILE" ]]; then
    cp "$HERE/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    log "created $ENV_FILE from .env.example"
  else
    log "updating existing $ENV_FILE"
  fi

  if [[ "$mode" == domain ]]; then
    [[ -n "$email" ]] || die "--email is required in domain mode (Let's Encrypt expiry notices)"
    [[ "$domain" == *.* ]] || die "'$domain' does not look like a domain"
    [[ "$domain" == http* ]] && die "pass the bare domain, not a URL"
    set_env DEPLOY_MODE domain
    set_env CADDYFILE Caddyfile
    set_env ROOT_DOMAIN "$domain"
    set_env ACME_EMAIL "$email"
    set_env PUBLIC_WEB_URL "https://$domain"
    set_env PUBLIC_API_URL "https://api.$domain"
    set_env NEXT_PUBLIC_API_URL "https://api.$domain"
    set_env CORS_ORIGINS "https://$domain,https://www.$domain"
    set_env S3_ENDPOINT "https://s3.$domain"
    set_env CDN_BASE_URL "https://s3.$domain/jetpool-public"
    set_env API_BIND 127.0.0.1
    set_env MINIO_BIND 127.0.0.1
    log "domain mode: https://$domain · https://api.$domain · https://s3.$domain"
    warn "A records for $domain, www.$domain, api.$domain and s3.$domain must already point at this server,"
    warn "and TCP 80 + 443 must be open, or Caddy cannot get certificates."
  else
    [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "'$ip' is not an IPv4 address"
    set_env DEPLOY_MODE ip
    set_env CADDYFILE Caddyfile.ip
    set_env ROOT_DOMAIN "$ip"
    set_env PUBLIC_WEB_URL "http://$ip"
    set_env PUBLIC_API_URL "http://$ip:4000"
    set_env NEXT_PUBLIC_API_URL "http://$ip:4000"
    set_env CORS_ORIGINS "http://$ip"
    set_env S3_ENDPOINT "http://$ip:9000"
    set_env CDN_BASE_URL "http://$ip:9000/jetpool-public"
    set_env API_BIND 0.0.0.0
    set_env MINIO_BIND 0.0.0.0
    log "IP mode: http://$ip (api :4000, media :9000) — no TLS"
    warn "No TLS in IP mode: passwords and sessions travel in the clear. Use it only to smoke-test,"
    warn "then re-run 'init --domain ... --email ...' and 'deploy' before any real user signs in."
  fi

  log "secrets"
  fill POSTGRES_PASSWORD    rand_hex 16
  fill JWT_SECRET           rand_hex 32
  fill DATA_ENCRYPTION_KEY  rand_hex 32   # must stay exactly 64 hex chars
  fill GEO_FUZZ_SECRET      rand_hex 32
  fill MEILI_MASTER_KEY     rand_hex 24
  fill MINIO_ROOT_PASSWORD  rand_hex 16
  fill SEED_PASSWORD        rand_pw
  fill SEED_ADMIN_PASSWORD  rand_pw

  echo
  bold "Ready. Next:  $0 deploy"
  echo "  $ENV_FILE holds every secret for this platform, it is gitignored — back it up somewhere safe."
}

# ------------------------------------------------------------------ preflight
cmd_check() {
  [[ -f "$ENV_FILE" ]] || die "no $ENV_FILE — run '$0 init' first"
  command -v docker >/dev/null || die "docker is not installed — run infra/single-server/bootstrap.sh"
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing — run bootstrap.sh"
  docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon (sudo systemctl start docker, or re-login after bootstrap)"
  local missing=()
  local k
  for k in POSTGRES_PASSWORD JWT_SECRET DATA_ENCRYPTION_KEY GEO_FUZZ_SECRET MEILI_MASTER_KEY MINIO_ROOT_PASSWORD; do
    [[ "$(get_env "$k")" == "AUTO_GENERATE" || -z "$(get_env "$k")" ]] && missing+=("$k")
  done
  [[ ${#missing[@]} -eq 0 ]] || die "still unset in $ENV_FILE: ${missing[*]} — re-run '$0 init'"
  [[ "$(get_env DATA_ENCRYPTION_KEY)" =~ ^[0-9a-f]{64}$ ]] || die "DATA_ENCRYPTION_KEY must be 64 hex chars"
  if [[ "$(get_env NODE_ENV)" == "production" ]]; then
    [[ "$(get_env PAYMENT_PROVIDER)" == "TOSS" ]] || die "NODE_ENV=production forbids PAYMENT_PROVIDER=MOCK"
    [[ "$(get_env OAUTH_MOCK)" == "false" ]] || die "NODE_ENV=production forbids OAUTH_MOCK=true"
  fi
  dc config --quiet
  echo "  ok   $ENV_FILE and the compose file are consistent"
  local free_gb; free_gb="$(df -BG --output=avail "$ROOT" 2>/dev/null | tail -1 | tr -dc '0-9' || echo 99)"
  [[ "${free_gb:-99}" -ge 12 ]] || warn "only ${free_gb}GB free on this filesystem; the two image builds want ~10GB"
}

# ------------------------------------------------------------------ build / run
cmd_build() {
  cmd_check
  log "building jetpool-api and jetpool-web (first build on 2 vCPU takes 10–25 minutes)"
  GIT_SHA="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo unknown)" \
    dc build --pull migrate web
}

wait_ready() {
  log "waiting for the API to report ready"
  local i
  for i in $(seq 1 90); do
    if curl -fsS --max-time 5 http://127.0.0.1:4000/ready 2>/dev/null | grep -q '"status":"ready"'; then
      echo "  ok   api /ready"
      return 0
    fi
    sleep 5
  done
  dc ps
  dc logs --tail 60 api migrate
  die "the API never became ready — the logs above usually name the reason (bad env var, migration, DB)"
}

cmd_up() {
  cmd_check
  log "starting the stack (migrations run first, then api/worker/web/caddy)"
  dc up -d --remove-orphans
  wait_ready
  cmd_smoke
}

cmd_deploy() { cmd_build; cmd_up; }

cmd_update() { # pull the branch and redeploy
  log "git pull"
  git -C "$ROOT" pull --ff-only
  cmd_deploy
}

cmd_migrate() { cmd_check; dc run --rm migrate; }

cmd_seed() {
  cmd_check
  [[ "$(get_env NODE_ENV)" != "production" ]] || die "the demo seed refuses to run with NODE_ENV=production"
  log "seeding demo content (idempotent — safe to re-run)"
  dc run --rm seed
  cmd_logins
}

cmd_logins() {
  [[ -f "$ENV_FILE" ]] || die "no $ENV_FILE"
  local web; web="$(get_env PUBLIC_WEB_URL)"
  echo
  bold "Demo logins (created by '$0 seed')"
  echo "  member sign-in   $web/login"
  echo "    the seed prints every persona e-mail in its own output; the password for all of them is:"
  echo "    $(get_env SEED_PASSWORD)"
  echo "  admin console    $web/admin/login"
  echo "    handle    $(get_env SEED_ADMIN_USERNAME)"
  echo "    password  $(get_env SEED_ADMIN_PASSWORD)"
  echo
  echo "  Staff routes need an AAL2 session — enroll an authenticator app on the first admin sign-in."
  echo "  The main page is edited in Admin → Content → Main page (/admin/home)."
}

cmd_smoke() {
  cmd_check
  local root; root="$(get_env ROOT_DOMAIN)"
  log "smoke test against the containers (127.0.0.1)"
  SMOKE_RETRIES=12 SMOKE_INTERVAL=5 bash "$ROOT/infra/scripts/smoke.sh" "http://127.0.0.1:4000" || true
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -H "Host: $root" http://127.0.0.1/ || true)"
  [[ "$code" == "200" ]] && echo "  ok   web through caddy ($code)" || warn "web through caddy returned ${code:-none}"
  if [[ "$(get_env DEPLOY_MODE)" == "domain" ]]; then
    log "smoke test from the public internet (https://$root)"
    for url in "https://$root/" "https://api.$root/health"; do
      code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url" || true)"
      if [[ "$code" == "200" ]]; then
        echo "  ok   $url"
      else
        warn "$url returned ${code:-none} — DNS may still be propagating, or 80/443 is closed in the"
        warn "     security group. 'logs caddy' shows the certificate attempts."
      fi
    done
  fi
}

cmd_backup() {
  cmd_check
  mkdir -p "$HERE/backups"
  local out="$HERE/backups/jetpool-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  log "pg_dump → $out"
  dc exec -T postgres pg_dump -U jetpool --format=plain jetpool | gzip -9 > "$out"
  ls -lh "$out"
  echo "  Media lives in the 'miniodata' docker volume — back that up too (see the runbook)."
}

case "${1:-help}" in
  init)    shift; cmd_init "$@" ;;
  check)   cmd_check ;;
  build)   cmd_build ;;
  up)      cmd_up ;;
  deploy)  cmd_deploy ;;
  update)  cmd_update ;;
  migrate) cmd_migrate ;;
  seed)    cmd_seed ;;
  logins)  cmd_logins ;;
  smoke)   cmd_smoke ;;
  backup)  cmd_backup ;;
  ps)      dc ps ;;
  logs)    shift; dc logs -f --tail 200 "$@" ;;
  restart) shift; dc restart "$@" ;;
  stop)    dc stop ;;
  down)    dc down ;;
  psql)    dc exec postgres psql -U jetpool jetpool ;;
  prune)   docker image prune -f && docker builder prune -f ;;
  help|-h|--help)
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" ;;
  *) die "unknown command '$1' — try '$0 help'" ;;
esac
