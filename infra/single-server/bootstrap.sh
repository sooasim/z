#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu 22.04 server for JETPOOL. Run as root:
#
#   sudo bash infra/single-server/bootstrap.sh
#
# Installs Docker Engine + the compose plugin from Docker's own apt repository, puts the clock on UTC,
# adds swap (the Next.js build is the memory peak on an 8 GB box), opens 22/80/443 in the host firewall
# and puts the login user in the docker group. Re-running it is harmless.
#
# This only configures the HOST firewall. The cloud console's security group is separate and must allow
# inbound TCP 22, 80 and 443 as well, or nothing reaches the server.
set -euo pipefail

[[ "$(id -u)" -eq 0 ]] || { echo "run as root: sudo bash $0" >&2; exit 1; }
log() { printf '\033[1m▶ %s\033[0m\n' "$*"; }

TARGET_USER="${SUDO_USER:-${JETPOOL_USER:-}}"

log "clock → UTC (the app builds period boundaries from toISOString())"
timedatectl set-timezone UTC || true

log "base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git openssl ufw jq

if ! command -v docker >/dev/null 2>&1; then
  log "Docker Engine from download.docker.com"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  log "Docker already installed: $(docker --version)"
fi
systemctl enable --now docker

# Cap the journal and container logs so 50 GB of disk cannot be eaten by logs alone.
log "log rotation"
mkdir -p /etc/docker
if [[ ! -f /etc/docker/daemon.json ]]; then
  cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}
JSON
  systemctl restart docker
fi
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=500M\n' > /etc/systemd/journald.conf.d/jetpool.conf
systemctl restart systemd-journald || true

if [[ "$(swapon --show --noheadings | wc -l)" -eq 0 ]]; then
  log "4 GB swap file (headroom for the web image build)"
  fallocate -l 4G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=4096
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q -w vm.swappiness=10
  grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
else
  log "swap already present"
fi

# SSH first, always — enabling ufw without it would lock this session out.
log "host firewall (ufw): 22, 80, 443"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
ufw status verbose | sed 's/^/  /'

if [[ -n "$TARGET_USER" ]] && id "$TARGET_USER" >/dev/null 2>&1; then
  log "adding $TARGET_USER to the docker group"
  usermod -aG docker "$TARGET_USER"
  echo "  log out and back in (or run 'newgrp docker') before using docker without sudo"
fi

echo
printf '\033[1mHost is ready.\033[0m\n'
cat <<'NEXT'

Still to do in the cloud console (the host firewall above is not the security group):
  1. Attach a public IP to this server.
  2. Allow inbound TCP 22 (SSH), 80 (HTTP) and 443 (HTTPS) in its security group.
     Caddy can get a certificate over 443 alone (TLS-ALPN-01), but with 80 closed
     http://<domain> answers nothing, so anyone typing the bare domain sees a dead site.

Then, in the repository checkout:
  ./infra/single-server/jetpool.sh init --domain <your-domain> --email <you@example.com>
  ./infra/single-server/jetpool.sh deploy
NEXT
