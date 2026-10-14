#!/usr/bin/env bash
# JETPOOL single-server control script. Everything you need on one Ubuntu box.
#
#   ./infra/single-server/jetpool.sh init --domain example.com --email you@example.com
#   ./infra/single-server/jetpool.sh init --ip 203.0.113.10        # no domain yet, plain HTTP
#   ./infra/single-server/jetpool.sh deploy                        # build images, migrate, start, smoke
#   ./infra/single-server/jetpool.sh seed                           # demo content + demo logins
#   ./infra/single-server/jetpool.sh logins                         # print the generated logins
#   ./infra/single-server/jetpool.sh doctor                          # why isn't it opening? run this
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
get_env() { [[ -f "$ENV_FILE" ]] || return 0; awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,""); print; exit}' "$ENV_FILE"; }

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
  docker info >/dev/null 2>&1 || die "cannot talk to the docker daemon — try again with sudo, run 'sudo systemctl start docker', or log out and back in once after bootstrap (docker group)"
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

# ------------------------------------------------------------------ doctor
# Answers "it's deployed but nothing opens from the internet" without guessing. Every check is
# independent and none of them die, so this runs before init, before deploy, and on a half-set-up box.
# The verdict at the end names the first thing that is actually wrong and what to do about it.
cmd_doctor() {
  local fail=() warnings=()
  local okmark='  \033[32mok\033[0m  '
  ok()   { printf "$okmark%s\n" "$*"; }
  bad()  { printf '  \033[31mBAD\033[0m %s\n' "$*"; fail+=("$*"); }
  note() { printf '  \033[33m??\033[0m  %s\n' "$*"; warnings+=("$*"); }
  info() { printf '      %s\n' "$*"; }

  # dig is not on a minimal Ubuntu; getent uses the same resolver and is always there.
  resolve() { # <name> -> one address per line
    if command -v dig >/dev/null 2>&1; then dig +short +time=3 +tries=1 "$1" A 2>/dev/null | grep -E '^[0-9.]+$'
    else getent ahostsv4 "$1" 2>/dev/null | awk '{print $1}' | sort -u; fi
  }

  bold "1. repository checkout"
  local branch sha
  branch="$(git -C "$ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
  sha="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
  info "branch $branch @ $sha  ($ROOT)"
  if [[ -f "$COMPOSE_FILE" ]]; then
    ok "infra/single-server/ is present"
  else
    bad "infra/single-server/docker-compose.prod.yml is missing — this checkout does not have the deployment files"
    info "the single-server setup lives on branch claude/youthful-darwin-fueqrx (PR #18, not merged yet):"
    info "  git fetch origin claude/youthful-darwin-fueqrx && git checkout claude/youthful-darwin-fueqrx"
  fi

  bold "2. docker"
  if command -v docker >/dev/null 2>&1; then ok "docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)"
  else bad "docker is not installed — run: sudo bash infra/single-server/bootstrap.sh"; fi
  if docker compose version >/dev/null 2>&1; then ok "compose plugin present"
  else bad "the docker compose plugin is missing — run bootstrap.sh"; fi
  if docker info >/dev/null 2>&1; then ok "docker daemon reachable"
  else bad "cannot talk to the docker daemon — re-run this with sudo, or log out and back in once after bootstrap (docker group)"; fi

  bold "3. configuration"
  local mode root_domain
  if [[ -f "$ENV_FILE" ]]; then
    mode="$(get_env DEPLOY_MODE)"; root_domain="$(get_env ROOT_DOMAIN)"
    ok ".env present — DEPLOY_MODE=${mode:-?} ROOT_DOMAIN=${root_domain:-?}"
    info "web $(get_env PUBLIC_WEB_URL)  ·  api $(get_env PUBLIC_API_URL)"
    if [[ "$mode" == "ip" ]]; then
      note "this box is configured for IP mode: there is NO TLS and no vhost for a domain, so https://<domain> cannot work"
      info "after the DNS records exist, switch over with:"
      info "  ./infra/single-server/jetpool.sh init --domain <도메인> --email <메일> && ./infra/single-server/jetpool.sh deploy"
    fi
  else
    bad "no $ENV_FILE — nothing has been configured yet; run 'jetpool.sh init --domain <도메인> --email <메일>'"
    mode=""; root_domain=""
  fi

  bold "4. containers"
  if docker info >/dev/null 2>&1 && [[ -f "$ENV_FILE" && -f "$COMPOSE_FILE" ]]; then
    local ps_out
    ps_out="$(dc ps --format '{{.Service}}\t{{.State}}\t{{.Status}}' 2>/dev/null || true)"
    if [[ -z "$ps_out" ]]; then
      bad "no containers for this project are running — 'jetpool.sh deploy' has not completed"
    else
      printf '%s\n' "$ps_out" | sed 's/^/      /'
      local svc state
      while IFS=$'\t' read -r svc state _; do
        [[ -z "${svc:-}" ]] && continue
        case "$state" in
          running) ;;
          restarting) bad "service '$svc' is restarting in a loop — see 'jetpool.sh logs $svc'" ;;
          exited|dead) [[ "$svc" == "migrate" || "$svc" == "minio-init" || "$svc" == "seed" ]] \
            && ok "'$svc' is a one-shot job, exited is normal" \
            || bad "service '$svc' is not running ($state) — see 'jetpool.sh logs $svc'" ;;
          *) note "service '$svc' state: $state" ;;
        esac
      done <<< "$ps_out"
      grep -q $'\trunning' <<< "$ps_out" && ok "containers are up"
    fi
  else
    note "container check skipped (needs a reachable docker daemon, .env and the compose file)"
  fi

  bold "5. the app, from inside the server"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 http://127.0.0.1:4000/health 2>/dev/null || true)"
  [[ "$code" == "200" ]] && ok "api /health 200 on 127.0.0.1:4000" \
    || bad "api /health returned ${code:-no response} on 127.0.0.1:4000 — the API itself is not serving ('jetpool.sh logs api')"
  if [[ -n "${root_domain:-}" ]]; then
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 -H "Host: $root_domain" http://127.0.0.1/ 2>/dev/null || true)"
    [[ "$code" == "200" ]] && ok "web through caddy on port 80 (Host: $root_domain) → 200" \
      || bad "caddy on port 80 returned ${code:-no response} for Host $root_domain ('jetpool.sh logs caddy')"
  fi

  bold "6. who is listening on 80/443"
  if command -v ss >/dev/null 2>&1; then
    local listeners; listeners="$(ss -tlnH 2>/dev/null | awk '{print $4}' | grep -E ':(80|443)$' || true)"
    if [[ -n "$listeners" ]]; then
      printf '%s\n' "$listeners" | sed 's/^/      /'
      ok "something is bound to 80/443"
    else
      bad "nothing is listening on 80 or 443 — caddy is not up"
    fi
    for other in nginx apache2 httpd; do
      pgrep -x "$other" >/dev/null 2>&1 && bad "$other is running on this host and will hold 80/443 — stop it: sudo systemctl disable --now $other"
    done
  else
    note "port-listener check skipped (ss not available)"
  fi

  bold "7. host firewall (ufw)"
  if command -v ufw >/dev/null 2>&1; then
    local ufw_status; ufw_status="$(ufw status 2>/dev/null || echo 'need root')"
    if grep -qi 'inactive' <<< "$ufw_status"; then
      ok "ufw inactive (the cloud security group is then the only filter)"
    elif grep -qi 'need root\|ERROR' <<< "$ufw_status"; then
      note "could not read ufw status without root — re-run with sudo to include this check"
    else
      grep -qE '(^|[^0-9])80($|[^0-9])' <<< "$ufw_status" && ok "ufw allows 80" || bad "ufw does NOT allow 80 — sudo ufw allow 80/tcp"
      grep -qE '(^|[^0-9])443($|[^0-9])' <<< "$ufw_status" && ok "ufw allows 443" || bad "ufw does NOT allow 443 — sudo ufw allow 443/tcp"
    fi
  else
    ok "ufw not installed (nothing filtering on the host)"
  fi

  bold "8. addresses and DNS"
  local nic_ip public_ip
  nic_ip="$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | paste -sd, - || true)"
  info "this server's own NIC: ${nic_ip:-unknown}"
  case "${nic_ip:-}" in
    10.*|192.168.*|172.1[6-9].*|172.2*.*|172.3[01].*)
      info "that is a private address — normal behind a cloud NAT; the public IP is mapped to it, not configured here" ;;
  esac
  for svc in https://api.ipify.org https://checkip.amazonaws.com https://ifconfig.me/ip; do
    public_ip="$(curl -fsS --max-time 6 "$svc" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "$public_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] && break || public_ip=""
  done
  if [[ -n "$public_ip" ]]; then
    ok "this server's public IP, as the internet sees it: $public_ip"
  else
    note "could not determine the public IP from this server (no outbound HTTP?) — compare the DNS answers below against the IP in your cloud console by hand"
  fi

  if [[ -n "${root_domain:-}" && "${mode:-}" == "domain" ]]; then
    local name answers
    for name in "$root_domain" "www.$root_domain" "api.$root_domain" "s3.$root_domain"; do
      answers="$(resolve "$name" | paste -sd, - || true)"
      if [[ -z "$answers" ]]; then
        bad "$name does not resolve — the A record is missing (or DNS has not propagated yet)"
      elif [[ -n "$public_ip" && "$answers" == "$public_ip" ]]; then
        ok "$name → $answers"
      elif [[ -n "$public_ip" ]]; then
        bad "$name → $answers but this server is $public_ip — the A record points elsewhere (or a CDN/proxy such as Cloudflare sits in front; turn its proxy off until HTTPS works)"
      else
        info "$name → $answers (check this equals the public IP in your console)"
      fi
    done
    # Cloudflare's proxy terminates TLS itself and breaks Caddy's HTTP-01 issuance.
    local ns; ns="$(command -v dig >/dev/null 2>&1 && dig +short +time=3 NS "$root_domain" 2>/dev/null | tr 'A-Z' 'a-z' | paste -sd, - || true)"
    [[ "$ns" == *cloudflare* ]] && note "nameservers are Cloudflare ($ns): set every record to 'DNS only' (grey cloud) until HTTPS works, or issuance fails"
  elif [[ -n "${root_domain:-}" ]]; then
    note "DNS checks skipped — DEPLOY_MODE is '${mode:-unset}', so no domain is configured to check"
  fi

  bold "9. certificates"
  if ! docker info >/dev/null 2>&1 || [[ ! -f "$ENV_FILE" || ! -f "$COMPOSE_FILE" ]]; then
    note "certificate check skipped (needs a reachable docker daemon, .env and the compose file)"
  else
    local caddy_log
    caddy_log="$(dc logs --tail 400 caddy 2>/dev/null || true)"
    if [[ -z "$caddy_log" ]]; then
      note "no caddy logs yet"
    elif grep -qiE 'certificate obtained|obtained certificate|successfully' <<< "$caddy_log"; then
      ok "caddy reports a certificate was obtained"
    elif grep -qiE 'could not get certificate|obtain certificate|acme|challenge failed|timeout|connection refused' <<< "$caddy_log"; then
      bad "caddy is failing to get a certificate — the ACME errors below almost always mean port 80 is not reachable from the internet"
      grep -iE 'error|challenge|acme|obtain' <<< "$caddy_log" | tail -8 | sed 's/^/      /'
    else
      note "caddy has not logged a certificate result yet"
    fi
  fi

  bold "10. resources"
  info "disk:   $(df -h "$ROOT" 2>/dev/null | tail -1 | awk '{print $4" free of "$2}')"
  info "memory: $(free -h 2>/dev/null | awk '/^Mem:/{print $7" available of "$2}')"
  info "swap:   $(free -h 2>/dev/null | awk '/^Swap:/{print $2" total"}')"
  local avail; avail="$(df -BG --output=avail "$ROOT" 2>/dev/null | tail -1 | tr -dc '0-9' || true)"
  [[ -n "$avail" && "$avail" -lt 3 ]] && bad "only ${avail}GB disk free — builds and containers fail at this point ('jetpool.sh prune')"

  echo
  if [[ ${#fail[@]} -eq 0 ]]; then
    bold "Verdict"
    if [[ "${mode:-}" == "domain" ]]; then
      echo "  Everything checkable from inside the server is healthy, and DNS points here."
      echo "  If the site still does not open from outside, what is left is OUTSIDE this server:"
      echo "    the cloud security group must allow inbound TCP 80 and 443 from 0.0.0.0/0."
      echo "  Test from your own PC (not from the server):"
      echo "    curl -I http://${root_domain:-<도메인>}"
      echo "    curl -I https://${root_domain:-<도메인>}"
      echo "  A hang or 'connection timed out' = the security group. 'connection refused' = nothing listening."
    else
      echo "  The stack is healthy but this box is not configured for a domain (DEPLOY_MODE=${mode:-unset})."
      echo "  Run: ./infra/single-server/jetpool.sh init --domain <도메인> --email <메일> && ./infra/single-server/jetpool.sh deploy"
    fi
  else
    bold "Verdict — fix these, first one first"
    local i=1 f
    for f in "${fail[@]}"; do printf '  %d. %s\n' "$i" "$f"; i=$((i + 1)); done
  fi
  if [[ ${#warnings[@]} -gt 0 ]]; then
    echo
    bold "Worth knowing"
    for f in "${warnings[@]}"; do printf '  - %s\n' "$f"; done
  fi
  echo
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

# bootstrap.sh puts the login user in the docker group, but group membership only applies to NEW logins,
# so the very first deploy after bootstrap would fail on a permission error. Re-exec through sudo when that
# is what is happening and sudo needs no password; otherwise fall through to the explicit message in check().
ensure_docker_access() {
  [[ "${JETPOOL_SUDO_REEXEC:-}" == "1" ]] && return 0
  [[ "$(id -u)" -eq 0 ]] && return 0
  docker info >/dev/null 2>&1 && return 0
  command -v sudo >/dev/null 2>&1 || return 0
  sudo -n true 2>/dev/null || return 0
  sudo -n docker info >/dev/null 2>&1 || return 0
  log "docker needs root until your next login (docker group) — re-running through sudo"
  exec sudo -E JETPOOL_SUDO_REEXEC=1 "$0" "$@"
}

case "${1:-help}" in
  init)    shift; cmd_init "$@" ;;
  check)   ensure_docker_access "$@"; cmd_check ;;
  build)   ensure_docker_access "$@"; cmd_build ;;
  up)      ensure_docker_access "$@"; cmd_up ;;
  deploy)  ensure_docker_access "$@"; cmd_deploy ;;
  update)  ensure_docker_access "$@"; cmd_update ;;
  migrate) ensure_docker_access "$@"; cmd_migrate ;;
  seed)    ensure_docker_access "$@"; cmd_seed ;;
  logins)  cmd_logins ;;
  smoke)   ensure_docker_access "$@"; cmd_smoke ;;
  doctor)  ensure_docker_access "$@"; cmd_doctor ;;
  backup)  ensure_docker_access "$@"; cmd_backup ;;
  ps)      ensure_docker_access "$@"; dc ps ;;
  logs)    ensure_docker_access "$@"; shift; dc logs -f --tail 200 "$@" ;;
  restart) ensure_docker_access "$@"; shift; dc restart "$@" ;;
  stop)    ensure_docker_access "$@"; dc stop ;;
  down)    ensure_docker_access "$@"; dc down ;;
  psql)    ensure_docker_access "$@"; dc exec postgres psql -U jetpool jetpool ;;
  prune)   ensure_docker_access "$@"; docker image prune -f && docker builder prune -f ;;
  help|-h|--help)
    awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "${BASH_SOURCE[0]}" ;;
  *) die "unknown command '$1' — try '$0 help'" ;;
esac
