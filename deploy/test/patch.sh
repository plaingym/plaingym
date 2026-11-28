#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Exercises `update.sh --patch` with Docker, curl and date fixtures and real Ed25519 signatures: patch selection,
# signature and digest checks, the owner's setting, a skipped snapshot, rollback, the nightly window, and results
# kept until the app can record them. Needs root, OpenSSL 3, flock and tzdata (a disposable Ubuntu 24.04 is fine).
set -eu
umask 077
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# Recovery must work before lib.sh is safe to source; keep both self-contained copies and inventories aligned.
# shellcheck disable=SC2016
python3 -c '
import fnmatch, pathlib, re, sys
root = pathlib.Path(sys.argv[1])
scripts = [(root / name).read_text() for name in ("update.sh", "rotate-key.sh")]
blocks = [re.search(r"(?ms)^bootstrap_recover\(\) \{.*?(?=^# shellcheck source=deploy/lib.sh)", text).group() for text in scripts]
assert blocks[0].replace("$ROOT/update.sh", "$ROOT/SCRIPT") == blocks[1].replace("$ROOT/rotate-key.sh", "$ROOT/SCRIPT"), "Bootstrap recovery copies differ"
lib = (root / "lib.sh").read_text()
files = re.search(r"(?m)^host_files=\x27([^\x27]+)\x27", lib).group(1).split()
units = re.search(r"(?m)^host_units=\x27([^\x27]+)\x27", lib).group(1).split()
block = blocks[0]
assert re.search(r"for bootstrap_file in (.*?); do", block).group(1).split() == [f for f in files if f != "release-signing.pem"], "Bootstrap host files differ"
assert re.search(r"for bootstrap_unit in (.*?); do", block).group(1).split() == units, "Bootstrap units differ"
def modes(text):
    return re.findall(r"([^\s;)]+)\) (?:echo |bootstrap_mode=)(0[0-7]{3})", text)
def mode(entries, name):
    return next(value for patterns, value in entries if any(fnmatch.fnmatchcase(name, p) for p in patterns.split("|")))
canonical = modes(re.search(r"(?m)^host_mode\(\).*", lib).group())
bootstrap = modes(re.search(r"case \"\$bootstrap_file\".*?esac", block).group())
for name in files:
    if name != "release-signing.pem":
        assert mode(canonical, name) == mode(bootstrap, name), "Bootstrap mode differs: " + name
unit_mode = re.search(r"install -m (0[0-7]{3}) .*?/before/units/", block).group(1)
assert all(mode(canonical, "systemd/" + name) == unit_mode for name in units), "Bootstrap unit modes differ"

# The host snapshot bypasses the entrypoint and must repeat every single-gym pre-migration safety step.
entrypoint = (root / "container/entrypoint.sh").read_text()
single = re.search(r"(?ms)^if \[ \"\$\{TENANCY:-single\}\" = multi \]; then\n.*?^fi\n(.*?)(?=^/app/deploy/database.sh migrate$)", entrypoint).group(1)
snapshot = re.search(r"(?ms)^maintenance_snapshot\(\) \{.*?app -ec \x27\n(.*?)(?=^    shift$)", scripts[0]).group(1)
def steps(text):
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]
assert steps(single) == steps(snapshot), "Snapshot pre-migration steps differ from the single-gym entrypoint"
' "$source_dir"
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
export UPDATE_SETTLE_SECONDS=0 UPDATE_INFRA_SETTLE_SECONDS=0
digest=sha256:$(printf 'd%.0s' $(seq 64))
# PostgreSQL and Caddy images: P0 and C0 are the install's compose.yaml pins, P1, P2 and C1 newer releases' images.
infra_digest() { printf 'sha256:%s' "$(printf '%064d' 0 | tr 0 "$1")"; }
P0="postgres:18@$(infra_digest 3)" P1="postgres:18.2@$(infra_digest 4)" P2="postgres:18.3@$(infra_digest 5)"
C0="caddy:2.11.7-alpine@$(infra_digest 6)" C1="caddy:2.11.8-alpine@$(infra_digest 7)"
export DIGEST="$digest"
PREVIOUS_ID="sha256:$(printf 'a%.0s' $(seq 64))"
export PREVIOUS_ID

