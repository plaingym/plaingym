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
export PATH="$temporary/bin:$PATH" CALLS="$temporary/calls" RECORDS="$temporary/records" NOTIFIED="$temporary/notified" FIXTURES="$temporary/release"
export UPDATE_SETTLE_SECONDS=0
digest=sha256:$(printf 'd%.0s' $(seq 64))
export DIGEST="$digest"
PREVIOUS_ID="sha256:$(printf 'a%.0s' $(seq 64))"
export PREVIOUS_ID

# Docker: logs each call with the image it targets, and fails where FAIL_AT says. A start that fails leaves the app
# down (the file `down`) until a start succeeds. DISTINCT_IDS gives each release's image its own ID and label.
cat > "$temporary/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s IMAGE=%s\n' "$*" "${APP_IMAGE:-configured}" >> "$CALLS"
version_in() { tag=${1#*:v}; printf 'v%s\n' "${tag%%@*}"; }
id_in() { tag=${1##*.}; printf 'sha256:%064d\n' "${tag%%@*}"; }
case "$*" in
  *' ps --status running --services') [ "${FAIL_AT:-}" = app_down ] || [ -e "$FIXTURES/down" ] || echo app ;;
  *' ps -q app') echo container-1 ;;
  'inspect container-1 '*) if [ "${FAIL_AT:-}" = settle ]; then echo 'healthy 1'; else echo 'healthy 0'; fi ;;
  *' exec -T app gym-app auto-update check') cat "$FIXTURES/check" ;;
  *' exec -T postgres '*) echo '20|1000' ;;
  *' exec -T app gym-app auto-update record '*)
    [ "${FAIL_AT:-}" != record ] || exit 1
    case "$*" in *' --reason refused'*) exit 2 ;; esac
    case "$*" in *' --notice deferred') ;; *) echo 'Host must defer notices until results are stored' >&2; exit 1 ;; esac
    printf '%s\n' "$*" | sed 's/.* auto-update record //; s/ --notice deferred$//' >> "$RECORDS" ;;
  *' exec -T app gym-app auto-update notice '*)
    [ "${FAIL_AT:-}" != notice ] || exit 3
    case "${FAIL_AT:-}:$*" in notice_one:*' --to v1.2.4 '*) exit 3 ;; esac
    printf '%s\n' "$*" | sed 's/.* auto-update notice //' >> "$NOTIFIED" ;;
  "image inspect "*" --format {{.Id}}") [ "${FAIL_AT:-}" != previous ] || exit 1
    # GONE_REF: a reference removed outside the updater (docker image prune -a, say).
    [ "$3" != "${GONE_REF:-}" ] || exit 1
    case "$3" in
      sha256:*) echo "$3" ;;
      *:v1.2.1@*) echo "sha256:$(printf 'b%.0s' $(seq 64))" ;;
      *:v1.2.2@*) echo "sha256:$(printf 'e%.0s' $(seq 64))" ;;
      *@sha256:*) if [ -n "${DISTINCT_IDS:-}" ]; then id_in "$3"; else echo "$DIGEST"; fi ;;
      *) echo "$PREVIOUS_ID" ;;
    esac ;;
  'image inspect '*'org.opencontainers.image.version'*)
    case "$3" in
      "$PREVIOUS_ID") echo v1.2.3 ;;
      *@sha256:*) if [ -n "${DISTINCT_IDS:-}" ]; then version_in "$3"; else echo "${TARGET_LABEL:-v1.2.5}"; fi ;;
      *) echo "${CURRENT_LABEL:-v1.2.3}" ;;
    esac ;;
  'image inspect '*RepoDigests*) echo "${REPO_DIGEST:-ghcr.io/example/app@$DIGEST}"; echo 'ghcr.io/example/app@sha256:0000000000000000000000000000000000000000000000000000000000000000' ;;
  # An image is there until it is removed.
  'image inspect '*) [ ! -e "$FIXTURES/removed" ] || ! grep -qxF "$3" "$FIXTURES/removed" ;;
  'image rm '*) printf '%s\n' "$3" >> "$FIXTURES/removed" ;;
  'run --rm --network none '*)
    case "$*" in *@sha256:*' -c '*) [ "${FAIL_AT:-}" != migration ] || { echo "$(printf 'f%.0s' $(seq 64))  -"; exit 0; } ;; esac
    echo "$(printf 'c%.0s' $(seq 64))  -" ;;
  *' pull app') [ "${FAIL_AT:-}" != pull ] ;;
  *' snapshot pre-upgrade')
    # snapshot_signal: the unit is stopped during the snapshot (systemd signals update.sh and its commands).
    [ "${FAIL_AT:-}" != snapshot_signal ] || { kill -TERM "$PPID"; exit 143; }
    [ "${FAIL_AT:-}" != snapshot ] || { echo 'S3 refused the upload' >&2; exit 1; } ;;
  *'up -d '*)
    started=true
    if [ "${APP_IMAGE:-}" = "$PREVIOUS_ID" ]; then [ "${FAIL_AT:-}" != rollback ] || started=false
    elif [ -n "${APP_IMAGE:-}" ]; then [ "${FAIL_AT:-}" != startup ] || started=false
    else [ "${FAIL_AT:-}" != pinned ] || started=false; fi
    if [ "$started" = true ]; then rm -f "$FIXTURES/down"; else : > "$FIXTURES/down"; exit 1; fi ;;
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
  https://github.com/example/app/releases/download/*/plaingym-deploy-*.tar.gz) [ "${FAIL_AT:-}" != archive ] || exit 22; cp "$FIXTURES/host.tar.gz" "$output" ;;
  *) exit 22 ;;
