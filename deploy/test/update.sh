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
  # The requested image is another one, with no release version label; its digest names the running one.
  'image inspect example:v1.0.1-local --format {{.Id}}') echo sha256:next; exit 0 ;;
  'image inspect '*) echo sha256:previous; exit 0 ;;
  *' ps --status running --services')
    [ "${FAIL_AT:-}" != compose ] || { echo 'Cannot connect to the Docker daemon' >&2; exit 1; }
    [ "${APP_STATE:-running}" != running ] || echo app ;;
  *' pull app') [ "${FAIL_AT:-}" != pull ] ;;
  *' snapshot pre-upgrade')
    [ "${FAIL_AT:-}" != snapshot ] || { echo 'Backups are not set up: set them up in Settings → Integrations, then run the update again' >&2; exit 1; } ;;
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
# An image with no release version label has no signature to check: it installs only with --unsigned.
make_install unlabelled
before=$(sha256sum "$case_dir/.env")
if sh "$case_dir/update.sh" example:v1.0.1-local > "$temporary/output" 2>&1; then echo 'Installed an unlabelled image without --unsigned.' >&2; exit 1; fi
grep -q 'run ./update.sh --unsigned IMAGE' "$temporary/output"
[ "$before" = "$(sha256sum "$case_dir/.env")" ]
if grep -q ' stop app\| snapshot \|up -d' "$CALLS"; then echo 'Stopped or started something for a refused unlabelled image.' >&2; exit 1; fi
make_install success
sh "$case_dir/update.sh" --unsigned example:v1.0.1-local > "$temporary/output" 2>&1
grep -qx APP_IMAGE=example:v1.0.1-local "$case_dir/.env"
grep -qx FAKE_SECRET=private-test-value "$case_dir/.env"
[ "$(stat -c %a "$case_dir/.env")" = 600 ]
[ "$(grep -n ' pull app' "$CALLS" | cut -d: -f1)" -lt "$(grep -n ' stop app' "$CALLS" | cut -d: -f1)" ]
[ "$(grep -n ' stop app' "$CALLS" | cut -d: -f1)" -lt "$(grep -n ' snapshot pre-upgrade' "$CALLS" | cut -d: -f1)" ]
[ "$(grep -n ' snapshot pre-upgrade' "$CALLS" | cut -d: -f1)" -lt "$(grep -n ' up -d ' "$CALLS" | cut -d: -f1)" ]
if grep -q 'up -d .* IMAGE=sha256:previous' "$CALLS"; then exit 1; fi
# The running image asked for again, by its own pin or by another name for it (here its digest): resolved, then left alone.
repeat=0
for request in example:v1.0.0 "example@sha256:$(printf 'a%.0s' $(seq 64))"; do
  repeat=$((repeat + 1))
  make_install "repeat-$repeat"
  before=$(sha256sum "$case_dir/.env")
  sh "$case_dir/update.sh" "$request" > "$temporary/output" 2>&1
  grep -qx 'Already on the requested image.' "$temporary/output"
  [ "$before" = "$(sha256sum "$case_dir/.env")" ]
  if grep -q ' stop app\| snapshot \|up -d' "$CALLS"; then echo "Changed something for a repeated request: $request" >&2; exit 1; fi
  [ ! -e "$case_dir/version-history.tsv" ]
done
for stage in pull snapshot startup health; do
  make_install "$stage"
  if FAIL_AT="$stage" sh "$case_dir/update.sh" --unsigned example:v1.0.1-local >"$temporary/output" 2>&1; then
    echo "Expected $stage failure" >&2; exit 1
  fi
  grep -qx APP_IMAGE=example:v1.0.0 "$case_dir/.env"
  if grep -q private-test-value "$temporary/output"; then exit 1; fi
  if [ "$stage" = snapshot ]; then
    grep -q "set them up in Settings → Integrations" "$temporary/output"
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
  if APP_STATE="$app_state" sh "$case_dir/update.sh" --unsigned example:v1.0.1-local >"$temporary/output" 2>&1; then
    echo "Accepted an ordinary update with app $app_state and no recovery record." >&2; exit 1
  fi
  grep -q 'The app must be running before an update' "$temporary/output"
  grep -qx APP_IMAGE=example:v1.0.0 "$case_dir/.env"
  if grep -q 'stop app\|snapshot pre-upgrade\|up -d' "$CALLS"; then exit 1; fi
