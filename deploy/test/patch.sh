#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Exercises `update.sh --patch` with Docker, curl and date fixtures and real Ed25519 signatures: patch selection,
# signature and digest checks, the owner's setting, a skipped snapshot, rollback, the nightly window, and results
# kept until the app can record them. Needs root, OpenSSL 3, flock and tzdata (a disposable Ubuntu 24.04 is fine).
set -eu
umask 077
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
[ "$(id -u)" -eq 0 ] || { echo 'Run this test as root in a disposable environment.' >&2; exit 1; }
[ -f /usr/share/zoneinfo/America/Denver ] || { echo 'Install tzdata first.' >&2; exit 1; }
temporary=$(mktemp -d)
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$temporary/output" ]; then echo '--- last update.sh output:' >&2; cat "$temporary/output" >&2; fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT
mkdir "$temporary/bin" "$temporary/release"
export PATH="$temporary/bin:$PATH" CALLS="$temporary/calls" RECORDS="$temporary/records" FIXTURES="$temporary/release"
export UPDATE_SETTLE_SECONDS=0
digest=sha256:$(printf 'd%.0s' $(seq 64))
export DIGEST="$digest"

# Docker: logs each call with the image it targets, and fails where FAIL_AT says.
cat > "$temporary/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s IMAGE=%s\n' "$*" "${APP_IMAGE:-configured}" >> "$CALLS"
image_of() { for argument in "$@"; do last=$argument; done; printf '%s' "$last"; }
case "$*" in
  *' ps --status running --services') [ "${FAIL_AT:-}" = app_down ] || echo app ;;
  *' ps -q app') echo container-1 ;;
  'inspect container-1 '*) if [ "${FAIL_AT:-}" = settle ]; then echo 'healthy 1'; else echo 'healthy 0'; fi ;;
  *' exec -T app gym-app auto-update check') cat "$FIXTURES/check" ;;
  *' exec -T app gym-app auto-update record '*)
    [ "${FAIL_AT:-}" != record ] || exit 1
    printf '%s\n' "$*" | sed 's/.* auto-update record //' >> "$RECORDS" ;;
  "image inspect "*" --format {{.Id}}") [ "${FAIL_AT:-}" != previous ] || exit 1; echo sha256:previous ;;
  'image inspect '*'org.opencontainers.image.version'*)
    case "$3" in *@sha256:*) echo "${TARGET_LABEL:-v1.2.5}" ;; *) echo "${CURRENT_LABEL:-v1.2.3}" ;; esac ;;
  'image inspect '*RepoDigests*) echo "${REPO_DIGEST:-ghcr.io/example/app@$DIGEST}"; echo 'ghcr.io/example/app@sha256:0000000000000000000000000000000000000000000000000000000000000000' ;;
  'run --rm --network none '*)
    case "$*" in *@sha256:*' -c '*) [ "${FAIL_AT:-}" != migration ] || { echo "$(printf 'f%.0s' $(seq 64))  -"; exit 0; } ;; esac
    echo "$(printf 'c%.0s' $(seq 64))  -" ;;
  *' pull app') [ "${FAIL_AT:-}" != pull ] ;;
  *' snapshot pre-upgrade')
    # snapshot_signal: the unit is stopped during the snapshot (systemd signals update.sh and its commands).
    [ "${FAIL_AT:-}" != snapshot_signal ] || { kill -TERM "$PPID"; exit 143; }
    [ "${FAIL_AT:-}" != snapshot ] || { echo 'S3 refused the upload' >&2; exit 1; } ;;
  *'up -d '*)
    if [ "${APP_IMAGE:-}" = sha256:previous ]; then [ "${FAIL_AT:-}" != rollback ]
    elif [ -n "${APP_IMAGE:-}" ]; then [ "${FAIL_AT:-}" != startup ]
    else [ "${FAIL_AT:-}" != pinned ]; fi ;;
  *' node /app/deploy/healthcheck.mjs') case "${FAIL_AT:-}" in health|rollback) exit 1 ;; esac ;;
