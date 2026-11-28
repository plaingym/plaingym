#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# ./update.sh IMAGE           Update to an explicit image, run by the owner (deploy/README.md, "Updates and recovery").
# ./update.sh --unsigned IMAGE The same for an image with no release version label, which has no signature to check.
# ./update.sh --patch [--now] The nightly timer's run: install the newest signed patch release of the running minor
#                             version, once a night in the three hours from the start hour the owner picks in
#                             Settings → Updates (default 02:00–05:00), in the gym's timezone (--now: at once).
# The exit trap calls cleanup and what it uses, which shellcheck reads as unreachable.
# shellcheck disable=SC2317,SC2329
set -eu
umask 077
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# Bootstrap recovery must stay self-contained: this script and lib.sh may be different generations.
# Keep this protocol in sync with rotate-key.sh; take the lock before reading or restoring host files.
[ "$(id -u)" -eq 0 ] || { echo 'Run update.sh as root.' >&2; exit 1; }
[ -f "$ROOT/.env" ] || { echo 'Missing installation .env.' >&2; exit 1; }
exec 9>"$ROOT/.update.lock"
flock -n 9 || { [ "${1:-}" = --patch ] && { echo 'Another update is running; this run does nothing.'; exit 0; }; echo 'An update or key rotation is running.' >&2; exit 1; }
bootstrap_recover() {
  [ -d "$ROOT/.host-update" ] || return 0
  [ -s "$ROOT/.host-update/target" ] && [ -d "$ROOT/.host-update/before/files" ] || return 1
  bootstrap_units=${SYSTEMD_UNIT_DIR:-/etc/systemd/system}
  bootstrap_pin=$(awk 'index($0, "APP_IMAGE=") == 1 { value=substr($0, 11) } END { print value }' "$ROOT/.env") || return 1
  bootstrap_restored=false
  if [ "$bootstrap_pin" != "$(cat "$ROOT/.host-update/target")" ]; then
    echo 'Restoring host files from the unfinished update.' >&2
    for bootstrap_file in update.sh lib.sh rotate-key.sh restore.sh systemd/plaingym-update.service systemd/plaingym-update.timer; do
      bootstrap_dest="$ROOT/$bootstrap_file"
      if [ -f "$ROOT/.host-update/before/files/$bootstrap_file" ]; then
        case "$bootstrap_file" in update.sh|rotate-key.sh|restore.sh) bootstrap_mode=0700 ;; *) bootstrap_mode=0644 ;; esac
        mkdir -p "$(dirname "$bootstrap_dest")" || return 1
        install -m "$bootstrap_mode" "$ROOT/.host-update/before/files/$bootstrap_file" "$bootstrap_dest.host-next" || return 1
        mv -f "$bootstrap_dest.host-next" "$bootstrap_dest" || return 1
      else rm -f "$bootstrap_dest" || return 1; fi
    done
    for bootstrap_unit in plaingym-update.service plaingym-update.timer; do
      bootstrap_dest="$bootstrap_units/$bootstrap_unit"
      if [ -f "$ROOT/.host-update/before/units/$bootstrap_unit" ]; then
        mkdir -p "$bootstrap_units" || return 1
        install -m 0644 "$ROOT/.host-update/before/units/$bootstrap_unit" "$bootstrap_dest.host-next" || return 1
        mv -f "$bootstrap_dest.host-next" "$bootstrap_dest" || return 1
      else rm -f "$bootstrap_dest" || return 1; fi
    done
    sync -f "$ROOT" "$bootstrap_units" || return 1
    systemctl daemon-reload || return 1
    bootstrap_restored=true
  fi
  sync -f "$ROOT" "$bootstrap_units" || return 1
  bootstrap_retired=$(mktemp -d "$ROOT/.host-retired.XXXXXX") || return 1
  mv "$ROOT/.host-update" "$bootstrap_retired/transaction" || return 1
  sync -f "$ROOT" || return 1
  rm -rf -- "$bootstrap_retired" || return 1
}
bootstrap_recover || { echo 'Host file recovery failed; run update.sh again to retry it.' >&2; exit 1; }
if [ "${bootstrap_restored:-false}" = true ]; then exec sh "$ROOT/update.sh" "$@" 9>&-; fi
# shellcheck source=deploy/lib.sh
. "$ROOT/lib.sh"
[ "$(id -u)" -eq 0 ] || fail 'Run update.sh as root.'
[ -f "$ROOT/.env" ] || fail 'Missing installation .env.'
# PostgreSQL and Caddy run the images .env names, except where a call below passes a new one.
unset POSTGRES_IMAGE CADDY_IMAGE
usage='Usage: ./update.sh [--unsigned] IMAGE (explicit semver tag or sha256 digest) | ./update.sh --patch [--now] | ./update.sh --rollback'
patch=false
now=false
requested_rollback=false
# --unsigned allows only an image with no release version label; a labelled image is always verified.
unsigned=false
request=
case "$#:${1:-}:${2:-}" in
  1:--rollback:) requested_rollback=true ;;
  1:--patch:) patch=true ;;
  2:--patch:--now) patch=true; now=true ;;
  2:--unsigned:-*) fail "$usage" ;;
  2:--unsigned:*) unsigned=true; request=$2; valid_image "$2" || fail 'Use an explicit semver tag or sha256 digest.' ;;
  1:-*) fail "$usage" ;;
  1:*) request=$1; valid_image "$1" || fail 'Use an explicit semver tag or sha256 digest.' ;;
  *) fail "$usage" ;;