esac
MOCK
# date: FAKE_HOUR and FAKE_DAY stand in for the gym's local hour and date.
cat > "$temporary/bin/date" <<'MOCK'
#!/bin/sh
case "$*" in '+%H') echo "${FAKE_HOUR:-03}" ;; '+%F') echo "${FAKE_DAY:-2026-11-03}" ;; *) exec /bin/date "$@" ;; esac
MOCK
REAL_OPENSSL=$(command -v openssl)
REAL_MV=$(command -v mv)
export REAL_OPENSSL REAL_MV
cat > "$temporary/bin/openssl" <<'MOCK'
#!/bin/sh
printf 'openssl %s\n' "$*" >> "$CALLS"
exec "$REAL_OPENSSL" "$@"
MOCK
cat > "$temporary/bin/systemctl" <<'MOCK'
#!/bin/sh
printf 'systemctl %s\n' "$*" >> "$CALLS"
if [ "${FAIL_AT:-}" = host_reload ] && [ ! -f "$FIXTURES/reload_failed" ]; then
  touch "$FIXTURES/reload_failed"; exit 1
fi
MOCK
cat > "$temporary/bin/mv" <<'MOCK'
#!/bin/sh
case "$*" in
  *'.env.next '*)
    if [ "${FAIL_AT:-}" = host_pin_signal ]; then "$REAL_MV" "$@"; kill -TERM "$PPID"; exit 0; fi ;;
  *'.host-retired.'*)
    if [ "${FAIL_AT:-}" = host_cleanup_killed ]; then "$REAL_MV" "$@"; kill -KILL "$PPID"; exit 1; fi ;;
  *lib.sh.host-next*)
    if [ ! -f "$FIXTURES/mv_failed" ]; then
      case "${FAIL_AT:-}" in
        host_midway) touch "$FIXTURES/mv_failed"; exit 1 ;;
        host_killed) touch "$FIXTURES/mv_failed"; "$REAL_MV" "$@"; kill -KILL "$PPID"; exit 1 ;;
      esac
    fi ;;
esac
exec "$REAL_MV" "$@"
MOCK
chmod 0700 "$temporary/bin/docker" "$temporary/bin/curl" "$temporary/bin/date" "$temporary/bin/openssl" "$temporary/bin/systemctl" "$temporary/bin/mv"

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
  printf 'Case: %s\n' "$1"
  case_dir="$temporary/$1"
  mkdir "$case_dir"
  cp "$source_dir/update.sh" "$source_dir/lib.sh" "$case_dir/"
  cp "$temporary/release/public.pem" "$case_dir/release-signing.pem"
  : > "$case_dir/compose.yaml"
  printf 'APP_IMAGE=ghcr.io/example/app:v1.2.3\nRELEASE_REPOSITORY=example/app\nFAKE_SECRET=private-test-value\n' > "$case_dir/.env"
  : > "$CALLS"; : > "$RECORDS"; : > "$NOTIFIED"
  rm -f "$FIXTURES/down" "$FIXTURES/removed"
  rm -f "$FIXTURES/mv_failed" "$FIXTURES/reload_failed" "$FIXTURES/generations"
  SYSTEMD_UNIT_DIR="$case_dir/units"
  export SYSTEMD_UNIT_DIR
  mkdir "$SYSTEMD_UNIT_DIR"
  write_manifest v1.2.5
  checks
  : > "$CALLS" # Fixture signing is setup, not an updater call (including the lock-refusal case).
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
never "IMAGE=$PREVIOUS_ID"
[ "$(wc -l < "$case_dir/version-history.tsv")" -eq 3 ]
awk -F '\t' 'NR == 1 { if ($2 != "v1.2.3" || $4 != "install") exit 1 } NR == 3 { if ($2 != "v1.2.5" || $4 != "update") exit 1 }' "$case_dir/version-history.tsv"
[ ! -e "$case_dir/.auto-update.inflight" ] && [ ! -e "$case_dir/auto-update.result" ]
grep -qx timezone=America/Denver "$case_dir/auto-update.state"
grep -qx night=2026-11-03 "$case_dir/auto-update.state"
no_secret

# Only images this install's updater pulled, or that the rollback stack held, may be pruned; the stack's top three stay.
make_install pruning
old_id="sha256:$(printf 'b%.0s' $(seq 64))"
retained_id="sha256:$(printf 'e%.0s' $(seq 64))"
printf 'ghcr.io/example/app:v1.2.1@%s\t%s\tv1.2.1\n' "$old_id" "$old_id" > "$case_dir/auto-update-images.tsv"
printf 'ghcr.io/example/app:v1.2.2@%s\t%s\tv1.2.2\n' "$retained_id" "$retained_id" >> "$case_dir/auto-update-images.tsv"
printf '2026-11-01T00:00:00Z\tv1.2.2\t%s\tinstall\tv1.2.0\t-\n' "$retained_id" > "$case_dir/version-history.tsv"
printf '2026-11-02T00:00:00Z\tv1.2.3\t%s\tupdate\tv1.2.0\t-\n' "$PREVIOUS_ID" >> "$case_dir/version-history.tsv"
expect_status 0 --patch --now
called "image rm $old_id"
[ "$(grep -c 'image rm ' "$CALLS")" -eq 1 ]
never "image rm $retained_id"
never 'image prune'
never 'image rm other/'
# Each pulled image is listed once, and a removed one leaves the list.
[ "$(cut -f3 "$case_dir/auto-update-images.tsv" | tr '\n' ' ')" = 'v1.2.2 v1.2.5 ' ]
grep -q "ghcr.io/example/app:v1.2.5@$digest" "$case_dir/auto-update-images.tsv"

