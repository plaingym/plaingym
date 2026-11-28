#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# shellcheck disable=SC2317,SC2329
set -euo pipefail
umask 077
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# Recover before sourcing files that may have been replaced by an interrupted refresh.
if [ -d "$ROOT/.demo-deploy-update" ]; then
  [ "$(id -u)" -eq 0 ] || { echo 'Run update.sh as root.' >&2; exit 1; }
  exec 9>"$ROOT/.install.lock"
  flock -n 9 || { echo 'Demo update skipped: install or update holds the lock.'; exit 0; }
  python3 "$ROOT/deploy-files.py" recover "$ROOT"
  exec bash "$ROOT/update.sh" "$@" 9>&-
fi
unset -f plaingym_shared_helpers_loaded
# shellcheck source=/dev/null
. "$ROOT/lib.sh"
if [ "${1:-}" = --status ] && [ "$#" -eq 1 ]; then
  if [ -f "$ROOT/auto-update.status" ]; then cat "$ROOT/auto-update.status"; else echo 'No automatic demo update has run.'; fi
  exit 0
fi
require_compose
[ "$(id -u)" -eq 0 ] || fail 'Run update.sh as root.'
usage='Usage: update.sh IMAGE [--bundle /path/to/demo-bundle.tar] | --auto [--now] | --status'
automatic=false
now=false
bundle=
case "$#:${1:-}:${2:-}" in
  1:--auto:) automatic=true ;;
  2:--auto:--now) automatic=true; now=true ;;
  1:-*:|0::) fail "$usage" ;;
  1:*:) valid_image "$1" || fail 'Use an explicit version or sha256 digest.' ;;
  3:*:--bundle) valid_image "$1" || fail 'Use an explicit version or sha256 digest.'; bundle=$3 ;;
  *) fail "$usage" ;;
esac
signed_release=false
if [ "$automatic" = false ] && [ -z "$bundle" ] && valid_published_version "${1##*:}"; then signed_release=true; fi
if [ "$automatic" = true ] || [ "$signed_release" = true ]; then
  # shellcheck source=deploy/demo/auto-update.sh
  . "$ROOT/auto-update.sh"
fi
if [ "$automatic" = true ]; then
  exec 8>"$ROOT/.auto-update.lock"
  flock -n 8 || exit 0
  # An interrupted attempt left the app stopped: recover it at the next hourly run, not the next night.
  scheduled=false
  if [ ! -f "$ROOT/.demo-update.inflight" ]; then demo_auto_schedule; scheduled=true; fi
fi
exec 9>"$ROOT/.install.lock"
if ! flock -n 9; then
  if [ "$automatic" = true ]; then
    # An explicit update holding the lock owns its own marker; stay quiet outside the nightly run.
    [ "$scheduled" = true ] || exit 0
    demo_auto_finish skipped install_or_update_holds_the_lock
  fi
  fail 'Another demo install or update is running.'
fi
current=$(read_env APP_IMAGE)
work=
changed=false
previous=
auto_attempt=false
rollback_result=unchanged
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$auto_attempt" = true ] && [ "$(read_env APP_IMAGE)" = "$target" ]; then result=0; changed=false; fi
  if [ -d "$ROOT/.demo-deploy-update" ]; then
    if ! python3 "$ROOT/deploy-files.py" recover "$ROOT"; then
      echo 'Demo host-file recovery failed; rerun update.sh before restarting the app.' >&2
      exit 1
    fi
  fi
  if [ "$changed" = true ]; then
    printf 'Update failed; restarting the previous image.\n' >&2
    rollback_result=rollback_failed
    if DEMO_TARGET_APP_IMAGE="$previous" compose up -d --no-deps --pull never --wait --wait-timeout 180 app; then
      rollback_result=rolled_back
      rm -f "$ROOT/.demo-update.inflight"
      if [ -n "${deploy_source:-}" ]; then
        compose up -d --no-deps --pull never --force-recreate --wait --wait-timeout 180 caddy || result=1
      fi
    fi
  fi
  if [ "$automatic" = true ] && [ "$auto_attempt" = true ]; then
    if [ "$result" -eq 0 ]; then demo_auto_report updated -
    else demo_auto_report "$rollback_result" update_failed; fi
  fi
  if [ -n "$work" ]; then rm -rf -- "$work"; fi
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