esac
MOCK
# curl: the release list, manifest and signature come from the fixture directory.
cat > "$temporary/bin/curl" <<'MOCK'
#!/bin/sh
url= output=
while [ "$#" -gt 0 ]; do case "$1" in -o) output=$2; shift 2 ;; https://*) url=$1; shift ;; *) shift ;; esac; done
printf 'curl %s\n' "$url" >> "$CALLS"
case "$url" in
  https://api.github.com/repos/example/app/releases?per_page=100) [ "${FAIL_AT:-}" != releases ] || exit 22; cp "$FIXTURES/releases.json" "$output" ;;
  https://github.com/example/app/releases/download/*/release-manifest.txt) [ "${FAIL_AT:-}" != manifest ] || exit 22; cp "$FIXTURES/manifest" "$output" ;;
  https://github.com/example/app/releases/download/*/release-manifest.txt.sig) cp "$FIXTURES/manifest.sig" "$output" ;;
  *) exit 22 ;;
esac
MOCK
# date: FAKE_HOUR and FAKE_DAY stand in for the gym's local hour and date.
cat > "$temporary/bin/date" <<'MOCK'
#!/bin/sh
case "$*" in '+%H') echo "${FAKE_HOUR:-03}" ;; '+%F') echo "${FAKE_DAY:-2026-11-03}" ;; *) exec /bin/date "$@" ;; esac
MOCK
chmod 0700 "$temporary/bin/docker" "$temporary/bin/curl" "$temporary/bin/date"

openssl genpkey -algorithm ed25519 -out "$temporary/release/key.pem" 2>/dev/null
openssl pkey -in "$temporary/release/key.pem" -pubout -out "$temporary/release/public.pem"
openssl genpkey -algorithm ed25519 -out "$temporary/release/other.pem" 2>/dev/null
printf '[{"tag_name": "v2.0.0"}, {"tag_name":"v1.3.0"},\n {"tag_name": "v1.2.5"}, {"tag_name": "v1.2.4"}, {"tag_name": "v1.2.3"}, {"tag_name": "v1.2.10-rc.1"}]\n' > "$FIXTURES/releases.json"
# write_manifest VERSION [KEY]: a signed manifest for VERSION.
write_manifest() {
  printf 'format=plaingym-release-manifest/1\nversion=%s\nimage=ghcr.io/example/app\ndigest=%s\ndigest.linux/amd64=sha256:%s\ndigest.linux/arm64=sha256:%s\nrevision=%s\nmigrations=sha256:%s\nreleased=2026-11-03T00:00:00Z\n' \
    "$1" "$digest" "$(printf 'a%.0s' $(seq 64))" "$(printf 'b%.0s' $(seq 64))" "$(printf '1%.0s' $(seq 40))" "$(printf 'c%.0s' $(seq 64))" > "$FIXTURES/manifest"
  openssl pkeyutl -sign -inkey "${2:-$temporary/release/key.pem}" -rawin -in "$FIXTURES/manifest" -out "$FIXTURES/manifest.sig"
}
# checks [RESTORE] [ENABLED] [BACKUPS]: what `gym-app auto-update check` answers.
checks() { printf 'restore=%s\nsetup=true\nenabled=%s\nbackups=%s\ntimezone=America/Denver\n' "${1:-false}" "${2:-true}" "${3:-true}" > "$FIXTURES/check"; }
make_install() {
  case_dir="$temporary/$1"
  mkdir "$case_dir"
  cp "$source_dir/update.sh" "$source_dir/lib.sh" "$case_dir/"
  cp "$temporary/release/public.pem" "$case_dir/release-signing.pem"
  : > "$case_dir/compose.yaml"
  printf 'APP_IMAGE=ghcr.io/example/app:v1.2.3\nRELEASE_REPOSITORY=example/app\nFAKE_SECRET=private-test-value\n' > "$case_dir/.env"
  : > "$CALLS"; : > "$RECORDS"
  write_manifest v1.2.5
  checks
}
# expect_status STATUS [NAME=VALUE...] ARGS...: run update.sh with the fixture settings given, expecting STATUS.
expect_status() {
  expected=$1; shift
  assignments=
  while [ "$#" -gt 0 ]; do case "$1" in [A-Z]*=*) assignments="$assignments $1"; shift ;; *) break ;; esac; done
  status=0
  # Fixture values hold no spaces.
  # shellcheck disable=SC2086
  env $assignments sh "$case_dir/update.sh" "$@" > "$temporary/output" 2>&1 || status=$?
  [ "$status" -eq "$expected" ] || { echo "Expected exit $expected, got $status:$assignments $*" >&2; exit 1; }
}
pinned() { grep -qx "APP_IMAGE=$1" "$case_dir/.env"; }
recorded() { tail -n 1 "$RECORDS" | grep -Eq "^--at [0-9T:Z-]+ $1\$" || { echo "Expected the record: $1" >&2; cat "$RECORDS" >&2; exit 1; }; }
called() { grep -q -- "$1" "$CALLS"; }
line_of() { grep -n -- "$1" "$CALLS" | head -n 1 | cut -d: -f1; }
never() { if grep -q -- "$1" "$CALLS"; then echo "Unexpected call: $1" >&2; cat "$CALLS" >&2; exit 1; fi; }
no_secret() { if grep -q private-test-value "$temporary/output"; then echo 'A secret reached the output.' >&2; exit 1; fi; }
target="ghcr.io/example/app:v1.2.5@$digest"

