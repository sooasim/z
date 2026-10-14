#!/usr/bin/env bash
# JETPOOL — bare Ubuntu 22.04 server to a running platform, in one command.
#
#   sudo bash infra/single-server/install.sh --domain example.com --email you@example.com
#   sudo bash infra/single-server/install.sh --ip 203.0.113.10     # no domain yet: plain HTTP, no TLS
#   sudo bash infra/single-server/install.sh --domain example.com --email you@example.com --seed
#
# Runs bootstrap (Docker, swap, firewall, UTC) → init (secrets + public addresses) → deploy
# (build, migrate, start, smoke), and optionally the demo seed. Everything it calls is idempotent, so
# re-running after a failure or a dropped SSH session is safe and picks up the cached build layers.
#
# The build takes 10–25 minutes on 2 vCPU. Run it under tmux/screen, or accept that a dropped
# connection means re-running this script.
#
# Options:
#   --domain <d> --email <e>   serve https://d, https://api.d, https://s3.d with Let's Encrypt certs
#   --ip <addr>                serve http://addr only (first smoke test; no TLS)
#   --seed                     also load the demo catalogue and print its logins
#   --storage local|minio      media storage. local (default) keeps media on a disk volume served by
#                              the API — no object-storage service and no third-party image. minio
#                              starts MinIO and needs an image you have confirmed you can pull.
#   --skip-dns-check           deploy in domain mode even if the DNS preflight objects
#   --dir <path>               where the checkout is / should be (default: the repo this script is in)
#   --branch <name>            branch to clone when --dir has no checkout (default: the branch below,
#                              which carries this setup; pass the default branch once PR #18 is merged)
set -euo pipefail

REPO_URL="${JETPOOL_REPO_URL:-https://github.com/sooasim/z.git}"
BRANCH="claude/youthful-darwin-fueqrx"
DIR=""
SEED=0
SKIP_DNS_CHECK=0
MODE_ARGS=()

log()  { printf '\n\033[1m=== %s\033[0m\n' "$*"; }
die()  { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) MODE_ARGS+=(--domain "${2:?--domain needs a value}"); shift 2 ;;
    --email)  MODE_ARGS+=(--email "${2:?--email needs a value}"); shift 2 ;;
    --ip)     MODE_ARGS+=(--ip "${2:?--ip needs a value}"); shift 2 ;;
    --seed)   SEED=1; shift ;;
    --storage) MODE_ARGS+=(--storage "${2:?--storage needs local or minio}"); shift 2 ;;
    --skip-dns-check) SKIP_DNS_CHECK=1; shift ;;
    --dir)    DIR="${2:?--dir needs a value}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch needs a value}"; shift 2 ;;
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
done

