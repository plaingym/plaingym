#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# ./rotate-key.sh   Replace APP_ENCRYPTION_KEY (deploy/README.md, "Rotating the encryption key"): stop the app,
#                   re-encrypt every stored secret with a new key, write that key to .env and start the app with it.
#                   Until it finishes, both keys stay in .rotate-key.inflight; run it again to finish an interrupted one.
# The exit trap calls cleanup and what it uses, which shellcheck reads as unreachable.
# shellcheck disable=SC2317
set -eu
umask 077
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=deploy/lib.sh
. "$ROOT/lib.sh"
[ "$(id -u)" -eq 0 ] || fail 'Run rotate-key.sh as root.'
[ "$#" -eq 0 ] || fail 'Usage: ./rotate-key.sh'
[ -f "$ROOT/.env" ] || fail 'Missing installation .env.'
INFLIGHT="$ROOT/.rotate-key.inflight"
valid_key() { printf '%s\n' "$1" | grep -Eq '^[a-fA-F0-9]{64}$'; }
inflight_value() { # KEY
  awk -v key="$1" 'index($0, key "=") == 1 { value = substr($0, length(key) + 2) } END { print value }' "$INFLIGHT"
}
# The updater's lock: an update and a key rotation never run at once.
exec 9>"$ROOT/.update.lock"
flock -n 9 || fail 'An update or key rotation is running; run this again once it finishes. Nothing was changed.'

stopped=false
switched=false
interrupted=false
may_have_committed=false
write_inflight() { # MAY_HAVE_COMMITTED; replace atomically and durably before changing the in-memory state.
  printf 'old=%s\nnew=%s\nmay_have_committed=%s\n' "$old" "$new" "$1" > "$INFLIGHT.next"
  mv "$INFLIGHT.next" "$INFLIGHT"
  sync
}
restore_connect() {
  # As the maintenance role (the database owner), grants CONNECT back to app only; PUBLIC stays revoked as in bootstrap.
  # Like the rotation, a one-off that bypasses the entrypoint, whose app-role check cannot connect under the fence.
  compose run --rm --no-deps -T --entrypoint node app /app/maintenance.mjs restore-connect </dev/null
}
wait_for_database() {
  # The one-off below skips the entrypoint's database wait, so a database still starting would read as an
  # uncertain failure: wait here, before an attempt is recorded as one that may commit.
  tries=0
  # shellcheck disable=SC2016
  until compose exec -T postgres sh -c 'exec pg_isready -q -h 127.0.0.1 -U postgres -d "$POSTGRES_DB"' </dev/null; do
    tries=$((tries + 1))
    [ "$tries" -lt 30 ] || return 1
    sleep 1
  done
}
cleanup() {
  exit_status=$?
  trap - EXIT HUP INT TERM
  unset NEW_APP_ENCRYPTION_KEY
  if [ "$exit_status" -ne 0 ] && [ "$stopped" = true ] && [ "$switched" = false ]; then
    if [ "$interrupted" = true ]; then
      echo 'Interrupted. The app stays stopped; run ./rotate-key.sh again to finish the key rotation.' >&2
    elif [ "$may_have_committed" = true ]; then
      # A previous or current attempt may have committed pages: the old key is unsafe for startup.
      echo 'Stored secrets may use the new key, but .env was not updated (reason above). The app stays stopped; run ./rotate-key.sh again to finish.' >&2
    else
      # Every attempt so far was definitely refused before committing any pages.
      echo 'The key rotation did not finish (reason above). Restarting the app with the current key; run ./rotate-key.sh again to finish.' >&2
      if restore_connect; then
        compose up -d --no-deps --pull never --wait --wait-timeout 90 app || echo 'The app did not restart; run ./rotate-key.sh again.' >&2
      else
        echo 'CONNECT could not be restored. The app stays stopped; run ./rotate-key.sh again.' >&2
      fi
    fi
  fi
  exit "$exit_status"
}
trap cleanup EXIT
trap 'interrupted=true; exit 130' HUP INT TERM

