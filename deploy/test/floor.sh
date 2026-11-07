#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Exercises `update.sh IMAGE` across a rollback floor with Docker and curl fixtures and a real signature. The Docker
# fixture refuses the previous image under a guard above it, as the app's startup does, so a failed update that leaves
# the guard up shows as an install that won't start. Needs root and OpenSSL 3.
set -eu
umask 077
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
[ "$(id -u)" -eq 0 ] || { echo 'Run this test as root in a disposable environment.' >&2; exit 1; }
temporary=$(mktemp -d)
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$temporary/output" ]; then echo '--- last update.sh output:' >&2; cat "$temporary/output" >&2; fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT
mkdir "$temporary/bin" "$temporary/release"
export PATH="$temporary/bin:$PATH" CALLS="$temporary/calls" FIXTURES="$temporary/release"
digest=sha256:$(printf 'd%.0s' $(seq 64))
export DIGEST="$digest"
PREVIOUS_ID="sha256:$(printf 'a%.0s' $(seq 64))"
export PREVIOUS_ID
snapshot=00000000-0000-4000-8000-00000000000a

cat > "$temporary/bin/docker" <<'MOCK'
#!/bin/sh
set -eu
printf '%s IMAGE=%s\n' "$*" "${APP_IMAGE:-configured}" >> "$CALLS"
guard=
for argument in "$@"; do case "$argument" in *schema-compatibility.yaml) guard=$argument ;; esac; done
case "$*" in
  *' ps --status running --services') echo app ;;
  "image inspect "*" --format {{.Id}}") case "$3" in *:v1.9.0|"$PREVIOUS_ID") echo "$PREVIOUS_ID" ;; *) echo "$DIGEST" ;; esac ;;
  'image inspect '*'org.opencontainers.image.version'*) case "$3" in *:v1.9.0|"$PREVIOUS_ID") echo v1.9.0 ;; *) echo "$TARGET" ;; esac ;;
  'image inspect '*RepoDigests*) echo "ghcr.io/example/app@$DIGEST" ;;
  *' snapshot pre-upgrade') echo 'Snapshot: 00000000-0000-4000-8000-00000000000a' ;;
  *' exec -T postgres '*) [ "${FAIL_AT:-}" != database ] && [ ! -e "$FIXTURES/database_down" ] || exit 1; cat "$FIXTURES/schema" ;;
  *'up -d '*)
    if [ "${APP_IMAGE:-}" = "$PREVIOUS_ID" ]; then
      if [ -n "$guard" ] && grep -q "SCHEMA_ROLLBACK_FLOOR: 'v$REFUSED_ABOVE" "$guard"; then echo 'Cannot start v1.9.0' >&2; exit 1; fi
    else
      case "${FAIL_AT:-}" in
        before_migrating) exit 1 ;;
        database_lost) : > "$FIXTURES/database_down"; exit 1 ;;
        after_migrating) echo '21|2000' > "$FIXTURES/schema"; exit 1 ;;
        killed) kill -KILL "$PPID"; exit 1 ;;
        killed_after_migrating) echo '21|2000' > "$FIXTURES/schema"; kill -KILL "$PPID"; exit 1 ;;
        *) echo '21|2000' > "$FIXTURES/schema" ;;
      esac
    fi ;;
esac
MOCK
cat > "$temporary/bin/curl" <<'MOCK'
#!/bin/sh
url= output=
while [ "$#" -gt 0 ]; do case "$1" in -o) output=$2; shift 2 ;; https://*) url=$1; shift ;; *) shift ;; esac; done
case "$url" in
  https://github.com/example/app/releases/download/*/release-manifest.txt) cp "$FIXTURES/manifest" "$output" ;;
  https://github.com/example/app/releases/download/*/release-manifest.txt.sig) cp "$FIXTURES/manifest.sig" "$output" ;;
  *) exit 22 ;;
esac
MOCK
chmod 0700 "$temporary/bin/docker" "$temporary/bin/curl"
openssl genpkey -algorithm ed25519 -out "$FIXTURES/key.pem" 2>/dev/null
openssl pkey -in "$FIXTURES/key.pem" -pubout -out "$FIXTURES/public.pem"