# Five patch updates leave the current image and the two before it, and nothing older: the installer's image goes
# too once it falls off. --rollback then walks back only through the kept images.
make_install five
image_id() { printf 'sha256:%064d' "$1"; }
for patch_number in 4 5 6 7 8; do
  printf '[{"tag_name": "v1.2.%s"}, {"tag_name": "v1.3.0"}]\n' "$patch_number" > "$FIXTURES/releases.json"
  write_manifest "v1.2.$patch_number"
  expect_status 0 DISTINCT_IDS=true --patch --now
  recorded "--result updated --from v1.2.$((patch_number - 1)) --to v1.2.$patch_number"
done
pinned "ghcr.io/example/app:v1.2.8@$digest"
for removed in "$PREVIOUS_ID" "$(image_id 4)" "$(image_id 5)"; do called "image rm $removed"; done
for retained in 6 7 8; do never "image rm $(image_id "$retained")"; done
[ "$(grep -c 'image rm ' "$CALLS")" -eq 3 ]
[ "$(cut -f3 "$case_dir/auto-update-images.tsv" | tr '\n' ' ')" = 'v1.2.6 v1.2.7 v1.2.8 ' ]
[ "$(grep -c "$(printf '\ttrimmed\t')" "$case_dir/version-history.tsv")" -eq 3 ]
(
  ROOT=$case_dir
  # shellcheck source=deploy/lib.sh
  . "$case_dir/lib.sh"
  [ "$(previous_version "$(image_id 8)" | cut -f2)" = v1.2.7 ]
  history_record v1.2.7 "$(image_id 7)" rollback v1.2.0 -
  [ "$(previous_version "$(image_id 7)" | cut -f2)" = v1.2.6 ]
  history_record v1.2.6 "$(image_id 6)" rollback v1.2.0 -
  [ -z "$(previous_version "$(image_id 6)")" ]
  # The trimmed rows change no rollback floor: the installer's v1.2.3 stays the highest.
  [ "$(schema_floor)" = v1.2.3 ]
)
printf '[{"tag_name": "v2.0.0"}, {"tag_name":"v1.3.0"},\n {"tag_name": "v1.2.5"}, {"tag_name": "v1.2.4"}, {"tag_name": "v1.2.3"}]\n' > "$FIXTURES/releases.json"

make_install dot-repository
printf 'APP_IMAGE=ghcr.io/example/app:v1.2.3\nRELEASE_REPOSITORY=../..\n' > "$case_dir/.env"
expect_status 1 --patch --now
recorded '--result skipped --reason release_list_unavailable --from v1.2.3'
never 'curl '

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

# A release the owner rolled back from stays out, without a pull or a download; only a newer patch comes in.
make_install declined
printf '2026-11-01T00:00:00Z\tv1.2.3\t%s\tinstall\tv1.2.3\t-\n2026-11-02T00:00:00Z\tv1.2.5\t%s\tupdate\tv1.2.0\t-\n2026-11-03T00:00:00Z\tv1.2.3\t%s\trollback\tv1.2.0\t-\n' \
  "$PREVIOUS_ID" "$digest" "$PREVIOUS_ID" > "$case_dir/version-history.tsv"
expect_status 0 --patch --now
recorded "--result skipped --reason rolled_back_version --from v1.2.3 --to v1.2.5"
pinned ghcr.io/example/app:v1.2.3
never ' pull app'; never 'release-manifest.txt'
cp "$FIXTURES/releases.json" "$temporary/releases.json"
printf '[{"tag_name": "v1.2.6"}, {"tag_name": "v1.2.5"}, {"tag_name": "v1.2.3"}]\n' > "$FIXTURES/releases.json"
write_manifest v1.2.6
expect_status 0 TARGET_LABEL=v1.2.6 --patch --now
recorded "--result updated --from v1.2.3 --to v1.2.6"
cp "$temporary/releases.json" "$FIXTURES/releases.json"

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

# The image-to-image check is not a substitute for the digest promised by the signed manifest.
make_install signed-migrations
sed -i "s/^migrations=.*/migrations=sha256:$(printf 'e%.0s' $(seq 64))/" "$FIXTURES/manifest"
openssl pkeyutl -sign -inkey "$FIXTURES/key.pem" -rawin -in "$FIXTURES/manifest" -out "$FIXTURES/manifest.sig"
expect_status 1 --patch --now
recorded "--result skipped --reason manifest_invalid --from v1.2.3 --to v1.2.5"
never ' stop app'

# A snapshot that can't be taken skips the update and restarts the running version.
make_install snapshot
expect_status 1 FAIL_AT=snapshot --patch --now
recorded "--result skipped --reason snapshot_failed --from v1.2.3 --to v1.2.5"
pinned ghcr.io/example/app:v1.2.3
grep 'up -d ' "$CALLS" | tail -n 1 | grep -q "IMAGE=$PREVIOUS_ID"
never "up -d .* IMAGE=$target"
[ ! -e "$case_dir/.auto-update.inflight" ]