# The newest patch of the running minor, never a newer minor or major, verified, then applied with a snapshot.
make_install success
expect_status 0 --patch --now
pinned "$target"
recorded "--result updated --from v1.2.3 --to v1.2.5"
called 'curl https://github.com/example/app/releases/download/v1.2.5/release-manifest.txt'
[ "$(line_of ' pull app')" -lt "$(line_of ' stop app')" ]
[ "$(line_of 'run --rm --network none')" -lt "$(line_of ' stop app')" ]
[ "$(line_of ' stop app')" -lt "$(line_of ' snapshot pre-upgrade')" ]
[ "$(line_of ' snapshot pre-upgrade')" -lt "$(line_of ' up -d ')" ]
grep -q " up -d .* IMAGE=$target" "$CALLS"
never 'IMAGE=sha256:previous'
[ ! -e "$case_dir/.auto-update.inflight" ] && [ ! -e "$case_dir/auto-update.result" ]
grep -qx timezone=America/Denver "$case_dir/auto-update.state"
grep -qx night=2026-11-03 "$case_dir/auto-update.state"
no_secret

# Nothing newer in this minor: up to date, nothing pulled.
make_install current
printf '[{"tag_name": "v1.3.0"}, {"tag_name": "v1.2.3"}]\n' > "$FIXTURES/releases.json"
expect_status 0 --patch --now
recorded "--result up_to_date --from v1.2.3"
never ' pull app'
printf '[{"tag_name": "v2.0.0"}, {"tag_name":"v1.3.0"},\n {"tag_name": "v1.2.5"}, {"tag_name": "v1.2.4"}, {"tag_name": "v1.2.3"}]\n' > "$FIXTURES/releases.json"

# The owner turned automatic updates off: nothing is downloaded or changed, and the skip is recorded.
make_install disabled
checks false false true
expect_status 0 --patch --now
recorded "--result skipped --reason disabled --from v1.2.3"
never 'curl '; never ' pull app'; never ' stop app'
pinned ghcr.io/example/app:v1.2.3

# No snapshot can be taken without backups: skipped before anything stops.
make_install no-backups
checks false true false
expect_status 0 --patch --now
recorded "--result skipped --reason backups_not_configured --from v1.2.3"
never ' pull app'; never ' stop app'

# A manifest changed after signing, or signed by another key, is refused before any pull.
make_install tampered
sed -i "s/^digest=.*/digest=sha256:$(printf 'e%.0s' $(seq 64))/" "$FIXTURES/manifest"
expect_status 1 --patch --now
recorded "--result skipped --reason signature_invalid --from v1.2.3 --to v1.2.5"
never ' pull app'
make_install other-key
write_manifest v1.2.5 "$temporary/release/other.pem"
expect_status 1 --patch --now
recorded "--result skipped --reason signature_invalid --from v1.2.3 --to v1.2.5"
never ' pull app'
make_install truncated-signature
head -c 63 "$FIXTURES/manifest.sig" > "$FIXTURES/short.sig" && mv "$FIXTURES/short.sig" "$FIXTURES/manifest.sig"
expect_status 1 --patch --now
recorded "--result skipped --reason signature_invalid --from v1.2.3 --to v1.2.5"
# A validly signed manifest for another version is refused too.
make_install wrong-version
write_manifest v1.2.4
expect_status 1 --patch --now
recorded "--result skipped --reason manifest_invalid --from v1.2.3 --to v1.2.5"
never ' pull app'