# Docker: logs each call with the images it targets, and fails where FAIL_AT says. A start that fails leaves the app
# down (the file `down`) until a start succeeds. DISTINCT_IDS gives each release's image its own ID and label. A
# PostgreSQL or Caddy image's ID is its digest; PG_CHECK is what the database check on a new PostgreSQL answers.
cat > "$temporary/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s IMAGE=%s POSTGRES_IMAGE=%s CADDY_IMAGE=%s\n' "$*" "${APP_IMAGE:-configured}" "${POSTGRES_IMAGE:-unset}" "${CADDY_IMAGE:-unset}" >> "$CALLS"
version_in() { tag=${1#*:v}; printf 'v%s\n' "${tag%%@*}"; }
id_in() { tag=${1##*.}; printf 'sha256:%064d\n' "${tag%%@*}"; }
case "$*" in
  *' ps --status running --services') [ "${FAIL_AT:-}" = app_down ] || [ -e "$FIXTURES/down" ] || echo app ;;
  *' ps -q app') echo container-1 ;;
  'inspect container-1 '*) if [ "${FAIL_AT:-}" = settle ]; then echo 'healthy 1'; else echo 'healthy 0'; fi ;;
  *' ps -q caddy') echo caddy-1 ;;
  'inspect caddy-1 '*) if [ "${FAIL_AT:-}" = caddy_settle ]; then echo 'running 1'; else echo 'running 0'; fi ;;
  'pull '*) [ "${FAIL_AT:-}" != infra_pull ] ;;
  *' --entrypoint postgres '*) if [ "${FAIL_AT:-}" = postgres_check ]; then echo 'postgres (PostgreSQL) 19.0'; else echo 'postgres (PostgreSQL) 18.2'; fi ;;
  *' --entrypoint caddy '*) echo 'v2.11.8 h1:fixture' ;;
  # The restore of both services after a failure, PostgreSQL alone on its new image, and Caddy alone.
  *' up -d '*' postgres caddy') [ "${FAIL_AT:-}" != infra_restore ] ;;
  *' up -d '*' postgres') case "${FAIL_AT:-}" in postgres_up|infra_restore) exit 1 ;; esac ;;
  *' up -d '*' caddy') [ "${FAIL_AT:-}" != caddy_up ] ;;
  *' exec -T postgres '*server_version_num*) echo "${PG_CHECK:-18|t}" ;;
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
      postgres:*|caddy:*) echo "sha256:${3##*@sha256:}" ;;
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
  'image ls --quiet --no-trunc')
    [ "${FAIL_AT:-}" != image_list ] || exit 1
    for image_id in "$PREVIOUS_ID" "$DIGEST" "${HISTORY_IMAGE:-}"; do
      [ -n "$image_id" ] || continue
      if [ ! -f "$FIXTURES/removed" ] || ! grep -qxF "$image_id" "$FIXTURES/removed"; then echo "$image_id"; fi
    done ;;
  'image rm '*) printf '%s\n' "$3" >> "$FIXTURES/removed" ;;
  'run --rm --network none '*)
    case "$*" in *@sha256:*' -c '*) [ "${FAIL_AT:-}" != migration ] || { echo "$(printf 'f%.0s' $(seq 64))  -"; exit 0; } ;; esac
    echo "$(printf 'c%.0s' $(seq 64))  -" ;;
  *' pull app') [ "${FAIL_AT:-}" != pull ] ;;
  *' snapshot pre-upgrade')
    # snapshot_signal: the unit is stopped during the snapshot (systemd signals update.sh and its commands).
    [ "${FAIL_AT:-}" != snapshot_signal ] || { kill -TERM "$PPID"; exit 143; }
    [ "${FAIL_AT:-}" != snapshot ] || { echo 'S3 refused the upload' >&2; exit 1; } ;;
  # The app's image as the loaded files give it: OWN_APP_IMAGE stands for an own Compose file naming one.
  *' config --images app') echo "${OWN_APP_IMAGE:-${APP_IMAGE:-}}" ;;
  *'up -d '*)
    # own_files: an own Compose file that broke, so any start that loads it fails.
    case "${FAIL_AT:-}:$*" in own_files:*compose.override.yaml*) : > "$FIXTURES/down"; exit 1 ;; esac
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
  # Later pages come from releases-N.json; FAIL_AT=releases_page_N fails page N.
  'https://api.github.com/repos/example/app/releases?per_page=100&page='*)
    page=${url##*=}
    [ "${FAIL_AT:-}" != "releases_page_$page" ] || exit 22
    cp "$FIXTURES/releases-$page.json" "$output" ;;
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
REAL_CP=$(command -v cp)
REAL_MKDIR=$(command -v mkdir)
REAL_TAR=$(command -v tar)
export REAL_OPENSSL REAL_MV REAL_CP REAL_MKDIR REAL_TAR
cat > "$temporary/bin/cp" <<'MOCK'
#!/bin/sh
case "$*" in *'.host-history/'*'.next') [ "${FAIL_AT:-}" != host_history_copy ] || exit 1 ;; esac
exec "$REAL_CP" "$@"
MOCK
cat > "$temporary/bin/mkdir" <<'MOCK'
#!/bin/sh
case "$*" in *'/.host-history') [ "${FAIL_AT:-}" != host_history_mkdir ] || exit 1 ;; esac
exec "$REAL_MKDIR" "$@"
MOCK
cat > "$temporary/bin/tar" <<'MOCK'
#!/bin/sh
printf 'tar %s\n' "$*" >> "$CALLS"
exec "$REAL_TAR" "$@"
MOCK
cat > "$temporary/bin/openssl" <<'MOCK'
#!/bin/sh
printf 'openssl %s\n' "$*" >> "$CALLS"
exec "$REAL_OPENSSL" "$@"
MOCK
cat > "$temporary/bin/systemctl" <<'MOCK'
#!/bin/sh
printf 'systemctl %s\n' "$*" >> "$CALLS"
[ "${FAIL_AT:-}" != host_reload_always ] || exit 1
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
        host_killed) touch "$FIXTURES/mv_failed"; kill -KILL "$PPID"; exit 1 ;;
      esac
    fi ;;
esac
exec "$REAL_MV" "$@"
MOCK
chmod 0700 "$temporary/bin/docker" "$temporary/bin/curl" "$temporary/bin/date" "$temporary/bin/openssl" "$temporary/bin/systemctl" "$temporary/bin/mv"
chmod 0700 "$temporary/bin/cp" "$temporary/bin/mkdir" "$temporary/bin/tar"

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
with_images() { # POSTGRES CADDY: the fixture's signed manifest also names these images
  printf 'postgres_image=%s\ncaddy_image=%s\n' "$1" "$2" >> "$FIXTURES/manifest"
  openssl pkeyutl -sign -inkey "$temporary/release/key.pem" -rawin -in "$FIXTURES/manifest" -out "$FIXTURES/manifest.sig"
}
# compose.yaml as it is laid out, with only the lines the updater reads.
printf 'name: plaingym\nservices:\n  postgres:\n    image: %s\n    restart: unless-stopped\n  app:\n    image: app\n  caddy:\n    image: %s\nvolumes:\n  pgdata:\n' \
  "$P0" "$C0" > "$FIXTURES/compose.yaml"