# A damaged marker cannot report an updated result without a valid source version.
make_install interrupted-damaged
printf '%s\n' '- v1.2.5' > "$case_dir/.auto-update.inflight"
expect_status 1 CURRENT_LABEL=v1.2.5 --patch
[ ! -s "$RECORDS" ]
never 'auto-update record'
# Stopped during the snapshot: the new version never ran, so it reads as skipped, not rolled back.
make_install snapshot-signal
expect_status 130 FAIL_AT=snapshot_signal --patch --now
recorded "--result skipped --reason snapshot_failed --from v1.2.3 --to v1.2.5"
pinned ghcr.io/example/app:v1.2.3
grep 'up -d ' "$CALLS" | tail -n 1 | grep -q "IMAGE=$PREVIOUS_ID"
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
  recorded "--result rolled_back --reason $reason --from v1.2.3 --to v1.2.5 --failures 1"
  grep -q "^Automatic patch update: rolled_back, $reason (running v1.2.3, newest v1.2.5).$" "$temporary/output"
  pinned ghcr.io/example/app:v1.2.3
  grep 'up -d ' "$CALLS" | tail -n 1 | grep -q "IMAGE=$PREVIOUS_ID"
  [ ! -e "$case_dir/.auto-update.inflight" ]
  no_secret
done
# The update and its rollback both fail: the site is down, so the result waits. A retry with the app still down
# reports nothing new; once the pinned image runs, the failure and then the recovery are recorded, in order.
make_install rollback
expect_status 1 FAIL_AT=rollback --patch --now
grep -q '^Automatic patch update: failed, rollback_failed (from v1.2.3 to v1.2.5).$' "$temporary/output"
[ ! -s "$RECORDS" ]
pinned ghcr.io/example/app:v1.2.3
# The previous image may not be running: the marker stays, and every later run starts the pinned image until it runs.
grep -Eq '^v1\.2\.3 v1\.2\.5 [0-9T:Z-]+ rollback_failed$' "$case_dir/.auto-update.inflight"
: > "$CALLS"
expect_status 1 FAIL_AT=pinned FAKE_HOUR=14 --patch
grep -q 'still does not start' "$temporary/output"
grep -q ' up -d --no-deps --wait --wait-timeout 90 app IMAGE=configured' "$CALLS"
never 'auto-update check'
[ ! -s "$RECORDS" ]
[ "$(wc -l < "$case_dir/auto-update.result")" -eq 1 ]
[ -e "$case_dir/.auto-update.inflight" ]
expect_status 1 FAKE_HOUR=14 --patch
[ "$(wc -l < "$RECORDS")" -eq 2 ]
head -n 1 "$RECORDS" | grep -Eq '^--at [0-9T:Z-]+ --result failed --reason rollback_failed --from v1\.2\.3 --to v1\.2\.5 --failures 1$'
recorded '--result rolled_back --reason rollback_failed --from v1.2.3 --to v1.2.5 --failures 1 --down-at [0-9T:Z-]+'
grep -q '^Automatic patch update: rolled_back, rollback_failed (running v1.2.3, newest v1.2.5).$' "$temporary/output"
[ ! -e "$case_dir/.auto-update.inflight" ] && [ ! -e "$case_dir/auto-update.result" ]
# The site went down when the update stopped the app, before the recovery's own report.
[ "$(wc -l < "$NOTIFIED")" -eq 1 ]
grep -q -- '--result rolled_back --reason rollback_failed' "$NOTIFIED"
down_at=$(tail -n 1 "$RECORDS" | sed 's/.* --down-at //')
[ "$(/bin/date -u -d "$down_at" +%s)" -le "$(/bin/date -u -d "$(tail -n 1 "$RECORDS" | cut -d' ' -f2)" +%s)" ]
grep -qx 'failures.v1.2.5=1' "$case_dir/auto-update.state"

# A patch that failed is tried once more the next night. After a second failure it waits for a newer patch, or for the
# owner's run with --now; a success clears the count. Each pulled image is listed once, however often it is tried.
make_install retries
expect_status 1 FAIL_AT=health --patch --now
recorded '--result rolled_back --reason health_check_failed --from v1.2.3 --to v1.2.5 --failures 1'
expect_status 1 FAIL_AT=health FAKE_DAY=2026-11-04 --patch
recorded '--result rolled_back --reason health_check_failed --from v1.2.3 --to v1.2.5 --failures 2'
: > "$CALLS"
expect_status 0 FAKE_DAY=2026-11-05 --patch
recorded '--result skipped --reason repeated_failure --from v1.2.3 --to v1.2.5 --failures 2'
never ' pull app'; never ' stop app'
[ "$(wc -l < "$case_dir/auto-update-images.tsv")" -eq 1 ]
expect_status 0 --patch --now
recorded '--result updated --from v1.2.3 --to v1.2.5'
if grep -q '^failures\.' "$case_dir/auto-update.state"; then echo 'Kept a failure count after a successful update.' >&2; exit 1; fi
# A newer patch than the held one is tried at once.
make_install held-newer
printf 'failures.v1.2.5=2\n' > "$case_dir/auto-update.state"
printf '[{"tag_name": "v1.2.6"}, {"tag_name": "v1.2.5"}]\n' > "$FIXTURES/releases.json"
write_manifest v1.2.6
expect_status 0 TARGET_LABEL=v1.2.6 FAKE_HOUR=02 --patch
recorded '--result updated --from v1.2.3 --to v1.2.6'
printf '[{"tag_name": "v2.0.0"}, {"tag_name":"v1.3.0"},\n {"tag_name": "v1.2.5"}, {"tag_name": "v1.2.4"}, {"tag_name": "v1.2.3"}]\n' > "$FIXTURES/releases.json"

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
make_install development-metadata
expect_status 1 CURRENT_LABEL=1.2.0+14.gabc1234 --patch --now
recorded "--result skipped --reason version_unknown"
never 'curl '
make_install development-zero
expect_status 1 CURRENT_LABEL=0.0.0 --patch --now
recorded "--result skipped --reason version_unknown --from v0.0.0"
never 'curl '
make_install releases
expect_status 1 FAIL_AT=releases --patch --now
recorded "--result skipped --reason release_list_unavailable --from v1.2.3"
make_install manifest
expect_status 1 FAIL_AT=manifest --patch --now
recorded "--result skipped --reason manifest_unavailable --from v1.2.3 --to v1.2.5"
make_install app-down
expect_status 1 FAIL_AT=app_down --patch --now
never 'auto-update check'
grep -Eq '^[0-9T:Z-]+ skipped check_failed - - - -$' "$case_dir/auto-update.result"

