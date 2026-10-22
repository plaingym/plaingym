#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
umask 077
SOURCE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$SOURCE/lib.sh"
hostname=
image=
email=
local_image=false
ROOT=/opt/plaingym
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hostname|--image|--email|--directory)
      [ "$#" -ge 2 ] || fail "Missing value for $1"
      case "$1" in
        --hostname) hostname=$2 ;; --image) image=$2 ;;
        --email) email=$2 ;; --directory) ROOT=$2 ;;
      esac
      shift 2 ;;
    --local-image) local_image=true; shift ;;
    *) fail 'Usage: install.sh --hostname DNS_NAME --email EMAIL --image IMAGE [--local-image] [--directory /opt/plaingym]' ;;
  esac
done
[ "$(id -u)" -eq 0 ] || fail 'Run install.sh as root.'
[ -n "$hostname" ] && [ "${#hostname}" -le 253 ] || fail 'A DNS hostname is required.'
printf '%s\n' "$hostname" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$' || fail 'Use a lowercase public DNS hostname, without a URL or port.'
printf '%s\n' "$email" | grep -Eq '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$' || fail 'An ACME contact email is required.'
valid_image "$image" || fail 'Use an explicit semver image tag or sha256 digest.'
case "$ROOT" in /*) ;; *) fail 'Installation directory must be absolute.' ;; esac
[ ! -e "$ROOT/.env" ] || fail 'Installation already exists. Use update.sh; secrets were preserved.'
# shellcheck source=/dev/null
. /etc/os-release
[ "$ID" = ubuntu ] || fail 'The installer supports Ubuntu.'
case "$VERSION_ID" in 24.04|26.04) ;; *) fail 'Use Ubuntu 24.04 or 26.04 LTS.' ;; esac
case "$(dpkg --print-architecture)" in amd64|arm64) ;; *) fail 'Use amd64 or arm64.' ;; esac

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl gnupg openssl ufw unattended-upgrades age
if ! docker compose version >/dev/null 2>&1; then
  install -d -m 0755 /etc/apt/keyrings
  curl --fail --silent --show-error --location --proto '=https' https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod 0644 /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu %s stable\n' "$(dpkg --print-architecture)" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades
systemctl enable --now unattended-upgrades
# Preserve the configured SSH listener, including a nonstandard port.
ssh_ports=$(/usr/sbin/sshd -T | awk '$1 == "port" {print $2}')
[ -n "$ssh_ports" ] || fail 'Could not determine SSH port; firewall was not enabled.'
for ssh_port in $ssh_ports; do ufw allow "$ssh_port/tcp"; done
ufw allow 80/tcp
ufw allow 443/tcp
ufw default deny incoming
ufw default allow outgoing
ufw --force enable
if ! swapon --noheadings --show | grep -q .; then
  [ ! -e /swapfile.plaingym ] || fail 'Existing /swapfile.plaingym is inactive; inspect it before retrying.'
  fallocate -l 1G /swapfile.plaingym
  chmod 0600 /swapfile.plaingym
  mkswap /swapfile.plaingym
  swapon /swapfile.plaingym
  printf '/swapfile.plaingym none swap sw 0 0\n' >> /etc/fstab
fi

install -d -m 0700 "$ROOT"
install -d -m 0755 "$ROOT/postgres"
for file in compose.yaml Caddyfile lib.sh; do install -m 0644 "$SOURCE/$file" "$ROOT/$file"; done
install -m 0644 "$SOURCE/postgres/01-roles.sh" "$ROOT/postgres/01-roles.sh"
install -m 0700 "$SOURCE/update.sh" "$ROOT/update.sh"
# Generate independent passwords; nothing is written to stdout.
{
  printf 'COMPOSE_PROJECT_NAME=plaingym\nAPP_IMAGE=%s\nGYM_HOSTNAME=%s\nACME_EMAIL=%s\nPOSTGRES_DB=plaingym\n' "$image" "$hostname" "$email"
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'APP_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'MAINTENANCE_PASSWORD=%s\n' "$(openssl rand -hex 32)"
  printf 'APP_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
  printf 'AUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
  printf 'BACKUP_RECIPIENT=\n'
} > "$ROOT/.env"
chmod 0600 "$ROOT/.env"
# Caddy/Postgres still pull normally. --local-image is for a maintainer-loaded build.
if [ "$local_image" = true ]; then
  docker image inspect "$image" >/dev/null
  compose pull postgres caddy
else
  compose pull
fi
compose up -d --pull never --wait --wait-timeout 180
compose exec -T app /app/deploy/database.sh migrate
compose exec -T app node /app/deploy/healthcheck.mjs
# A valid public certificate is part of success; never use curl -k.
attempt=0
until curl --fail --silent --show-error --connect-timeout 5 --max-time 10 "https://$hostname/healthz" >/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 24 ] || fail 'Containers are running, but HTTPS failed. Check DNS, ports 80/443, and Caddy logs.'
  sleep 5
done
printf 'PlainGym is running: https://%s/healthz\nInstallation: %s\n' "$hostname" "$ROOT"