esac
current=$(read_env APP_IMAGE)
STATE="$ROOT/auto-update.state"
PENDING="$ROOT/auto-update.result"
NOTICES="$ROOT/auto-update.notices"
INFLIGHT="$ROOT/.auto-update.inflight"
ATTEMPT="$ROOT/.schema-attempt"
RECOVERY="$ROOT/.schema-recovery"
# Exists exactly while PostgreSQL or Caddy may run another image than .env names; the next run starts those first.
INFRA="$ROOT/.infrastructure-update"
recovery_version=
work=
host_source=
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
was_running=false
changed=false
interrupted=false
previous_id=
swap_pin=
attempt_end=failed
# The PostgreSQL and Caddy images this update moves to (infrastructure_plan), the IDs of the images they replace, and
# whether either service was started on its new image.
infra_postgres=
infra_caddy=
infra_postgres_before=
infra_caddy_before=
infra_started=false
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
  # Keep the attempt when .env can't be rewritten, so the next run settles it again.
  restore_schema_guard || { echo "Could not rewrite .env (is the disk full?), so $from_version stays stopped. Free some space and run update.sh again." >&2; return 1; }
  rm -f "$ATTEMPT"
  attempt_end=abandoned
  target_floor=-
}
infrastructure_restore() ( # PostgreSQL and Caddy on the images .env names.
  # A call that failed under set -e leaves its APP_IMAGE=, POSTGRES_IMAGE= or CADDY_IMAGE= in the exit handler's
  # environment; here every value comes from .env.
  unset APP_IMAGE POSTGRES_IMAGE CADDY_IMAGE
  compose_exec up -d --no-deps --pull never --wait --wait-timeout 120 postgres caddy
)
rollback() {
  # PostgreSQL first, so the attempt can be settled and the previous app started against the image .env names.
  if [ "$infra_started" = true ]; then
    compose stop app || true
    if ! infrastructure_restore; then
      echo 'Could not start PostgreSQL and Caddy on their previous images.' >&2
      return 1
    fi
    rm -f "$INFRA"
    infra_started=false
  fi
  settle_attempt || return 1
  # A recovery retry that changed nothing still cannot restart code below the already-migrated floor.
  if [ -f "$RECOVERY" ]; then
    recovery_notice
    return 1
  fi
  APP_IMAGE="$previous_id" compose up -d --no-deps --pull never --wait --wait-timeout 90 app && return 0
  # An own Compose file that broke since the last start would keep the previous version down too: try once without.
  [ -n "$(owner_compose_files)" ] || return 1
  echo "The previous version didn't start with this install's own Compose files, so it starts without them. Fix them, then run sudo docker compose up -d." >&2
  OWN_COMPOSE_FILES=off APP_IMAGE="$previous_id" compose up -d --no-deps --pull never --wait --wait-timeout 90 app
}
cleanup() {
  exit_status=$?
  trap - EXIT HUP INT TERM
  # The rename of .env commits both the image and its host files, even if a signal arrived immediately after it.
  if { [ "$changed" = true ] || [ "$stage" = finished ]; } && [ "$(read_env APP_IMAGE)" = "$swap_pin" ]; then
    changed=false; stopped=false; stage=finished
    rm -f "$ATTEMPT" "$RECOVERY" "$ROOT/schema-compatibility.yaml.before" "$INFRA"
    infra_started=false
    exit_status=0
  fi
  # Restore before rollback uses Compose or any other release-owned file. Leave the journal for a retry on failure.
  if ! host_recover; then echo 'Host file recovery failed; run update.sh again to retry it.' >&2; exit_status=1; fi
  outcome=unchanged
  if [ "$exit_status" -ne 0 ] && [ "$changed" = true ]; then
    if [ "$requested_rollback" = true ]; then echo 'Rollback failed; restarting the original image.' >&2
    elif [ -f "$RECOVERY" ]; then echo 'Update failed; the previous version stays stopped.' >&2
    else echo 'Update failed; restarting the previous image.' >&2; fi
    if rollback; then outcome=rolled_back; else outcome=rollback_failed; exit_status=1; fi
  elif [ "$stopped" = true ] && [ "$was_running" = true ]; then
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
      if [ "$requested_rollback" = false ]; then
        prune_images || true; prune_host_history || true
        infrastructure_prune "$infra_postgres" "$infra_postgres_before"
        infrastructure_prune "$infra_caddy" "$infra_caddy_before"
        prune_infrastructure_pulled || true
      fi
    else
      history_record "$to_version" "$target_id" "$attempt_end" "$target_floor" "$snapshot"
      if [ "$outcome" = rolled_back ] || [ "$outcome" = restarted ]; then
        history_record "$from_version" "$previous_id" rollback "$(schema_floor)" "$snapshot"
      fi
    fi
  fi
  if [ "$requested_rollback" = true ] && [ "$stage" != none ] && [ "$stage" != finished ]; then
    if [ "$outcome" = rollback_failed ]; then report failed rollback_failed
    elif [ "$stage" = snapshot ]; then report skipped snapshot_failed
    elif [ "$stage" = startup ]; then report rolled_back startup_failed
    else report rolled_back health_check_failed; fi
  fi
  # Send once, after every result for this run has reached the app.
  send_notices || true
  [ -z "$work" ] || rm -rf -- "$work"
  [ -z "$snapshot_file" ] || rm -f -- "$snapshot_file"
  exit "$exit_status"
}
# Both snapshot paths bypass the normal entrypoint, which may be why the app cannot start.
# Keep its database checks and verified restore resumption, but never migrate before the snapshot.
maintenance_snapshot() { # KIND
  # shellcheck disable=SC2016
  compose run --rm --no-deps -T --entrypoint sh app -ec '
    /app/deploy/database.sh wait
    /app/deploy/database.sh roles
    node ${PLAINGYM_NODE_FLAGS:-} /app/maintenance.mjs resume
    shift
    exec node ${PLAINGYM_NODE_FLAGS:-} "$@"
  ' snapshot node /app/maintenance.mjs snapshot "$1"
}
# Stop the app, snapshot, start the target, check it, and pin it. The manual path pulls first.
swap_image() { # TARGET
  swap_pin=$1
  # Preserve Compose's own diagnostics: an unavailable daemon or bad file is not a stopped app.
  running_services=$(compose ps --status running --services) || fail 'Could not check whether the app is running; fix the Compose error above and retry.'
  if printf '%s\n' "$running_services" | grep -qx app; then was_running=true; else was_running=false; fi
  if [ "$requested_rollback" = false ] && [ -z "$recovery_version" ]; then
    [ "$was_running" = true ] || fail 'The app must be running before an update.'
  fi
  if [ -z "$recovery_version" ]; then previous_id=$(docker image inspect "$current" --format '{{.Id}}')
  else
    # Host-file history still needs the old image's identity, even when the image itself is gone.
    previous_id=$(awk -F '\t' -v version="$from_version" '$2 == version && $4 ~ /^(install|update|rollback)$/ { image=$3 } END { print image }' "$ROOT/version-history.tsv")
  fi
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
  # Its own message above says why it failed, such as backups that aren't set up yet (Settings → Integrations).
  snapshot_file=$(mktemp "$ROOT/.snapshot.XXXXXX")
  if [ -n "$recovery_version" ]; then
    # The pinned image is below the floor. Use the recorded compatible image without migrating first.
    recovery_image=$(cut -f4 "$RECOVERY")
    if [ "$(image_version "$recovery_image")" != "$recovery_version" ] || ! version_at_least "$recovery_version" "$(schema_floor)"; then
      fail 'The recovery image is missing or incompatible. Restore the pre-upgrade snapshot; see docs/restoring.md.'
    fi
    # Keep retries out of the two pre-upgrade slots, so they cannot evict the pre-migration restore point.
    APP_IMAGE="$recovery_image" maintenance_snapshot manual > "$snapshot_file" \
      || fail 'The pre-upgrade snapshot failed (reason above). The app stays stopped; retry the recovery update.'
  else
    snapshot_failure='The pre-upgrade snapshot failed (reason above). Nothing was changed; the app stays stopped.'
    [ "$was_running" = false ] || snapshot_failure='The pre-upgrade snapshot failed (reason above). Nothing was changed; the current version is restarting.'
    maintenance_snapshot pre-upgrade > "$snapshot_file" \
      || fail "$snapshot_failure"
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
      if [ -z "$schema_before" ]; then
        if [ -n "$recovery_version" ]; then fail "The database's migrations couldn't be read. The app stays stopped; retry the recovery update."
        else fail "The database's migrations couldn't be read. Nothing was changed; the current version is restarting."; fi
      fi
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
  # The snapshot above ran on the old PostgreSQL, and the app is stopped.
  if [ -n "$infra_postgres" ]; then
    : > "$INFRA"
    infra_started=true
    POSTGRES_IMAGE="$infra_postgres" compose up -d --no-deps --pull never --wait --wait-timeout 120 postgres
    infrastructure_database_check || fail "PostgreSQL on $infra_postgres is not major 18 or its collation version differs from the database's; restoring the previous images."
  fi
  APP_IMAGE="$1" compose up -d --no-deps --pull never --wait --wait-timeout 90 app
  stage=health
  APP_IMAGE="$1" compose exec -T app node /app/deploy/healthcheck.mjs
  [ "$patch" = false ] || settle "$1"
  if [ -n "$infra_caddy" ]; then
    : > "$INFRA"
    infra_started=true
    CADDY_IMAGE="$infra_caddy" compose up -d --no-deps --pull never --wait --wait-timeout 60 caddy
    infrastructure_caddy_settle || fail "Caddy on $infra_caddy did not keep running; restoring the previous images."
  fi
  if [ -n "$host_source" ]; then host_apply "$host_source" "$1" "$previous_id" || fail 'Could not install the signed host files; restoring the previous copies.'; fi
  # Startup completes migrations before reporting healthy. Publish the pin only afterwards, in one rename with the
  # PostgreSQL and Caddy images it ran with.
  set -- APP_IMAGE
  [ -z "$infra_postgres" ] || set -- "$@" POSTGRES_IMAGE
  [ -z "$infra_caddy" ] || set -- "$@" CADDY_IMAGE
  awk -v image="$swap_pin" -v postgres="$infra_postgres" -v caddy="$infra_caddy" '
    function put(key, value) { if (!(key in done)) print key "=" value; done[key] = 1 }
    /^APP_IMAGE=/ { print "APP_IMAGE=" image; found=1; next }
    postgres != "" && /^POSTGRES_IMAGE=/ { put("POSTGRES_IMAGE", postgres); next }
    caddy != "" && /^CADDY_IMAGE=/ { put("CADDY_IMAGE", caddy); next }
    { print }
    END { if (!found) print "APP_IMAGE=" image; if (postgres != "") put("POSTGRES_IMAGE", postgres); if (caddy != "") put("CADDY_IMAGE", caddy) }' "$ROOT/.env" > "$ROOT/.env.next" \
    || { rm -f "$ROOT/.env.next"; fail 'Could not write .env; the update was not applied.'; }
  env_install "$ROOT/.env.next" "$@" || fail 'Could not write .env; the update was not applied.'
  rm -f "$RECOVERY" "$ATTEMPT" "$ROOT/schema-compatibility.yaml.before" "$INFRA"
  infra_started=false
  stage=finished
  changed=false
}
# A healthy start must stay healthy: wait, then check that the same container still runs, healthy and never restarted.
settle() { # TARGET
  container=$(compose ps -q app)
  sleep "${UPDATE_SETTLE_SECONDS:-60}"
  [ "$(compose ps -q app)" = "$container" ] || return 1
  [ "$(docker inspect "$container" --format '{{.State.Health.Status}} {{.RestartCount}}')" = 'healthy 0' ] || return 1
  APP_IMAGE="$1" compose exec -T app node /app/deploy/healthcheck.mjs
}