# A result the app can't take yet (restoring, or down) waits and is recorded first on the next run.
make_install notice-retry
printf '2026-11-03T08:00:00Z rolled_back health_check_failed v1.2.3 v1.2.4 1 -\n' > "$case_dir/auto-update.result"
expect_status 0 FAIL_AT=notice --patch --now
[ ! -e "$case_dir/auto-update.result" ]
[ "$(wc -l < "$RECORDS")" -eq 2 ]
recorded '--result updated --from v1.2.3 --to v1.2.5'
[ "$(wc -l < "$case_dir/auto-update.notices")" -eq 1 ]
grep -q 'An owner notice could not be sent yet' "$temporary/output"
expect_status 0 FAKE_HOUR=14 --patch
[ ! -e "$case_dir/auto-update.notices" ]
[ "$(wc -l < "$NOTIFIED")" -eq 1 ]
# One refused notice cannot hold back the next notice.
make_install notice-fairness
printf '2026-11-03T08:00:00Z rolled_back health_check_failed v1.2.3 v1.2.4 1 -\n2026-11-03T09:00:00Z rolled_back health_check_failed v1.2.3 v1.2.5 1 -\n' > "$case_dir/auto-update.result"
expect_status 0 FAIL_AT=notice_one FAKE_HOUR=14 --patch
[ "$(wc -l < "$NOTIFIED")" -eq 1 ]
grep -q -- '--to v1.2.5' "$NOTIFIED"
[ "$(wc -l < "$case_dir/auto-update.notices")" -eq 1 ]
grep -q 'v1.2.4' "$case_dir/auto-update.notices"
expect_status 0 FAKE_HOUR=14 --patch
[ "$(wc -l < "$NOTIFIED")" -eq 2 ]
[ ! -e "$case_dir/auto-update.notices" ]
# A notice queue write failure keeps the result pending for a safe replay.
make_install notice-storage-error
mkdir "$case_dir/auto-update.notices"
printf '2026-11-03T08:00:00Z rolled_back health_check_failed v1.2.3 v1.2.4 1 -\n' > "$case_dir/auto-update.result"
expect_status 0 FAKE_HOUR=14 --patch
[ "$(wc -l < "$case_dir/auto-update.result")" -eq 1 ]
rmdir "$case_dir/auto-update.notices"
expect_status 0 FAKE_HOUR=14 --patch
[ ! -e "$case_dir/auto-update.result" ]
[ "$(wc -l < "$NOTIFIED")" -eq 1 ]

# Manual-only installs enforce the same three-image retention policy and discard stale inventory references.
make_install manual-pruning
stale_id="sha256:$(printf 'f%.0s' $(seq 64))"
printf 'ghcr.io/example/app:v1.2.99@%s\t%s\tv1.2.99\n' "$digest" "$stale_id" > "$case_dir/auto-update-images.tsv"
for patch_number in 4 5 6 7 8; do
  write_manifest "v1.2.$patch_number"
  expect_status 0 DISTINCT_IDS=1 CURRENT_LABEL="v1.2.$((patch_number - 1))" "ghcr.io/example/app:v1.2.$patch_number@$digest"
done
[ "$(cut -f3 "$case_dir/auto-update-images.tsv" | tr '\n' ' ')" = 'v1.2.6 v1.2.7 v1.2.8 ' ]
never 'image prune'
grep -q -- 'trimmed' "$case_dir/version-history.tsv"
# An image still on the rollback stack keeps its saved pin after something outside the updater removed it.
gone_ref=$(awk -F '\t' '$3 == "v1.2.7" { print $1 }' "$case_dir/auto-update-images.tsv")
[ -n "$gone_ref" ]
write_manifest v1.2.9
expect_status 0 DISTINCT_IDS=1 CURRENT_LABEL=v1.2.8 "GONE_REF=$gone_ref" "ghcr.io/example/app:v1.2.9@$digest"
[ "$(cut -f3 "$case_dir/auto-update-images.tsv" | tr '\n' ' ')" = 'v1.2.7 v1.2.8 v1.2.9 ' ]
write_manifest v1.2.5
# One refusal does not stop later notices, and unsent outage failures are superseded by their recovery.
make_install notice-recovery
printf '2026-11-03T09:05:00Z failed rollback_failed v1.2.3 v1.2.5 1 -\n2026-11-03T10:05:00Z rolled_back rollback_failed v1.2.3 v1.2.5 1 2026-11-03T09:02:00Z\n' > "$case_dir/auto-update.result"
expect_status 0 FAKE_HOUR=14 --patch
[ "$(wc -l < "$RECORDS")" -eq 2 ]
[ "$(wc -l < "$NOTIFIED")" -eq 1 ]
grep -q -- '--result rolled_back --reason rollback_failed' "$NOTIFIED"
[ ! -e "$case_dir/auto-update.result" ] && [ ! -e "$case_dir/auto-update.notices" ]