# checks [RESTORE] [ENABLED] [BACKUPS] [WINDOW_START]: what `gym-app auto-update check` answers. Without WINDOW_START
# it answers as an app older than the window setting, with no window_start line.
checks() {
  printf 'restore=%s\nsetup=true\nenabled=%s\nbackups=%s\ntimezone=America/Denver\n' "${1:-false}" "${2:-true}" "${3:-true}" > "$FIXTURES/check"
  [ -z "${4:-}" ] || printf 'window_start=%s\n' "$4" >> "$FIXTURES/check"
}
make_install() {
  printf 'Case: %s\n' "$1"
  case_dir="$temporary/$1"
  mkdir "$case_dir"
  cp "$source_dir/update.sh" "$source_dir/lib.sh" "$case_dir/"
  chmod 0644 "$case_dir/lib.sh"
  cp "$temporary/release/public.pem" "$case_dir/release-signing.pem"
  cp "$FIXTURES/compose.yaml" "$case_dir/compose.yaml"
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

# Manual release failures point directly at the signing-key reference, including the fork instructions.
make_install manual-missing-key
rm "$case_dir/release-signing.pem"
expect_status 1 "$target"
grep -qF 'docs/update-reference.md#the-release-signing-key' "$temporary/output"
never ' stop app'
make_install manual-manifest-unavailable
expect_status 1 FAIL_AT=manifest "$target"
grep -qF 'docs/update-reference.md#the-release-signing-key' "$temporary/output"
never ' stop app'

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
mkdir -p "$case_dir/.host-history/${old_id#sha256:}" "$case_dir/.host-history/${retained_id#sha256:}"
expect_status 0 --patch --now
# Neither image is local now; only the kept one's saved pin lets --rollback pull it, with its host generation.
[ ! -d "$case_dir/.host-history/${old_id#sha256:}" ]
[ -d "$case_dir/.host-history/${retained_id#sha256:}" ]
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

# The release list is read in pages of 100, until a page that isn't full, and at most 10 pages.
release_list_requests() { grep '^curl https://api.github.com/' "$CALLS" | sed 's/^curl //'; }
full_page() { # FILE MAJOR: 100 releases, none of them of the running minor
  seq 0 99 | awk -v major="$2" 'BEGIN { printf "[" } { printf "%s{\"tag_name\": \"v%s.%s.0\"}", (NR > 1 ? ", " : ""), major, $1 } END { print "]" }' > "$1"
}
cp "$FIXTURES/releases.json" "$temporary/releases.json"
make_install one-page
expect_status 0 --patch --now
recorded "--result updated --from v1.2.3 --to v1.2.5"
[ "$(release_list_requests)" = 'https://api.github.com/repos/example/app/releases?per_page=100' ]
make_install second-page
full_page "$FIXTURES/releases.json" 3
printf '[{"tag_name": "v1.2.5"}, {"tag_name": "v1.2.4"}]\n' > "$FIXTURES/releases-2.json"
expect_status 0 --patch --now
recorded "--result updated --from v1.2.3 --to v1.2.5"
[ "$(release_list_requests | tr '\n' ' ')" = 'https://api.github.com/repos/example/app/releases?per_page=100 https://api.github.com/repos/example/app/releases?per_page=100&page=2 ' ]
# A page that can't be read ends the run: never a choice from part of the list.
make_install second-page-unavailable
expect_status 1 FAIL_AT=releases_page_2 --patch --now
recorded "--result skipped --reason release_list_unavailable --from v1.2.3"
never ' pull app'
never ' stop app'
make_install ten-pages
for page in 2 3 4 5 6 7 8 9 10; do full_page "$FIXTURES/releases-$page.json" "$((page + 2))"; done
printf '[{"tag_name": "v1.2.5"}]\n' > "$FIXTURES/releases-11.json"
expect_status 0 --patch --now
recorded "--result up_to_date --from v1.2.3"
[ "$(release_list_requests | wc -l)" -eq 10 ]
never 'page=11'
cp "$temporary/releases.json" "$FIXTURES/releases.json"
rm -f "$FIXTURES"/releases-*.json
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
[ "$(grep -c 'auto-update notice ' "$CALLS")" -eq 1 ] # One send attempt per run, including reports.
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
[ "$(grep -c 'auto-update notice ' "$CALLS")" -eq 2 ]
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

# The owner's start hour moves the three-hour window; it never crosses midnight, so the night is the gym's date.
make_install window-start
checks false true true 21
expect_status 0 FAKE_HOUR=21 --patch
recorded "--result updated --from v1.2.3 --to v1.2.5"
grep -qx night=2026-11-03 "$case_dir/auto-update.state"
grep -qx window_start=21 "$case_dir/auto-update.state"
: > "$CALLS"
expect_status 0 FAKE_HOUR=22 --patch
never 'curl '; [ "$(wc -l < "$RECORDS")" -eq 1 ]
expect_status 0 FAKE_HOUR=02 FAKE_DAY=2026-11-04 --patch
never 'curl '; [ "$(wc -l < "$RECORDS")" -eq 1 ]
expect_status 0 FAKE_HOUR=00 FAKE_DAY=2026-11-04 --patch
never 'curl '; [ "$(wc -l < "$RECORDS")" -eq 1 ]
# Anything but an hour from 0 to 21 reads as 02:00.
make_install window-start-invalid
checks false true true 22
expect_status 0 FAKE_HOUR=22 --patch
[ ! -s "$RECORDS" ]; never 'curl '
grep -qx window_start=2 "$case_dir/auto-update.state"
expect_status 0 FAKE_HOUR=02 --patch
recorded "--result updated --from v1.2.3 --to v1.2.5"
# An app that names no start hour keeps 02:00-05:00.
make_install window-start-older-app
expect_status 0 FAKE_HOUR=21 --patch
[ ! -s "$RECORDS" ]; never 'curl '
expect_status 0 FAKE_HOUR=02 --patch
recorded "--result updated --from v1.2.3 --to v1.2.5"
# The app can't answer: the start hour it last gave decides, so 02:30 is outside a 21:00 window and reports nothing.
make_install window-start-fallback
printf 'timezone=America/Denver\nwindow_start=21\n' > "$case_dir/auto-update.state"
expect_status 0 FAIL_AT=app_down FAKE_HOUR=02 --patch
[ ! -s "$RECORDS" ] && [ ! -e "$case_dir/auto-update.result" ]
never 'auto-update check'
expect_status 1 FAIL_AT=app_down FAKE_HOUR=21 --patch
grep -Eq '^[0-9T:Z-]+ skipped check_failed - - - -$' "$case_dir/auto-update.result"
# Moving the start hour just after a night's run waits six hours, so a window moved from 21:00 to 00:00 doesn't
# update again three hours later on the next date.
# night_state NIGHT START SECONDS_AGO: the state after a run on NIGHT in UTC with START, SECONDS_AGO seconds ago.
night_state() {
  sed -i 's|^timezone=.*|timezone=UTC|' "$FIXTURES/check"
  printf 'timezone=UTC\nwindow_start=%s\nnight=%s\nnight_zone=UTC\nnight_start=%s\nnight_at=%s\n' \
    "$2" "$1" "$2" "$(($(/bin/date -u +%s) - $3))" > "$case_dir/auto-update.state"
}
make_install window-start-earlier
checks false true true 0
night_state 2026-11-03 21 10800
expect_status 0 FAKE_HOUR=00 FAKE_DAY=2026-11-04 --patch
called 'auto-update check'
[ ! -s "$RECORDS" ]; never 'curl '
grep -qx night=2026-11-03 "$case_dir/auto-update.state"
# The night after, the new start hour updates and is stored with the night.
make_install window-start-earlier-next-night
checks false true true 0
night_state 2026-11-03 21 97200
expect_status 0 FAKE_HOUR=00 FAKE_DAY=2026-11-05 --patch
recorded "--result updated --from v1.2.3 --to v1.2.5"
grep -qx night=2026-11-05 "$case_dir/auto-update.state"
grep -qx night_start=0 "$case_dir/auto-update.state"
# Moving the start hour later the same date still counts tonight's date as done.
make_install window-start-later
checks false true true 21
night_state 2026-11-04 0 75600
expect_status 0 FAKE_HOUR=21 FAKE_DAY=2026-11-04 --patch
[ ! -s "$RECORDS" ]; never 'curl '
grep -qx night_start=0 "$case_dir/auto-update.state"
# A state from before the start hour was stored means 02:00: with the window unchanged, tonight's date decides.
make_install window-start-unstored
checks false true true 2
printf 'timezone=America/Denver\nnight=2026-11-03\nnight_zone=America/Denver\nnight_at=%s\n' "$(/bin/date -u +%s)" > "$case_dir/auto-update.state"
expect_status 0 FAKE_HOUR=02 --patch
[ ! -s "$RECORDS" ]; never 'curl '
printf 'timezone=America/Denver\nnight=2026-11-02\nnight_zone=America/Denver\nnight_at=%s\n' "$(/bin/date -u +%s)" > "$case_dir/auto-update.state"
expect_status 0 FAKE_HOUR=02 --patch
recorded "--result updated --from v1.2.3 --to v1.2.5"
grep -qx night_start=2 "$case_dir/auto-update.state"

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
  # This generation cannot run with the old library, even just after sourcing it.
  awk '{ print; if ($0 == ". \"$ROOT/lib.sh\"") print "new_library_only" }' "$case_dir/update.sh" > "$FIXTURES/host/deploy/update.sh"
  awk '{ print; if ($0 == ". \"$ROOT/lib.sh\"") print "new_library_only" }' "$case_dir/rotate-key.sh" > "$FIXTURES/host/deploy/rotate-key.sh"
  # The generated function reads FIXTURES when the new library is loaded.
  # shellcheck disable=SC2016
  printf '\nnew_library_only() { echo new-updater >> "$FIXTURES/generations"; }\n' >> "$FIXTURES/host/deploy/lib.sh"
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
  [ "$(stat -c %a "$case_dir/lib.sh")" = 644 ]
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
[ "$(grep -c '^tar -xzf ' "$CALLS")" -eq 1 ]
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

for failure in host_midway host_reload host_history_mkdir host_history_copy; do
  make_install "$failure"
  host_release
  expect_status 1 "FAIL_AT=$failure" --patch --now
  old_hosts
  [ -z "$(find "$case_dir" -maxdepth 1 -name '.host-prepare.*' -print)" ]
  [ -z "$(find "$case_dir/.host-history" -name '*.next' -print 2>/dev/null)" ]
done
# Even a persistent systemd failure must not skip image rollback or leave its history starting.
make_install host-reload-always
host_release
expect_status 1 FAIL_AT=host_reload_always --patch --now
cmp -s "$source_dir/update.sh" "$case_dir/update.sh"
cmp -s "$source_dir/lib.sh" "$case_dir/lib.sh"
[ -d "$case_dir/.host-update" ]
called "up -d .* IMAGE=$PREVIOUS_ID"
recorded '--result rolled_back --reason health_check_failed --from v1.2.3 --to v1.2.5 --failures 1'
tail -n 2 "$case_dir/version-history.tsv" | cut -f4 | tr '\n' ' ' | grep -qx 'failed rollback '
[ ! -e "$case_dir/.auto-update.inflight" ]
expect_status 1 FAIL_AT=host_reload_always --patch --now # The next run preserves the restored generation and journal.
cmp -s "$source_dir/lib.sh" "$case_dir/lib.sh"
expect_status 0 --patch --now
[ ! -d "$case_dir/.host-update" ]

make_install host-rollback-reload-always
host_release
expect_status 0 --patch --now
expect_status 1 FAIL_AT=host_reload_always CURRENT_LABEL=v1.2.5 --rollback
pinned "$target"
cmp -s "$case_dir/update.sh" "$FIXTURES/host/deploy/update.sh"
[ -d "$case_dir/.host-update" ]
called "up -d .* IMAGE=$DIGEST" # A failed rollback restarts the image it began on.
recorded '--result rolled_back --reason health_check_failed --from v1.2.5 --to v1.2.3'
tail -n 2 "$case_dir/version-history.tsv" | cut -f4 | tr '\n' ' ' | grep -qx 'failed rollback '

# A process killed between renames leaves a durable journal; the next invocation restores before acting.
make_install host-killed
host_release
expect_status 137 FAIL_AT=host_killed --patch --now
[ -d "$case_dir/.host-update" ]
cmp -s "$source_dir/lib.sh" "$case_dir/lib.sh" # New updater, old library at the interruption.
checks false false
expect_status 1 --patch --now # Reports recovery of the interrupted automatic attempt.
old_hosts
[ ! -e "$FIXTURES/generations" ] # Recovery re-execs the old updater; new top-level code never runs.

make_install host-killed-rotation
host_release
expect_status 137 FAIL_AT=host_killed --patch --now
rotation_old=$(printf 'a%.0s' $(seq 64))
printf 'APP_ENCRYPTION_KEY=%s\n' "$rotation_old" >> "$case_dir/.env"
sh "$case_dir/rotate-key.sh" > "$temporary/output" 2>&1
old_hosts
[ "$(awk -F= '$1 == "APP_ENCRYPTION_KEY" { print $2 }' "$case_dir/.env")" != "$rotation_old" ]
[ ! -e "$case_dir/.rotate-key.inflight" ]
called ' /app/maintenance.mjs rotate-key'
[ "$(line_of 'systemctl daemon-reload')" -lt "$(line_of ' /app/maintenance.mjs rotate-key')" ]
[ ! -e "$FIXTURES/generations" ]

make_install host-killed-rotation-marker
host_release
expect_status 137 FAIL_AT=host_killed --patch --now
touch "$case_dir/.rotate-key.inflight"
expect_status 0 --patch --now
old_hosts # Host recovery happens before the early rotation check, too.
[ ! -e "$FIXTURES/generations" ]

make_install host-cleanup-killed
host_release
expect_status 137 FAIL_AT=host_cleanup_killed --patch --now
pinned "$target"
[ ! -d "$case_dir/.host-update" ]
expect_status 0 CURRENT_LABEL=v1.2.5 --patch --now
pinned "$target"
cmp -s "$case_dir/update.sh" "$FIXTURES/host/deploy/update.sh"
[ -z "$(find "$case_dir" -maxdepth 1 -name '.host-retired.*' -print)" ]

make_install host-pin-signal
host_release
expect_status 0 FAIL_AT=host_pin_signal --patch --now
pinned "$target"
cmp -s "$case_dir/update.sh" "$FIXTURES/host/deploy/update.sh"
recorded "--result updated --from v1.2.3 --to v1.2.5"
never "up -d .* IMAGE=$PREVIOUS_ID"
[ ! -e "$case_dir/.schema-attempt" ] && [ ! -e "$case_dir/.schema-recovery" ] && [ ! -e "$case_dir/schema-compatibility.yaml.before" ]

make_install host-pin-signal-manual
host_release
expect_status 0 FAIL_AT=host_pin_signal "$target"
pinned "$target"
[ ! -e "$case_dir/.schema-attempt" ] && [ ! -e "$case_dir/.schema-recovery" ] && [ ! -e "$case_dir/schema-compatibility.yaml.before" ]

# A manual update first settles a killed nightly patch, even after the owner hand-started the app.
make_install manual-after-killed-patch
printf 'v1.2.3 v1.2.5 2026-11-03T09:02:00Z -\n' > "$case_dir/.auto-update.inflight"
expect_status 1 ghcr.io/example/app:v1.3.0
[ ! -e "$case_dir/.auto-update.inflight" ]
recorded '--result rolled_back --reason interrupted --from v1.2.3 --to v1.2.5 --failures 1'
never 'IMAGE=ghcr.io/example/app:v1.3.0'
pinned ghcr.io/example/app:v1.2.3

# Saved host generations follow the local image inventory and saved pins (see the pruning case above).
for inventory in available unavailable; do
  make_install "host-history-$inventory"
  orphan=$(printf 'f%.0s' $(seq 64))
  mkdir -p "$case_dir/.host-history/$orphan" "$case_dir/.host-history/${PREVIOUS_ID#sha256:}"
  if [ "$inventory" = available ]; then
    expect_status 0 --patch --now
    [ ! -d "$case_dir/.host-history/$orphan" ]
  else
    expect_status 0 FAIL_AT=image_list --patch --now
    [ -d "$case_dir/.host-history/$orphan" ]
  fi
  [ -d "$case_dir/.host-history/${PREVIOUS_ID#sha256:}" ]
done

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

# --- PostgreSQL and Caddy images ---------------------------------------------------------------------------------
override_text() { # SERVICES...: infrastructure-images.yaml as update.sh writes it for these services
  printf '%s\n' "# Written by update.sh; don't edit. PostgreSQL and Caddy run the images .env names (POSTGRES_IMAGE, CADDY_IMAGE)." 'services:'
  for service do
    case "$service" in
      postgres) printf '%s\n' '  postgres:' "    image: '\${POSTGRES_IMAGE:-$P0}'" ;;
      caddy) printf '%s\n' '  caddy:' "    image: '\${CADDY_IMAGE:-$C0}'" ;;
    esac
  done
}
restored='120 postgres caddy IMAGE=configured POSTGRES_IMAGE=unset CADDY_IMAGE=unset'
no_line() { if grep -Eq "^($1)=" "$case_dir/.env"; then echo "Unexpected .env line: $1" >&2; exit 1; fi; }