# --- PostgreSQL and Caddy images (docs/update-reference.md, "PostgreSQL and Caddy images") ----------------------------
# An update to a newer signed release moves them to the images its manifest names. compose.yaml is never written: the
# override infrastructure-images.yaml reads POSTGRES_IMAGE and CADDY_IMAGE from .env, which the pin's rename commits.
own_compose_files() { # Whether this install has Compose files of its own (lib.sh, owner_compose_files).
  # Every Compose call loads them, but infrastructure-images.yaml comes after them and would replace an image they name.
  [ -n "$(owner_compose_files)" ]
}
# Whether an own Compose file names the app's image, which would replace the release every Compose call starts.
own_app_image() {
  own_compose_files || return 1
  own_probe=plaingym-update-probe
  own_images=$(APP_IMAGE=$own_probe compose config --images app 2>/dev/null) || return 1
  [ -n "$own_images" ] && [ "$own_images" != "$own_probe" ]
}
# Sets infra_postgres and infra_caddy to the images to move to, and pulls and checks them before anything stops.
# Returns 2 when an image can't be pulled, and 1 when one fails its check or the Compose files can't be written.
infrastructure_plan() { # MANIFEST
  infrastructure_pin_notice
  infra_postgres=
  infra_caddy=
  [ -n "$(manifest_value "$1" postgres_image)" ] || return 0
  [ -z "$recovery_version" ] || return 0
  valid_version "$from_version" && valid_version "$to_version" || return 0
  [ "$to_version" != "$from_version" ] && version_at_least "$to_version" "$from_version" || return 0
  if own_compose_files; then
    echo 'This install has its own Compose files, so its PostgreSQL and Caddy images stay as they are. See docs/update-reference.md.'
    return 0
  fi
  infra_services=
  for infra_service in postgres caddy; do
    infra_base=$(compose_image "$ROOT/compose.yaml" "$infra_service") || infra_base=
    case "$infra_service" in
      postgres) infra_pattern=$postgres_image_pattern; infra_current=$(read_env POSTGRES_IMAGE) ;;
      *) infra_pattern=$caddy_image_pattern; infra_current=$(read_env CADDY_IMAGE) ;;
    esac
    if ! printf '%s\n' "$infra_base" | grep -Eq "$infra_pattern"; then
      echo "compose.yaml names its own image for $infra_service, so it stays as it is."
      continue
    fi
    infra_services="$infra_services $infra_service"
    [ -n "$infra_current" ] || infra_current=$infra_base
    infra_new=$(manifest_value "$1" "${infra_service}_image")
    [ "$infra_new" != "$infra_current" ] || continue
    infra_before=$(docker image inspect "$infra_current" --format '{{.Id}}' 2>/dev/null) || infra_before=
    case "$infra_service" in
      postgres) infra_postgres=$infra_new; infra_postgres_before=$infra_before ;;
      *) infra_caddy=$infra_new; infra_caddy_before=$infra_before ;;
    esac
  done
  [ -n "$infra_postgres$infra_caddy" ] || return 0
  if [ -n "$infra_postgres" ]; then docker pull "$infra_postgres" || return 2; remember_infrastructure_image "$infra_postgres"; fi
  if [ -n "$infra_caddy" ]; then docker pull "$infra_caddy" || return 2; remember_infrastructure_image "$infra_caddy"; fi
  if [ -n "$infra_postgres" ]; then
    docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pull never \
      --entrypoint postgres "$infra_postgres" --version | grep -Eq '^postgres \(PostgreSQL\) 18\.' || return 1
  fi
  if [ -n "$infra_caddy" ]; then
    # The caddy binary carries the capability to bind ports 80 and 443, and can't run where it is dropped.
    docker run --rm --network none --read-only --cap-drop ALL --cap-add NET_BIND_SERVICE --security-opt no-new-privileges \
      --pull never --entrypoint caddy "$infra_caddy" version | grep -q '^v2\.' || return 1
  fi
  # Until .env names another image the override gives each service compose.yaml's own, so this changes nothing yet.
  # shellcheck disable=SC2086 # Service names only.
  infrastructure_file $infra_services > "$ROOT/infrastructure-images.yaml.next" \
    || { rm -f "$ROOT/infrastructure-images.yaml.next"; return 1; }
  if cmp -s "$ROOT/infrastructure-images.yaml.next" "$ROOT/infrastructure-images.yaml"; then
    rm -f "$ROOT/infrastructure-images.yaml.next"
  else
    mv "$ROOT/infrastructure-images.yaml.next" "$ROOT/infrastructure-images.yaml" \
      || { rm -f "$ROOT/infrastructure-images.yaml.next"; return 1; }
  fi
  # Ordinary `docker compose` commands load the same files as the updater's explicit -f arguments.
  infra_listed=$(read_env COMPOSE_FILE)
  case ":$infra_listed:" in
    *:infrastructure-images.yaml:*) ;;
    *)
      { awk '!/^COMPOSE_FILE=/' "$ROOT/.env" > "$ROOT/.env.infrastructure-next" \
        && printf 'COMPOSE_FILE=%s\n' "${infra_listed:-compose.yaml}:infrastructure-images.yaml" >> "$ROOT/.env.infrastructure-next" \
        && env_install "$ROOT/.env.infrastructure-next" COMPOSE_FILE; } \
        || { rm -f "$ROOT/.env.infrastructure-next"; return 1; } ;;
  esac
}
infrastructure_database_check() { # PostgreSQL answers on major 18, with the collation version its database recorded.
  # shellcheck disable=SC2016
  [ "$(compose exec -T postgres sh -c 'exec psql -X -U postgres -d "$POSTGRES_DB" -qtAc "$1"' sh \
    "select current_setting('server_version_num')::int / 10000, coalesce((select datcollversion is not distinct from pg_database_collation_actual_version(oid) from pg_database where datname = current_database()), true)")" = '18|t' ]
}
infrastructure_caddy_settle() { # Caddy keeps running on its new image: the same container, never restarted.
  infra_container=$(compose ps -q caddy) && [ -n "$infra_container" ] || return 1
  sleep "${UPDATE_INFRA_SETTLE_SECONDS:-10}"
  [ "$(compose ps -q caddy)" = "$infra_container" ] || return 1
  [ "$(docker inspect "$infra_container" --format '{{.State.Status}} {{.RestartCount}}')" = 'running 0' ]
}
infrastructure_prune() { # NEW_IMAGE BEFORE_ID: after a successful update, the image a service ran before goes.
  [ -n "$1" ] && [ -n "$2" ] || return 0
  [ "$(docker image inspect "$1" --format '{{.Id}}' 2>/dev/null || true)" != "$2" ] || return 0
  remove_image "$2" || true
}
# Each PostgreSQL or Caddy image an update pulled is listed once in infrastructure-pulled.txt, so a later successful
# update removes one that never ran (its update failed, and a later release names others). Recording never fails one.
remember_infrastructure_image() { # IMAGE
  infra_pulled_id=$(docker image inspect "$1" --format '{{.Id}}' 2>/dev/null) || return 0
  printf '%s\n' "$infra_pulled_id" | grep -Eq '^sha256:[a-f0-9]{64}$' || return 0
  if [ -f "$ROOT/infrastructure-pulled.txt" ] && grep -qxF "$infra_pulled_id" "$ROOT/infrastructure-pulled.txt"; then return 0; fi
  { printf '%s\n' "$infra_pulled_id" >> "$ROOT/infrastructure-pulled.txt"; } 2>/dev/null \
    || echo 'Could not record the pulled PostgreSQL or Caddy image for later cleanup.' >&2
}
# After a successful update, each listed image goes unless .env or compose.yaml names it; one Docker refuses to remove
# (a container uses it) stays listed, so a later update tries again. Never forced.
prune_infrastructure_pulled() {
  [ -f "$ROOT/infrastructure-pulled.txt" ] || return 0
  infra_keep=
  for infra_named in "$(read_env POSTGRES_IMAGE)" "$(read_env CADDY_IMAGE)" \
    "$(compose_image "$ROOT/compose.yaml" postgres)" "$(compose_image "$ROOT/compose.yaml" caddy)"; do
    [ -n "$infra_named" ] || continue
    infra_named_id=$(docker image inspect "$infra_named" --format '{{.Id}}' 2>/dev/null) || continue
    infra_keep=$(printf '%s\n%s' "$infra_keep" "$infra_named_id")
  done
  : > "$ROOT/infrastructure-pulled.txt.next" || return 1
  while IFS= read -r infra_pulled_id || [ -n "$infra_pulled_id" ]; do
    printf '%s\n' "$infra_pulled_id" | grep -Eq '^sha256:[a-f0-9]{64}$' || continue
    ! grep -qxF "$infra_pulled_id" "$ROOT/infrastructure-pulled.txt.next" || continue
    if ! printf '%s\n' "$infra_keep" | grep -qxF "$infra_pulled_id"; then
      remove_image "$infra_pulled_id" || true
      docker image inspect "$infra_pulled_id" >/dev/null 2>&1 || continue
    fi
    printf '%s\n' "$infra_pulled_id" >> "$ROOT/infrastructure-pulled.txt.next" \
      || { rm -f "$ROOT/infrastructure-pulled.txt.next"; return 1; }
  done < "$ROOT/infrastructure-pulled.txt"
  mv "$ROOT/infrastructure-pulled.txt.next" "$ROOT/infrastructure-pulled.txt"
}
# Once .env names a service's image, the override gives it that image and compose.yaml's image line does nothing. Says
# so when that line changed since the override was written; it changes no file.
infrastructure_pin_notice() {
  [ -f "$ROOT/infrastructure-images.yaml" ] || return 0
  for infra_service in postgres caddy; do
    case "$infra_service" in postgres) infra_variable=POSTGRES_IMAGE ;; *) infra_variable=CADDY_IMAGE ;; esac
    infra_pin=$(read_env "$infra_variable")
    infra_written=$(compose_image "$ROOT/infrastructure-images.yaml" "$infra_service") || infra_written=
    infra_written=${infra_written#*:-}
    infra_written=${infra_written%\}}
    infra_base=$(compose_image "$ROOT/compose.yaml" "$infra_service") || infra_base=
    [ -n "$infra_pin" ] && [ -n "$infra_written" ] && [ -n "$infra_base" ] || continue
    [ "$infra_base" != "$infra_written" ] && [ "$infra_base" != "$infra_pin" ] || continue
    echo "compose.yaml names $infra_base for $infra_service, but $infra_variable in .env decides its image ($infra_pin). To change it, edit $infra_variable in .env."
  done
}
# The restore after a run killed outright failed. With an automatic update's marker this is that update's failed
# rollback: report it once, as the in-flight block reports its own failed start, and each later run tries again.
infrastructure_restore_failed() {
  infra_message='PostgreSQL or Caddy did not start on the images .env names. Fix the error above and run update.sh again.'
  [ -f "$INFLIGHT" ] || fail "$infra_message"
  read -r from_version to_version down_at left_by < "$INFLIGHT" || true
  valid_version "$from_version" || from_version=-
  valid_version "$to_version" || to_version=-
  [ "${left_by:-}" != rollback_failed ] || fail "$infra_message"
  patch=true
  requested_rollback=false
  work=$(mktemp -d)
  send_pending || true
  echo "$infra_message" >&2
  inflight_mark rollback_failed
  if [ "$from_version" = - ] || [ "$to_version" = - ]; then exit 1; fi
  count_failure
  finish failed rollback_failed 1
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
pending_args() { # COMMAND: the current checked queue line, shared by result recording and notice retries.
  set -- "$1" --at "$pending_at" --result "$pending_result"
  [ "$pending_reason" = - ] || set -- "$@" --reason "$pending_reason"
  [ "$pending_from" = - ] || set -- "$@" --from "$pending_from"
  [ "$pending_to" = - ] || set -- "$@" --to "$pending_to"
  [ "${pending_failures:--}" = - ] || set -- "$@" --failures "$pending_failures"
  [ "${pending_down:--}" = - ] || set -- "$@" --down-at "$pending_down"
  [ "$1" != record ] || set -- "$@" --notice deferred
  compose exec -T app gym-app auto-update "$@" >/dev/null
}
send_pending() { # Oldest first; each result leaves the file once the app took it, and a later one never replaces it.
  [ -f "$PENDING" ] || return 0
  while [ -s "$PENDING" ]; do
    # Written by report below from checked values only: instants, fixed words, release versions and a count.
    read -r pending_at pending_result pending_reason pending_from pending_to pending_failures pending_down < "$PENDING" || return 1
    app_running || return 1
    record_status=0
    pending_args record || record_status=$?
    # Exit 2 is the app refusing the result itself, which no retry changes: say so, and go on with the next.
    if [ "$record_status" -eq 2 ]; then echo "The app refused the recorded result \"$pending_result $pending_reason\" from $pending_at; it was dropped." >&2
    elif [ "$record_status" -ne 0 ]; then return 1
    else
      case "$pending_result" in rolled_back|failed)
        pending_line=$(head -n 1 "$PENDING")
        # Append before removing the result. A crash replays the stored result and its per-owner delivery key.
        if [ ! -f "$NOTICES" ] || ! grep -qxF "$pending_line" "$NOTICES"; then printf '%s\n' "$pending_line" >> "$NOTICES" || return 1; fi ;;
      esac
    fi
    tail -n +2 "$PENDING" > "$PENDING.next" || return 1
    mv "$PENDING.next" "$PENDING" || return 1
  done
  rm -f "$PENDING"
}
send_notices() {
  # Results are drained first, including a recovered failed rollback, so owners hear the whole outage in one notice.
  [ ! -s "$PENDING" ] || return 1
  [ -s "$NOTICES" ] || return 0
  app_running || return 1
  awk '
    NR == FNR { if ($2 == "rolled_back" && $3 == "rollback_failed" && $7 != "-") {
      n++; from[n]=$4; to[n]=$5; down[n]=$7; recovered[n]=$1
    } next }
    $2 == "failed" && $3 == "rollback_failed" {
      for (i=1;i<=n;i++) if ($4 == from[i] && $5 == to[i] && $1 >= down[i] && $1 <= recovered[i]) next
    }
    { print }' "$NOTICES" "$NOTICES" > "$NOTICES.next" || return 1
  mv "$NOTICES.next" "$NOTICES" || return 1
  : > "$NOTICES.retry" || return 1
  # Try each notice once: a refused mailbox cannot starve any later notice.
  while read -r pending_at pending_result pending_reason pending_from pending_to pending_failures pending_down; do
    notice_status=0
    pending_args notice </dev/null || notice_status=$?
    case "$notice_status" in
      0) ;;
      2) echo 'The app refused an automatic update notice; it was dropped.' >&2 ;;
      *) printf '%s %s %s %s %s %s %s\n' "$pending_at" "$pending_result" "$pending_reason" "$pending_from" "$pending_to" "${pending_failures:--}" "${pending_down:--}" >> "$NOTICES.retry" || return 1 ;;
    esac
  done < "$NOTICES"
  mv "$NOTICES.retry" "$NOTICES" || return 1
  if [ -s "$NOTICES" ]; then echo 'An owner notice could not be sent yet; the next run retries it.' >&2; return 1; fi
  rm -f "$NOTICES"
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
remember_image() { # ID PIN VERSION: each image this updater pulled is listed once.
  printf '%s\n' "$1" | grep -Eq '^sha256:[a-f0-9]{64}$' || return 0
  if [ -f "$ROOT/auto-update-images.tsv" ] && cut -f2 "$ROOT/auto-update-images.tsv" | grep -qxF "$1"; then return 0; fi
  printf '%s\t%s\t%s\n' "$2" "$1" "$3" >> "$ROOT/auto-update-images.tsv" \
    || echo 'Could not record the pulled image for later cleanup.' >&2
}
remember_manual_image() { # IMAGE VERSION: retain a pullable pin for rollback, without changing history's format.
  manual_id=$(docker image inspect "$1" --format '{{.Id}}' 2>/dev/null) || return 0
  manual_pin=$(registry_pin "$manual_id" "$2")
  [ -n "$manual_pin" ] || return 0
  remember_image "$manual_id" "$manual_pin" "$2"
}
remove_image() { # IMAGE_ID: never forced, and bounded, so maintenance can't hold the update lock forever.
  printf '%s\n' "$1" | grep -Eq '^sha256:[a-f0-9]{64}$' || return 1
  docker image inspect "$1" >/dev/null 2>&1 || return 0
  # Docker refuses an image a container uses or that names in other repositories refer to; that refusal stands.
  timeout -k 5 30 docker image rm "$1" >/dev/null 2>&1
}
docker_reports() { # STDERR MESSAGE: match a complete Docker error line even when warnings precede it.
  printf '%s\n' "$1" | grep -Fxq -e "$2" -e "Error: $2" -e "Error response from daemon: $2"
}
cleanup_snapshot_check() {
  # Docker may still be creating the container when the first removal runs.
  timeout -k 5 10 docker rm -f "$1" >/dev/null 2>&1 || case "$?" in 124|137) return 1 ;; esac
  for snapshot_check_attempt in 1 2; do
    [ "$snapshot_check_attempt" -eq 1 ] || sleep 1
    # Capture stderr while discarding stdout, which can include container configuration.
    if snapshot_check_error=$(timeout -k 5 10 docker container inspect "$1" 2>&1 >/dev/null); then
      break
    else
      case "$?" in 124|137) return 1 ;; esac
    fi
    if [ "$snapshot_check_attempt" -eq 2 ]; then
      docker_reports "$snapshot_check_error" "No such container: $1"
      return
    fi
  done

  if snapshot_check_error=$(timeout -k 5 10 docker rm -f "$1" 2>&1 >/dev/null); then
    return 0
  else
    case "$?" in 124|137) return 1 ;; esac
  fi
  if ! docker_reports "$snapshot_check_error" "removal of container $1 is already in progress"; then
    docker_reports "$snapshot_check_error" "No such container: $1"
    return
  fi

  for snapshot_check_poll in 1 2 3 4 5; do
    [ "$snapshot_check_poll" -eq 1 ] || sleep 1
    if snapshot_check_error=$(timeout -k 5 10 docker container inspect "$1" 2>&1 >/dev/null); then
      continue
    else
      case "$?" in 124|137) return 1 ;; esac
    fi
    if docker_reports "$snapshot_check_error" "No such container: $1"; then
      return 0
    fi
  done
  return 1
}
# After a successful update, keep the current image and the two before it (the rollback stack's top
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
    # A kept image stays listed even if it was removed outside the updater: --rollback pulls it again by this pin.
    if ! printf '%s\n' "$kept" | grep -qxF "$pulled_id"; then
      # Other references removed or retagged outside the updater no longer belong in its inventory.
      [ "$(docker image inspect "$pulled_ref" --format '{{.Id}}' 2>/dev/null || true)" = "$pulled_id" ] || continue
      remove_image "$pulled_id" && continue
    fi
    printf '%s\t%s\t%s\n' "$pulled_ref" "$pulled_id" "$pulled_version" >> "$ROOT/auto-update-images.tsv.next"
  done < "$ROOT/auto-update-images.tsv"
  mv "$ROOT/auto-update-images.tsv.next" "$ROOT/auto-update-images.tsv"
}
migrations_of() { # IMAGE: a digest of the migrations the image applies when it starts
  docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges --entrypoint sh "$1" \
    -c 'cd /app/migrations && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum' | awk '{ print $1 }'
}
prune_host_history() { # After prune_images, which keeps saved pins only for images --rollback can still use.
  [ -d "$ROOT/.host-history" ] || return 0
  # A daemon failure is not evidence that every image disappeared.
  host_images=$(docker image ls --quiet --no-trunc) || return 0
  # --rollback pulls a kept image again by its saved pin, so its generation stays while the pin does.
  if [ -f "$ROOT/auto-update-images.tsv" ]; then
    host_images=$(printf '%s\n' "$host_images"; cut -f2 "$ROOT/auto-update-images.tsv") || return 0
  fi
  for host_history in "$ROOT/.host-history/"*; do
    [ -d "$host_history" ] || continue
    host_id=${host_history##*/}
    printf '%s\n' "$host_id" | grep -Eq '^[a-f0-9]{64}$' || continue
    printf '%s\n' "$host_images" | grep -qxF "sha256:$host_id" || rm -rf -- "$host_history" || return 1
  done
}

rotation_check
trap cleanup EXIT
trap 'interrupted=true; exit 130' HUP INT TERM
host_recover || fail 'Could not recover host files from an interrupted update.'

# A run killed outright while PostgreSQL or Caddy may have run a new image: put both back on the images .env names
# first. The blocks below then start the pinned app as before.
if [ -f "$INFRA" ]; then
  echo 'An earlier update stopped while changing PostgreSQL or Caddy; starting the images .env names.' >&2
  infrastructure_restore || infrastructure_restore_failed
  rm -f "$INFRA"
fi

# A run killed outright during a manual update left its record: finish what its exit handler would have done.
# This run only does that, even when --rollback started it, so it reports the earlier update, not a rollback.
if [ -f "$ATTEMPT" ]; then
  read -r _ from_version to_version target_id target_floor snapshot < "$ATTEMPT"
  if [ -f "$RECOVERY" ]; then
    from_version=$(cut -f2 "$RECOVERY")
    # The obsolete pinned image may have been pruned. Only inspect opportunistically to detect a committed pin.
    committed_id=$(docker image inspect "$current" --format '{{.Id}}' 2>/dev/null || true)
  else
    previous_id=$(docker image inspect "$current" --format '{{.Id}}')
    committed_id=$previous_id
  fi
  if [ "$committed_id" = "$target_id" ]; then
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

if [ -f "$INFLIGHT" ]; then
  # Finish the interrupted patch before accepting a separate manual update or rollback request.
  patch=true
  requested_rollback=false
  work=$(mktemp -d)
  send_pending || true
  read -r from_version to_version down_at left_by < "$INFLIGHT" || true
  valid_version "$from_version" || from_version=-
  valid_version "$to_version" || to_version=-
  printf '%s\n' "${down_at:-}" | grep -Eq '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' || down_at=-
  [ "${left_by:-}" = rollback_failed ] || left_by=-
  if [ "$left_by" = rollback_failed ]; then echo 'The previous automatic update and its rollback failed; starting the pinned image again.' >&2
  else echo 'The previous automatic update was interrupted; starting the pinned image again.' >&2; fi
  if ! compose up -d --no-deps --wait --wait-timeout 90 app; then
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
    report_failures=$(failure_count "$to_version"); [ "$report_failures" -gt 0 ] || report_failures=-
    report_down_at=$down_at
    finish rolled_back rollback_failed 1
  fi
  count_failure
  finish rolled_back interrupted 1
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
    snapshot_protection=
    if [ -n "$restore_snapshot" ] && [ "$restore_snapshot" != "$(guard_floor_snapshot)" ]; then
      snapshot_protection=' This history snapshot is not protected by the active schema guard and may have been pruned under normal retention.'
    fi
    # Use the current image's maintenance entry only: no migrations, snapshot, or service changes.
    snapshot_availability='Snapshot availability could not be checked; verify the backup destination before restoring.'
    if printf '%s\n' "$restore_snapshot" | grep -Eq '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'; then
      check_image=$current
      [ -z "$recovery_version" ] || check_image=$(cut -f4 "$RECOVERY")
      snapshot_check_name="plaingym-snapshot-check-$$-$(date +%s)"
      # Replace the timed shell so the deadline follows the Compose client through signal handling.
      # shellcheck disable=SC2016
      if snapshot_check=$(APP_IMAGE="$check_image" timeout -k 5 40 sh -c '
        ROOT=$1; shift
        . "$ROOT/lib.sh"
        compose_exec "$@"
      ' sh "$ROOT" run --rm --name "$snapshot_check_name" --no-deps -T --entrypoint node app /app/maintenance.mjs snapshot-check "$restore_snapshot" 2>/dev/null); then
        :
      else
        snapshot_check_status=$?
        snapshot_check=
        case "$snapshot_check_status" in
          124|137)
            # A timed-out Compose client may leave its one-off container behind.
            cleanup_snapshot_check "$snapshot_check_name" \
              || echo "Could not remove snapshot-check container $snapshot_check_name; remove it when Docker is available." >&2 ;;
        esac
      fi
      case "$snapshot_check" in
        'Snapshot availability: available') snapshot_availability='The named snapshot is available at the configured backup destination.' ;;
        'Snapshot availability: missing or incomplete') snapshot_availability="The named snapshot $restore_snapshot is missing or incomplete at the configured backup destination; choose another verified backup or retry a compatible release." ;;
      esac
    fi
    forward=
    [ -z "$recovery_version" ] || forward=" Or retry $recovery_version with ./update.sh IMAGE, or update to a newer compatible signed release, which keeps the data written since that snapshot."
    fail "Cannot roll back to $to_version: the schema requires $target_floor. Restore pre-upgrade snapshot ${restore_snapshot:-listed in version-history.tsv}; see docs/restoring.md.$snapshot_protection $snapshot_availability$forward Nothing was changed."
  fi
  printf '%s\n' "$target" | grep -Eq '^sha256:[a-f0-9]{64}$' || fail 'The previous image digest is invalid.'
  if ! target_id=$(docker image inspect "$target" --format '{{.Id}}' 2>/dev/null); then
    saved_pin=
    if [ -f "$ROOT/auto-update-images.tsv" ]; then
      saved_pin=$(awk -F '\t' -v image="$target" -v version="$to_version" '$2 == image && $3 == version { print $1; exit }' "$ROOT/auto-update-images.tsv")
    fi
    valid_image "$saved_pin" || fail 'The previous image is no longer local and has no saved registry pin. Pull its original image again or restore its pre-upgrade snapshot; see docs/restoring.md.'
    case "$saved_pin" in *":$to_version@sha256:"*) ;; *) fail 'The saved rollback image pin is invalid.' ;; esac
    APP_IMAGE="$saved_pin" compose pull app || fail 'Could not pull the previous image by its saved digest. Nothing was changed.'
    target_id=$(docker image inspect "$saved_pin" --format '{{.Id}}') || fail 'Could not inspect the pulled rollback image.'
  fi
  if [ "$target_id" != "$target" ] || [ "$(image_version "$target")" != "$to_version" ]; then
    fail 'The previous image identity does not match the history.'
  fi
  from_version=$(image_version "$current")
  # Pin it by name, tag and digest like an update, so the image can be pulled again if it is ever removed. An image
  # with no registry digest (a local build) has nowhere to come back from, so it keeps its image ID.
  pin=$(registry_pin "$target_id" "$to_version")
  if [ -d "$ROOT/.host-history/${target_id#sha256:}" ]; then host_source="$ROOT/.host-history/${target_id#sha256:}"; fi
  swap_image "${pin:-$target}"
  printf 'Rolled back to %s by digest. Pre-upgrade snapshot: %s.\n' "$to_version" "$snapshot"
  exit 0
