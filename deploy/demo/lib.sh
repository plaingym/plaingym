#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Host-side only. No Docker socket is mounted into the app.
# shellcheck source=deploy/lib.sh
# Before the first install there is no base-lib.sh beside this file; install.sh has sourced the shared
# helpers itself (it also repairs a lost copy), which is how this file knows: `read_env` is already
# defined. Every other caller needs the copy beside this file, and a missing one is named. This checks
# the shell's own functions, not an environment variable, so nothing an operator exports can skip it.
if [ -f "$ROOT/base-lib.sh" ]; then
  . "$ROOT/base-lib.sh"
elif ! command -v read_env >/dev/null 2>&1; then
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
# Saved .env changes are written to .env.next and then moved over .env, always the same way: the file is
# created private (umask) and committed as 0600. env_next reads the new contents on stdin.
env_next() { ( umask 077; cat > "$ROOT/.env.next" ); }
commit_env_next() { chmod 0600 "$ROOT/.env.next" && mv "$ROOT/.env.next" "$ROOT/.env"; }
# A re-run never replaces the saved .env, so demo billing values given now (the installer's inputs file is $1)
# are added to it. The key and its secret are a pair: a key added from $1 brings $1's secret, replacing any
# saved one, and a saved key with no saved secret gets $1's secret. A saved key is left alone, and every
# other line is kept. Prints nothing.
merge_demo_billing() {
  if [ -z "$(read_env DEMO_STRIPE_TEST_KEY)" ]; then
    merge_add='DEMO_STRIPE_TEST_KEY DEMO_STRIPE_WEBHOOK_SECRET' merge_given=DEMO_STRIPE_TEST_KEY
  elif [ -z "$(read_env DEMO_STRIPE_WEBHOOK_SECRET)" ]; then
    merge_add=DEMO_STRIPE_WEBHOOK_SECRET merge_given=DEMO_STRIPE_WEBHOOK_SECRET
  else
    return 0
  fi
  [ -n "$(awk -F= -v key="$merge_given" '$1 == key && $2 != "" { print; exit }' "$1")" ] || return 0
  merge_kept=$(awk -F= -v names="$merge_add" 'BEGIN { split(names, list, " "); for (i in list) drop[list[i]] = 1 } !($1 in drop)' "$ROOT/.env")
  merge_new=$(awk -F= -v names="$merge_add" 'BEGIN { split(names, list, " "); for (i in list) take[list[i]] = 1 } ($1 in take) && $2 != ""' "$1")
  printf '%s\n%s\n' "$merge_kept" "$merge_new" | env_next
  commit_env_next
}
# The installer's preflight writes TRUST_CLOUDFLARE=true to its inputs file ($1) for a proxied hostname. A re-run
# never replaces the saved .env, so that line is added to a saved .env with no TRUST_CLOUDFLARE line; a saved
# one, even false, is the operator's and stays. Prints nothing.
merge_demo_trust() {
  if grep -q '^TRUST_CLOUDFLARE=' "$ROOT/.env" || ! grep -qx 'TRUST_CLOUDFLARE=true' "$1"; then return 0; fi
  { awk 1 "$ROOT/.env"; printf 'TRUST_CLOUDFLARE=true\n'; } | env_next
  commit_env_next
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
    [ "$attempts" -lt 36 ] || fail "HTTPS is not ready; rerun the same installer after correcting DNS or API credentials. Behind Cloudflare's proxy, also check that SSL/TLS is Full (strict) and that no Cloudflare security setting (Bot Fight Mode, Under Attack mode, a WAF or rate-limiting rule) challenges /healthz."
    sleep 5
  done
}
demo_link() { printf 'PlainGym demo is ready: https://%s\n' "$(read_env GYM_HOSTNAME)"; }
