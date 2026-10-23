#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
umask 077
SOURCE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
[ "$(id -u)" -eq 0 ] || { echo 'Run the local smoke as root.' >&2; exit 1; }
export PYTHONDONTWRITEBYTECODE=1
cd "$SOURCE"
python3 -m unittest -v test_config.py test_bootstrap.py test_snapshots.py
grep -qx 'export DEBIAN_FRONTEND=noninteractive' ../install.sh
# shellcheck disable=SC2016
grep -qx 'install -d -m 0700 "$ROOT"' ../install.sh
test_id=$(python3 -c 'import secrets; print(secrets.token_hex(5))')
export COMPOSE_PROJECT_NAME="plaingym-demo-test-$test_id"
export HTTP_PORT=127.0.0.1:0 HTTPS_PORT=127.0.0.1:0
export APP_IMAGE="${DEMO_TEST_APP_IMAGE:-plaingym:e2e}"
export CADDY_IMAGE="${DEMO_TEST_CADDY_IMAGE:-plaingym-caddy:v2.11.7-cf0.2.4}"
# Versioned aliases permit the same code to prove update/publication and rollback.
docker tag "$APP_IMAGE" "plaingym:v0.0.0-demo-$test_id"
export APP_IMAGE="plaingym:v0.0.0-demo-$test_id"
# Linux filesystem permissions must be real even when the checkout is on NTFS.
ROOT=$(mktemp -d "/tmp/$COMPOSE_PROJECT_NAME.XXXXXXXX")
s3_name="$COMPOSE_PROJECT_NAME-s3"
cleanup() {
  result=$?
  trap - EXIT HUP INT TERM
  if [ -f "$ROOT/.env" ]; then
    # shellcheck source=/dev/null
    . "$ROOT/lib.sh"
    compose logs --no-color > "$ROOT/containers.log" 2>&1 || true
    compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  docker rm -f "$s3_name" >/dev/null 2>&1 || true
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
docker run -d --name "$s3_name" --publish 127.0.0.1::5000 \
  motoserver/moto:5.1.4@sha256:32d7805d8bd4c81db789c4fff2c36f96a8837cbd8e7a3853116b6516b9490dde >/dev/null
s3_port=$(docker port "$s3_name" 5000 | head -n 1 | sed 's/.*://')
export GYM_HOSTNAME=demo.localhost ACME_EMAIL=test@example.invalid CLOUDFLARE_API_TOKEN=local-standin
export UPLOADS_S3_ENDPOINT="http://127.0.0.1:$s3_port" UPLOADS_S3_BUCKET=demo-test
export UPLOADS_S3_REGION=us-east-1 UPLOADS_S3_ACCESS_KEY_ID=local-test UPLOADS_S3_SECRET_ACCESS_KEY=local-secret
attempt=0
until curl --noproxy '*' --fail --silent "$UPLOADS_S3_ENDPOINT/" >/dev/null; do
  attempt=$((attempt + 1)); [ "$attempt" -lt 30 ] || exit 1; sleep 1
done
python3 - <<'PY'
# SPDX-License-Identifier: AGPL-3.0-only
import os
import config
config.s3_request(os.environ, "PUT", "")
PY
# Production Caddy must adapt with exactly the fixed base and wildcard subjects.
docker run --rm -e GYM_HOSTNAME -e ACME_EMAIL -e CLOUDFLARE_API_TOKEN \
  -v "$SOURCE/Caddyfile:/etc/caddy/Caddyfile:ro" "$CADDY_IMAGE" caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile > "$ROOT/caddy.json"
python3 - "$ROOT/caddy.json" <<'PY'
# SPDX-License-Identifier: AGPL-3.0-only
import json
import sys
data = json.load(open(sys.argv[1]))
policies = data["apps"]["tls"]["automation"]["policies"]
assert {subject for policy in policies for subject in policy.get("subjects", [])} == {"demo.localhost", "*.demo.localhost"}
assert all(not policy.get("on_demand") for policy in policies)
assert policies[0]["issuers"][0]["challenges"]["dns"]["provider"]["name"] == "cloudflare"
PY
sh "$SOURCE/install.sh" --local-test --directory "$ROOT"
# shellcheck source=/dev/null
. "$ROOT/lib.sh"
before=$(sha256sum "$ROOT/.env")
containers=$(compose ps -q | sort)
sh "$SOURCE/install.sh" --local-test --directory "$ROOT"
[ "$before" = "$(sha256sum "$ROOT/.env")" ]
[ "$containers" = "$(compose ps -q | sort)" ]
export DEMO_TEST_HTTPS_PORT
DEMO_TEST_HTTPS_PORT=$(compose port caddy 443 | head -n 1 | sed 's/.*://')
export DEMO_TEST_CA="$ROOT/ca.crt" DEMO_TEST_FIXTURE="$ROOT/sandbox.json"
compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$DEMO_TEST_CA" >/dev/null
python3 "$SOURCE/test-client.py"
# Refresh through a trusted HTTPS bundle, then prove the same sessions still work.
new_app="plaingym:v0.0.99-demo-$test_id"
new_caddy="plaingym-caddy:v2.11.7-refresh-$test_id"
docker tag "$APP_IMAGE" "$new_app"
docker tag "$CADDY_IMAGE" "$new_caddy"
python3 "$SOURCE/test-refresh.py" "$ROOT" "$new_app" "$new_caddy"
DEMO_TEST_HTTPS_PORT=$(compose port caddy 443 | head -n 1 | sed 's/.*://')
python3 "$SOURCE/test-client.py" preserved
# Seed older local copies to exercise default retention during a real update.
mkdir -m 0700 "$ROOT/snapshots"
python3 - "$ROOT/snapshots" <<'PY'
# SPDX-License-Identifier: AGPL-3.0-only
import os
from pathlib import Path
import sys
for index in range(5):
    path = Path(sys.argv[1]) / f"pre-update-old-{index}.dump"
    path.write_bytes(b"PGDMP")
    os.utime(path, (index + 1, index + 1))
PY
target="plaingym:v0.0.1-demo-$test_id"
docker tag "$APP_IMAGE" "$target"
bash "$ROOT/update.sh" "$target"
[ "$(read_env APP_IMAGE)" = "$target" ]
python3 - "$ROOT/snapshots" <<'PY'
# SPDX-License-Identifier: AGPL-3.0-only
from pathlib import Path
import sys
directory = Path(sys.argv[1])
snapshots = list(directory.glob("*.dump"))
assert len(snapshots) == 3
assert directory.stat().st_mode & 0o777 == 0o700
for path in snapshots:
    assert path.read_bytes().startswith(b"PGDMP")
    assert path.stat().st_mode & 0o777 == 0o600
PY
# A custom retention count applies after a second healthy update.
target="plaingym:v0.0.2-demo-$test_id"
docker tag "$APP_IMAGE" "$target"
DEMO_SNAPSHOT_RETENTION=2 bash "$ROOT/update.sh" "$target"
before_failure=$(find "$ROOT/snapshots" -name 'pre-update-*.dump' -type f | sort)
[ "$(printf '%s\n' "$before_failure" | wc -l)" -eq 2 ]
python3 "$SOURCE/test-client.py" preserved
# A versioned image that cannot start proves rollback to the previous ID and pin.
bad="plaingym:v0.0.3-demo-$test_id"
printf 'FROM %s\nENTRYPOINT ["/bin/false"]\n' "$target" | docker build -q -t "$bad" - >/dev/null
if bash "$ROOT/update.sh" "$bad" > "$ROOT/rollback.log" 2>&1; then echo 'Bad update unexpectedly passed.' >&2; exit 1; fi
[ "$(read_env APP_IMAGE)" = "$target" ]
for snapshot in $before_failure; do [ -f "$snapshot" ]; done
[ "$(find "$ROOT/snapshots" -name 'pre-update-*.dump' -type f | wc -l)" -eq 3 ]
compose exec -T app node /app/deploy/healthcheck.mjs
python3 "$SOURCE/test-client.py" preserved
printf 'PASS: install, unchanged rerun, verified deploy refresh, plaintext private snapshots, default/custom retention, preserved sandbox and failed-update rollback. Evidence: %s\n' "$ROOT"