fi

if [ "$patch" = false ]; then
  target=$request
  if [ -z "$recovery_version" ]; then
    [ "$target" != "$current" ] || { echo 'Already on the requested image.'; exit 0; }
  fi
  ! own_app_image || fail "This install's own Compose files name an image for the app, so an update would start that image instead of the release. Remove that image line (APP_IMAGE in .env names the app's image), then run this again. Nothing was changed."
  # Pull while the app runs, then compare what the request names with the running image: a tag of the running
  # release, or its digest, is the same image however the pin spells it.
  APP_IMAGE="$target" compose pull app
  target_id=$(docker image inspect "$target" --format '{{.Id}}')
  if [ -z "$recovery_version" ] && [ "$target_id" = "$(docker image inspect "$current" --format '{{.Id}}' 2>/dev/null || true)" ]; then
    echo 'Already on the requested image.'
    exit 0
  fi
  history_install
  if [ -n "$recovery_version" ]; then from_version=$(cut -f2 "$RECOVERY"); else from_version=$(image_version "$current"); fi
  to_version=$(image_version "$target")
  # A registry tag can be moved to another image: a release tag in the request must be the image's own version. A
  # tag with a suffix (v1.2.3-rc.1) or a request by digest alone names no release. A release-shaped tag that isn't
  # canonical (v01.10.0) never matches a label, so it is refused too.
  requested_tag=${request%@sha256:*}
  case "${requested_tag##*/}" in
    *:*) requested_tag=${requested_tag##*:}; requested_tag=v${requested_tag#v} ;;
    *) requested_tag= ;;
  esac
  if printf '%s\n' "$requested_tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' && [ "$to_version" != "$requested_tag" ]; then
    fail "The image's version doesn't match the requested tag. Nothing was changed."
  fi
  if valid_version "$to_version"; then
    work=$(mktemp -d)
    repository=$(read_env RELEASE_REPOSITORY); [ -n "$repository" ] || repository=plaingym/plaingym
    valid_repository "$repository" || fail 'Invalid release repository.'
    [ -f "$ROOT/release-signing.pem" ] || fail 'Install the release signing public key before updating a release. For forks, set RELEASE_REPOSITORY to the repository publishing its signed releases; see docs/update-reference.md#the-release-signing-key. Nothing was changed.'
    { download "https://github.com/$repository/releases/download/$to_version/release-manifest.txt" "$work/manifest" \
      && download "https://github.com/$repository/releases/download/$to_version/release-manifest.txt.sig" "$work/manifest.sig"; } \
      || fail "Could not download the signed release manifest and signature for $to_version from $repository. Check network access and that the release exists; for forks set RELEASE_REPOSITORY to their release repository (docs/update-reference.md#the-release-signing-key), then retry. Nothing was changed."
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
    host_status=0
    host_download "$work/manifest" "https://github.com/$repository/releases/download/$to_version" "$work" || host_status=$?
    [ "$host_status" -ne 2 ] || fail "Could not download the deployment files of $to_version. Nothing was installed."
    [ "$host_status" -eq 0 ] || fail 'Invalid signed host files or release signing key change. Nothing was installed.'
    infra_status=0
    infrastructure_plan "$work/manifest" || infra_status=$?
    [ "$infra_status" -ne 2 ] || fail "Could not pull the PostgreSQL or Caddy image of $to_version. Nothing was changed."
    [ "$infra_status" -eq 0 ] || fail "The PostgreSQL or Caddy image of $to_version failed its check. Nothing was changed."
  fi
  if [ -n "$recovery_version" ] && ! valid_version "$to_version"; then
    fail "Recovery requires $recovery_version or a newer compatible signed release. Nothing was changed."
  fi
  if ! valid_version "$to_version" && [ "$unsigned" = false ]; then
    fail "This image has no release version label, so its signature can't be checked. To install it anyway, run ./update.sh --unsigned IMAGE. Nothing was changed."
  fi
  [ -n "$work" ] || work=$(mktemp -d)
  if [ -z "$recovery_version" ]; then remember_manual_image "$current" "$from_version"; fi
  remember_manual_image "$target" "$to_version"
  swap_image "$target"
  printf 'Updated to %s. Coordinated pre-upgrade snapshot completed.\n' "$target"
  exit 0