# make_install NAME VERSION FLOOR: an install on v1.9.0 and a signed release VERSION with that rollback floor.
make_install() {
  case_dir="$temporary/$1"
  mkdir "$case_dir"
  cp "$source_dir/update.sh" "$source_dir/lib.sh" "$case_dir/"
  cp "$FIXTURES/public.pem" "$case_dir/release-signing.pem"
  : > "$case_dir/compose.yaml"
  printf 'APP_IMAGE=ghcr.io/example/app:v1.9.0\nRELEASE_REPOSITORY=example/app\n' > "$case_dir/.env"
  printf '20|1000\n' > "$FIXTURES/schema"
  : > "$CALLS"
  TARGET=$2 REFUSED_ABOVE=${3#v}
  export TARGET REFUSED_ABOVE
  printf 'format=plaingym-release-manifest/2\nversion=%s\nimage=ghcr.io/example/app\ndigest=%s\nrollback_floor=%s\nrevision=%s\nmigrations=sha256:%s\n' \
    "$2" "$digest" "$3" "$(printf '1%.0s' $(seq 40))" "$(printf 'c%.0s' $(seq 64))" > "$FIXTURES/manifest"
  openssl pkeyutl -sign -inkey "$FIXTURES/key.pem" -rawin -in "$FIXTURES/manifest" -out "$FIXTURES/manifest.sig"
}
update() { # EXPECTED_STATUS [NAME=VALUE]: update to the fixture's target
  expected=$1; shift
  status=0
  env "$@" sh "$case_dir/update.sh" "ghcr.io/example/app:$TARGET" > "$temporary/output" 2>&1 || status=$?
  [ "$status" -eq "$expected" ] || { echo "Expected exit $expected, got $status: $*" >&2; exit 1; }
}
said() { grep -q -- "$1" "$temporary/output" || { echo "Expected the output: $1" >&2; exit 1; }; }
pinned() { grep -qx "APP_IMAGE=$1" "$case_dir/.env"; }
no_guard() {
  [ ! -e "$case_dir/schema-compatibility.yaml" ] && [ ! -e "$case_dir/schema-compatibility.yaml.before" ] && [ ! -e "$case_dir/.schema-attempt" ]
  if grep -q COMPOSE_FILE "$case_dir/.env"; then echo 'COMPOSE_FILE was left behind.' >&2; exit 1; fi
}
served_previous() { tail -n 1 "$CALLS" | grep -q "up -d .* IMAGE=$PREVIOUS_ID"; }
outcomes() { [ "$(cut -f4 "$case_dir/version-history.tsv" | tr '\n' ' ')" = "$1" ] || { echo "Expected the history: $1" >&2; cat "$case_dir/version-history.tsv" >&2; exit 1; }; }
# shellcheck source=deploy/lib.sh
installed() { (ROOT=$case_dir; . "$case_dir/lib.sh"; "$@"); }
floor() { installed schema_floor; }

# The owner is told before anything stops; the attempt fails before migrating; the previous version starts again and
# the floor doesn't stay, so a later rollback isn't refused because of an update that changed nothing.
make_install before_migrating v2.0.0 v2.0.0
update 1 FAIL_AT=before_migrating
said 'v2.0.0 has rollback floor v2.0.0'
[ "$(grep -n 'rollback floor' "$temporary/output" | cut -d: -f1)" -lt "$(grep -n 'Update failed' "$temporary/output" | cut -d: -f1)" ]
served_previous
pinned ghcr.io/example/app:v1.9.0
no_guard
outcomes 'install starting abandoned rollback '
[ "$(floor)" = v1.9.0 ]
# The next attempt crosses for real and leaves the guard, with its own snapshot.
update 0
pinned "ghcr.io/example/app@$digest"
grep -q "SCHEMA_ROLLBACK_FLOOR: 'v2.0.0'" "$case_dir/schema-compatibility.yaml"
grep -qx 'COMPOSE_FILE=compose.yaml:schema-compatibility.yaml' "$case_dir/.env"
[ ! -e "$case_dir/.schema-attempt" ] && [ ! -e "$case_dir/schema-compatibility.yaml.before" ]
outcomes 'install starting abandoned rollback starting update '
[ "$(floor)" = v2.0.0 ]

# Once the target migrated, the previous version can't run: no restart, the guard stays, and the snapshot is named.
make_install after_migrating v2.0.0 v2.0.0
update 1 FAIL_AT=after_migrating
said 'changed the database'
said "$snapshot"
if served_previous; then echo 'Restarted the previous image on the migrated database.' >&2; exit 1; fi
[ "$(grep -c 'up -d' "$CALLS")" -eq 1 ]
pinned ghcr.io/example/app:v1.9.0
grep -q "SCHEMA_ROLLBACK_FLOOR: 'v2.0.0'" "$case_dir/schema-compatibility.yaml"
[ ! -e "$case_dir/.schema-attempt" ]
outcomes 'install starting failed '
[ "$(floor)" = v2.0.0 ]

# A guard from an earlier release comes back as it was, with an owner's own Compose list.
make_install earlier_guard v2.0.0 v2.0.0
installed write_schema_guard v1.8.0 v1.9.0 00000000-0000-4000-8000-000000000008
cp "$case_dir/schema-compatibility.yaml" "$temporary/guard"
cp "$case_dir/.env" "$temporary/environment"
update 1 FAIL_AT=before_migrating
cmp "$case_dir/schema-compatibility.yaml" "$temporary/guard"
cmp "$case_dir/.env" "$temporary/environment"
make_install owner_compose v2.0.0 v2.0.0
printf 'COMPOSE_FILE=compose.yaml:compose.override.yaml\n' >> "$case_dir/.env"
cp "$case_dir/.env" "$temporary/environment"
update 1 FAIL_AT=before_migrating
[ "$(sort "$case_dir/.env")" = "$(sort "$temporary/environment")" ]
[ ! -e "$case_dir/schema-compatibility.yaml" ]

# A skipped minor crosses too: v1.9 to v1.11, whose floor is v1.10.0.
make_install skipped_minor v1.11.0 v1.10.0
update 1 FAIL_AT=before_migrating
said 'v1.11.0 has rollback floor v1.10.0'
served_previous
no_guard

# Within the floor nothing is at stake: no notice, and the previous image runs under the guard even after a migration.
make_install within_floor v1.10.0 v1.9.0
export REFUSED_ABOVE=9.9.9
update 1 FAIL_AT=after_migrating
if grep -q 'rollback floor' "$temporary/output"; then echo 'Warned within the floor.' >&2; exit 1; fi
served_previous
grep -q "SCHEMA_ROLLBACK_FLOOR: 'v1.9.0'" "$case_dir/schema-compatibility.yaml"
[ ! -e "$case_dir/.schema-attempt" ]
outcomes 'install starting failed rollback '

# When the migrations can't be read nothing crosses, and the previous version is restarted.
make_install unreadable v2.0.0 v2.0.0
update 1 FAIL_AT=database
said "migrations couldn't be read"
served_previous
no_guard
outcomes 'install '

# The database stops answering during the failure: the attempt stays open as failed, and the next run settles it. An
# attempt that turns out to have changed nothing leaves no floor, though its failed row was written first.
make_install lost_database v2.0.0 v2.0.0
update 1 FAIL_AT=database_lost
said "database can't be read"
[ -e "$case_dir/.schema-attempt" ]
outcomes 'install starting failed '
[ "$(floor)" = v2.0.0 ]
rm "$FIXTURES/database_down"
update 1
said 'interrupted'
served_previous
no_guard
outcomes 'install starting failed abandoned rollback '
[ "$(floor)" = v1.9.0 ]

# A run killed outright: the next run of any kind finishes it, by the same rules.
make_install killed v2.0.0 v2.0.0
update 137 FAIL_AT=killed
[ -e "$case_dir/.schema-attempt" ]
pinned ghcr.io/example/app:v1.9.0
update 1
said 'interrupted'
served_previous
no_guard
outcomes 'install starting abandoned rollback '
[ "$(floor)" = v1.9.0 ]
update 0
pinned "ghcr.io/example/app@$digest"
make_install killed_after v2.0.0 v2.0.0
update 137 FAIL_AT=killed_after_migrating
: > "$CALLS"
update 1
said 'changed the database'
[ "$(grep -c 'up -d' "$CALLS")" -eq 0 ]
grep -q "SCHEMA_ROLLBACK_FLOOR: 'v2.0.0'" "$case_dir/schema-compatibility.yaml"
outcomes 'install starting failed '

# Killed once the new image was pinned, the update is done: its record goes, and nothing is undone.
make_install killed_pinned v2.0.0 v2.0.0
update 0
printf '20|1000\tv1.9.0\tv2.0.0\t%s\tv2.0.0\t%s\n' "$digest" "$snapshot" > "$case_dir/.schema-attempt"
: > "$CALLS"
sh "$case_dir/update.sh" "ghcr.io/example/app@$digest" > "$temporary/output" 2>&1
said 'Already on the requested image'
[ ! -e "$case_dir/.schema-attempt" ]
grep -q "SCHEMA_ROLLBACK_FLOOR: 'v2.0.0'" "$case_dir/schema-compatibility.yaml"

# With no floor recorded, as with development builds, nothing bounds a rollback.
make_install no_floor v2.0.0 v2.0.0
printf 'APP_IMAGE=ghcr.io/example/app@%s\n' "$digest" > "$case_dir/.env"
printf '2026-11-01T00:00:00Z\tv1.9.0\t%s\tinstall\t-\t-\n2026-11-02T00:00:00Z\tv2.0.0\t%s\tupdate\t-\t-\n' "$PREVIOUS_ID" "$digest" > "$case_dir/version-history.tsv"
sh "$case_dir/update.sh" --rollback > "$temporary/output" 2>&1
said 'Rolled back to v1.9.0'
pinned "$PREVIOUS_ID"

# The history: rollbacks walk back, a rollback's restart of the running version changes nothing, and an update
# from there leaves the version it replaced as the way back.
ROOT="$temporary/history"
mkdir "$ROOT"
# shellcheck source=deploy/lib.sh
. "$source_dir/lib.sh"
one=sha256:$(printf '1%.0s' $(seq 64)) two=sha256:$(printf '2%.0s' $(seq 64)) three=sha256:$(printf '3%.0s' $(seq 64))
row() { history_record "$1" "$2" "$3" "$4" -; }
row v1.2.3 "$one" install v1.2.3; row v1.2.4 "$two" update v1.2.0; row v1.2.5 "$three" update v1.2.0
[ "$(previous_version "$three" | cut -f2)" = v1.2.4 ]
row v1.2.4 "$two" rollback v1.2.0
[ "$(previous_version "$two" | cut -f2)" = v1.2.3 ]
declined_patch v1.2.5
declined_patch v1.2.4 # An older patch than the one left stays out too.
if declined_patch v1.2.6; then echo 'Held back a newer patch.' >&2; exit 1; fi
if declined_patch v1.3.0; then echo 'Held back another minor.' >&2; exit 1; fi
row v1.2.3 "$one" rollback v1.2.0
[ -z "$(previous_version "$one")" ]
# A failed update restarts the running version with a rollback row: nothing was left, and the stack doesn't move.
row v1.2.5 "$three" failed v1.2.0; row v1.2.3 "$one" rollback v1.2.0
[ -z "$(previous_version "$one")" ]
# Installing a release again by hand clears its hold, and it can be rolled back from again.
row v1.2.5 "$three" update v1.2.0
if declined_patch v1.2.5; then echo 'Kept holding a release the owner installed again.' >&2; exit 1; fi
declined_patch v1.2.4
[ "$(previous_version "$three" | cut -f2)" = v1.2.3 ]
# A patch of another minor keeps its own hold.
row v1.3.0 "$two" update v1.2.0; row v1.2.5 "$three" rollback v1.2.0
declined_patch v1.3.0
if declined_patch v1.2.6; then echo 'Held back a patch of the version running.' >&2; exit 1; fi
echo 'PASS: crossing a floor: notice, failure before and after migrating, earlier guards, skipped minors, killed runs; history replay.'