# A manifest names both images or neither: PostgreSQL 18 on its default variant and Caddy 2 on Alpine, by digest.
make_install infra-manifest
(
  ROOT=$case_dir
  # shellcheck source=deploy/lib.sh
  . "$case_dir/lib.sh"
  images_accepted() { # POSTGRES CADDY: manifest_check on the fixture's manifest with these keys added (- for none)
    cp "$FIXTURES/manifest" "$temporary/images-manifest"
    [ "$1" = - ] || printf 'postgres_image=%s\n' "$1" >> "$temporary/images-manifest"
    [ "$2" = - ] || printf 'caddy_image=%s\n' "$2" >> "$temporary/images-manifest"
    manifest_check "$temporary/images-manifest" v1.2.5
  }
  images_accepted "$P1" "$C1"
  images_accepted - -
  for refused in "$P1 -" "- $C1" "postgres:19@$(infra_digest 4) $C1" "postgres:18-alpine@$(infra_digest 4) $C1" \
    "postgres:18 $C1" "$P1 caddy:3.0.0-alpine@$(infra_digest 7)" "$P1 caddy:2.11.8@$(infra_digest 7)"; do
    # shellcheck disable=SC2086 # Two words without spaces.
    if images_accepted $refused; then echo "manifest_check accepted: $refused" >&2; exit 1; fi
  done
)

