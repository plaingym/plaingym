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
# The update timer's unit names the directory, so keep it to plain path characters.
case "$ROOT" in *[!A-Za-z0-9/._-]*) fail 'Use an installation directory of letters, digits, and / . _ - only. Nothing was changed.' ;; esac
for unit in plaingym-update.service plaingym-update.timer; do [ -f "$SOURCE/systemd/$unit" ] || fail "The deployment files lack systemd/$unit."; done
[ -z "$image_archive" ] || [ -f "$image_archive" ] || fail 'The image archive does not exist.'
# A hostname proxied by Cloudflare (orange cloud) resolves to Cloudflare's published ranges: check_dns accepts those
# and sets dns_proxied, and the app then reads the visitor's address from CF-Connecting-IP on requests from them.
[ -f "$SOURCE/cloudflare-ranges.txt" ] || fail 'The deployment files lack cloudflare-ranges.txt. Nothing was changed.'
CLOUDFLARE_RANGES="$SOURCE/cloudflare-ranges.txt"
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
# A proxied re-run needs this install's own files to carry the Cloudflare support: the app reads TRUST_CLOUDFLARE
# only through compose.yaml, and the origin check needs the Caddyfile's handler. Host files don't update themselves.
if [ "$existing" = true ] && [ "$dns_proxied" = true ]; then
  grep -q TRUST_CLOUDFLARE "$ROOT/compose.yaml" && grep -q plaingym-origin "$ROOT/Caddyfile" ||
    fail "$hostname is behind Cloudflare's proxy, but this install's compose.yaml and Caddyfile predate support for it. Copy both from the current deployment files into $ROOT, then re-run. Nothing was changed."
fi
# add_env KEY VALUE: add a line to .env, rewriting it so a missing final newline can't merge two lines.
add_env() {
  awk -v line="$1=$2" '{ print } END { print line }' "$ROOT/.env" > "$ROOT/.env.next"
  chmod 0600 "$ROOT/.env.next"
  mv "$ROOT/.env.next" "$ROOT/.env"
}

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
  install -m 0700 "$SOURCE/rotate-key.sh" "$ROOT/rotate-key.sh"
  # Generate independent passwords; nothing is written to stdout.
  {
    printf 'COMPOSE_PROJECT_NAME=plaingym\nAPP_IMAGE=%s\nGYM_HOSTNAME=%s\nACME_EMAIL=%s\nPOSTGRES_DB=plaingym\n' "$image" "$hostname" "$email"
    printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'APP_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'MAINTENANCE_PASSWORD=%s\n' "$(openssl rand -hex 32)"
    printf 'APP_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)"
    printf 'AUTH_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'SETUP_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'PLAINGYM_ORIGIN_NONCE=%s\n' "$(openssl rand -hex 16)"
    if [ "$dns_proxied" = true ]; then printf 'TRUST_CLOUDFLARE=true\n'; fi
  } > "$ROOT/.env"
  chmod 0600 "$ROOT/.env"
  # Caddy/Postgres still pull normally. --local-image is for a maintainer-loaded build.
  if [ "$local_image" = true ]; then
    compose pull postgres caddy
  else
    compose pull
  fi
else
  # A re-run adds what an install lacks, and nothing else; compose then recreates the containers whose environment
  # changed. TRUST_CLOUDFLARE is added only when absent, so an owner's own value (even false) stays; a hostname moved
  # back to DNS only leaves it on, which is harmless (the app reads CF-Connecting-IP only from Cloudflare's addresses).
  # An empty value counts as missing: the added line comes last, which read_env and Compose use.
  if grep -q plaingym-origin "$ROOT/Caddyfile" && [ -z "$(read_env PLAINGYM_ORIGIN_NONCE)" ]; then add_env PLAINGYM_ORIGIN_NONCE "$(openssl rand -hex 16)"; fi
  if [ "$dns_proxied" = true ] && ! grep -q '^TRUST_CLOUDFLARE=' "$ROOT/.env"; then add_env TRUST_CLOUDFLARE true; fi
fi
# The public key update.sh --patch checks release manifests with. A bundle without one leaves automatic updates
# skipping each night with "no release signing key" until the deployment files are updated.
if [ -f "$SOURCE/release-signing.pem" ] && [ ! -f "$ROOT/release-signing.pem" ]; then
  install -m 0644 "$SOURCE/release-signing.pem" "$ROOT/release-signing.pem"
