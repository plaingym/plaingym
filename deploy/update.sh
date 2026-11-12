#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# ./update.sh IMAGE           Update to an explicit image, run by the owner (deploy/README.md, "Updates and recovery").
# ./update.sh --patch [--now] The nightly timer's run: install the newest signed patch release of the running minor
#                             version, once a night between 02:00 and 05:00 in the gym's timezone (--now: at once).
# The exit trap calls cleanup and what it uses, which shellcheck reads as unreachable.
# shellcheck disable=SC2317,SC2329
set -eu
umask 077
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=deploy/lib.sh
. "$ROOT/lib.sh"
[ "$(id -u)" -eq 0 ] || fail 'Run update.sh as root.'
[ -f "$ROOT/.env" ] || fail 'Missing installation .env.'
usage='Usage: ./update.sh IMAGE (explicit semver tag or sha256 digest) | ./update.sh --patch [--now] | ./update.sh --rollback'
patch=false
now=false
requested_rollback=false
case "$#:${1:-}:${2:-}" in
  1:--rollback:) requested_rollback=true ;;
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
ATTEMPT="$ROOT/.schema-attempt"
RECOVERY="$ROOT/.schema-recovery"
recovery_version=
work=
# A requested update fails; the nightly patch run has nothing to do.
rotation_check() {
  [ -f "$ROOT/.rotate-key.inflight" ] || return 0
  message='Key rotation is unfinished; update skipped. Rerun rotate-key.sh before updating.'
  [ "$patch" = true ] || fail "$message"
  echo "$message"
  exit 0
}
target_floor=-
snapshot=-
target_id=
history_started=false
snapshot_file=

