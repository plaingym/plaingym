#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# ./update.sh IMAGE           Update to an explicit image, run by the owner (deploy/README.md, "Updates and recovery").
# ./update.sh --patch [--now] The nightly timer's run: install the newest signed patch release of the running minor
#                             version, once a night between 02:00 and 05:00 in the gym's timezone (--now: at once).
# The exit trap calls cleanup and what it uses, which shellcheck reads as unreachable.
# shellcheck disable=SC2317
set -eu
umask 077
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=deploy/lib.sh
. "$ROOT/lib.sh"
[ "$(id -u)" -eq 0 ] || fail 'Run update.sh as root.'
[ -f "$ROOT/.env" ] || fail 'Missing installation .env.'
usage='Usage: ./update.sh IMAGE (explicit semver tag or sha256 digest) | ./update.sh --patch [--now]'
patch=false
now=false
case "$#:${1:-}:${2:-}" in
  1:--patch:) patch=true ;;
  2:--patch:--now) patch=true; now=true ;;
  1:-*) fail "$usage" ;;
  1:*) valid_image "$1" || fail 'Use an explicit semver tag or sha256 digest.' ;;
  *) fail "$usage" ;;
esac
current=$(read_env APP_IMAGE)
STATE="$ROOT/auto-update.state"
PENDING="$ROOT/auto-update.result"
INFLIGHT="$ROOT/.auto-update.inflight"
work=

# --- Swapping the app image, shared by both paths ---------------------------------------------------------
# `stage` says how far a swap got, so the exit handler knows what to undo and the patch path what to report.
stage=none
stopped=false
changed=false
interrupted=false
previous_id=
rollback() {
  APP_IMAGE="$previous_id" compose up -d --no-deps --pull never --wait --wait-timeout 90 app
}
cleanup() {
  exit_status=$?
  trap - EXIT HUP INT TERM
  outcome=unchanged
  if [ "$exit_status" -ne 0 ] && [ "$changed" = true ]; then
    echo 'Update failed; restarting the previous image.' >&2
    if rollback; then outcome=rolled_back; else outcome=rollback_failed; exit_status=1; fi
  elif [ "$stopped" = true ]; then
    if rollback; then outcome=restarted; else outcome=rollback_failed; exit_status=1; fi
  fi
  if [ "$patch" = true ] && [ "$stage" != none ]; then patch_finish; fi
  [ -z "$work" ] || rm -rf -- "$work"
  exit "$exit_status"
}
# Stop the app, snapshot, start the target, check it, and pin it. The manual path pulls first, while the app runs.
swap_image() { # TARGET
  compose ps --status running --services | grep -qx app || fail 'The app must be running before an update.'
  previous_id=$(docker image inspect "$current" --format '{{.Id}}')
  if [ "$patch" = false ]; then
    stage=pull
    APP_IMAGE="$1" compose pull app
  fi
  stage=snapshot
  # From here on a run killed outright leaves the marker, and the next run starts the pinned image first.
  [ "$patch" = false ] || printf '%s %s\n' "$from_version" "$to_version" > "$INFLIGHT"
  stopped=true
  compose stop app
  # One coordinated install snapshot: stored age recipient, encrypted recovery bundle,
  # immutable upload references, multipart retry/abort, retention, and backup_runs.
  # Its own message above says why it failed, such as backups that aren't set up yet (Settings → Email, payments and backups).
  compose run --rm --no-deps -T app node /app/maintenance.mjs snapshot pre-upgrade \
    || fail 'The pre-upgrade snapshot failed (reason above). Nothing was changed; the current version is restarting.'
  stopped=false
  changed=true
  stage=startup
  APP_IMAGE="$1" compose up -d --no-deps --pull never --wait --wait-timeout 90 app
  stage=health
  APP_IMAGE="$1" compose exec -T app node /app/deploy/healthcheck.mjs
  [ "$patch" = false ] || settle "$1"
  # Startup completes migrations before reporting healthy. Publish the pin only afterwards.
  awk -v image="$1" 'BEGIN { found=0 } /^APP_IMAGE=/ { print "APP_IMAGE=" image; found=1; next } { print } END { if (!found) print "APP_IMAGE=" image }' "$ROOT/.env" > "$ROOT/.env.next"
  chmod 0600 "$ROOT/.env.next"
  mv "$ROOT/.env.next" "$ROOT/.env"
  changed=false
  stage=finished
}
# A healthy start must stay healthy: wait, then check that the same container still runs, healthy and never restarted.
settle() { # TARGET
  container=$(compose ps -q app)
  sleep "${UPDATE_SETTLE_SECONDS:-60}"
  [ "$(compose ps -q app)" = "$container" ] || return 1
  [ "$(docker inspect "$container" --format '{{.State.Health.Status}} {{.RestartCount}}')" = 'healthy 0' ] || return 1
  APP_IMAGE="$1" compose exec -T app node /app/deploy/healthcheck.mjs
}

