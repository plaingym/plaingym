#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Host-side only. No Docker socket is mounted into the app.
# shellcheck source=deploy/lib.sh
# Before the first install there is no base-lib.sh beside this file; install.sh has sourced the shared
# helpers itself and says so with DEMO_FIRST_INSTALL=true (it also repairs a lost copy). Every other
# caller needs the copy beside this file, and a missing one is named.
if [ -f "$ROOT/base-lib.sh" ]; then
  . "$ROOT/base-lib.sh"
elif [ "${DEMO_FIRST_INSTALL:-}" != true ]; then
  printf '%s\n' "$ROOT/base-lib.sh is missing, so the demo cannot run. Run install.sh again from the demo bundle, which restores it." >&2
  exit 1
fi
# The overlay's `!reset` (it keeps the maintenance credentials out of the app) needs Compose 2.24;
# an older Compose fails on the file, or ignores the tag and passes the credentials on.
# Call it before anything on the host changes. `missing-ok` lets the installer's host setup add a
# Compose that is not there yet; `after-setup` checks what that setup left (so "Nothing was
# changed" no longer holds). POSIX sh has no `local`, so its variables carry a `compose_` prefix.
require_compose() {
  compose_ending=' Nothing was changed.'
  [ "${1:-}" != after-setup ] || compose_ending=
  if ! docker compose version >/dev/null 2>&1; then
    [ "${1:-}" != missing-ok ] || return 0
    fail "Docker Compose is not installed. The demo needs Docker Compose 2.24 or later.$compose_ending"
  fi
  compose_version=$(docker compose version --short 2>/dev/null) || compose_version=
  compose_version=${compose_version#v}
  compose_unreadable="Could not read the Docker Compose version '$compose_version'. The demo needs Docker Compose 2.24 or later. Upgrade Docker Compose, then run this again.$compose_ending"
  case "$compose_version" in [0-9]*.[0-9]*) ;; *) fail "$compose_unreadable" ;; esac
  compose_major=${compose_version%%.*}
  compose_minor=${compose_version#*.}
  compose_minor=${compose_minor%%.*}
  case "$compose_major$compose_minor" in *[!0-9]*) fail "$compose_unreadable" ;; esac
  if [ "$compose_major" -lt 2 ] || { [ "$compose_major" -eq 2 ] && [ "$compose_minor" -lt 24 ]; }; then
    fail "Docker Compose $compose_version is too old: the demo needs 2.24 or later. Upgrade Docker Compose (the docker-compose-plugin package, or the Compose package of your distribution, whichever installed it), then run this again.$compose_ending"
  fi
}
compose() {
  # Bundle metadata and caller input must not override the installed pins on rerun.
  APP_IMAGE="${DEMO_TARGET_APP_IMAGE:-$(read_env APP_IMAGE)}" \
  CADDY_IMAGE="${DEMO_TARGET_CADDY_IMAGE:-$(read_env CADDY_IMAGE)}" \
  docker compose --project-directory "$ROOT" --env-file "$ROOT/.env" \
    -f "$ROOT/compose.yaml" -f "$ROOT/demo.compose.yaml" "$@"
}
demo_health() {
  compose exec -T app node /app/deploy/healthcheck.mjs
  if [ "$(read_env DEMO_LOCAL_TEST)" = true ]; then
    # The local CA is exported and trusted by the test client; no public ACME call.
    return
  fi
  attempts=0
  until curl --fail --silent --show-error --connect-timeout 5 --max-time 10 \
    "https://$(read_env GYM_HOSTNAME)/healthz" >/dev/null; do
    attempts=$((attempts + 1))
    [ "$attempts" -lt 36 ] || fail 'HTTPS is not ready; rerun the same installer after correcting DNS or API credentials.'
    sleep 5
  done
}
demo_link() { printf 'PlainGym demo is ready: https://%s\n' "$(read_env GYM_HOSTNAME)"; }