make_install restore
checks true
expect_status 0 FAIL_AT=record --patch --now
[ ! -s "$RECORDS" ]
grep -Eq '^[0-9T:Z-]+ skipped restore_in_progress - - - -$' "$case_dir/auto-update.result"
never ' pull app'
checks
expect_status 0 --patch --now
head -n 1 "$RECORDS" | grep -Eq '^--at [0-9T:Z-]+ --result skipped --reason restore_in_progress$'
recorded "--result updated --from v1.2.3 --to v1.2.5"
[ ! -e "$case_dir/auto-update.result" ]

# A run killed between stopping the app and pinning an image: the next run starts the pinned image first.
make_install interrupted
printf 'v1.2.3 v1.2.5 2026-11-03T09:02:00Z -\n' > "$case_dir/.auto-update.inflight"
expect_status 1 --patch
recorded "--result rolled_back --reason interrupted --from v1.2.3 --to v1.2.5 --failures 1"
grep -q ' up -d --no-deps --wait --wait-timeout 90 app IMAGE=configured' "$CALLS"
never 'auto-update check'
[ ! -e "$case_dir/.auto-update.inflight" ]
# A rollback request settles the killed patch first, leaving the healthy pin and history alone.
make_install interrupted-rollback
printf 'v1.2.3 v1.2.5 2026-11-03T09:02:00Z -\n' > "$case_dir/.auto-update.inflight"
expect_status 1 --rollback
recorded '--result rolled_back --reason interrupted --from v1.2.3 --to v1.2.5 --failures 1'
pinned ghcr.io/example/app:v1.2.3
[ ! -e "$case_dir/.auto-update.inflight" ]
never 'snapshot pre-upgrade'
# A marker from before it held more than the versions reads the same way.
make_install interrupted-older
printf 'v1.2.3 v1.2.5\n' > "$case_dir/.auto-update.inflight"
expect_status 1 --patch
recorded "--result rolled_back --reason interrupted --from v1.2.3 --to v1.2.5 --failures 1"
# Killed outright, and the pinned image doesn't start either: that is reported once as a failed rollback, and the
# recovery names when the app stopped.
make_install interrupted-down
printf 'v1.2.3 v1.2.5 2026-11-03T09:02:00Z -\n' > "$case_dir/.auto-update.inflight"
expect_status 1 FAIL_AT=pinned --patch
[ ! -s "$RECORDS" ] && [ "$(wc -l < "$case_dir/auto-update.result")" -eq 1 ]
expect_status 1 FAIL_AT=pinned --patch
[ ! -s "$RECORDS" ] && [ "$(wc -l < "$case_dir/auto-update.result")" -eq 1 ]
expect_status 1 --patch
head -n 1 "$RECORDS" | grep -Eq '^--at [0-9T:Z-]+ --result failed --reason rollback_failed --from v1\.2\.3 --to v1\.2\.5 --failures 1$'
recorded "--result rolled_back --reason rollback_failed --from v1.2.3 --to v1.2.5 --failures 1 --down-at 2026-11-03T09:02:00Z"
[ "$(wc -l < "$RECORDS")" -eq 2 ]

# Results wait in order, and one the app refuses as invalid is dropped instead of holding back the rest.
make_install pending-order
printf '2026-11-02T09:00:00Z skipped refused v1.2.3 - - -\n2026-11-02T10:00:00Z skipped pull_failed v1.2.3 v1.2.5 - -\n' > "$case_dir/auto-update.result"
expect_status 0 --patch --now
grep -q 'refused the recorded result "skipped refused"' "$temporary/output"
[ "$(wc -l < "$RECORDS")" -eq 2 ]
head -n 1 "$RECORDS" | grep -qx -- '--at 2026-11-02T10:00:00Z --result skipped --reason pull_failed --from v1.2.3 --to v1.2.5'
recorded "--result updated --from v1.2.3 --to v1.2.5"
[ ! -e "$case_dir/auto-update.result" ]

# The timer fires hourly: each run asks the app for the gym's timezone, and only the first run inside 02:00-05:00 of
# the gym's night acts.
make_install window
expect_status 0 FAKE_HOUR=14 --patch
called 'auto-update check'
[ ! -s "$RECORDS" ]; never 'curl '
grep -qx timezone=America/Denver "$case_dir/auto-update.state"
: > "$CALLS"
expect_status 0 FAKE_HOUR=15 --patch
called 'auto-update check'
[ ! -s "$RECORDS" ]; never 'curl '
expect_status 0 FAKE_HOUR=02 --patch
recorded "--result updated --from v1.2.3 --to v1.2.5"
grep -q '^Automatic patch update: updated from v1.2.3 to v1.2.5.$' "$temporary/output"
: > "$CALLS"
expect_status 0 FAKE_HOUR=03 --patch
never 'curl '; [ "$(wc -l < "$RECORDS")" -eq 1 ]
expect_status 0 FAKE_HOUR=02 FAKE_DAY=2026-11-04 --patch
recorded "--result up_to_date --from v1.2.5"
grep -q '^Automatic patch update: up to date (v1.2.5; no newer patch).$' "$temporary/output"

