#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
umask 077
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=deploy/lib.sh
. "$ROOT/lib.sh"
[ "$(id -u)" -eq 0 ] || fail 'Run update.sh as root.'
[ -f "$ROOT/.env" ] || fail 'Missing installation .env.'
[ "$#" -eq 1 ] || fail 'Usage: ./update.sh IMAGE (explicit semver tag or sha256 digest)'
[ "$1" != --patch ] || fail 'Automatic patch selection is not installed.'
valid_image "$1" || fail 'Use an explicit semver tag or sha256 digest.'
target=$1
current=$(read_env APP_IMAGE)
[ "$target" != "$current" ] || { echo 'Already on the requested image.'; exit 0; }
exec 9>"$ROOT/.update.lock"
flock -n 9 || fail 'Another update is running.'
compose ps --status running --services | grep -qx app || fail 'The app must be running before an update.'
previous_id=$(docker image inspect "$current" --format '{{.Id}}')
stopped=false
changed=false
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$result" -ne 0 ] && [ "$changed" = true ]; then
    echo 'Update failed; restarting the previous image.' >&2
    APP_IMAGE="$previous_id" compose up -d --no-deps --pull never --wait --wait-timeout 90 app || result=1
  elif [ "$stopped" = true ]; then
    APP_IMAGE="$previous_id" compose up -d --no-deps --pull never --wait --wait-timeout 90 app || result=1
  fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# Pull before the outage. The stopped app cannot write between capture and migration.
APP_IMAGE="$target" compose pull app
stopped=true
compose stop app
# One coordinated install snapshot: stored age recipient, encrypted recovery bundle,
# immutable upload references, multipart retry/abort, retention, and backup_runs.
compose run --rm --no-deps -T app node /app/maintenance.mjs snapshot pre-upgrade
stopped=false
changed=true
APP_IMAGE="$target" compose up -d --no-deps --pull never --wait --wait-timeout 90 app
APP_IMAGE="$target" compose exec -T app node /app/deploy/healthcheck.mjs
# Startup completes migrations before reporting healthy. Publish the pin only afterwards.
awk -v image="$target" 'BEGIN { found=0 } /^APP_IMAGE=/ { print "APP_IMAGE=" image; found=1; next } { print } END { if (!found) print "APP_IMAGE=" image }' "$ROOT/.env" > "$ROOT/.env.next"
chmod 0600 "$ROOT/.env.next"
mv "$ROOT/.env.next" "$ROOT/.env"
changed=false
printf 'Updated to %s. Coordinated pre-upgrade snapshot completed.\n' "$target"
