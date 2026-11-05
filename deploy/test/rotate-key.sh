#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Exercises rotate-key.sh's host orchestration with a command fixture: the order of steps, when .env changes,
# resuming after a failure, and that no key reaches a command line or the output.
set -eu
umask 077
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
mkdir "$temporary/bin"
export PATH="$temporary/bin:$PATH"
export CALLS="$temporary/calls" RECEIVED="$temporary/received"
cat > "$temporary/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> "$CALLS"
case "$*" in
  *' ps --status running --services') [ "${APP_DOWN:-}" = true ] || echo app ;;
  *' run --rm --no-deps -T -e NEW_APP_ENCRYPTION_KEY app node /app/maintenance.mjs rotate-key')
    printf '%s\n' "${NEW_APP_ENCRYPTION_KEY:-}" > "$RECEIVED"
    [ "${FAIL_AT:-}" != rotate ] || { echo 'Stored secrets open with neither key, so nothing was changed.' >&2; exit 1; } ;;
  *'up -d '*) [ "${FAIL_AT:-}" != startup ] ;;
  *' node /app/deploy/healthcheck.mjs') [ "${FAIL_AT:-}" != health ] ;;
esac
MOCK
chmod 0700 "$temporary/bin/docker"
[ "$(id -u)" -eq 0 ] || { echo 'Run this test as root in a disposable environment.' >&2; exit 1; }
original=$(printf 'a%.0s' $(seq 64))
make_install() {
  case_dir="$temporary/$1"
  mkdir "$case_dir"
  cp "$source_dir/rotate-key.sh" "$source_dir/lib.sh" "$case_dir/"
  : > "$case_dir/compose.yaml"
  printf 'APP_IMAGE=example:v1.0.0\nAPP_ENCRYPTION_KEY=%s\nFAKE_SECRET=private-test-value\n' "$original" > "$case_dir/.env"
  : > "$CALLS"
  rm -f "$RECEIVED"
}
key_of() { awk 'index($0, "APP_ENCRYPTION_KEY=") == 1 { print substr($0, 20) }' "$case_dir/.env"; }
line_of() { grep -n -- "$1" "$CALLS" | head -n 1 | cut -d: -f1; }
# Neither key, nor anything else from .env, is in a command line or the output.
no_leaks() { # KEY...
  for value in private-test-value "$@"; do
    if grep -q -- "$value" "$CALLS" "$temporary/output"; then echo "Leaked a value: $value" >&2; exit 1; fi
  done
}

make_install success
sh "$case_dir/rotate-key.sh" > "$temporary/output" 2>&1
new=$(cat "$RECEIVED")
printf '%s\n' "$new" | grep -Eqx '[a-f0-9]{64}'
[ "$new" != "$original" ]
[ "$(key_of)" = "$new" ]
grep -qx 'APP_IMAGE=example:v1.0.0' "$case_dir/.env"
grep -qx 'FAKE_SECRET=private-test-value' "$case_dir/.env"
[ "$(stat -c %a "$case_dir/.env")" = 600 ]
[ ! -e "$case_dir/.rotate-key.inflight" ]
[ "$(line_of ' stop app')" -lt "$(line_of ' rotate-key')" ]
[ "$(line_of ' rotate-key')" -lt "$(line_of ' up -d ')" ]
[ "$(line_of ' up -d ')" -lt "$(line_of '/healthcheck.mjs')" ]
grep -q 'runs with the new key' "$temporary/output"
no_leaks "$original" "$new"

# The command fails: .env keeps the current key, the app restarts with it, and both keys wait in the inflight file.
make_install failed
if FAIL_AT=rotate sh "$case_dir/rotate-key.sh" > "$temporary/output" 2>&1; then echo 'Expected the rotation to fail' >&2; exit 1; fi
new=$(cat "$RECEIVED")
[ "$(key_of)" = "$original" ]
grep -qx "old=$original" "$case_dir/.rotate-key.inflight"
grep -qx "new=$new" "$case_dir/.rotate-key.inflight"
[ "$(stat -c %a "$case_dir/.rotate-key.inflight")" = 600 ]
tail -n 1 "$CALLS" | grep -q ' up -d '
grep -q 'run ./rotate-key.sh again' "$temporary/output"
no_leaks "$original" "$new"
# Run again: the same new key, even with the app now running again, and then .env names it.
: > "$CALLS"
sh "$case_dir/rotate-key.sh" > "$temporary/output" 2>&1
grep -q 'Finishing the interrupted key rotation' "$temporary/output"
[ "$(cat "$RECEIVED")" = "$new" ]
[ "$(key_of)" = "$new" ]
[ ! -e "$case_dir/.rotate-key.inflight" ]
no_leaks "$original" "$new"