# A changed timezone counts from the new zone's next night, even when the old zone's night is already done.
make_install timezone-change
printf 'timezone=America/Denver\nnight=2026-11-03\nnight_zone=America/Denver\nnight_at=1\n' > "$case_dir/auto-update.state"
sed -i 's|^timezone=.*|timezone=Asia/Riyadh|' "$FIXTURES/check"
expect_status 0 FAKE_HOUR=02 --patch
recorded "--result updated --from v1.2.3 --to v1.2.5"
grep -qx timezone=Asia/Riyadh "$case_dir/auto-update.state"
grep -qx night_zone=Asia/Riyadh "$case_dir/auto-update.state"
# Still once a night: a change of zone just after a night's run waits for the next night.
make_install timezone-same-night
printf 'timezone=America/Denver\nnight=2026-11-03\nnight_zone=America/Denver\nnight_at=%s\n' "$(/bin/date -u +%s)" > "$case_dir/auto-update.state"
sed -i 's|^timezone=.*|timezone=Asia/Riyadh|' "$FIXTURES/check"
expect_status 0 FAKE_HOUR=02 --patch
[ ! -s "$RECORDS" ]; never 'curl '
grep -qx timezone=Asia/Riyadh "$case_dir/auto-update.state"
# The app can't answer: the zone it last gave decides, and outside that zone's night nothing is reported.
make_install timezone-fallback
printf 'timezone=America/Denver\n' > "$case_dir/auto-update.state"
expect_status 0 FAIL_AT=app_down FAKE_HOUR=14 --patch
[ ! -s "$RECORDS" ] && [ ! -e "$case_dir/auto-update.result" ]
never 'auto-update check'
expect_status 1 FAIL_AT=app_down FAKE_HOUR=02 --patch
grep -Eq '^[0-9T:Z-]+ skipped check_failed - - - -$' "$case_dir/auto-update.result"

# Another update holds the lock: this run does nothing.
make_install locked
if ! flock "$case_dir/.update.lock" sh "$case_dir/update.sh" --patch --now > "$temporary/output" 2>&1; then exit 1; fi
[ ! -s "$CALLS" ]
for arguments in '--patch extra' '--now' '--patch --later'; do
  # shellcheck disable=SC2086
  if sh "$case_dir/update.sh" $arguments > /dev/null 2>&1; then echo "Accepted: $arguments" >&2; exit 1; fi
done
# Host updates use a real archive and signatures, with distinguishable old and new scripts and units.
host_release() {
  mkdir -p "$case_dir/systemd" "$case_dir/postgres"
  cp "$source_dir/rotate-key.sh" "$source_dir/restore.sh" "$case_dir/"
  cp "$source_dir/Caddyfile" "$case_dir/"
  cp "$source_dir/postgres/01-roles.sh" "$case_dir/postgres/"
  cp "$source_dir/systemd/"* "$case_dir/systemd/"
  for unit in plaingym-update.service plaingym-update.timer; do printf 'old unit %s\n' "$unit" > "$SYSTEMD_UNIT_DIR/$unit"; done
  mkdir -p "$FIXTURES/host/deploy"
  cp -R "$case_dir/systemd" "$case_dir/postgres" "$FIXTURES/host/deploy/"
  for file in update.sh lib.sh rotate-key.sh restore.sh compose.yaml Caddyfile release-signing.pem; do cp "$case_dir/$file" "$FIXTURES/host/deploy/"; done
  awk '{ print; if ($0 == "set -eu") print "echo new-updater >> \"$FIXTURES/generations\"" }' "$case_dir/update.sh" > "$FIXTURES/host/deploy/update.sh"
  printf '\n# New library generation\n' >> "$FIXTURES/host/deploy/lib.sh"
  printf '\n# New unit generation\n' >> "$FIXTURES/host/deploy/systemd/plaingym-update.service"
  write_manifest v1.2.5
  sed -i 's#manifest/1#manifest/2#' "$FIXTURES/manifest"
  printf 'rollback_floor=v1.2.0\n' >> "$FIXTURES/manifest"
  host_sign
}
host_sign() {
  tar -czf "$FIXTURES/host.tar.gz" -C "$FIXTURES/host" deploy
  # Replace only the host extension when signing again.
  sed '/^host[._]/d; /^deploy_archive/d' "$FIXTURES/manifest" > "$FIXTURES/manifest.next"
  mv "$FIXTURES/manifest.next" "$FIXTURES/manifest"
  printf 'host_format=1\ndeploy_archive=plaingym-deploy-v1.2.5.tar.gz\ndeploy_archive_sha256=sha256:%s\n' \
    "$(sha256sum "$FIXTURES/host.tar.gz" | cut -d' ' -f1)" >> "$FIXTURES/manifest"
  for file in update.sh lib.sh rotate-key.sh restore.sh release-signing.pem systemd/plaingym-update.service systemd/plaingym-update.timer; do
    printf 'host.%s=sha256:%s\n' "$(printf '%s' "$file" | tr '[:upper:]' '[:lower:]')" \
      "$(sha256sum "$FIXTURES/host/deploy/$file" | cut -d' ' -f1)" >> "$FIXTURES/manifest"
  done
  openssl pkeyutl -sign -inkey "$FIXTURES/key.pem" -rawin -in "$FIXTURES/manifest" -out "$FIXTURES/manifest.sig"
}
old_hosts() {
  cmp -s "$source_dir/update.sh" "$case_dir/update.sh"
  cmp -s "$source_dir/lib.sh" "$case_dir/lib.sh"
  grep -qx 'old unit plaingym-update.service' "$SYSTEMD_UNIT_DIR/plaingym-update.service"
  pinned "${1:-ghcr.io/example/app:v1.2.3}"
  [ ! -d "$case_dir/.host-update" ]
}
make_install host-success
host_release
expect_status 0 --patch --now
pinned "$target"
for file in update.sh lib.sh systemd/plaingym-update.service; do cmp -s "$case_dir/$file" "$FIXTURES/host/deploy/$file"; done
grep -q 'New unit generation' "$SYSTEMD_UNIT_DIR/plaingym-update.service"
grep -qx "ExecStart=/bin/sh $case_dir/update.sh --patch" "$SYSTEMD_UNIT_DIR/plaingym-update.service"
called 'systemctl daemon-reload'
[ "$(line_of 'openssl pkeyutl -verify')" -lt "$(line_of 'curl .*plaingym-deploy-')" ]
[ ! -e "$FIXTURES/generations" ] # The running shell finishes the inode it opened before replacement.
expect_status 0 CURRENT_LABEL=v1.2.5 --patch --now
grep -qx new-updater "$FIXTURES/generations" # The next invocation uses the new updater.
# Rollback restores the scripts and rendered units kept with the previous image.
# An explicitly replaced trust key must survive that rollback, even though the snapshot held the old one.
openssl pkey -in "$FIXTURES/other.pem" -pubout -out "$case_dir/release-signing.pem"
cp "$case_dir/release-signing.pem" "$temporary/rotated-public.pem"
expect_status 0 CURRENT_LABEL=v1.2.5 --rollback
old_hosts "$PREVIOUS_ID"
cmp -s "$temporary/rotated-public.pem" "$case_dir/release-signing.pem"