# The pulled image must carry the signed digest and version; otherwise nothing stops.
make_install digest
expect_status 1 "REPO_DIGEST=ghcr.io/example/app@sha256:$(printf 'e%.0s' $(seq 64))" --patch --now
recorded "--result skipped --reason digest_mismatch --from v1.2.3 --to v1.2.5"
never ' stop app'
make_install label
expect_status 1 TARGET_LABEL=v1.2.4 --patch --now
recorded "--result skipped --reason digest_mismatch --from v1.2.3 --to v1.2.5"
never ' stop app'
# A patch whose image would change the database is never installed automatically.
make_install migration
expect_status 1 FAIL_AT=migration --patch --now
recorded "--result skipped --reason migration_in_patch --from v1.2.3 --to v1.2.5"
never ' stop app'
make_install pull
expect_status 1 FAIL_AT=pull --patch --now
recorded "--result skipped --reason pull_failed --from v1.2.3 --to v1.2.5"
never ' stop app'

# A snapshot that can't be taken skips the update and restarts the running version.
make_install snapshot
expect_status 1 FAIL_AT=snapshot --patch --now
recorded "--result skipped --reason snapshot_failed --from v1.2.3 --to v1.2.5"
pinned ghcr.io/example/app:v1.2.3
grep 'up -d ' "$CALLS" | tail -n 1 | grep -q 'IMAGE=sha256:previous'
never "up -d .* IMAGE=$target"
[ ! -e "$case_dir/.auto-update.inflight" ]
# Stopped during the snapshot: the new version never ran, so it reads as skipped, not rolled back.
make_install snapshot-signal
expect_status 130 FAIL_AT=snapshot_signal --patch --now
recorded "--result skipped --reason snapshot_failed --from v1.2.3 --to v1.2.5"
pinned ghcr.io/example/app:v1.2.3
grep 'up -d ' "$CALLS" | tail -n 1 | grep -q 'IMAGE=sha256:previous'
never "up -d .* IMAGE=$target"
[ ! -e "$case_dir/.auto-update.inflight" ]
# The swap can't start (the running image can't be read): nothing stopped, and no marker for the next run.
make_install previous
expect_status 1 FAIL_AT=previous --patch --now
never ' stop app'
[ ! -e "$case_dir/.auto-update.inflight" ]

# A failed start or health check goes back to the previous image, by image ID.
for stage in startup health settle; do
  make_install "$stage"
  expect_status 1 FAIL_AT=$stage --patch --now
  reason=health_check_failed; [ "$stage" != startup ] || reason=startup_failed
  recorded "--result rolled_back --reason $reason --from v1.2.3 --to v1.2.5"
  pinned ghcr.io/example/app:v1.2.3
  grep 'up -d ' "$CALLS" | tail -n 1 | grep -q 'IMAGE=sha256:previous'
  [ ! -e "$case_dir/.auto-update.inflight" ]
  no_secret
done
make_install rollback
expect_status 1 FAIL_AT=rollback --patch --now
recorded "--result failed --reason rollback_failed --from v1.2.3 --to v1.2.5"
pinned ghcr.io/example/app:v1.2.3
# The previous image may not be running: the marker stays, and every later run starts the pinned image until it runs.
[ -e "$case_dir/.auto-update.inflight" ]
: > "$CALLS"
expect_status 1 FAIL_AT=pinned FAKE_HOUR=14 --patch
recorded "--result failed --reason rollback_failed --from v1.2.3 --to v1.2.5"
grep -q ' up -d --no-deps --wait --wait-timeout 90 app IMAGE=configured' "$CALLS"
never 'auto-update check'
[ -e "$case_dir/.auto-update.inflight" ]
expect_status 1 FAKE_HOUR=14 --patch
recorded "--result rolled_back --reason interrupted --from v1.2.3 --to v1.2.5"
[ ! -e "$case_dir/.auto-update.inflight" ]