# .env can't be written after the rotation committed: the app stays stopped instead of starting with the old key,
# and the next run finishes the same rotation.
make_install unswitched
mkdir "$case_dir/.env.next"
if sh "$case_dir/rotate-key.sh" > "$temporary/output" 2>&1; then echo 'Expected the .env switch to fail' >&2; exit 1; fi
new=$(cat "$RECEIVED")
[ "$(key_of)" = "$original" ]
grep -qx "new=$new" "$case_dir/.rotate-key.inflight"
if grep -q ' up -d ' "$CALLS"; then echo 'Started the app with the old key' >&2; exit 1; fi
grep -q 'The app stays stopped' "$temporary/output"
rmdir "$case_dir/.env.next"
: > "$CALLS"
APP_DOWN=true sh "$case_dir/rotate-key.sh" > "$temporary/output" 2>&1
[ "$(cat "$RECEIVED")" = "$new" ]
[ "$(key_of)" = "$new" ]
[ ! -e "$case_dir/.rotate-key.inflight" ]
no_leaks "$original" "$new"

# The app doesn't start after .env changed: nothing is undone, and the next run only starts it.
make_install startup
if FAIL_AT=startup sh "$case_dir/rotate-key.sh" > "$temporary/output" 2>&1; then echo 'Expected the start to fail' >&2; exit 1; fi
new=$(cat "$RECEIVED")
[ "$(key_of)" = "$new" ]
[ -f "$case_dir/.rotate-key.inflight" ]
: > "$CALLS"
sh "$case_dir/rotate-key.sh" > "$temporary/output" 2>&1
if grep -q -e ' stop app' -e ' rotate-key' "$CALLS"; then echo 'Rotated twice' >&2; exit 1; fi
grep -q ' up -d ' "$CALLS"
[ "$(key_of)" = "$new" ]
[ ! -e "$case_dir/.rotate-key.inflight" ]

# Refusals change nothing: the app not running, the lock held, arguments, a damaged or foreign inflight file.
make_install stopped
if APP_DOWN=true sh "$case_dir/rotate-key.sh" > "$temporary/output" 2>&1; then exit 1; fi
grep -q 'Nothing was changed' "$temporary/output"
[ "$(key_of)" = "$original" ]
[ ! -e "$case_dir/.rotate-key.inflight" ]
if grep -q -e ' stop app' -e ' rotate-key' "$CALLS"; then exit 1; fi
make_install locked
if flock "$case_dir/.update.lock" sh "$case_dir/rotate-key.sh" > "$temporary/output" 2>&1; then exit 1; fi
[ ! -s "$CALLS" ]
if sh "$case_dir/rotate-key.sh" --now > "$temporary/output" 2>&1; then exit 1; fi
[ ! -s "$CALLS" ]
printf 'old=short\nnew=%s\n' "$original" > "$case_dir/.rotate-key.inflight"
if sh "$case_dir/rotate-key.sh" > "$temporary/output" 2>&1; then exit 1; fi
grep -q 'damaged' "$temporary/output"
printf 'old=%s\nnew=%s\n' "$(printf 'b%.0s' $(seq 64))" "$(printf 'c%.0s' $(seq 64))" > "$case_dir/.rotate-key.inflight"
if sh "$case_dir/rotate-key.sh" > "$temporary/output" 2>&1; then exit 1; fi
grep -q 'neither key' "$temporary/output"
[ "$(key_of)" = "$original" ]
[ ! -s "$CALLS" ]
echo 'PASS: key rotation order, .env switched only after the rotation, restart on failure, resume, refusals, no key on a command line.'