fi
compose up -d --pull missing --wait --wait-timeout 180
compose exec -T app /app/deploy/database.sh migrate
compose exec -T app node /app/deploy/healthcheck.mjs
history_install
# Nightly patch updates (update.sh --patch): the timer fires hourly, and update.sh acts once a night in the gym's
# timezone. The owner turns them off in Settings → Updates; the timer stays and then only records the skip.
# Installed before the public checks below, so an install that a DNS or proxy setting holds up is still complete.
units=${SYSTEMD_UNIT_DIR:-/etc/systemd/system}
for unit in plaingym-update.service plaingym-update.timer; do
  sed "s#@ROOT@#$ROOT#g" "$SOURCE/systemd/$unit" > "$units/$unit.next"
  chmod 0644 "$units/$unit.next"
  mv "$units/$unit.next" "$units/$unit"
done
systemctl daemon-reload
systemctl enable --now plaingym-update.timer
# The public checks resolve the name through DNS, as check_dns does, and connect to that address: /etc/hosts may map
# the server's own name to itself, which would hide a record that points elsewhere.
case "$hostname" in
  *.localhost) public=$(getent ahosts "$hostname" | awk 'NR == 1 {print $1}') ;;
  *) public=$(getent -s dns ahosts "$hostname" | awk 'NR == 1 {print $1}') ;;
esac
case "$public" in *:*) pinned="$hostname:443:[$public]" ;; *) pinned="$hostname:443:$public" ;; esac
# public_get PATH: the body, then the HTTP status on its own line (000 when nothing answered).
public_get() { curl --silent --connect-timeout 5 --max-time 10 --resolve "$pinned" --write-out '\n%{http_code}' "https://$hostname$1" || true; }
# explain STATUS: why a public request failed, for the owner.
explain() {
  case "$1" in
    000|'') printf 'Nothing answered over HTTPS. Check DNS, ports 80/443, the certificate (sudo docker compose logs caddy in %s) and, behind Cloudflare, that SSL/TLS is Full (strict).' "$ROOT" ;;
    3??) printf 'It answered with a redirect (HTTP %s). Behind Cloudflare, use SSL/TLS Full (strict), not Flexible, and check redirect rules.' "$1" ;;
    *) printf 'It answered HTTP %s. If Cloudflare challenges or blocks it (Bot Fight Mode, Under Attack mode, a WAF or rate-limiting rule), allow /healthz and /.well-known/plaingym-origin and re-run the installer with the same options.' "$1" ;;
  esac
}
# A valid public certificate is part of success; never use curl -k.
attempt=0
until health=$(public_get /healthz | tail -n 1) && [ "$health" = 200 ]; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 24 ] || fail "Containers are running and the update timer is installed, but https://$hostname/healthz failed. $(explain "$health")"
  sleep 5
done
printf 'PlainGym is running: https://%s/healthz\nInstallation: %s\n' "$hostname" "$ROOT"
printf 'Patch releases install automatically each night (plaingym-update.timer); owners can turn this off in Settings → Updates.\n'
# First-boot setup endpoints close (404) once the gym is set up.
if [ "$(public_get /api/setup | tail -n 1)" = 404 ]; then
  printf 'Setup is complete. Sign in at https://%s/login\n' "$hostname"
  exit 0
fi
# The DNS check can't see past a proxy, so before the private setup link goes out, prove the hostname reaches this
# server: fetch this install's random value through it. A failure only withholds the link. An install whose Caddyfile
# predates the check is DNS only (proxied re-runs refuse it above), which check_dns already confirmed.
if grep -q plaingym-origin "$ROOT/Caddyfile"; then
  nonce=$(read_env PLAINGYM_ORIGIN_NONCE)
  [ -n "$nonce" ] || fail "PLAINGYM_ORIGIN_NONCE in $ROOT/.env is empty; remove that line and re-run the installer with the same options."
  origin=$(public_get /.well-known/plaingym-origin)
  origin_status=$(printf '%s\n' "$origin" | tail -n 1)
  [ "$origin_status" = 200 ] || fail "The private setup link was not printed: https://$hostname/.well-known/plaingym-origin failed. $(explain "$origin_status")"
  [ "$(printf '%s\n' "$origin" | sed '$d')" = "$nonce" ] ||
    fail "https://$hostname answers, but not from this server, so the private setup link was not printed. Point the record (DNS only or through Cloudflare's proxy) at this server and re-run the installer with the same options."
fi
printf 'Private setup link (keep it secret):\n'
compose exec -T app gym-app setup-link