# --- Swapping the app image, shared by both paths ---------------------------------------------------------
# `stage` says how far a swap got, so the exit handler knows what to undo and the patch path what to report.
stage=none
stopped=false
changed=false
interrupted=false
previous_id=
attempt_end=failed
recovery_notice() {
  failed_version=$(cut -f3 "$RECOVERY")
  restore_snapshot=$(cut -f6 "$RECOVERY")
  echo "The failed update changed the database, and $from_version can't run on it. Retry $failed_version with ./update.sh IMAGE, or update to a newer compatible signed release. To go back, restore pre-upgrade snapshot $restore_snapshot; see docs/restoring.md." >&2
}
# Stop the target before comparing migrations. An unchanged attempt never counts towards the floor.
settle_attempt() {
  [ -f "$ATTEMPT" ] || return 0
  compose stop app || true
  state=$(schema_state)
  if [ -z "$state" ]; then
    echo "The database can't be read, so $from_version stays stopped. Once PostgreSQL is running, run update.sh again." >&2
    return 1
  fi
  if [ "$state" != "$(cut -f1 "$ATTEMPT")" ]; then
    rm -f "$ROOT/schema-compatibility.yaml.before"
    if version_at_least "$from_version" "$(schema_floor)"; then rm -f "$ATTEMPT"; return 0; fi
    if [ -f "$RECOVERY" ]; then
      # A later migration changes the recovery release, but its snapshot is already past the original boundary.
      restore_snapshot=$(cut -f6 "$RECOVERY")
      awk -F '\t' -v snapshot="$restore_snapshot" 'BEGIN { OFS="\t" } { $6=snapshot; print }' "$ATTEMPT" > "$RECOVERY.next"
      mv "$RECOVERY.next" "$RECOVERY"
      rm -f "$ATTEMPT"
    else
      mv "$ATTEMPT" "$RECOVERY"
    fi
    recovery_notice
    return 1
  fi
  restore_schema_guard
  rm -f "$ATTEMPT"
  attempt_end=abandoned
  target_floor=-
}
rollback() {
  settle_attempt || return 1
  # A recovery retry that changed nothing still cannot restart code below the already-migrated floor.
  if [ -f "$RECOVERY" ]; then
    recovery_notice
    return 1
  fi
  APP_IMAGE="$previous_id" compose up -d --no-deps --pull never --wait --wait-timeout 90 app
}
cleanup() {
  exit_status=$?
  trap - EXIT HUP INT TERM
  outcome=unchanged
  if [ "$exit_status" -ne 0 ] && [ "$changed" = true ]; then
    if [ "$requested_rollback" = true ]; then echo 'Rollback failed; restarting the original image.' >&2
    elif [ -f "$RECOVERY" ]; then echo 'Update failed; the previous version stays stopped.' >&2
    else echo 'Update failed; restarting the previous image.' >&2; fi
    if rollback; then outcome=rolled_back; else outcome=rollback_failed; exit_status=1; fi
  elif [ "$stopped" = true ]; then
    if rollback; then outcome=restarted; else outcome=rollback_failed; exit_status=1; fi
  fi
  if [ "$patch" = true ] && [ "$stage" != none ]; then patch_finish; fi
  if [ "$history_started" = true ]; then
    if [ "$stage" = finished ]; then
      history_outcome=update
      [ "$requested_rollback" = false ] || history_outcome=rollback
      history_record "$to_version" "$target_id" "$history_outcome" "$target_floor" "$snapshot"
      if [ "$requested_rollback" = true ]; then report updated -; fi
      # After the update's own row, so its image tops the rollback stack.
      if [ "$patch" = true ]; then prune_images || true; fi
    else
      history_record "$to_version" "$target_id" "$attempt_end" "$target_floor" "$snapshot"
      if [ "$outcome" = rolled_back ] || [ "$outcome" = restarted ]; then
        history_record "$from_version" "$previous_id" rollback "$(schema_floor)" "$snapshot"
      fi
    fi
  fi
  if [ "$requested_rollback" = true ] && [ "$stage" != none ] && [ "$stage" != finished ]; then
    if [ "$stage" = snapshot ]; then report skipped snapshot_failed
    elif [ "$outcome" = rollback_failed ]; then report failed rollback_failed
    elif [ "$stage" = startup ]; then report rolled_back startup_failed
    else report rolled_back health_check_failed; fi
  fi
  [ -z "$work" ] || rm -rf -- "$work"
  [ -z "$snapshot_file" ] || rm -f -- "$snapshot_file"
  exit "$exit_status"
}
# Stop the app, snapshot, start the target, check it, and pin it. The manual path pulls first.
swap_image() { # TARGET
  if [ "$requested_rollback" = false ] && [ -z "$recovery_version" ]; then
    app_running || fail 'The app must be running before an update.'
  fi
  previous_id=$(docker image inspect "$current" --format '{{.Id}}')
  if [ "$patch" = false ] && [ "$requested_rollback" = false ] && [ -z "$target_id" ]; then
    stage=pull
    APP_IMAGE="$1" compose pull app
  fi
  stage=snapshot
  # From here on a run killed outright leaves the marker, and the next run starts the pinned image first. It holds the
  # versions, when the app stopped, and why it was left (- while the swap runs; see inflight_mark).
  [ "$patch" = false ] || printf '%s %s %s -\n' "$from_version" "$to_version" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$INFLIGHT"
  stopped=true
  compose stop app
  # One coordinated install snapshot: stored age recipient, encrypted recovery bundle,
  # immutable upload references, multipart retry/abort, retention, and backup_runs.
  # Its own message above says why it failed, such as backups that aren't set up yet (Settings → Email, payments and backups).
  snapshot_file=$(mktemp "$ROOT/.snapshot.XXXXXX")
  if [ -n "$recovery_version" ]; then
    # The pinned image is below the floor. Use the recorded compatible image's maintenance command directly:
    # its ordinary entrypoint would run migrations before the snapshot. No server or migrations start here.
    recovery_image=$(cut -f4 "$RECOVERY")
    if [ "$(image_version "$recovery_image")" != "$recovery_version" ] || ! version_at_least "$recovery_version" "$(schema_floor)"; then
      fail 'The recovery image is missing or incompatible. Restore the pre-upgrade snapshot; see docs/restoring.md.'
    fi
    # Keep retries out of the two pre-upgrade slots, so they cannot evict the pre-migration restore point.
    APP_IMAGE="$recovery_image" compose run --rm --no-deps -T --entrypoint node app /app/maintenance.mjs snapshot manual > "$snapshot_file" \
      || fail 'The pre-upgrade snapshot failed (reason above). The app stays stopped; retry the recovery update.'
  else
    compose run --rm --no-deps -T app node /app/maintenance.mjs snapshot pre-upgrade > "$snapshot_file" \
      || fail 'The pre-upgrade snapshot failed (reason above). Nothing was changed; the current version is restarting.'
  fi
  snapshot_output=$(cat "$snapshot_file")
  rm -f -- "$snapshot_file"
  snapshot_file=
  [ -z "$snapshot_output" ] || printf '%s\n' "$snapshot_output"
  snapshot=$(printf '%s\n' "$snapshot_output" | sed -n 's/^Snapshot: \([a-f0-9-]\{36\}\)$/\1/p' | tail -n 1)
  [ -n "$snapshot" ] || snapshot=-
  target_id=$(docker image inspect "$1" --format '{{.Id}}')
  if valid_version "$to_version" && valid_version "$target_floor" && [ "$requested_rollback" = false ]; then
    effective_floor=$(schema_floor)
    if [ -z "$effective_floor" ] || version_at_least "$target_floor" "$effective_floor"; then effective_floor=$target_floor; fi
    # Record every manual upgrade, including attempts within the compatibility window. Automatic patches already
    # proved their migrations identical and keep their existing recovery path.
    if [ "$patch" = false ]; then
      schema_before=$(schema_state)
      [ -n "$schema_before" ] || fail "The database's migrations couldn't be read. Nothing was changed; the current version is restarting."
      keep_schema_guard
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$schema_before" "$from_version" "$to_version" "$target_id" "$target_floor" "$snapshot" > "$ATTEMPT"
    fi
    schema_snapshot=$snapshot
    [ ! -f "$RECOVERY" ] || schema_snapshot=$(cut -f6 "$RECOVERY")
    write_schema_guard "$effective_floor" "$to_version" "$schema_snapshot"
  fi
  history_record "$to_version" "$target_id" starting "$target_floor" "$snapshot"
  history_started=true
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
  rm -f "$RECOVERY" "$ATTEMPT" "$ROOT/schema-compatibility.yaml.before"
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

# --- Automatic patch updates (--patch) ---------------------------------------------------------------------
# The app never holds the Docker socket: the owner's setting and each result cross through `gym-app auto-update`
# in the app container. Results the app can't take yet (it is down or restoring) wait in auto-update.result, in
# order, and are sent first on the next run.
from_version=-
to_version=-
# Sent with a report: how many automatic attempts at to_version failed, and when a recovered site went down.
report_failures=-
report_down_at=-
value_of() { # FILE KEY; nothing when the file doesn't exist yet
  [ -f "$1" ] || return 0
  read_env "$2" "$1"
}
state_set() { # KEY VALUE
  { [ ! -f "$STATE" ] || awk -v key="$1" 'index($0, key "=") != 1' "$STATE"; printf '%s=%s\n' "$1" "$2"; } > "$STATE.next"
  mv "$STATE.next" "$STATE"
}
app_running() { compose ps --status running --services 2>/dev/null | grep -qx app; }
send_pending() { # Oldest first; each result leaves the file once the app took it, and a later one never replaces it.
  [ -f "$PENDING" ] || return 0
  while [ -s "$PENDING" ]; do
    # Written by report below from checked values only: instants, fixed words, release versions and a count.
    read -r pending_at pending_result pending_reason pending_from pending_to pending_failures pending_down < "$PENDING" || return 1
    set -- record --at "$pending_at" --result "$pending_result"
    [ "$pending_reason" = - ] || set -- "$@" --reason "$pending_reason"
    [ "$pending_from" = - ] || set -- "$@" --from "$pending_from"
    [ "$pending_to" = - ] || set -- "$@" --to "$pending_to"
    [ "${pending_failures:--}" = - ] || set -- "$@" --failures "$pending_failures"
    [ "${pending_down:--}" = - ] || set -- "$@" --down-at "$pending_down"
    app_running || return 1
    record_status=0
    compose exec -T app gym-app auto-update "$@" >/dev/null || record_status=$?
    # Exit 2 is the app refusing the result itself, which no retry changes: say so, and go on with the next.
    if [ "$record_status" -eq 2 ]; then echo "The app refused the recorded result \"$pending_result $pending_reason\" from $pending_at; it was dropped." >&2
    elif [ "$record_status" -ne 0 ]; then return 1; fi
    tail -n +2 "$PENDING" > "$PENDING.next"
    mv "$PENDING.next" "$PENDING"
  done
  rm -f "$PENDING"
}
summary() { # RESULT REASON: the journal's words for one result
  case "$1:$2" in
    updated:*) printf 'updated from %s to %s' "$from_version" "$to_version" ;;
    up_to_date:*) printf 'up to date (%s; no newer patch)' "$from_version" ;;
    failed:*) printf 'failed, %s (from %s to %s)' "$2" "$from_version" "$to_version" ;;
    *:-) printf '%s (running %s, newest %s)' "$1" "$from_version" "$to_version" ;;
    *) printf '%s, %s (running %s, newest %s)' "$1" "$2" "$from_version" "$to_version" ;;
  esac
}
report() { # RESULT REASON: keep the result after any still unsent, say it on the journal, and give them all to the app.
  printf '%s %s %s %s %s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$from_version" "$to_version" "$report_failures" "$report_down_at" >> "$PENDING"
  if [ "$requested_rollback" = true ]; then
    printf 'Rollback: %s%s (from %s to %s).\n' "$1" "$([ "$2" = - ] || printf ', %s' "$2")" "$from_version" "$to_version"
  else
    printf 'Automatic patch update: %s.\n' "$(summary "$1" "$2")"
  fi
  send_pending || echo 'The app could not record this result yet; the next run sends it.' >&2
}
finish() { # RESULT REASON [STATUS]: report and stop. Expected situations exit 0; problems exit 1.
  report "$1" "$2"
  exit "${3:-0}"
}
# A release whose automatic attempts failed twice (rolled back or failed, an interrupted run too) waits for a newer patch
# or the owner's retry (--now). auto-update.state keeps the count per release until a patch update succeeds.
failure_count() { # VERSION: the failed attempts so far, or 0
  count=$(value_of "$STATE" "failures.$1")
  case "$count" in ''|*[!0-9]*|0*) echo 0 ;; ????*) echo 999 ;; *) echo "$count" ;; esac
}
count_failure() { # to_version failed once more: count it, and send the count with the report.
  valid_version "$to_version" || return 0
  report_failures=$(($(failure_count "$to_version") + 1))
  [ "$report_failures" -le 999 ] || report_failures=999
  state_set "failures.$to_version" "$report_failures"
}
clear_failures() {
  [ -f "$STATE" ] || return 0
  awk 'index($0, "failures.") != 1' "$STATE" > "$STATE.next"
  mv "$STATE.next" "$STATE"
}
inflight_mark() { # REASON: why the marker stays. After rollback_failed the next run reports a recovery, not an interruption.
  [ -f "$INFLIGHT" ] || return 0
  read -r mark_from mark_to mark_down _ < "$INFLIGHT" || true
  printf '%s %s %s %s\n' "${mark_from:--}" "${mark_to:--}" "${mark_down:--}" "$1" > "$INFLIGHT.next"
  mv "$INFLIGHT.next" "$INFLIGHT"
}
patch_finish() { # From the exit handler, once a swap started.
  # The pinned image may not be running after a failed rollback: keep the marker, so the next run starts it again.
  [ "$outcome" = rollback_failed ] || rm -f "$INFLIGHT"
  case "$stage:$outcome:$interrupted" in
    finished:*) clear_failures; report updated - ;;
    *:rollback_failed:*) count_failure; inflight_mark rollback_failed; report failed rollback_failed ;;
    # Stopped before the new version started, even by a signal: nothing was installed.
    snapshot:*) report skipped snapshot_failed ;;
    *:true) count_failure; report rolled_back interrupted ;;
    startup:rolled_back:*) count_failure; report rolled_back startup_failed ;;
    *:rolled_back:*) count_failure; report rolled_back health_check_failed ;;
    *) count_failure; report failed rollback_failed ;;
  esac
}
image_version() { installed_version "$1" || true; }
registry_pin() { # IMAGE_ID TAG: NAME:TAG@DIGEST from the image's registry digests (the running image's name first), or nothing
  pin_name=${current%@sha256:*}
  case "${pin_name##*/}" in *:*) pin_name=${pin_name%:*} ;; esac
  pin=$(docker image inspect "$1" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null | awk -v name="$pin_name" -v tag="$2" '
    /^[^@]+@sha256:[a-f0-9]{64}$/ { split($0, part, "@"); ref = part[1] ":" tag "@" part[2]; if (part[1] == name) { found = ref; exit } if (first == "") first = ref }
    END { print (found != "" ? found : first) }') || return 0
  # Only a pin that names this very image.
  valid_image "$pin" && [ "$(docker image inspect "$pin" --format '{{.Id}}' 2>/dev/null)" = "$1" ] && printf '%s\n' "$pin"
  return 0
}
remember_patch_image() { # Only images this updater actually pulled can be removed later; each is listed once.
  pulled_id=$(docker image inspect "$target" --format '{{.Id}}') || return 0
  printf '%s\n' "$pulled_id" | grep -Eq '^sha256:[a-f0-9]{64}$' || return 0
  if [ -f "$ROOT/auto-update-images.tsv" ] && cut -f2 "$ROOT/auto-update-images.tsv" | grep -qxF "$pulled_id"; then return 0; fi
  printf '%s\t%s\t%s\n' "$image:$tag@$digest" "$pulled_id" "$tag" >> "$ROOT/auto-update-images.tsv" \
    || echo 'Could not record the pulled image for later cleanup.' >&2
}
remove_image() { # IMAGE_ID: never forced, and bounded, so maintenance can't hold the update lock forever.
  printf '%s\n' "$1" | grep -Eq '^sha256:[a-f0-9]{64}$' || return 1
  docker image inspect "$1" >/dev/null 2>&1 || return 0
  # Docker refuses an image a container uses or that names in other repositories refer to; that refusal stands.
  timeout -k 5 30 docker image rm "$1" >/dev/null 2>&1
}
# After a successful patch update, keep the current image and the two before it (the rollback stack's top
# `rollback_depth` entries, lib.sh). Older entries' images go, the installer's too, and each removed one leaves what
# --rollback offers (a `trimmed` history row); so do images this updater pulled that are off the stack (a rolled-back release).
# No global prune runs, and images nothing here recorded are left alone.
prune_images() {
  [ -f "$ROOT/version-history.tsv" ] || return 0
  kept=$(awk -F '\t' -v depth="$rollback_depth" "$history_stack"'END { for (i = n; i > 0 && i > n - depth; i--) print image[i] }' "$ROOT/version-history.tsv") || return 0
  # The new image tops the stack after an update. Anything else means the history can't be relied on: nothing goes.
  [ "$(printf '%s\n' "$kept" | head -n 1)" = "$target_id" ] || return 0
  kept=$(printf '%s\n%s\n%s\n' "$kept" "$target_id" "$previous_id"; [ ! -f "$RECOVERY" ] || cut -f4 "$RECOVERY")
  awk -F '\t' -v depth="$rollback_depth" "$history_stack"'END { for (i = 1; i <= n - depth; i++) print version[i] "\t" image[i] }' \
    "$ROOT/version-history.tsv" > "$work/trimmed" || return 0
  while IFS="$(printf '\t')" read -r trim_version trim_id; do
    printf '%s\n' "$kept" | grep -qxF "$trim_id" && continue
    # Only a removed image leaves the stack: one Docker refused or timed out on stays there, so the next prune tries again.
    remove_image "$trim_id" || continue
    history_record "$trim_version" "$trim_id" trimmed - -
  done < "$work/trimmed"
  [ -f "$ROOT/auto-update-images.tsv" ] || return 0
  : > "$ROOT/auto-update-images.tsv.next"
  while IFS="$(printf '\t')" read -r pulled_ref pulled_id pulled_version; do
    if ! printf '%s\n' "$kept" | grep -qxF "$pulled_id" && remove_image "$pulled_id"; then continue; fi
    printf '%s\t%s\t%s\n' "$pulled_ref" "$pulled_id" "$pulled_version" >> "$ROOT/auto-update-images.tsv.next"
  done < "$ROOT/auto-update-images.tsv"
  mv "$ROOT/auto-update-images.tsv.next" "$ROOT/auto-update-images.tsv"
}
migrations_of() { # IMAGE: a digest of the migrations the image applies when it starts
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint sh "$1" \
    -c 'cd /app/migrations && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum' | awk '{ print $1 }'
}
valid_timezone() { printf '%s\n' "$1" | grep -Eq '^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$' && [ -f "/usr/share/zoneinfo/$1" ]; }
in_window() { hour=$(TZ="$1" date +%H); hour=${hour#0}; [ "$hour" -ge 2 ] && [ "$hour" -lt 5 ]; }
download() { # URL FILE [MAX_BYTES]
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 60 \
    --max-filesize "${3:-65536}" -H 'User-Agent: plaingym-update' "$1" -o "$2"
}

exec 9>"$ROOT/.update.lock"
flock -n 9 || { [ "$patch" = true ] && { echo 'Another update is running; this run does nothing.'; exit 0; }; fail 'Another update is running.'; }
rotation_check
trap cleanup EXIT
trap 'interrupted=true; exit 130' HUP INT TERM

# A run killed outright during a manual update left its record: finish what its exit handler would have done.
# This run only does that, even when --rollback started it, so it reports the earlier update, not a rollback.
if [ -f "$ATTEMPT" ]; then
  read -r _ from_version to_version target_id target_floor snapshot < "$ATTEMPT"
  previous_id=$(docker image inspect "$current" --format '{{.Id}}')
  if [ "$previous_id" = "$target_id" ]; then
    rm -f "$RECOVERY" "$ATTEMPT" "$ROOT/schema-compatibility.yaml.before"
  else
    history_started=true
    changed=true
    stage=startup
    interrupted=true
    requested_rollback=false
    fail 'An earlier update was interrupted; checking the database, and restarting the pinned image if it can run. Run the update again afterwards.'
  fi
fi

if [ -f "$RECOVERY" ] && [ "$patch" = false ]; then
  recovery_version=$(cut -f3 "$RECOVERY")
  valid_version "$recovery_version" || fail 'Invalid schema recovery state. Restore the pre-upgrade snapshot; see docs/restoring.md.'
fi

if [ "$requested_rollback" = true ]; then
  [ -s "$ROOT/version-history.tsv" ] || fail 'No version history exists. Restore the pre-upgrade snapshot; see docs/restoring.md.'
  current_id=$(docker image inspect "$current" --format '{{.Id}}')
  candidate=$(previous_version "$current_id")
  [ -n "$candidate" ] || fail 'There is no previous installed version in version-history.tsv.'
  to_version=$(printf '%s\n' "$candidate" | cut -f2)
  target=$(printf '%s\n' "$candidate" | cut -f3)
  target_floor=$(schema_floor)
  if [ -n "$target_floor" ] && ! version_at_least "$to_version" "$target_floor"; then
    restore_snapshot=$(floor_snapshot "$target_floor")
    forward=
    [ -z "$recovery_version" ] || forward=" Or retry $recovery_version with ./update.sh IMAGE, or update to a newer compatible signed release, which keeps the data written since that snapshot."
    fail "Cannot roll back to $to_version: the schema requires $target_floor. Restore pre-upgrade snapshot ${restore_snapshot:-listed in version-history.tsv}; see docs/restoring.md.$forward Nothing was changed."
  fi
  printf '%s\n' "$target" | grep -Eq '^sha256:[a-f0-9]{64}$' || fail 'The previous image digest is invalid.'
  target_id=$(docker image inspect "$target" --format '{{.Id}}') || fail 'The previous image is no longer local. Restore its pre-upgrade snapshot; see docs/restoring.md.'
  if [ "$target_id" != "$target" ] || [ "$(image_version "$target")" != "$to_version" ]; then
    fail 'The previous image identity does not match the history.'
  fi
  from_version=$(image_version "$current")
  # Pin it by name, tag and digest like an update, so the image can be pulled again if it is ever removed. An image
  # with no registry digest (a local build) has nowhere to come back from, so it keeps its image ID.
  pin=$(registry_pin "$target_id" "$to_version")
  swap_image "${pin:-$target}"
  printf 'Rolled back to %s by digest. Pre-upgrade snapshot: %s.\n' "$to_version" "$snapshot"
  exit 0
fi

if [ "$patch" = false ]; then
  target=$1
  if [ -z "$recovery_version" ]; then
    [ "$target" != "$current" ] || { echo 'Already on the requested image.'; exit 0; }
  fi
  # Pull while the app runs, then compare what the request names with the running image: a tag of the running
  # release, or its digest, is the same image however the pin spells it.
  APP_IMAGE="$target" compose pull app
  target_id=$(docker image inspect "$target" --format '{{.Id}}')
  if [ -z "$recovery_version" ] && [ "$target_id" = "$(docker image inspect "$current" --format '{{.Id}}' 2>/dev/null || true)" ]; then
    echo 'Already on the requested image.'
    exit 0
  fi
  history_install
  from_version=$(image_version "$current")
  to_version=$(image_version "$target")
  if valid_version "$to_version"; then
    work=$(mktemp -d)
    repository=$(read_env RELEASE_REPOSITORY); [ -n "$repository" ] || repository=plaingym/plaingym
    valid_repository "$repository" || fail 'Invalid release repository.'
    [ -f "$ROOT/release-signing.pem" ] || fail 'Install the release signing public key before updating a release.'
    download "https://github.com/$repository/releases/download/$to_version/release-manifest.txt" "$work/manifest"
    download "https://github.com/$repository/releases/download/$to_version/release-manifest.txt.sig" "$work/manifest.sig"
    if ! manifest_verify "$ROOT/release-signing.pem" "$work/manifest" "$work/manifest.sig" || ! manifest_check "$work/manifest" "$to_version"; then fail 'Invalid signed release manifest.'; fi
    manifest_image=$(manifest_value "$work/manifest" image); manifest_digest=$(manifest_value "$work/manifest" digest)
    docker image inspect "$target" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -qxF "$manifest_image@$manifest_digest" || fail 'The requested image does not match its signed release digest.'
    # One pin form on every path: the signed name, the release tag and the signed digest.
    target="$manifest_image:$to_version@$manifest_digest"
    target_floor=$(manifest_value "$work/manifest" rollback_floor)
    [ -n "$target_floor" ] || target_floor=$to_version
    previous_floor=$(schema_floor)
    [ -z "$previous_floor" ] || version_at_least "$to_version" "$previous_floor" || fail "The schema requires $previous_floor. Restore the pre-upgrade snapshot; see docs/restoring.md."
    if [ -n "$recovery_version" ]; then
      version_at_least "$to_version" "$recovery_version" || fail "Recovery requires $recovery_version or a newer compatible signed release. Restore the pre-upgrade snapshot to go back; see docs/restoring.md. Nothing was changed."
      version_at_least "$recovery_version" "$target_floor" || fail "Recovery requires a release whose rollback floor covers $recovery_version; $to_version has floor $target_floor. Nothing was changed."
    fi
    if ! version_at_least "$from_version" "$target_floor"; then
      echo "$to_version has rollback floor $target_floor. Once it migrates the database, $from_version can't run on it: --rollback will refuse, and the way back is the pre-upgrade snapshot (docs/restoring.md)."
    fi
  fi
  if [ -n "$recovery_version" ] && ! valid_version "$to_version"; then
    fail "Recovery requires $recovery_version or a newer compatible signed release. Nothing was changed."
  fi
  swap_image "$target"
  printf 'Updated to %s. Coordinated pre-upgrade snapshot completed.\n' "$target"
  exit 0
fi

work=$(mktemp -d)
send_pending || true

# An earlier run stopped between stopping the app and pinning an image: start the pinned image. Either the run was
# killed outright (power loss, a kill), or its update and rollback both failed (the marker says rollback_failed).
if [ -f "$INFLIGHT" ]; then
  read -r from_version to_version down_at left_by < "$INFLIGHT" || true
  valid_version "$from_version" || from_version=-
  valid_version "$to_version" || to_version=-
  printf '%s\n' "${down_at:-}" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' || down_at=-
  [ "${left_by:-}" = rollback_failed ] || left_by=-
  if [ "$left_by" = rollback_failed ]; then echo 'The previous automatic update and its rollback failed; starting the pinned image again.' >&2
  else echo 'The previous automatic update was interrupted; starting the pinned image again.' >&2; fi
  if ! compose up -d --no-deps --wait --wait-timeout 90 app; then
    # Still down: the failure is reported once, each later run tries again, and the recovery is reported once it runs.
    [ "$left_by" = - ] || fail 'The pinned image still does not start; the next run tries again.'
    inflight_mark rollback_failed
    if [ "$from_version" = - ] || [ "$to_version" = - ]; then exit 1; fi
    count_failure
    finish failed rollback_failed 1
  fi
  rm -f "$INFLIGHT"
  if [ "$from_version" = - ] || [ "$to_version" = - ]; then exit 1; fi
  if [ "$(image_version "$current")" = "$to_version" ]; then clear_failures; finish updated -; fi
  if [ "$left_by" = rollback_failed ]; then
    # The same attempt as the failed report before it, so it isn't counted again.
    report_failures=$(failure_count "$to_version"); [ "$report_failures" -gt 0 ] || report_failures=-
    report_down_at=$down_at
    finish rolled_back rollback_failed 1
  fi
  count_failure
  finish rolled_back interrupted 1
fi

# Once a night, between 02:00 and 05:00 where the gym is. The timer fires every hour; the other runs stop here.
# Each run asks the app for the gym's timezone, so a changed zone counts from its next night. The zone it last gave
# is the fallback while the app can't answer (or a restore holds it); with that, a run outside the window stops
# without a result, and with no zone known yet a failed check is reported.
due() { in_window "$1" && ! tonight_done "$1"; }
# Once a night: tonight's date is done in this zone, or, after a change of zone, a run less than six hours ago counts.
tonight_done() {
  night_zone=$(value_of "$STATE" night_zone)
  if [ -z "$night_zone" ] || [ "$night_zone" = "$1" ]; then [ "$(value_of "$STATE" night)" = "$(TZ="$1" date +%F)" ]; return; fi
  night_at=$(value_of "$STATE" night_at)
  case "$night_at" in ''|*[!0-9]*) return 1 ;; esac
  [ $(($(date -u +%s) - night_at)) -lt 21600 ]
}
cached=$(value_of "$STATE" timezone)
valid_timezone "$cached" || cached=
answered=false
app_up=false
if app_running; then
  app_up=true
  if compose exec -T app gym-app auto-update check > "$work/check"; then answered=true; fi
fi
timezone=$cached
if [ "$answered" = true ] && [ "$(value_of "$work/check" restore)" != true ]; then
  # Before the setup wizard creates the gym there is nothing to update, and nowhere to record a result.
  if [ "$(value_of "$work/check" setup)" = false ]; then echo 'The gym is not set up yet; nothing to update.'; exit 0; fi
  timezone=$(value_of "$work/check" timezone)
  valid_timezone "$timezone" || timezone=UTC
  [ "$timezone" = "$cached" ] || state_set timezone "$timezone"
fi
if [ "$now" = false ] && [ -n "$timezone" ] && ! due "$timezone"; then exit 0; fi
if [ "$answered" = false ]; then
  [ "$app_up" = true ] || echo 'The app is not running.' >&2
  finish skipped check_failed 1
fi
[ "$(value_of "$work/check" restore)" != true ] || finish skipped restore_in_progress
state_set night "$(TZ="$timezone" date +%F)"
state_set night_zone "$timezone"
state_set night_at "$(date -u +%s)"

version=$(image_version "$current")
if valid_version "$version"; then from_version=$version; fi
[ "$(value_of "$work/check" enabled)" = true ] || finish skipped disabled
[ "$(value_of "$work/check" backups)" = true ] || finish skipped backups_not_configured
[ -f "$ROOT/release-signing.pem" ] || finish skipped no_signing_key
[ "$from_version" != - ] || finish skipped version_unknown 1
[ "$from_version" != v0.0.0 ] || finish skipped version_unknown 1

repository=$(read_env RELEASE_REPOSITORY)
[ -n "$repository" ] || repository=plaingym/plaingym
valid_repository "$repository" || finish skipped release_list_unavailable 1
download "https://api.github.com/repos/$repository/releases?per_page=100" "$work/releases.json" 5000000 \
  || finish skipped release_list_unavailable 1
# Only tag names are read from the list; the signed manifest below is what is trusted.
tags=$(grep -Eo '"tag_name"[[:space:]]*:[[:space:]]*"v[0-9]+\.[0-9]+\.[0-9]+"' "$work/releases.json" | grep -Eo 'v[0-9]+\.[0-9]+\.[0-9]+' || true)
tag=$(newest_patch "$from_version" "$tags")
[ -n "$tag" ] || finish up_to_date -
to_version=$tag
# The owner went back from this release or a newer patch: only a newer one installs by itself.
if declined_patch "$tag"; then finish skipped rolled_back_version; fi
# A release that failed twice waits for a newer patch; the owner's run with --now tries it again.
failures=$(failure_count "$tag")
if [ "$now" = false ] && [ "$failures" -ge 2 ]; then report_failures=$failures; finish skipped repeated_failure; fi
{ download "https://github.com/$repository/releases/download/$tag/release-manifest.txt" "$work/manifest" \
  && download "https://github.com/$repository/releases/download/$tag/release-manifest.txt.sig" "$work/manifest.sig"; } \
  || finish skipped manifest_unavailable 1
manifest_verify "$ROOT/release-signing.pem" "$work/manifest" "$work/manifest.sig" || finish skipped signature_invalid 1
manifest_check "$work/manifest" "$tag" || finish skipped manifest_invalid 1
target_floor=$(manifest_value "$work/manifest" rollback_floor)
[ -n "$target_floor" ] || target_floor=$(default_rollback_floor "$tag")
version_at_least "$from_version" "$target_floor" || finish skipped manifest_invalid 1
image=$(manifest_value "$work/manifest" image)
digest=$(manifest_value "$work/manifest" digest)
target="$image:$tag@$digest"
valid_image "$target" || finish skipped manifest_invalid 1

# Pull while the app runs, and check what arrived before anything stops.
APP_IMAGE="$target" compose pull app || finish skipped pull_failed 1
remember_patch_image
if ! docker image inspect "$target" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -qxF "$image@$digest" \
  || [ "$(image_version "$target")" != "$tag" ]; then finish skipped digest_mismatch 1; fi
# Patch releases never change the database: the release workflow refuses them, and so does this check.
hash='^[a-f0-9]{64}$'
old=$(migrations_of "$current") || old=
new=$(migrations_of "$target") || new=
if ! printf '%s\n' "$old" | grep -Eq "$hash" || ! printf '%s\n' "$new" | grep -Eq "$hash"; then finish skipped image_check_failed 1; fi
[ "$old" = "$new" ] || finish skipped migration_in_patch 1

history_install
swap_image "$target"
exit 0