fi

work=$(mktemp -d)
send_pending || true

# Once a night, in the three hours from the start hour the owner picks (0 to 21, so the window never crosses
# midnight; default 02:00–05:00) where the gym is. The timer fires every hour; the other runs stop here.
# Each run asks the app for the gym's timezone and start hour, so a changed zone counts from its next night. The zone
# and hour it last gave are the fallback while the app can't answer (or a restore holds it); with those, a run outside
# the window stops without a result, and with no zone known yet a failed check is reported. An app that names no
# start hour (one older than the setting) means 02:00.
due() { in_window "$1" "$2" && ! tonight_done "$1" "$2"; }
valid_window_start() { case "$1" in [0-9]|1[0-9]|2[01]) return 0 ;; *) return 1 ;; esac; }
# Once a night: with the same zone and start hour, tonight's date is done. After a change of start hour, tonight's
# date or a run less than six hours ago counts; after a change of zone, only a run less than six hours ago does. So
# moving the window just after a night's run doesn't start a second run the same evening. A state from before the
# start hour was stored means 02:00.
tonight_done() {
  night_zone=$(value_of "$STATE" night_zone)
  night_start=$(value_of "$STATE" night_start)
  valid_window_start "$night_start" || night_start=2
  if [ -z "$night_zone" ] || [ "$night_zone" = "$1" ]; then
    [ "$(value_of "$STATE" night)" != "$(TZ="$1" date +%F)" ] || return 0
    [ "$night_start" != "$2" ] || return 1
  fi
  night_at=$(value_of "$STATE" night_at)
  case "$night_at" in ''|*[!0-9]*) return 1 ;; esac
  [ $(($(date -u +%s) - night_at)) -lt 21600 ]
}
cached=$(value_of "$STATE" timezone)
valid_timezone "$cached" || cached=
cached_start=$(value_of "$STATE" window_start)
valid_window_start "$cached_start" || cached_start=2
answered=false
app_up=false
if app_running; then
  app_up=true
  if compose exec -T app gym-app auto-update check > "$work/check"; then answered=true; fi