# Situations that change nothing.
make_install not-set-up
printf 'restore=false\nsetup=false\n' > "$FIXTURES/check"
expect_status 0 --patch --now
[ ! -s "$RECORDS" ] && [ ! -e "$case_dir/auto-update.result" ]
never 'curl '; never ' pull app'
make_install no-key
rm "$case_dir/release-signing.pem"
expect_status 0 --patch --now
recorded "--result skipped --reason no_signing_key --from v1.2.3"
never 'curl '
make_install unknown-version
expect_status 1 CURRENT_LABEL=0.0.0-dev --patch --now
recorded "--result skipped --reason version_unknown"
make_install releases
expect_status 1 FAIL_AT=releases --patch --now
recorded "--result skipped --reason release_list_unavailable --from v1.2.3"
make_install manifest
expect_status 1 FAIL_AT=manifest --patch --now
recorded "--result skipped --reason manifest_unavailable --from v1.2.3 --to v1.2.5"
make_install app-down
expect_status 1 FAIL_AT=app_down --patch --now
never 'auto-update check'
grep -Eq '^[0-9T:Z-]+ skipped check_failed - -$' "$case_dir/auto-update.result"

# A result the app can't take yet (restoring, or down) waits and is recorded first on the next run.
make_install restore
checks true
expect_status 0 FAIL_AT=record --patch --now
[ ! -s "$RECORDS" ]
grep -Eq '^[0-9T:Z-]+ skipped restore_in_progress - -$' "$case_dir/auto-update.result"
never ' pull app'
checks
expect_status 0 --patch --now
head -n 1 "$RECORDS" | grep -Eq '^--at [0-9T:Z-]+ --result skipped --reason restore_in_progress$'
recorded "--result updated --from v1.2.3 --to v1.2.5"
[ ! -e "$case_dir/auto-update.result" ]

# A run killed between stopping the app and pinning an image: the next run starts the pinned image first.
make_install interrupted
printf 'v1.2.3 v1.2.5\n' > "$case_dir/.auto-update.inflight"
expect_status 1 --patch
recorded "--result rolled_back --reason interrupted --from v1.2.3 --to v1.2.5"
grep -q ' up -d --no-deps --wait --wait-timeout 90 app IMAGE=configured' "$CALLS"
never 'auto-update check'
[ ! -e "$case_dir/.auto-update.inflight" ]

# The timer fires hourly: only the first run inside 02:00-05:00 of the gym's night acts.
make_install window
expect_status 0 FAKE_HOUR=14 --patch
called 'auto-update check'
[ ! -s "$RECORDS" ]; never 'curl '
grep -qx timezone=America/Denver "$case_dir/auto-update.state"
: > "$CALLS"
expect_status 0 FAKE_HOUR=15 --patch
[ ! -s "$CALLS" ]
expect_status 0 FAKE_HOUR=02 --patch
recorded "--result updated --from v1.2.3 --to v1.2.5"
: > "$CALLS"
expect_status 0 FAKE_HOUR=03 --patch
[ ! -s "$CALLS" ]
expect_status 0 FAKE_HOUR=02 FAKE_DAY=2026-11-04 --patch
called 'auto-update check'

# Another update holds the lock: this run does nothing.
make_install locked
if ! flock "$case_dir/.update.lock" sh "$case_dir/update.sh" --patch --now > "$temporary/output" 2>&1; then exit 1; fi
[ ! -s "$CALLS" ]
for arguments in '--patch extra' '--now' '--patch --later'; do
  # shellcheck disable=SC2086
  if sh "$case_dir/update.sh" $arguments > /dev/null 2>&1; then echo "Accepted: $arguments" >&2; exit 1; fi
done
echo 'PASS: patch selection, signature, digest and migration checks, setting off, skipped snapshot, rollback, window, pending results.'