# Newer images: both are pulled and checked while the app runs, PostgreSQL moves after the snapshot while the app is
# stopped, Caddy once the app is healthy, and one rename of .env commits the app and both images.
make_install infra-success
with_images "$P1" "$C1"
expect_status 0 --patch --now
recorded "--result updated --from v1.2.3 --to v1.2.5"
pinned "$target"
[ "$(grep -c '^POSTGRES_IMAGE=' "$case_dir/.env")" -eq 1 ] && grep -qx "POSTGRES_IMAGE=$P1" "$case_dir/.env"
[ "$(grep -c '^CADDY_IMAGE=' "$case_dir/.env")" -eq 1 ] && grep -qx "CADDY_IMAGE=$C1" "$case_dir/.env"
# The schema guard of the swap is listed after the override.
grep -qx 'COMPOSE_FILE=compose.yaml:infrastructure-images.yaml:schema-compatibility.yaml' "$case_dir/.env"
override_text postgres caddy | cmp -s - "$case_dir/infrastructure-images.yaml"
cmp -s "$FIXTURES/compose.yaml" "$case_dir/compose.yaml"
[ ! -e "$case_dir/.infrastructure-update" ] && [ ! -e "$case_dir/infrastructure-images.yaml.next" ]
for check in "pull $P1" "pull $C1" ' --entrypoint postgres ' ' --entrypoint caddy '; do
  [ "$(line_of "$check")" -lt "$(line_of ' stop app')" ]
done
[ "$(line_of ' snapshot pre-upgrade')" -lt "$(line_of "120 postgres IMAGE=configured POSTGRES_IMAGE=$P1 CADDY_IMAGE=unset")" ]
[ "$(line_of '120 postgres IMAGE')" -lt "$(line_of 'server_version_num')" ]
[ "$(line_of 'server_version_num')" -lt "$(line_of " 90 app IMAGE=$target")" ]
[ "$(line_of ' node /app/deploy/healthcheck.mjs')" -lt "$(line_of "60 caddy IMAGE=configured POSTGRES_IMAGE=unset CADDY_IMAGE=$C1")" ]
[ "$(line_of "image rm $(infra_digest 3)")" -gt "$(line_of '60 caddy IMAGE')" ]
grep '^image rm ' "$CALLS" | tail -n 1 | grep -q "^image rm $(infra_digest 6) "
# After it only the pulled-image list's checks run.
awk -v rm="image rm $(infra_digest 6) " 'index($0, rm) == 1 { after = 1; next }
  after && index($0, "image inspect ") != 1 { bad = 1 } END { exit bad }' "$CALLS"
# Both pulled images run now, so the record keeps them.
printf '%s\n' "$(infra_digest 4)" "$(infra_digest 7)" | cmp -s - "$case_dir/infrastructure-pulled.txt"
never "$restored"
# Before the swap writes the schema guard, a Compose call loads compose.yaml and then the override.
grep ' stop app' "$CALLS" | grep -q -- "-f $case_dir/compose.yaml -f $case_dir/infrastructure-images.yaml stop app"

