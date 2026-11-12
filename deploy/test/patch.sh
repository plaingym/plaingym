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
  *' exec -T app gym-app auto-update record '*)
    [ "${FAIL_AT:-}" != record ] || exit 1
    case "$*" in *' --reason refused'*) exit 2 ;; esac
    printf '%s\n' "$*" | sed 's/.* auto-update record //' >> "$RECORDS" ;;
  "image inspect "*" --format {{.Id}}") [ "${FAIL_AT:-}" != previous ] || exit 1
    case "$3" in
      sha256:*) echo "$3" ;;
      *:v1.2.1@*) echo "sha256:$(printf 'b%.0s' $(seq 64))" ;;
      *:v1.2.2@*) echo "sha256:$(printf 'e%.0s' $(seq 64))" ;;
      *@sha256:*) if [ -n "${DISTINCT_IDS:-}" ]; then id_in "$3"; else echo "$DIGEST"; fi ;;
      *) echo "$PREVIOUS_ID" ;;
    esac ;;
  'image inspect '*'org.opencontainers.image.version'*)
    case "$3" in
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
  rm -f "$FIXTURES/down" "$FIXTURES/removed"
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
echo 'PASS: patch selection, signature, digest and migration checks, setting off, skipped snapshot, rollback, window, pending results.'
