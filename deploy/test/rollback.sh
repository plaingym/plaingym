#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Real Docker image swaps through the host updater; the fixture implements only snapshot and liveness commands.
set -eu
umask 077
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
[ "$(id -u)" -eq 0 ] || { echo 'Run as root in a disposable environment.' >&2; exit 1; }
temporary=$(mktemp -d)
run_id="r118-rollback-$$-$(date +%s)"
ROOT="$temporary/install"
export ROOT
# shellcheck source=deploy/lib.sh
. "$source_dir/lib.sh"
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$temporary/output" ]; then cat "$temporary/output" >&2; fi
  if [ -f "$ROOT/.env" ]; then compose down --volumes --remove-orphans >/dev/null 2>&1 || true; fi
  docker image rm "$run_id:oldest" "$run_id:old" "$run_id:new" >/dev/null 2>&1 || true
  rm -rf -- "$temporary"
}
trap cleanup EXIT
mkdir -p "$ROOT" "$temporary/build"
cp "$source_dir/update.sh" "$source_dir/lib.sh" "$ROOT/"
cat > "$temporary/build/Dockerfile" <<'DOCKERFILE'
FROM python:3.14-alpine@sha256:f6a589d43c42b9e7f7dc67a12d37132491f362859a5d750607710cc56da3bc72
ARG VERSION
LABEL org.opencontainers.image.version=$VERSION
RUN mkdir -p /www && printf '%s\n' "$VERSION" > /www/index.html
COPY node /usr/local/bin/node
RUN chmod 755 /usr/local/bin/node
WORKDIR /www
CMD ["timeout", "300", "nice", "-n", "10", "python", "-m", "http.server", "3000", "--bind", "0.0.0.0"]
DOCKERFILE
cat > "$temporary/build/node" <<'COMMAND'
#!/bin/sh
set -eu
case "$1" in
  /app/maintenance.mjs) echo 'Snapshot: 00000000-0000-4000-8000-000000000001' ;;
  /app/deploy/healthcheck.mjs) wget -qO- http://127.0.0.1:3000/ >/dev/null ;;
  *) exit 1 ;;
esac
COMMAND
docker build -q --build-arg VERSION=1.1.0 -t "$run_id:oldest" "$temporary/build" >/dev/null
docker build -q --build-arg VERSION=1.2.0 -t "$run_id:old" "$temporary/build" >/dev/null
docker build -q --build-arg VERSION=1.3.0 -t "$run_id:new" "$temporary/build" >/dev/null
oldest_id=$(docker image inspect "$run_id:oldest" --format '{{.Id}}')
old_id=$(docker image inspect "$run_id:old" --format '{{.Id}}')
new_id=$(docker image inspect "$run_id:new" --format '{{.Id}}')
cat > "$ROOT/compose.yaml" <<'COMPOSE'
services:
  app:
    image: ${APP_IMAGE}
    cpus: 0.25
    ports:
      - '${TEST_LOOPBACK:-127.0.0.1}:0:3000'
    healthcheck:
      test: ['CMD', 'node', '/app/deploy/healthcheck.mjs']
      interval: 1s
      timeout: 2s
      retries: 20
COMPOSE
export TEST_LOOPBACK="${E2E_LOOPBACK:-127.0.0.1}"
printf 'COMPOSE_PROJECT_NAME=%s\nAPP_IMAGE=%s\n' "$run_id" "$run_id:new" > "$ROOT/.env"
history_record v1.1.0 "$oldest_id" install v1.1.0 -
history_record v1.2.0 "$old_id" update v1.1.0 00000000-0000-4000-8000-000000000003
history_record v1.3.0 "$new_id" update v1.1.0 00000000-0000-4000-8000-000000000001
write_schema_guard v1.1.0 v1.3.0 00000000-0000-4000-8000-000000000001
write_schema_guard v1.1.0 v1.3.1 00000000-0000-4000-8000-000000000009
grep -q 00000000-0000-4000-8000-000000000001 "$ROOT/schema-compatibility.yaml"
grep -qx 'COMPOSE_FILE=compose.yaml:schema-compatibility.yaml' "$ROOT/.env"
compose up -d --wait --wait-timeout 30 > "$temporary/output" 2>&1
sh "$ROOT/update.sh" --rollback > "$temporary/output" 2>&1
[ "$(read_env APP_IMAGE)" = "$old_id" ]
port=$(compose port app 3000 | sed 's/.*://')
[ "$(curl --fail --silent "http://$TEST_LOOPBACK:$port/")" = 1.2.0 ]
tail -n 1 "$ROOT/version-history.tsv" | grep -q "$(printf '\trollback\t')"
# A second rollback keeps walking back, and never forward to the version just left; at the bottom there is nowhere to go.
sh "$ROOT/update.sh" --rollback > "$temporary/output" 2>&1
[ "$(read_env APP_IMAGE)" = "$oldest_id" ]
port=$(compose port app 3000 | sed 's/.*://')
[ "$(curl --fail --silent "http://$TEST_LOOPBACK:$port/")" = 1.1.0 ]
if sh "$ROOT/update.sh" --rollback > "$temporary/output" 2>&1; then echo 'Rolled back with no version left.' >&2; exit 1; fi
grep -q 'no previous installed version' "$temporary/output"
[ "$(read_env APP_IMAGE)" = "$oldest_id" ]
# Simulate a later boundary already reached by this install; refusal must leave pin, history and serving image intact.
printf 'COMPOSE_PROJECT_NAME=%s\nAPP_IMAGE=%s\n' "$run_id" "$run_id:new" > "$ROOT/.env"
compose up -d --wait --wait-timeout 30 > "$temporary/output" 2>&1
history_record v1.3.0 "$new_id" starting v1.3.0 00000000-0000-4000-8000-000000000002
write_schema_guard v1.3.0 v1.3.0 00000000-0000-4000-8000-000000000002
before=$(cat "$ROOT/.env" "$ROOT/version-history.tsv" | sha256sum)
if sh "$ROOT/update.sh" --rollback > "$temporary/output" 2>&1; then echo 'Accepted rollback below the floor.' >&2; exit 1; fi
grep -q '00000000-0000-4000-8000-000000000002' "$temporary/output"
[ "$before" = "$(cat "$ROOT/.env" "$ROOT/version-history.tsv" | sha256sum)" ]
port=$(compose port app 3000 | sed 's/.*://')
[ "$(curl --fail --silent "http://$TEST_LOOPBACK:$port/")" = 1.3.0 ]
echo 'PASS: rollback serves the previous image by digest, walks back on a second run, records its snapshot and history, and refuses below the floor without changing the install.'