make_install host-manual
host_release
expect_status 0 "$target"
pinned "$target"
cmp -s "$case_dir/update.sh" "$FIXTURES/host/deploy/update.sh"
expect_status 0 --rollback
old_hosts "$PREVIOUS_ID"

for failure in host_midway host_reload; do
  make_install "$failure"
  host_release
  expect_status 1 "FAIL_AT=$failure" --patch --now
  old_hosts
done
# A process killed between renames leaves a durable journal; the next invocation restores before acting.
make_install host-killed
host_release
expect_status 137 FAIL_AT=host_killed --patch --now
[ -d "$case_dir/.host-update" ]
checks false false
expect_status 1 --patch --now # Reports recovery of the interrupted automatic attempt.
old_hosts

make_install host-cleanup-killed
host_release
expect_status 137 FAIL_AT=host_cleanup_killed --patch --now
pinned "$target"
[ ! -d "$case_dir/.host-update" ]
expect_status 0 CURRENT_LABEL=v1.2.5 --patch --now
pinned "$target"
cmp -s "$case_dir/update.sh" "$FIXTURES/host/deploy/update.sh"

make_install host-pin-signal
host_release
expect_status 130 FAIL_AT=host_pin_signal --patch --now
pinned "$target"
cmp -s "$case_dir/update.sh" "$FIXTURES/host/deploy/update.sh"
recorded "--result updated --from v1.2.3 --to v1.2.5"
never "up -d .* IMAGE=$PREVIOUS_ID"

for corruption in archive file signature key; do
  make_install "host-$corruption"
  host_release
  case "$corruption" in
    archive) printf 'tampered' >> "$FIXTURES/host.tar.gz" ;;
    file)
      printf '# tampered\n' >> "$FIXTURES/host/deploy/lib.sh"
      tar -czf "$FIXTURES/host.tar.gz" -C "$FIXTURES/host" deploy
      # Even a correctly signed archive digest cannot override the signed digest of an individual file.
      sed -i "s/^deploy_archive_sha256=.*/deploy_archive_sha256=sha256:$(sha256sum "$FIXTURES/host.tar.gz" | cut -d' ' -f1)/" "$FIXTURES/manifest"
      openssl pkeyutl -sign -inkey "$FIXTURES/key.pem" -rawin -in "$FIXTURES/manifest" -out "$FIXTURES/manifest.sig" ;;
    signature) printf 'released=changed\n' >> "$FIXTURES/manifest" ;;
    key) openssl pkey -in "$FIXTURES/other.pem" -pubout -out "$FIXTURES/host/deploy/release-signing.pem"; host_sign ;;
  esac
  expect_status 1 --patch --now
  old_hosts
  never ' stop app'
done
# An archive that can't be downloaded is a transient skip, not a refused release.
make_install host-download
host_release
expect_status 1 FAIL_AT=archive --patch --now
recorded "--result skipped --reason manifest_unavailable --from v1.2.3 --to v1.2.5"
old_hosts
never ' stop app'
make_install host-download-manual
host_release
expect_status 1 FAIL_AT=archive "$target"
grep -q 'Could not download the deployment files of v1.2.5' "$temporary/output"
old_hosts
never ' stop app'

echo 'PASS: patch selection, signature, digest and migration checks, setting off, skipped snapshot, rollback, window, pending results; signed host generations, tampering, partial failure, interruption and rollback.'