# A release naming the images the install runs, or none: no Docker call for them, no file and no .env line.
for images in same none; do
  make_install "infra-$images"
  [ "$images" = none ] || with_images "$P0" "$C0"
  expect_status 0 --patch --now
  recorded "--result updated --from v1.2.3 --to v1.2.5"
  never 'pull postgres'; never 'pull caddy'; never ' --entrypoint postgres '; never "image inspect $P0"
  never '120 postgres'; never '60 caddy'
  [ ! -e "$case_dir/infrastructure-images.yaml" ]
  no_line 'POSTGRES_IMAGE|CADDY_IMAGE'
  if grep -q infrastructure-images "$case_dir/.env"; then echo 'COMPOSE_FILE lists the override.' >&2; exit 1; fi
done

# Only Caddy's image differs: PostgreSQL is never recreated or queried.
make_install infra-caddy
with_images "$P0" "$C1"
expect_status 0 --patch --now
recorded "--result updated --from v1.2.3 --to v1.2.5"
never '120 postgres'; never 'server_version_num'; never 'pull postgres'
grep -qx "CADDY_IMAGE=$C1" "$case_dir/.env"
no_line POSTGRES_IMAGE
override_text postgres caddy | cmp -s - "$case_dir/infrastructure-images.yaml"
called "image rm $(infra_digest 6)"
never "image rm $(infra_digest 3)"

# An image that can't be pulled, or fails its check, skips the update before anything stops.
make_install infra-pull
with_images "$P1" "$C1"
expect_status 1 FAIL_AT=infra_pull --patch --now
recorded "--result skipped --reason pull_failed --from v1.2.3 --to v1.2.5"
never ' stop app'
[ ! -e "$case_dir/infrastructure-images.yaml" ]
make_install infra-check
with_images "$P1" "$C1"
expect_status 1 FAIL_AT=postgres_check --patch --now
recorded "--result skipped --reason image_check_failed --from v1.2.3 --to v1.2.5"
never ' stop app'
[ ! -e "$case_dir/infrastructure-images.yaml" ]

# PostgreSQL doesn't start on its new image, or answers with another major or collation version: both services go back
# to the images .env names, then the previous app starts; .env keeps the previous pin.
attempt=0
for failure in FAIL_AT=postgres_up 'PG_CHECK=18|f' 'PG_CHECK=17|t'; do
  attempt=$((attempt + 1))
  make_install "infra-startup-$attempt"
  with_images "$P1" "$C1"
  expect_status 1 "$failure" --patch --now
  recorded "--result rolled_back --reason startup_failed --from v1.2.3 --to v1.2.5 --failures 1"
  [ "$(line_of '120 postgres IMAGE')" -lt "$(line_of "$restored")" ]
  [ "$(line_of "$restored")" -lt "$(line_of " 90 app IMAGE=$PREVIOUS_ID")" ]
  never " 90 app IMAGE=$target"
  pinned ghcr.io/example/app:v1.2.3
  no_line POSTGRES_IMAGE
  [ ! -e "$case_dir/.infrastructure-update" ]
done

# The app's health check fails after PostgreSQL moved: both services go back before the previous app starts.
make_install infra-health
with_images "$P1" "$C1"
expect_status 1 FAIL_AT=health --patch --now
recorded "--result rolled_back --reason health_check_failed --from v1.2.3 --to v1.2.5 --failures 1"
[ "$(line_of ' node /app/deploy/healthcheck.mjs')" -lt "$(line_of "$restored")" ]
[ "$(line_of "$restored")" -lt "$(line_of " 90 app IMAGE=$PREVIOUS_ID")" ]
never '60 caddy'
no_line 'POSTGRES_IMAGE|CADDY_IMAGE'
[ ! -e "$case_dir/.infrastructure-update" ]

# Caddy doesn't start on its new image, or doesn't keep running: the same restore, and only COMPOSE_FILE changed.
for failure in caddy_up caddy_settle; do
  make_install "infra-$failure"
  with_images "$P1" "$C1"
  cp "$case_dir/.env" "$temporary/env-before"
  expect_status 1 FAIL_AT=$failure --patch --now
  recorded "--result rolled_back --reason health_check_failed --from v1.2.3 --to v1.2.5 --failures 1"
  [ "$(line_of '60 caddy IMAGE')" -lt "$(line_of "$restored")" ]
  [ "$(line_of "$restored")" -lt "$(line_of " 90 app IMAGE=$PREVIOUS_ID")" ]
  grep -v '^COMPOSE_FILE=' "$case_dir/.env" | cmp -s - "$temporary/env-before"
  [ ! -e "$case_dir/.infrastructure-update" ]
done

# The restore itself fails: the rollback failed, and the marker stays. The next run starts with the same restore
# before anything else, and the marker goes once it works.
make_install infra-restore
with_images "$P1" "$C1"
expect_status 1 FAIL_AT=infra_restore --patch --now
grep -q 'Could not start PostgreSQL and Caddy on their previous images.' "$temporary/output"
recorded "--result failed --reason rollback_failed --from v1.2.3 --to v1.2.5 --failures 1"
[ -e "$case_dir/.infrastructure-update" ]
: > "$CALLS"
expect_status 1 FAKE_HOUR=14 --patch
head -n 1 "$CALLS" | grep -q -- "$restored"
[ ! -e "$case_dir/.infrastructure-update" ]
recorded '--result rolled_back --reason rollback_failed --from v1.2.3 --to v1.2.5 --failures 1 --down-at [0-9T:Z-]+'

# A marker left by a run killed outright: the next run's first Compose call is the restore.
make_install infra-marker
: > "$case_dir/.infrastructure-update"
expect_status 0 --patch --now
head -n 1 "$CALLS" | grep -q -- "$restored"
grep -q 'An earlier update stopped while changing PostgreSQL or Caddy' "$temporary/output"
[ ! -e "$case_dir/.infrastructure-update" ]
recorded "--result updated --from v1.2.3 --to v1.2.5"

