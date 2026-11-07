#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Exercises host orchestration with a command fixture; smoke.mjs tests real Docker.
set -eu
umask 077
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
mkdir "$temporary/bin"
export PATH="$temporary/bin:$PATH"
export CALLS="$temporary/calls"
cat > "$temporary/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s IMAGE=%s\n' "$*" "${APP_IMAGE:-configured}" >> "$CALLS"
case "$*" in
  'image inspect '*) echo sha256:previous; exit 0 ;;
  *' ps --status running --services') [ "${APP_STATE:-running}" != running ] || echo app ;;
  *' pull app') [ "${FAIL_AT:-}" != pull ] ;;
  *' snapshot pre-upgrade')
    [ "${FAIL_AT:-}" != snapshot ] || { echo 'Backups are not set up: set them up in Settings → Email, payments and backups, then run the update again' >&2; exit 1; } ;;
  *'up -d '*)
    if [ "${APP_IMAGE:-}" != sha256:previous ]; then [ "${FAIL_AT:-}" != startup ]; fi ;;
  *' node /app/deploy/healthcheck.mjs') [ "${FAIL_AT:-}" != health ] ;;
esac
MOCK
chmod 0700 "$temporary/bin/docker"
[ "$(id -u)" -eq 0 ] || { echo 'Run this test as root in a disposable environment.' >&2; exit 1; }
make_install() {
  case_dir="$temporary/$1"
  mkdir "$case_dir"
  cp "$source_dir/update.sh" "$source_dir/lib.sh" "$case_dir/"
  : > "$case_dir/compose.yaml"
  printf 'APP_IMAGE=example:v1.0.0\nFAKE_SECRET=private-test-value\n' > "$case_dir/.env"
  : > "$CALLS"
}
make_install success
sh "$case_dir/update.sh" example:v1.0.1 > "$temporary/output" 2>&1
grep -qx APP_IMAGE=example:v1.0.1 "$case_dir/.env"
[ "$(grep -n ' pull app' "$CALLS" | cut -d: -f1)" -lt "$(grep -n ' stop app' "$CALLS" | cut -d: -f1)" ]
[ "$(grep -n ' stop app' "$CALLS" | cut -d: -f1)" -lt "$(grep -n ' snapshot pre-upgrade' "$CALLS" | cut -d: -f1)" ]
[ "$(grep -n ' snapshot pre-upgrade' "$CALLS" | cut -d: -f1)" -lt "$(grep -n ' up -d ' "$CALLS" | cut -d: -f1)" ]
if grep -q 'up -d .* IMAGE=sha256:previous' "$CALLS"; then exit 1; fi
for stage in pull snapshot startup health; do
  make_install "$stage"
  if FAIL_AT="$stage" sh "$case_dir/update.sh" example:v1.0.1 > "$temporary/output" 2>&1; then
    echo "Expected $stage failure" >&2; exit 1
  fi
  grep -qx APP_IMAGE=example:v1.0.0 "$case_dir/.env"
  if grep -q private-test-value "$temporary/output"; then exit 1; fi
  if [ "$stage" = snapshot ]; then
    grep -q "set them up in Settings → Email, payments and backups" "$temporary/output"
    grep -q "Nothing was changed" "$temporary/output"
  fi
  if [ "$stage" != pull ]; then
    tail -n 1 "$CALLS" | grep 'up -d .* IMAGE=sha256:previous' >/dev/null
  else
    if grep -q ' stop app' "$CALLS"; then exit 1; fi
  fi
done
for app_state in stopped restarting; do
  make_install "app_$app_state"
  if APP_STATE="$app_state" sh "$case_dir/update.sh" example:v1.0.1 > "$temporary/output" 2>&1; then
    echo "Accepted an ordinary update with app $app_state and no recovery record." >&2; exit 1
  fi
  grep -q 'The app must be running before an update' "$temporary/output"
  grep -qx APP_IMAGE=example:v1.0.0 "$case_dir/.env"
  if grep -q 'stop app\|snapshot pre-upgrade\|up -d' "$CALLS"; then exit 1; fi
done
make_install locked
touch "$case_dir/.rotate-key.inflight"
for arguments in 'example:v1.0.1' '--patch --now'; do
  status=0
  # shellcheck disable=SC2086
  sh "$case_dir/update.sh" $arguments > "$temporary/output" 2>&1 || status=$?
  # A requested update fails; the nightly patch run exits cleanly.
  case $arguments in --patch*) [ "$status" -eq 0 ] ;; *) [ "$status" -eq 1 ] ;; esac
  grep -q 'Key rotation is unfinished; update skipped' "$temporary/output"
  grep -qx APP_IMAGE=example:v1.0.0 "$case_dir/.env"
  [ -f "$case_dir/.rotate-key.inflight" ]
  [ ! -s "$CALLS" ]
done
rm "$case_dir/.rotate-key.inflight"
if flock "$case_dir/.update.lock" sh "$case_dir/update.sh" example:v1.0.1 > "$temporary/output" 2>&1; then exit 1; fi
[ ! -s "$CALLS" ]
if sh "$case_dir/update.sh" example:latest >/dev/null 2>&1; then exit 1; fi
# Automatic patch updates have their own test (patch.sh); here only malformed arguments are refused.
for arguments in '' '--now' 'example:v1.0.1 example:v1.0.2' '--patch extra'; do
  # shellcheck disable=SC2086
  if sh "$case_dir/update.sh" $arguments >/dev/null 2>&1; then echo "Accepted: $arguments" >&2; exit 1; fi
done
[ ! -s "$CALLS" ]
echo 'PASS: coordinated snapshot, pull before capture, publication, startup/health failures, rollback, lock, version pinning.'
