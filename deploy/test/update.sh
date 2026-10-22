#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Exercises host orchestration with a command fixture; smoke.mjs tests real Docker.
set -eu
umask 077
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
mkdir "$temporary/bin"
age-keygen -o "$temporary/key" 2>/dev/null
recipient=$(age-keygen -y "$temporary/key")
export PATH="$temporary/bin:$PATH"
export CALLS="$temporary/calls"
cat > "$temporary/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s IMAGE=%s\n' "$*" "${APP_IMAGE:-configured}" >> "$CALLS"
case "$*" in
  'image inspect '*) echo sha256:previous; exit 0 ;;
  *' ps --status running --services') echo app ;;
  *' assert-empty') [ "${FAIL_AT:-}" != schema ] ;;
  *' dump') echo database-fixture ;;
  *' --entrypoint tar '*) tar -cf - --files-from /dev/null ;;
  *' pull app') [ "${FAIL_AT:-}" != pull ] ;;
  *' migrate') [ "${FAIL_AT:-}" != migrate ] ;;
  *' node /app/deploy/healthcheck.mjs') [ "${FAIL_AT:-}" != health ] ;;
esac
MOCK
chmod 0700 "$temporary/bin/docker"
# A container/CI runner supplies a real root user, age, flock and tar.
[ "$(id -u)" -eq 0 ] || { echo 'Run this test as root in a disposable environment.' >&2; exit 1; }
make_install() {
  case_dir="$temporary/$1"
  mkdir "$case_dir"
  cp "$source_dir/update.sh" "$source_dir/lib.sh" "$case_dir/"
  : > "$case_dir/compose.yaml"
  printf 'APP_IMAGE=example:v1.0.0\nBACKUP_RECIPIENT=%s\nFAKE_SECRET=private-test-value\n' "$recipient" > "$case_dir/.env"
  : > "$CALLS"
}
make_install success
sh "$case_dir/update.sh" example:v1.0.1 > "$temporary/output" 2>&1
grep -qx APP_IMAGE=example:v1.0.1 "$case_dir/.env"
snapshot=$(find "$case_dir/snapshots" -name '*.tar.age')
age -d -i "$temporary/key" "$snapshot" > "$temporary/decrypted.tar"
tar -xOf "$temporary/decrypted.tar" recovery.env | grep -qx FAKE_SECRET=private-test-value
if grep -q private-test-value "$temporary/output"; then exit 1; fi
# The image is pulled while the old app runs; the new image starts right after capture.
[ "$(grep -n ' pull app' "$CALLS" | cut -d: -f1)" -lt "$(grep -n ' stop app' "$CALLS" | cut -d: -f1)" ]
if grep -q 'up -d .* IMAGE=sha256:previous' "$CALLS"; then exit 1; fi
for stage in schema pull migrate health; do
  make_install "$stage"
  if FAIL_AT="$stage" sh "$case_dir/update.sh" example:v1.0.1 > "$temporary/output" 2>&1; then
    echo "Expected $stage failure" >&2
    exit 1
  fi
  grep -qx APP_IMAGE=example:v1.0.0 "$case_dir/.env"
  if grep -q private-test-value "$temporary/output"; then exit 1; fi
  if [ "$stage" = migrate ] || [ "$stage" = health ]; then
    tail -n 1 "$CALLS" | grep 'up -d .* IMAGE=sha256:previous' >/dev/null
  fi
  if [ "$stage" = schema ] || [ "$stage" = pull ]; then
    if grep -q ' stop app' "$CALLS"; then exit 1; fi
  fi
done
make_install encryption
sed 's/^BACKUP_RECIPIENT=.*/BACKUP_RECIPIENT=invalid/' "$case_dir/.env" > "$case_dir/next"
mv "$case_dir/next" "$case_dir/.env"
if sh "$case_dir/update.sh" example:v1.0.1 > "$temporary/output" 2>&1; then exit 1; fi
grep -qx APP_IMAGE=example:v1.0.0 "$case_dir/.env"
if grep -q -e ' pull app' -e ' stop app' "$CALLS"; then exit 1; fi
make_install locked
if flock "$case_dir/.update.lock" sh "$case_dir/update.sh" example:v1.0.1 > "$temporary/output" 2>&1; then exit 1; fi
[ ! -s "$CALLS" ]
if sh "$case_dir/update.sh" example:latest >/dev/null 2>&1; then exit 1; fi
if sh "$case_dir/update.sh" --patch >/dev/null 2>&1; then exit 1; fi
echo 'PASS: update encryption, pull before capture, publication, schema guard, failures, rollback, lock, version pinning.'