demo_drain() {
  running=$(compose ps --status running --services)
  if printf '%s\n' "$running" | grep -qx app; then compose kill --signal SIGTERM app; fi
  for ((waited=0; waited<1800; waited+=5)); do
    running=$(compose ps --status running --services)
    if ! printf '%s\n' "$running" | grep -qx app; then return 0; fi
    sleep 5
  done
  fail 'Demo seed is still draining after 30 minutes; no image or deploy files were changed.'
}

demo_apply_update() { # TARGET [PREPARED_DEPLOY_DIRECTORY]
  target=$1
  deploy_source=${2:-}
  keep=${DEMO_SNAPSHOT_RETENTION:-$(read_env DEMO_SNAPSHOT_RETENTION)}
  keep=${keep:-3}
  python3 -c 'import sys; sys.path.insert(0, sys.argv[1]); from snapshots import retention; retention(sys.argv[2])' "$ROOT" "$keep"
  [ "$target" != "$current" ] || { demo_health; demo_link; return 0; }
  if [ -n "$bundle" ]; then tar -xOf "$bundle" deploy/demo/images/app.tar | docker load >/dev/null; fi
  docker image inspect "$target" >/dev/null 2>&1 || docker pull "$target" >/dev/null
  previous=$(docker image inspect "$current" --format '{{.Id}}')
  compose ps --status running --services | grep -qx app || fail 'The demo must be running before updating.'
  install -d -m 0700 "$ROOT/snapshots"
  snapshot=$(mktemp "$ROOT/snapshots/pre-update-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX.dump")
  # SIGTERM stops new job claims; the worker awaits its running seed. Never SIGKILL a seed.
  # A later run restarts the pin if the host or updater dies while draining.
  printf '%s\n' "$previous" > "$ROOT/.demo-update.inflight"
  demo_drain
  changed=true
  # Variables expand only inside the database container.
  # shellcheck disable=SC2016
  compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U postgres -Fc "$POSTGRES_DB"' > "$snapshot"
  if [ -n "$deploy_source" ]; then
    python3 "$ROOT/deploy-files.py" apply "$ROOT" "$deploy_source" "$target"
    compose run --rm --no-deps -T caddy caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
  fi
  DEMO_TARGET_APP_IMAGE="$target" compose run --rm --no-deps -T migrate
  DEMO_TARGET_APP_IMAGE="$target" compose up -d --no-deps --pull never --wait --wait-timeout 180 app
  if [ -n "$deploy_source" ]; then compose up -d --no-deps --pull never --force-recreate --wait --wait-timeout 180 caddy; fi
  demo_health
  awk -v image="$target" '/^APP_IMAGE=/ { print "APP_IMAGE=" image; next } { print }' "$ROOT/.env" | env_next
  commit_env_next
  changed=false
  # Retire this committed generation before catch-up can open the next journal.
  if [ -d "$ROOT/.demo-deploy-update" ]; then python3 "$ROOT/deploy-files.py" recover "$ROOT"; fi
  rm -f "$ROOT/.demo-update.inflight"
  python3 "${snapshot_pruner:-$ROOT/snapshots.py}" --directory "$ROOT/snapshots" --keep "$keep" ${protect_snapshot:+--protect "$protect_snapshot"}
  printf 'Updated demo to %s. Pre-update snapshot: %s\n' "$target" "$snapshot"
  demo_link
}
# A timed-out drain stays running until its seed finishes. Never recreate that container mid-seed.
if [ -f "$ROOT/.demo-update.inflight" ]; then
  demo_drain
  compose up -d --no-deps --pull never --wait --wait-timeout 180 app
  # The proxy may still hold a refreshed Caddyfile that the journal recovery has since put back.
  compose up -d --no-deps --pull never --force-recreate --wait --wait-timeout 180 caddy
  rm -f "$ROOT/.demo-update.inflight"
  if [ "$automatic" = true ]; then
    from_version=$(installed_version "$current" || true)
    demo_auto_report recovered interrupted_attempt
    exit 0
  fi
  # An explicit update goes on to install the image it was asked for.
  echo 'Demo update recovered an interrupted attempt; the pinned image is running.'
fi
if [ "$automatic" = true ]; then
  demo_auto_run
elif [ "$signed_release" = true ]; then
  demo_explicit_release "$1"
else
  demo_apply_update "$1"
fi
