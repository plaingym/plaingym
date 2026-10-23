#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
umask 077
SOURCE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=deploy/lib.sh
. "$SOURCE/lib.sh"
hostname=
image=
email=
local_image=false
image_archive=
ROOT=/opt/plaingym
while [ "$#" -gt 0 ]; do
  case "$1" in
    --hostname|--image|--email|--directory|--image-archive)
      [ "$#" -ge 2 ] || fail "Missing value for $1"
      case "$1" in
        --hostname) hostname=$2 ;; --image) image=$2 ;;
        --email) email=$2 ;; --directory) ROOT=$2 ;;
        --image-archive) image_archive=$2; local_image=true ;;
      esac
      shift 2 ;;
    --local-image) local_image=true; shift ;;
    *) fail 'Usage: install.sh --hostname DNS_NAME --email EMAIL --image IMAGE [--local-image | --image-archive FILE] [--directory /opt/plaingym]' ;;
  esac
done
[ "$(id -u)" -eq 0 ] || fail 'Run install.sh as root.'
if [ -z "$hostname" ] || [ "${#hostname}" -gt 253 ]; then fail 'A DNS hostname is required.'; fi
printf '%s\n' "$hostname" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$' || fail 'Use a lowercase public DNS hostname, without a URL or port.'
printf '%s\n' "$email" | grep -Eq '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$' || fail 'An ACME contact email is required.'
valid_image "$image" || fail 'Use an explicit semver image tag or sha256 digest.'
case "$ROOT" in /*) ;; *) fail 'Installation directory must be absolute.' ;; esac
[ -z "$image_archive" ] || [ -f "$image_archive" ] || fail 'The image archive does not exist.'
# shellcheck source=/dev/null
. /etc/os-release
[ "$ID" = ubuntu ] || fail 'The installer supports Ubuntu.'
case "$VERSION_ID" in 24.04|26.04) ;; *) fail 'Use Ubuntu 24.04 or 26.04 LTS.' ;; esac
case "$(dpkg --print-architecture)" in amd64|arm64) ;; *) fail 'Use amd64 or arm64.' ;; esac
# Re-running the same install converges and keeps its secrets. A different
# hostname, email or image is another server or an update, never a reinstall.
existing=false
if [ -e "$ROOT/.env" ]; then
  existing=true
  [ "$(read_env GYM_HOSTNAME)" = "$hostname" ] || fail "This server is installed for $(read_env GYM_HOSTNAME). Nothing was changed."
  [ "$(read_env ACME_EMAIL)" = "$email" ] || fail 'This installation uses a different ACME email. Nothing was changed.'
  [ "$(read_env APP_IMAGE)" = "$image" ] || fail "This installation runs $(read_env APP_IMAGE); use update.sh to change the image. Nothing was changed."
fi
check_dns "$hostname"

sh "$SOURCE/host.sh"
# A re-run keeps the loaded image even if a newer bundle reuses its tag;
# changing the running image is update.sh's job.
if [ -n "$image_archive" ] && { [ "$existing" = false ] || ! docker image inspect "$image" >/dev/null 2>&1; }; then
  docker load -i "$image_archive" >/dev/null
fi
if [ "$local_image" = true ]; then
  docker image inspect "$image" >/dev/null 2>&1 || fail "The local image $image is not loaded."
fi

if [ "$existing" = false ]; then
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
    printf 'SETUP_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'BACKUP_RECIPIENT=\n'
  } > "$ROOT/.env"
  chmod 0600 "$ROOT/.env"
  # Caddy/Postgres still pull normally. --local-image is for a maintainer-loaded build.
  if [ "$local_image" = true ]; then
    compose pull postgres caddy
  else
    compose pull
  fi
fi
compose up -d --pull missing --wait --wait-timeout 180
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
# First-boot setup endpoints close (404) once the gym is set up.
if [ "$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "https://$hostname/api/setup" || true)" = 404 ]; then
  printf 'Setup is complete. Sign in at https://%s/login\n' "$hostname"
else
  printf 'Private setup link (keep it secret):\n'
  compose exec -T app gym-app setup-link
fi