if [ "$patch" = false ]; then
  target=$1
  [ "$target" != "$current" ] || { echo 'Already on the requested image.'; exit 0; }
  exec 9>"$ROOT/.update.lock"
  flock -n 9 || fail 'Another update is running.'
  trap cleanup EXIT
  trap 'exit 130' HUP INT TERM
  swap_image "$target"
  printf 'Updated to %s. Coordinated pre-upgrade snapshot completed.\n' "$target"
  exit 0
fi

# --- Automatic patch updates (--patch) ---------------------------------------------------------------------
# The app never holds the Docker socket: the owner's setting and each result cross through `gym-app auto-update`
# in the app container. A result the app can't take yet (it is down or restoring) waits in auto-update.result
# and is sent first on the next run.
from_version=-
to_version=-
value_of() { # FILE KEY
  [ -f "$1" ] || return 0
  awk -v key="$2" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { print value }' "$1"
}
state_set() { # KEY VALUE
  { [ ! -f "$STATE" ] || awk -v key="$1" 'index($0, key "=") != 1' "$STATE"; printf '%s=%s\n' "$1" "$2"; } > "$STATE.next"
  mv "$STATE.next" "$STATE"
}
app_running() { compose ps --status running --services 2>/dev/null | grep -qx app; }
send_pending() {
  [ -f "$PENDING" ] || return 0
  # Written by report below from checked values only: an instant, fixed words and release versions.
  read -r pending_at pending_result pending_reason pending_from pending_to < "$PENDING" || return 1
  set -- record --at "$pending_at" --result "$pending_result"
  [ "$pending_reason" = - ] || set -- "$@" --reason "$pending_reason"
  [ "$pending_from" = - ] || set -- "$@" --from "$pending_from"
  [ "$pending_to" = - ] || set -- "$@" --to "$pending_to"
  app_running && compose exec -T app gym-app auto-update "$@" >/dev/null && rm -f "$PENDING"
}
report() { # RESULT REASON: keep the result, say it on the journal, and give it to the app.
  printf '%s %s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$from_version" "$to_version" > "$PENDING.next"
  mv "$PENDING.next" "$PENDING"
  printf 'Automatic patch update: %s%s (running %s, newest %s).\n' "$1" "$([ "$2" = - ] || printf ', %s' "$2")" "$from_version" "$to_version"
  send_pending || echo 'The app could not record this result yet; the next run sends it.' >&2
}
finish() { # RESULT REASON [STATUS]: report and stop. Expected situations exit 0; problems exit 1.
  report "$1" "$2"
  exit "${3:-0}"
}
patch_finish() { # From the exit handler, once a swap started.
  # The pinned image may not be running after a failed rollback: keep the marker, so the next run starts it again.
  [ "$outcome" = rollback_failed ] || rm -f "$INFLIGHT"
  case "$stage:$outcome:$interrupted" in
    finished:*) report updated - ;;
    *:rollback_failed:*) report failed rollback_failed ;;
    # Stopped before the new version started, even by a signal: nothing was installed.
    snapshot:*) report skipped snapshot_failed ;;
    *:true) report rolled_back interrupted ;;
    startup:rolled_back:*) report rolled_back startup_failed ;;
    *:rolled_back:*) report rolled_back health_check_failed ;;
    *) report failed rollback_failed ;;
  esac
}
image_version() { docker image inspect "$1" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null || true; }
migrations_of() { # IMAGE: a digest of the migrations the image applies when it starts
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint sh "$1" \
    -c 'cd /app/migrations && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum' | awk '{ print $1 }'
}
valid_timezone() { printf '%s\n' "$1" | grep -Eq '^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$' && [ -f "/usr/share/zoneinfo/$1" ]; }
in_window() { hour=$(TZ="$1" date +%H); hour=${hour#0}; [ "$hour" -ge 2 ] && [ "$hour" -lt 5 ]; }
tonight_done() { [ "$(value_of "$STATE" night)" = "$(TZ="$1" date +%F)" ]; }
download() { # URL FILE [MAX_BYTES]
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 60 \
    --max-filesize "${3:-65536}" -H 'User-Agent: plaingym-update' "$1" -o "$2"
}

exec 9>"$ROOT/.update.lock"
flock -n 9 || { echo 'Another update is running; this run does nothing.'; exit 0; }
trap cleanup EXIT
trap 'interrupted=true; exit 130' HUP INT TERM
work=$(mktemp -d)
send_pending || true

# An earlier run stopped between stopping the app and pinning an image (power loss, a kill): start the pinned image.
if [ -f "$INFLIGHT" ]; then
  read -r from_version to_version < "$INFLIGHT" || true
  valid_version "$from_version" || from_version=-
  valid_version "$to_version" || to_version=-
  echo 'The previous automatic update was interrupted; starting the pinned image again.' >&2
  # Still failing: keep the marker and try again on the next run.
  if ! compose up -d --no-deps --wait --wait-timeout 90 app; then finish failed rollback_failed 1; fi
  rm -f "$INFLIGHT"
  if [ "$to_version" != - ] && [ "$(image_version "$current")" = "$to_version" ]; then finish updated -; fi
  if [ "$from_version" = - ] || [ "$to_version" = - ]; then exit 1; fi
  finish rolled_back interrupted 1
fi

# Once a night, between 02:00 and 05:00 where the gym is. The timer fires every hour; the other runs stop here.
due() { in_window "$1" && ! tonight_done "$1"; }
timezone=$(value_of "$STATE" timezone)
if [ "$now" = false ] && valid_timezone "$timezone" && ! due "$timezone"; then exit 0; fi
app_running || { echo 'The app is not running.' >&2; finish skipped check_failed 1; }
compose exec -T app gym-app auto-update check > "$work/check" || finish skipped check_failed 1
[ "$(value_of "$work/check" restore)" != true ] || finish skipped restore_in_progress
# Before the setup wizard creates the gym there is nothing to update, and nowhere to record a result.
if [ "$(value_of "$work/check" setup)" = false ]; then echo 'The gym is not set up yet; nothing to update.'; exit 0; fi
timezone=$(value_of "$work/check" timezone)
valid_timezone "$timezone" || timezone=UTC
state_set timezone "$timezone"
# The first run learns the timezone; it acts only inside the window too.
if [ "$now" = false ] && ! due "$timezone"; then exit 0; fi
state_set night "$(TZ="$timezone" date +%F)"

version=$(image_version "$current")
if valid_version "$version"; then from_version=$version; fi
[ "$(value_of "$work/check" enabled)" = true ] || finish skipped disabled
[ "$(value_of "$work/check" backups)" = true ] || finish skipped backups_not_configured
[ -f "$ROOT/release-signing.pem" ] || finish skipped no_signing_key
[ "$from_version" != - ] || finish skipped version_unknown 1

repository=$(read_env RELEASE_REPOSITORY)
[ -n "$repository" ] || repository=plaingym/plaingym
printf '%s\n' "$repository" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || finish skipped release_list_unavailable 1
download "https://api.github.com/repos/$repository/releases?per_page=100" "$work/releases.json" 5000000 \
  || finish skipped release_list_unavailable 1
# Only tag names are read from the list; the signed manifest below is what is trusted.
tags=$(grep -Eo '"tag_name"[[:space:]]*:[[:space:]]*"v[0-9]+\.[0-9]+\.[0-9]+"' "$work/releases.json" | grep -Eo 'v[0-9]+\.[0-9]+\.[0-9]+' || true)
tag=$(newest_patch "$from_version" "$tags")
[ -n "$tag" ] || finish up_to_date -
to_version=$tag
{ download "https://github.com/$repository/releases/download/$tag/release-manifest.txt" "$work/manifest" \
  && download "https://github.com/$repository/releases/download/$tag/release-manifest.txt.sig" "$work/manifest.sig"; } \
  || finish skipped manifest_unavailable 1
manifest_verify "$ROOT/release-signing.pem" "$work/manifest" "$work/manifest.sig" || finish skipped signature_invalid 1
manifest_check "$work/manifest" "$tag" || finish skipped manifest_invalid 1
image=$(manifest_value "$work/manifest" image)
digest=$(manifest_value "$work/manifest" digest)
target="$image:$tag@$digest"
valid_image "$target" || finish skipped manifest_invalid 1

# Pull while the app runs, and check what arrived before anything stops.
APP_IMAGE="$target" compose pull app || finish skipped pull_failed 1
if ! docker image inspect "$target" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -qxF "$image@$digest" \
  || [ "$(image_version "$target")" != "$tag" ]; then finish skipped digest_mismatch 1; fi
# Patch releases never change the database: the release workflow refuses them, and so does this check.
hash='^[a-f0-9]{64}$'
old=$(migrations_of "$current") || old=
new=$(migrations_of "$target") || new=
if ! printf '%s\n' "$old" | grep -Eq "$hash" || ! printf '%s\n' "$new" | grep -Eq "$hash"; then finish skipped image_check_failed 1; fi
[ "$old" = "$new" ] || finish skipped migration_in_patch 1

swap_image "$target"
exit 0
