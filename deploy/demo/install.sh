#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
umask 077
SOURCE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
DEPLOY=$(CDPATH='' cd -- "$SOURCE/.." && pwd)
# shellcheck source=deploy/lib.sh
. "$DEPLOY/lib.sh"
ROOT=/opt/plaingym-demo
export DEMO_LOCAL_TEST=false
check_only=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --directory|--hostname|--email|--image|--caddy-image|--snapshot-retention)
      [ "$#" -ge 2 ] || fail "Missing value for $1"
      case "$1" in
        --directory) ROOT=$2 ;; --hostname) export GYM_HOSTNAME="$2" ;;
        --email) export ACME_EMAIL="$2" ;; --image) export APP_IMAGE="$2" ;;
        --caddy-image) export CADDY_IMAGE="$2" ;;
        --snapshot-retention) export DEMO_SNAPSHOT_RETENTION="$2" ;;
      esac; shift 2 ;;
    --local-test) export DEMO_LOCAL_TEST=true; shift ;;
    --check-only) check_only=true; shift ;;
    *) fail 'Usage: install.sh [--hostname DOMAIN --email EMAIL] [--image IMAGE --caddy-image IMAGE] [--directory /opt/plaingym-demo] [--check-only] [--local-test]' ;;
  esac
done
case "$ROOT" in /*) ;; *) fail 'Installation directory must be absolute.' ;; esac
command -v python3 >/dev/null || fail 'Ubuntu python3 is required.'
if [ -f "$SOURCE/images.env" ]; then
  # Generated bundle metadata has image references only, never credentials.
  APP_IMAGE=${APP_IMAGE:-$(awk -F= '$1 == "APP_IMAGE" { print $2 }' "$SOURCE/images.env")}
  CADDY_IMAGE=${CADDY_IMAGE:-$(awk -F= '$1 == "CADDY_IMAGE" { print $2 }' "$SOURCE/images.env")}
  export APP_IMAGE CADDY_IMAGE
fi
desired_caddy=${CADDY_IMAGE:-}
if [ "$check_only" = true ]; then
  python3 "$SOURCE/config.py" --existing "$ROOT/.env" --check-only
  exit
fi
[ "$(id -u)" -eq 0 ] || fail 'Run the demo installer with sudo.'
if [ "$DEMO_LOCAL_TEST" != true ]; then
  # shellcheck source=/dev/null
  . /etc/os-release
  [ "$ID" = ubuntu ] || fail 'Use Ubuntu 24.04 or 26.04 LTS.'
  case "$VERSION_ID" in 24.04|26.04) ;; *) fail 'Use Ubuntu 24.04 or 26.04 LTS.' ;; esac
  case "$(dpkg --print-architecture)" in amd64|arm64) ;; *) fail 'Use amd64 or arm64.' ;; esac
  if [ -f "$SOURCE/images.env" ]; then
    bundle_arch=$(awk -F= '$1 == "BUNDLE_ARCHITECTURE" { print $2 }' "$SOURCE/images.env")
    [ "$bundle_arch" = "$(dpkg --print-architecture)" ] || fail 'Bundle architecture does not match this server.'
  fi
fi
inputs=$(mktemp)
backup=
refreshing=false
deploy_paths='compose.yaml base-lib.sh postgres/01-roles.sh demo.compose.yaml lib.sh update.sh snapshots.py Caddyfile'
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$result" -ne 0 ] && [ "$refreshing" = true ]; then
    printf 'Deploy refresh failed; restoring the previous files and proxy.\n' >&2
    for file in $deploy_paths .env; do
      if [ -f "$backup/$file" ]; then cp -p "$backup/$file" "$ROOT/$file"; fi
    done
    # shellcheck source=/dev/null
    . "$ROOT/lib.sh"
    APP_IMAGE=$(read_env APP_IMAGE)
    CADDY_IMAGE=$(read_env CADDY_IMAGE)
    export APP_IMAGE CADDY_IMAGE
    compose up -d --pull never --wait --wait-timeout 180 || result=1
  fi
  rm -f -- "$inputs"
  if [ -n "$backup" ]; then rm -rf -- "$backup"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
# All remote checks and prompts precede host changes or installation writes.
python3 "$SOURCE/config.py" --existing "$ROOT/.env" --output "$inputs"
if [ "$DEMO_LOCAL_TEST" != true ] && [ ! -f "$ROOT/.env" ]; then sh "$SOURCE/host.sh"; fi
install -d -m 0700 "$ROOT"
exec 9>"$ROOT/.install.lock"
flock -n 9 || fail 'Another demo installation is running.'
if [ ! -f "$ROOT/.env" ]; then
  install -m 0600 "$inputs" "$ROOT/.env"
else
  backup=$(mktemp -d "$ROOT/.deploy.XXXXXXXX")
  install -d -m 0700 "$backup/postgres"
  for file in $deploy_paths .env; do
    if [ -f "$ROOT/$file" ]; then cp -p "$ROOT/$file" "$backup/$file"; fi
  done
  refreshing=true
fi
desired_caddy=${desired_caddy:-$(read_env CADDY_IMAGE)}
valid_image "$desired_caddy" || fail 'Use an explicit proxy version or digest.'
# Input and bundle environment variables cannot change the installed app pin.
APP_IMAGE=$(read_env APP_IMAGE)
CADDY_IMAGE=$(read_env CADDY_IMAGE)
export APP_IMAGE CADDY_IMAGE
for kind in app caddy; do
  case "$kind" in app) pin=$APP_IMAGE ;; caddy) pin=$desired_caddy ;; esac
  if ! docker image inspect "$pin" >/dev/null 2>&1; then
    if [ -f "$SOURCE/images/$kind.tar" ]; then docker load -i "$SOURCE/images/$kind.tar" >/dev/null; fi
    docker image inspect "$pin" >/dev/null 2>&1 || docker pull "$pin" >/dev/null
  fi
done
docker run --rm --entrypoint caddy "$desired_caddy" list-modules | grep -qx dns.providers.cloudflare || fail 'Proxy image lacks Cloudflare DNS support.'
copy_deploy() {
  if ! cmp -s "$1" "$ROOT/$2"; then install -m "$3" "$1" "$ROOT/$2"; fi
}
install -d -m 0755 "$ROOT/postgres"
copy_deploy "$DEPLOY/compose.yaml" compose.yaml 0644
copy_deploy "$DEPLOY/lib.sh" base-lib.sh 0644
copy_deploy "$DEPLOY/postgres/01-roles.sh" postgres/01-roles.sh 0644
copy_deploy "$SOURCE/compose.yaml" demo.compose.yaml 0644
copy_deploy "$SOURCE/lib.sh" lib.sh 0644
copy_deploy "$SOURCE/update.sh" update.sh 0700
copy_deploy "$SOURCE/snapshots.py" snapshots.py 0700
if [ "$DEMO_LOCAL_TEST" = true ]; then caddyfile=Caddyfile.local.conf; else caddyfile=Caddyfile; fi
copy_deploy "$SOURCE/$caddyfile" Caddyfile 0644
# shellcheck source=/dev/null
. "$ROOT/lib.sh"
compose pull --policy missing postgres
DEMO_TARGET_CADDY_IMAGE="$desired_caddy" compose run --rm --no-deps -T caddy \
  caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
DEMO_TARGET_CADDY_IMAGE="$desired_caddy" compose up -d --pull never --wait --wait-timeout 180
if [ "$refreshing" = true ] && [ "$desired_caddy" = "$(read_env CADDY_IMAGE)" ] \
  && ! cmp -s "$backup/Caddyfile" "$ROOT/Caddyfile"; then
  # A bind-mounted config change alone does not make Compose recreate a container.
  compose up -d --no-deps --pull never --force-recreate --wait --wait-timeout 180 caddy
fi
demo_health
if [ "$desired_caddy" != "$(read_env CADDY_IMAGE)" ]; then
  awk -v image="$desired_caddy" '/^CADDY_IMAGE=/ { print "CADDY_IMAGE=" image; next } { print }' "$ROOT/.env" > "$ROOT/.env.next"
  chmod 0600 "$ROOT/.env.next"
  mv "$ROOT/.env.next" "$ROOT/.env"
fi
refreshing=false
demo_link