# An install with its own Compose files updates the app and says why PostgreSQL and Caddy stay as they are. Every
# Compose call, the rollback's too, loads its files right after compose.yaml, as `docker compose` in the directory does.
# owns: each Compose call loads FILE right after compose.yaml.
owns() {
  grep -F -- "-f $case_dir/compose.yaml " "$CALLS" > "$temporary/compose-calls"
  [ -s "$temporary/compose-calls" ]
  if grep -vF -- "-f $case_dir/compose.yaml -f $case_dir/$1 " "$temporary/compose-calls"; then
    echo "A Compose call without $1." >&2; exit 1
  fi
}
for own in override list rollback; do
  make_install "infra-own-$own"
  with_images "$P1" "$C1"
  case "$own" in
    list) owner_file=mine.yaml; printf 'COMPOSE_FILE=compose.yaml:mine.yaml\n' >> "$case_dir/.env" ;;
    *) owner_file=compose.override.yaml ;;
  esac
  : > "$case_dir/$owner_file"
  if [ "$own" = rollback ]; then
    expect_status 1 FAIL_AT=health --patch --now
    recorded '--result rolled_back --reason health_check_failed --from v1.2.3 --to v1.2.5 --failures 1'
    called " 90 app IMAGE=$PREVIOUS_ID"
  else
    expect_status 0 --patch --now
    recorded "--result updated --from v1.2.3 --to v1.2.5"
  fi
  owns "$owner_file"
  grep -qF 'This install has its own Compose files, so its PostgreSQL and Caddy images stay as they are. See docs/update-reference.md.' "$temporary/output"
  never 'pull postgres'; never 'pull caddy'; never '120 postgres'; never '60 caddy'
  [ ! -e "$case_dir/infrastructure-images.yaml" ]
done
# A COMPOSE_FILE entry whose file is gone is left out, so the update still starts the app, and it isn't an own file.
make_install infra-own-gone
with_images "$P1" "$C1"
printf 'COMPOSE_FILE=./compose.yaml:gone.yaml\n' >> "$case_dir/.env"
expect_status 0 --patch --now
recorded "--result updated --from v1.2.3 --to v1.2.5"
never "$case_dir/gone.yaml"
if grep -qF 'This install has its own Compose files' "$temporary/output"; then echo 'A gone file counted as an own file.' >&2; exit 1; fi
# An own file that names the app's image would replace the release: nothing is pulled, stopped or started.
make_install own-app-image
: > "$case_dir/compose.override.yaml"
expect_status 1 OWN_APP_IMAGE=registry.example/custom:1 --patch --now
recorded '--result skipped --reason own_app_image --from v1.2.3 --to v1.2.5'
never ' pull app'; never ' stop app'; never ' 90 app'
grep -qF "This install's own Compose files name an image for the app" "$temporary/output"
# An own file that broke stops the update and the first rollback start; the previous version then starts without it.
make_install own-files-broken
: > "$case_dir/compose.override.yaml"
expect_status 1 FAIL_AT=own_files --patch --now
recorded '--result rolled_back --reason startup_failed --from v1.2.3 --to v1.2.5 --failures 1'
grep " 90 app IMAGE=$PREVIOUS_ID" "$CALLS" | tail -n 1 | grep -qvF -- "compose.override.yaml"
grep -qF "The previous version didn't start with this install's own Compose files" "$temporary/output"
# A compose.yaml naming its own PostgreSQL image keeps it; Caddy still moves, and the override covers only Caddy.
make_install infra-own-image
with_images "$P1" "$C1"
sed -i "s#^    image: $P0\$#    image: example/postgres:18@$(infra_digest 8)#" "$case_dir/compose.yaml"
expect_status 0 --patch --now
grep -qF 'compose.yaml names its own image for postgres, so it stays as it is.' "$temporary/output"
never 'pull postgres'; never '120 postgres'
called "60 caddy IMAGE=configured POSTGRES_IMAGE=unset CADDY_IMAGE=$C1"
override_text caddy | cmp -s - "$case_dir/infrastructure-images.yaml"
grep -qx "CADDY_IMAGE=$C1" "$case_dir/.env"
no_line POSTGRES_IMAGE

# A second update moves PostgreSQL again: one .env line, the override listed once, and the image it replaced removed.
# Every Compose call loads compose.yaml, the schema guard, then the override.
make_install infra-again
with_images "$P1" "$C1"
expect_status 0 DISTINCT_IDS=true --patch --now
printf '[{"tag_name": "v1.2.6"}, {"tag_name": "v1.2.5"}]\n' > "$FIXTURES/releases.json"
write_manifest v1.2.6
with_images "$P2" "$C1"
: > "$CALLS"
expect_status 0 DISTINCT_IDS=true --patch --now
recorded "--result updated --from v1.2.5 --to v1.2.6"
[ "$(grep -c '^POSTGRES_IMAGE=' "$case_dir/.env")" -eq 1 ] && grep -qx "POSTGRES_IMAGE=$P2" "$case_dir/.env"
[ "$(grep -c '^CADDY_IMAGE=' "$case_dir/.env")" -eq 1 ] && grep -qx "CADDY_IMAGE=$C1" "$case_dir/.env"
[ "$(grep '^COMPOSE_FILE=' "$case_dir/.env" | tr ':' '\n' | grep -cx infrastructure-images.yaml)" -eq 1 ]
called "image rm $(infra_digest 4)"
never "pull $C1"; never '60 caddy'
grep " 90 app IMAGE=" "$CALLS" | grep -q -- "-f $case_dir/compose.yaml -f $case_dir/schema-compatibility.yaml -f $case_dir/infrastructure-images.yaml up "
printf '[{"tag_name": "v2.0.0"}, {"tag_name":"v1.3.0"},\n {"tag_name": "v1.2.5"}, {"tag_name": "v1.2.4"}, {"tag_name": "v1.2.3"}]\n' > "$FIXTURES/releases.json"

# An update that fails after pulling its images lists them, and removes none. The next successful update, to other
# images, removes the one that never ran and keeps those .env or compose.yaml names.
make_install infra-pulled
with_images "$P1" "$C1"
expect_status 1 FAIL_AT=health --patch --now
recorded "--result rolled_back --reason health_check_failed --from v1.2.3 --to v1.2.5 --failures 1"
printf '%s\n' "$(infra_digest 4)" "$(infra_digest 7)" | cmp -s - "$case_dir/infrastructure-pulled.txt"
never "image rm $(infra_digest 4)"; never "image rm $(infra_digest 7)"
write_manifest v1.2.5
with_images "$P2" "$C1"
: > "$CALLS"
expect_status 0 --patch --now
recorded "--result updated --from v1.2.3 --to v1.2.5"
grep -qx "POSTGRES_IMAGE=$P2" "$case_dir/.env" && grep -qx "CADDY_IMAGE=$C1" "$case_dir/.env"
[ "$(grep -c "^image rm $(infra_digest 4) " "$CALLS")" -eq 1 ]
never "image rm $(infra_digest 5)"; never "image rm $(infra_digest 7)"
# Exactly the listed images still on disk.
printf '%s\n' "$(infra_digest 7)" "$(infra_digest 5)" | cmp -s - "$case_dir/infrastructure-pulled.txt"

