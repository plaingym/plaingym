#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
set -euo pipefail
umask 077
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=/dev/null
. "$ROOT/lib.sh"
[ "$(id -u)" -eq 0 ] || fail 'Run update.sh as root.'
[ "$#" -eq 1 ] || [ "$#" -eq 3 ] || fail 'Usage: update.sh IMAGE [--bundle /path/to/demo-bundle.tar]'
target=$1
valid_image "$target" || fail 'Use an explicit version or sha256 digest.'
keep=${DEMO_SNAPSHOT_RETENTION:-$(read_env DEMO_SNAPSHOT_RETENTION)}
keep=${keep:-3}
python3 - "$ROOT" "$keep" <<'PY'
# SPDX-License-Identifier: AGPL-3.0-only
import sys
sys.path.insert(0, sys.argv[1])
from snapshots import retention
retention(sys.argv[2])
PY
exec 9>"$ROOT/.install.lock"
flock -n 9 || fail 'Another demo install or update is running.'
current=$(read_env APP_IMAGE)
[ "$target" != "$current" ] || { demo_health; demo_link; exit 0; }
if [ "$#" -eq 3 ]; then
  [ "$2" = --bundle ] || fail 'Expected --bundle.'
  # Load only the app image. No script, config or key from the new bundle is executed.
  tar -xOf "$3" deploy/demo/images/app.tar | docker load >/dev/null
fi
docker image inspect "$target" >/dev/null 2>&1 || docker pull "$target" >/dev/null
previous=$(docker image inspect "$current" --format '{{.Id}}')
compose ps --status running --services | grep -qx app || fail 'The demo must be running before updating.'
changed=false
rollback() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ "$changed" = true ]; then
    printf 'Update failed; restarting the previous image.\n' >&2
    DEMO_TARGET_APP_IMAGE="$previous" compose up -d --no-deps --pull never --wait --wait-timeout 180 app || result=1
  fi
  exit "$result"
}
trap rollback EXIT
trap 'exit 130' HUP INT TERM
# Demo sandboxes expire after 24 h. Capture a private database dump before migrations;
# uploads are disabled, and demo backups must not depend on a gym's backup settings.
install -d -m 0700 "$ROOT/snapshots"
snapshot=$(mktemp "$ROOT/snapshots/pre-update-$(date -u +%Y%m%dT%H%M%SZ).XXXXXX.dump")
changed=true
compose stop app
# Variables expand inside the database container only.
# shellcheck disable=SC2016
compose exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h 127.0.0.1 -U postgres -Fc "$POSTGRES_DB"' > "$snapshot"
# The app never holds the maintenance role in multi-gym mode; the one-shot step migrates first.
DEMO_TARGET_APP_IMAGE="$target" compose run --rm --no-deps -T migrate
DEMO_TARGET_APP_IMAGE="$target" compose up -d --no-deps --pull never --wait --wait-timeout 180 app
demo_health
awk -v image="$target" '/^APP_IMAGE=/ { print "APP_IMAGE=" image; next } { print }' "$ROOT/.env" > "$ROOT/.env.next"
chmod 0600 "$ROOT/.env.next"
mv "$ROOT/.env.next" "$ROOT/.env"
changed=false
python3 "$ROOT/snapshots.py" --directory "$ROOT/snapshots" --keep "$keep"
printf 'Updated demo to %s. Pre-update snapshot: %s\n' "$target" "$snapshot"
demo_link
