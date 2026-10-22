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
capture=
stopped=false
changed=false
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$result" -ne 0 ] && [ "$changed" = true ]; then
    echo 'Update failed; restarting the previous scaffold image.' >&2
    APP_IMAGE="$previous_id" compose up -d --no-deps --pull never --wait --wait-timeout 90 app || result=1
  elif [ "$stopped" = true ]; then
    APP_IMAGE="$previous_id" compose up -d --no-deps --pull never --wait --wait-timeout 90 app || result=1
  fi
  [ -z "$capture" ] || rm -rf -- "$capture"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

# TODO(CCR): use the coordinated backup and migration commands for schema releases.
# Until then this adapter deliberately refuses application tables and uploads.
compose exec -T app /app/deploy/database.sh assert-empty
# shellcheck disable=SC2016
compose exec -T app sh -c 'test -z "$(find /var/lib/plaingym/uploads -mindepth 1 -print -quit)"' \
  || fail 'Application uploads require the coordinated backup CLI.'
recipient=$(read_env BACKUP_RECIPIENT)
[ -n "$recipient" ] || fail 'Set BACKUP_RECIPIENT to your age public key before updating.'
command -v age >/dev/null || fail 'Install age before updating.'
printf '' | age -r "$recipient" >/dev/null 2>&1 || fail 'BACKUP_RECIPIENT is not a valid age public key.'
# Pull while the current app still serves, so the download does not extend the
# outage and nothing is written between the snapshot and the new image start.
APP_IMAGE="$target" compose pull app
install -d -m 0700 "$ROOT/snapshots"
capture=$(mktemp -d "$ROOT/snapshots/.capture.XXXXXXXX")
stopped=true
compose stop app
compose run --rm --no-deps -T app /app/deploy/database.sh dump > "$capture/database.dump"
compose run --rm --no-deps -T --entrypoint tar app -C /var/lib/plaingym -cf - uploads > "$capture/uploads.tar"
cp "$ROOT/.env" "$capture/recovery.env"
printf '%s\n' "$current" > "$capture/image"
snapshot="$ROOT/snapshots/$(date -u +%Y%m%dT%H%M%SZ)-$$.tar.age"
tar -C "$capture" -cf "$capture/bundle.tar" database.dump uploads.tar recovery.env image
age -r "$recipient" -o "$snapshot.partial" "$capture/bundle.tar"
mv "$snapshot.partial" "$snapshot"
stopped=false
changed=true
APP_IMAGE="$target" compose up -d --no-deps --pull never --wait --wait-timeout 90 app
APP_IMAGE="$target" compose exec -T app /app/deploy/database.sh migrate
APP_IMAGE="$target" compose exec -T app node /app/deploy/healthcheck.mjs
# Publish the new pin only after every check; failures leave the original .env.
awk -v image="$target" 'BEGIN { found=0 } /^APP_IMAGE=/ { print "APP_IMAGE=" image; found=1; next } { print } END { if (!found) print "APP_IMAGE=" image }' "$ROOT/.env" > "$ROOT/.env.next"
chmod 0600 "$ROOT/.env.next"
mv "$ROOT/.env.next" "$ROOT/.env"
changed=false
printf 'Updated to %s. Encrypted snapshot: %s\n' "$target" "$snapshot"