done
make_install compose-error
if FAIL_AT=compose sh "$case_dir/update.sh" --unsigned example:v1.0.1-local >"$temporary/output" 2>&1; then exit 1; fi
grep -q 'Cannot connect to the Docker daemon' "$temporary/output"
grep -q 'Could not check whether the app is running' "$temporary/output"
if grep -q 'The app must be running' "$temporary/output"; then exit 1; fi
if grep -q 'stop app\|snapshot pre-upgrade\|up -d' "$CALLS"; then exit 1; fi

make_install locked
touch "$case_dir/.rotate-key.inflight"
for arguments in '--unsigned example:v1.0.1-local' '--patch --now'; do
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
if flock "$case_dir/.update.lock" sh "$case_dir/update.sh" --unsigned example:v1.0.1-local > "$temporary/output" 2>&1; then exit 1; fi
[ ! -s "$CALLS" ]
if sh "$case_dir/update.sh" example:latest >/dev/null 2>&1; then exit 1; fi
if sh "$case_dir/update.sh" --unsigned example:latest >/dev/null 2>&1; then exit 1; fi
# Automatic patch updates have their own test (patch.sh); here only malformed arguments are refused.
for arguments in '' '--now' 'example:v1.0.1 example:v1.0.2' '--patch extra' '--unsigned' '--unsigned --patch' '--unsigned a b' \
  '--patch --unsigned' '--rollback --unsigned'; do
  # shellcheck disable=SC2086
  if sh "$case_dir/update.sh" $arguments > "$temporary/output" 2>&1; then echo "Accepted: $arguments" >&2; exit 1; fi
  case $arguments in --unsigned*) grep -q '^Usage: ./update.sh \[--unsigned\] IMAGE' "$temporary/output" ;; esac
done
[ ! -s "$CALLS" ]

# A nightly prerelease's version and floor (vX.Y.0-nightly.N) pass manifest_check only in a manifest signed for the
# prerelease channel; a release's manifest passes with or without it, as before.
manifest_case() { # VERSION FLOOR CHANNEL
  { printf 'format=plaingym-release-manifest/2\nversion=%s\nimage=ghcr.io/example/app\ndigest=sha256:%s\nrollback_floor=%s\n' \
      "$1" "$(printf 'a%.0s' $(seq 64))" "$2"
    [ -z "$3" ] || printf 'channel=%s\n' "$3"
    printf 'revision=%s\nmigrations=sha256:%s\n' "$(printf 'c%.0s' $(seq 40))" "$(printf 'd%.0s' $(seq 64))"; } > "$temporary/manifest.txt"
  (ROOT=$temporary; . "$source_dir/lib.sh"; manifest_check "$temporary/manifest.txt" "$1")
}
manifest_case v1.2.0-nightly.1 v1.2.0-nightly.1 prerelease
manifest_case v1.2.0-nightly.2 v1.1.3 prerelease
manifest_case v1.2.3 v1.2.0 ''
manifest_case v1.2.3 v1.2.0 prerelease
refuse_manifest() { if manifest_case "$@"; then echo "manifest_check accepted: $*" >&2; exit 1; fi; }
refuse_manifest v1.2.0-nightly.1 v1.2.0-nightly.1 ''
refuse_manifest v1.2.0-nightly.1 v1.1.3 ''
refuse_manifest v1.2.0 v1.2.0-nightly.1 ''
refuse_manifest v1.2.0-nightly.1 v1.2.0 prerelease
refuse_manifest v1.2.1-nightly.1 v1.2.0 prerelease
refuse_manifest v1.2.0-beta.1 v1.2.0 prerelease
# The schema guard takes a nightly floor and release only for the prerelease channel.
make_install nightly-guard
(ROOT=$case_dir; . "$source_dir/lib.sh"; write_schema_guard v1.2.0-nightly.1 v1.2.0-nightly.2 - prerelease)
grep -qx "      SCHEMA_ROLLBACK_FLOOR: 'v1.2.0-nightly.1'" "$case_dir/schema-compatibility.yaml"
grep -qx "      SCHEMA_RELEASE: 'v1.2.0-nightly.2'" "$case_dir/schema-compatibility.yaml"
rm "$case_dir/schema-compatibility.yaml"
if (ROOT=$case_dir; . "$source_dir/lib.sh"; write_schema_guard v1.2.0-nightly.1 v1.2.0-nightly.2 -) 2> "$temporary/output"; then
  echo 'Wrote a nightly schema guard without the prerelease channel.' >&2; exit 1
fi
grep -q 'Invalid schema compatibility state' "$temporary/output"
[ ! -e "$case_dir/schema-compatibility.yaml" ]
echo 'PASS: coordinated snapshot, pull before capture, publication, startup/health failures, rollback, lock, version pinning, unlabelled images only with --unsigned, nightly manifests and schema guards only on the prerelease channel.'