# A listed image compose.yaml names stays; an invalid line and a repeated ID leave the list without another removal.
make_install infra-pulled-kept
printf '%s\n' "$(infra_digest 3)" not-an-id "$(infra_digest 4)" "$(infra_digest 3)" "$(infra_digest 4)" > "$case_dir/infrastructure-pulled.txt"
expect_status 0 --patch --now
recorded "--result updated --from v1.2.3 --to v1.2.5"
never "image rm $(infra_digest 3)"; never 'image rm not-an-id'
[ "$(grep -c "^image rm $(infra_digest 4) " "$CALLS")" -eq 1 ]
printf '%s\n' "$(infra_digest 3)" | cmp -s - "$case_dir/infrastructure-pulled.txt"
# A --rollback run removes nothing and leaves the list as it was.
printf '%s\n' "$(infra_digest 5)" >> "$case_dir/infrastructure-pulled.txt"
cp "$case_dir/infrastructure-pulled.txt" "$temporary/pulled-before"
: > "$CALLS"
expect_status 0 CURRENT_LABEL=v1.2.5 --rollback
never 'image rm '
cmp -s "$temporary/pulled-before" "$case_dir/infrastructure-pulled.txt"

# A list that can't be written never fails the update.
make_install infra-pulled-unwritable
with_images "$P1" "$C1"
mkdir "$case_dir/infrastructure-pulled.txt"
expect_status 0 --patch --now
recorded "--result updated --from v1.2.3 --to v1.2.5"
grep -qxF 'Could not record the pulled PostgreSQL or Caddy image for later cleanup.' "$temporary/output"
[ -d "$case_dir/infrastructure-pulled.txt" ]

# An automatic update killed outright while changing PostgreSQL or Caddy, whose restore then fails: its rollback failed,
# reported once, and both markers stay. A later run whose restore works reports the recovery.
make_install infra-marker-inflight
: > "$case_dir/.infrastructure-update"
printf 'v1.2.3 v1.2.5 2026-11-20T03:00:00Z -\n' > "$case_dir/.auto-update.inflight"
expect_status 1 FAIL_AT=infra_restore --patch
recorded '--result failed --reason rollback_failed --from v1.2.3 --to v1.2.5 --failures 1'
[ "$(wc -l < "$RECORDS")" -eq 1 ]
grep -qxF 'PostgreSQL or Caddy did not start on the images .env names. Fix the error above and run update.sh again.' "$temporary/output"
[ "$(awk '{ print $4 }' "$case_dir/.auto-update.inflight")" = rollback_failed ]
[ -e "$case_dir/.infrastructure-update" ]
never ' 90 app'
expect_status 1 FAIL_AT=infra_restore --patch
[ "$(wc -l < "$RECORDS")" -eq 1 ]
[ -e "$case_dir/.infrastructure-update" ] && [ -e "$case_dir/.auto-update.inflight" ]
never ' 90 app'
: > "$CALLS"
expect_status 1 --patch
head -n 1 "$CALLS" | grep -q -- "$restored"
[ ! -e "$case_dir/.infrastructure-update" ] && [ ! -e "$case_dir/.auto-update.inflight" ]
recorded '--result rolled_back --reason rollback_failed --from v1.2.3 --to v1.2.5 --failures 1 --down-at 2026-11-20T03:00:00Z'
# Without an automatic update's marker the failed restore only says so.
make_install infra-marker-restore
: > "$case_dir/.infrastructure-update"
expect_status 1 FAIL_AT=infra_restore --patch
grep -qxF 'PostgreSQL or Caddy did not start on the images .env names. Fix the error above and run update.sh again.' "$temporary/output"
[ ! -s "$RECORDS" ]
[ -e "$case_dir/.infrastructure-update" ]

# compose.yaml's image line edited once .env names the image: the update says .env decides, once, and changes no file.
notice="compose.yaml names $P2 for postgres, but POSTGRES_IMAGE in .env decides its image ($P1). To change it, edit POSTGRES_IMAGE in .env."
for notice_case in edited unedited pinned unpinned; do
  make_install "infra-notice-$notice_case"
  override_text postgres caddy > "$case_dir/infrastructure-images.yaml"
  printf 'COMPOSE_FILE=compose.yaml:infrastructure-images.yaml\n' >> "$case_dir/.env"
  [ "$notice_case" = unpinned ] || printf 'POSTGRES_IMAGE=%s\n' "$P1" >> "$case_dir/.env"
  case "$notice_case" in unedited) edited=$P0 ;; pinned) edited=$P1 ;; *) edited=$P2 ;; esac
  sed -i "s#^    image: $P0\$#    image: $edited#" "$case_dir/compose.yaml"
  cp "$case_dir/compose.yaml" "$temporary/compose-before"
  expect_status 0 --patch --now
  recorded "--result updated --from v1.2.3 --to v1.2.5"
  if [ "$notice_case" = edited ]; then
    [ "$(grep -cxF "$notice" "$temporary/output")" -eq 1 ]
  elif grep -qF 'decides its image' "$temporary/output"; then
    echo "A notice without an edited image line: $notice_case" >&2; exit 1
  fi
  cmp -s "$temporary/compose-before" "$case_dir/compose.yaml"
  override_text postgres caddy | cmp -s - "$case_dir/infrastructure-images.yaml"
done
# A line naming an image of the install's own keeps that service out of the rewritten override, so compose.yaml
# decides it from then on: no notice says .env does.
make_install infra-notice-own-image
override_text postgres caddy > "$case_dir/infrastructure-images.yaml"
printf 'COMPOSE_FILE=compose.yaml:infrastructure-images.yaml\nPOSTGRES_IMAGE=%s\n' "$P1" >> "$case_dir/.env"
sed -i "s#^    image: $P0\$#    image: postgres:18-local#" "$case_dir/compose.yaml"
with_images "$P1" "$C1"
expect_status 0 --patch --now
recorded "--result updated --from v1.2.3 --to v1.2.5"
grep -qxF 'compose.yaml names its own image for postgres, so it stays as it is.' "$temporary/output"
if grep -qF 'decides its image' "$temporary/output"; then echo 'A notice for an image of the install'\''s own' >&2; exit 1; fi
override_text caddy | cmp -s - "$case_dir/infrastructure-images.yaml"

echo 'PASS: patch selection, signature, digest and migration checks, setting off, skipped snapshot, rollback, window, pending results; signed host generations, tampering, partial failure, interruption and rollback; PostgreSQL and Caddy image updates, checks, restores and the marker, pulled images that never ran, a failed restore after a killed automatic update, and an edited compose.yaml image line.'
