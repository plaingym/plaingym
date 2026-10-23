#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Host-side only. No Docker socket is mounted into the app.
# shellcheck source=deploy/lib.sh
. "$ROOT/base-lib.sh"
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