fi
timezone=$cached
window_start=$cached_start
if [ "$answered" = true ] && [ "$(value_of "$work/check" restore)" != true ]; then
  # Before the setup wizard creates the gym there is nothing to update, and nowhere to record a result.
  if [ "$(value_of "$work/check" setup)" = false ]; then echo 'The gym is not set up yet; nothing to update.'; exit 0; fi
  timezone=$(value_of "$work/check" timezone)
  valid_timezone "$timezone" || timezone=UTC
  [ "$timezone" = "$cached" ] || state_set timezone "$timezone"
  window_start=$(value_of "$work/check" window_start)
  valid_window_start "$window_start" || window_start=2
  [ "$window_start" = "$(value_of "$STATE" window_start)" ] || state_set window_start "$window_start"
fi
if [ "$now" = false ] && [ -n "$timezone" ] && ! due "$timezone" "$window_start"; then exit 0; fi
if [ "$answered" = false ]; then
  [ "$app_up" = true ] || echo 'The app is not running.' >&2
  finish skipped check_failed 1
fi
[ "$(value_of "$work/check" restore)" != true ] || finish skipped restore_in_progress
state_set night "$(TZ="$timezone" date +%F)"
state_set night_zone "$timezone"
state_set night_at "$(date -u +%s)"
state_set night_start "$window_start"

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
# Only tag names are read from the list; the signed manifest below is what is trusted. Read up to 10 pages of 100
# releases, until a page that isn't full. A page that can't be read ends the run: never choose from part of the list.
tags=
page=1
while :; do
  address="https://api.github.com/repos/$repository/releases?per_page=100"
  [ "$page" -eq 1 ] || address="$address&page=$page"
  download "$address" "$work/releases.json" 5000000 || finish skipped release_list_unavailable 1
  page_tags=$(grep -Eo '"tag_name"[[:space:]]*:[[:space:]]*"v[0-9]+\.[0-9]+\.[0-9]+"' "$work/releases.json" | grep -Eo 'v[0-9]+\.[0-9]+\.[0-9]+' || true)
  tags=$(printf '%s\n%s' "$tags" "$page_tags")
  if [ "$(grep -o '"tag_name"' "$work/releases.json" | wc -l)" -lt 100 ] || [ "$page" -ge 10 ]; then break; fi
  page=$((page + 1))