[[ ${#MODE_ARGS[@]} -gt 0 ]] || die "pass --domain <도메인> --email <메일>, or --ip <공인-IP>. See --help."
[[ "$(id -u)" -eq 0 ]] || die "this installs system packages — re-run it with sudo"

# Where this script already lives, when it was run from a checkout.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "$DIR" ]]; then
  if [[ -f "$HERE/jetpool.sh" && -f "$HERE/../../package.json" ]]; then
    DIR="$(cd "$HERE/../.." && pwd)"
  else
    if [[ -n "${SUDO_USER:-}" ]]; then
      DIR="$(getent passwd "$SUDO_USER" | cut -d: -f6)/jetpool"
    else
      DIR=/opt/jetpool
    fi
  fi
fi

log "0/4  checkout → $DIR  (branch $BRANCH)"
command -v git >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y -qq git; }
if [[ -d "$DIR/.git" ]]; then
  echo "already a checkout; leaving it as it is (use 'jetpool.sh update' to pull)"
else
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$DIR"
  [[ -n "${SUDO_USER:-}" ]] && chown -R "$SUDO_USER":"$SUDO_USER" "$DIR"
fi
[[ -f "$DIR/infra/single-server/jetpool.sh" ]] || die "$DIR has no infra/single-server — wrong branch? (--branch)"
cd "$DIR"

# A domain whose A record is missing or private cannot pass Let's Encrypt's HTTP-01 challenge, and
# every failed attempt counts against that domain's issuance rate limit. Catch it before deploying.
# Only the unambiguous cases refuse: a mismatch against our EGRESS address is reported but allowed,
# because behind some NAT setups the address we go out on is not the one traffic comes in on.
preflight_dns() {
  local domain="" i=0
  for ((i = 0; i < ${#MODE_ARGS[@]}; i++)); do
    [[ "${MODE_ARGS[i]}" == "--domain" ]] && domain="${MODE_ARGS[i + 1]}"
  done
  [[ -n "$domain" ]] || return 0

  is_private() {
    case "$1" in
      10.*|127.*|169.254.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0 ;;
      100.6[4-9].*|100.[7-9][0-9].*|100.1[0-1][0-9].*|100.12[0-7].*) return 0 ;;
    esac
    return 1
  }
  resolve1() { getent ahostsv4 "$1" 2>/dev/null | awk '{print $1; exit}' || true; }

  local egress="" svc
  for svc in https://api.ipify.org https://checkip.amazonaws.com; do
    egress="$(curl -fsS --max-time 6 "$svc" 2>/dev/null | tr -d '[:space:]' || true)"
    [[ "$egress" =~ ^[0-9.]+$ ]] && break || egress=""
  done

  # s3.<domain> is only used when object storage is enabled; the default deploy has none.
  local names=("$domain" "api.$domain")
  [[ " ${MODE_ARGS[*]} " == *" --storage minio "* ]] && names+=("s3.$domain")
  local name addr bad=0
  for name in "${names[@]}"; do
    addr="$(resolve1 "$name")"
    if [[ -z "$addr" ]]; then
      echo "  $name does not resolve" >&2
      bad=1
    elif is_private "$addr"; then
      echo "  $name → $addr is a PRIVATE address the internet cannot route" >&2
      bad=1
    elif [[ -n "$egress" && "$addr" != "$egress" ]]; then
      echo "  $name → $addr (this server goes out as $egress — fine if inbound differs, but worth checking)"
    else
      echo "  $name → $addr"
    fi
  done

  if [[ "$bad" -eq 1 ]]; then
    cat >&2 <<EOF

Refusing to deploy in domain mode: the DNS above cannot work.
Let's Encrypt validates over HTTP to the address in the A record, so a missing or private
record makes issuance fail, and repeated failures hit that domain's rate limit.

Point these A records at this server's PUBLIC IP and wait for them to propagate:
  ${names[*]}, www.$domain

To smoke-test without a domain in the meantime:
  sudo bash $0 --ip <public-ip>
Or, if you know the DNS is right and this check is wrong, re-run with --skip-dns-check.
EOF
    exit 1
  fi
}

if [[ "$SKIP_DNS_CHECK" -eq 0 ]]; then
  log "0.5/4  DNS preflight"
  preflight_dns
fi

log "1/4  bootstrap — docker, swap, firewall, UTC clock"
bash infra/single-server/bootstrap.sh

log "2/4  init — secrets and public addresses"
bash infra/single-server/jetpool.sh init "${MODE_ARGS[@]}"

log "3/4  deploy — build, migrate, start, smoke  (10–25 min on 2 vCPU)"
bash infra/single-server/jetpool.sh deploy

if [[ "$SEED" -eq 1 ]]; then
  log "4/4  seed — demo catalogue and logins"
  bash infra/single-server/jetpool.sh seed
else
  log "4/4  seed — skipped (pass --seed, or run: ./infra/single-server/jetpool.sh seed)"
fi

# The operator should own the checkout and its .env afterwards, not root.
if [[ -n "${SUDO_USER:-}" ]]; then
  chown -R "$SUDO_USER":"$SUDO_USER" "$DIR" 2>/dev/null || true
  chmod 600 "$DIR/infra/single-server/.env" 2>/dev/null || true
fi

log "done"
cat <<NEXT
  Status / diagnosis:  ./infra/single-server/jetpool.sh ps
                       ./infra/single-server/jetpool.sh doctor
  Logins (after seed): ./infra/single-server/jetpool.sh logins

  infra/single-server/.env holds every secret for this deployment and is gitignored.
  Back it up somewhere off this server.
NEXT