current=$(read_env APP_ENCRYPTION_KEY)
if [ -f "$INFLIGHT" ]; then
  old=$(inflight_value old)
  new=$(inflight_value new)
  { valid_key "$old" && valid_key "$new"; } || fail ".rotate-key.inflight is damaged. Keep it and .env, and don't run this again; see deploy/README.md, \"Rotating the encryption key\"."
  [ "$current" = "$old" ] || [ "$current" = "$new" ] || fail 'APP_ENCRYPTION_KEY in .env is neither key of the interrupted rotation in .rotate-key.inflight. Nothing was changed.'
  # Markers from older scripts have no state line: they may describe a partial rewrite.
  case "$(inflight_value may_have_committed)" in
    false) may_have_committed=false ;;
    *) may_have_committed=true ;;
  esac
  echo 'Finishing the interrupted key rotation.'
else
  valid_key "$current" || fail 'APP_ENCRYPTION_KEY in .env is not 64 hex characters. Nothing was changed.'
  compose ps --status running --services | grep -qx app || fail 'The app must be running before a key rotation. Nothing was changed.'
  old=$current
  new=$(openssl rand -hex 32)
  # Both keys are on disk before any secret is written with the new one.
  write_inflight false
fi

wait_for_database || fail 'PostgreSQL is not accepting connections (see docker compose ps postgres). This run changed nothing; run this again once it is.'
if [ "$current" = "$old" ]; then
  stopped=true
  compose stop app
  # Bypass the image entrypoint: its app-role check cannot connect under a retained fence. This image already ran
  # on this install, so no startup wait/resume/migrate is needed; rotate-key checks the restore gate itself.
  previously_committed=$may_have_committed
  # A killed host or an unclassified command failure must leave durable evidence that pages may have committed.
  write_inflight true
  may_have_committed=true
  rotation_status=0
  # Both keys reach the one-off container through the environment, never a command line, and only this one gets
  # the new key: the restore-connect one-off in cleanup runs without it.
  # Exported, not a prefix assignment: POSIX leaves unspecified whether one reaches a shell function's commands.
  export NEW_APP_ENCRYPTION_KEY="$new"
  compose run --rm --no-deps -T --entrypoint node -e NEW_APP_ENCRYPTION_KEY app /app/maintenance.mjs rotate-key || rotation_status=$?
  unset NEW_APP_ENCRYPTION_KEY
  if [ "$rotation_status" -ne 0 ]; then
    # Exit 3 proves only that this attempt changed nothing, so it cannot clear an earlier attempt's uncertainty.
    # Exit 4 also found no stored value under the new key: no attempt, earlier ones included, committed a page.
    if [ "$rotation_status" -eq 4 ] || { [ "$rotation_status" -eq 3 ] && [ "$previously_committed" = false ]; }; then
      write_inflight false
      may_have_committed=false
    fi
    fail 'The key rotation failed (reason above); rerun with the same keys in .rotate-key.inflight.'
  fi
  # Every stored secret now opens with the new key: only then does .env name it.
  awk -v key="$new" 'BEGIN { found=0 } /^APP_ENCRYPTION_KEY=/ { print "APP_ENCRYPTION_KEY=" key; found=1; next } { print } END { if (!found) print "APP_ENCRYPTION_KEY=" key }' "$ROOT/.env" > "$ROOT/.env.next"
  chmod 0600 "$ROOT/.env.next"
  mv "$ROOT/.env.next" "$ROOT/.env"
  sync
  switched=true
fi
# Idempotent even after a crash between the .env rename and this grant.
restore_connect || fail 'CONNECT could not be restored. Run ./rotate-key.sh again.'
# Recreated from .env, the app starts with the new key.
compose up -d --no-deps --pull never --wait --wait-timeout 90 app \
  || fail 'The stored secrets and .env use the new key, but the app did not start. Check its log (docker compose logs app), then run ./rotate-key.sh again.'
compose exec -T app node /app/deploy/healthcheck.mjs \
  || fail 'The stored secrets and .env use the new key, but the app is not healthy. Check its log (docker compose logs app), then run ./rotate-key.sh again.'
rm -f "$INFLIGHT"
echo 'APP_ENCRYPTION_KEY was replaced, and the app runs with the new key. Keep a copy of the new .env somewhere safe: backups taken from now on carry the new key.'