done
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

# An image an own Compose file names for the app would replace the release every Compose call starts.
if own_app_image; then
  echo "This install's own Compose files name an image for the app, so no release can be installed. Remove that image line; APP_IMAGE in .env names the app's image." >&2
  finish skipped own_app_image 1
fi
# Pull while the app runs, and check what arrived before anything stops.
APP_IMAGE="$target" compose pull app || finish skipped pull_failed 1
remember_image "$(docker image inspect "$target" --format '{{.Id}}' 2>/dev/null || true)" "$image:$tag@$digest" "$tag"
if ! docker image inspect "$target" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -qxF "$image@$digest" \
  || [ "$(image_version "$target")" != "$tag" ]; then finish skipped digest_mismatch 1; fi
# Patch releases never change the database: the release workflow refuses them, and so does this check.
hash='^[a-f0-9]{64}$'
old=$(migrations_of "$current") || old=
new=$(migrations_of "$target") || new=
if ! printf '%s\n' "$old" | grep -Eq "$hash" || ! printf '%s\n' "$new" | grep -Eq "$hash"; then finish skipped image_check_failed 1; fi
[ "$old" = "$new" ] || finish skipped migration_in_patch 1
[ "sha256:$new" = "$(manifest_value "$work/manifest" migrations)" ] || finish skipped manifest_invalid 1
host_status=0
host_download "$work/manifest" "https://github.com/$repository/releases/download/$tag" "$work" || host_status=$?
[ "$host_status" -ne 2 ] || finish skipped manifest_unavailable 1
[ "$host_status" -eq 0 ] || finish skipped manifest_invalid 1
infra_status=0
infrastructure_plan "$work/manifest" || infra_status=$?
[ "$infra_status" -ne 2 ] || finish skipped pull_failed 1
[ "$infra_status" -eq 0 ] || finish skipped image_check_failed 1

history_install
swap_image "$target"
exit 0
