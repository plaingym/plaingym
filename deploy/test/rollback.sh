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
registry_name=''
oldest_id='' old_id='' new_id=''
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$temporary/output" ]; then cat "$temporary/output" >&2; fi
  if [ -f "$ROOT/.env" ]; then
    timeout 120 docker compose --project-directory "$ROOT" --env-file "$ROOT/.env" -f "$ROOT/compose.yaml" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi
  [ -z "$registry_name" ] || timeout -k 5 120 docker rm -f -v "$registry_name" >/dev/null 2>&1 || echo "WARNING: could not remove $registry_name" >&2
  # By ID, with every name this run gave them (its tags, and the test registry's).
  for built in "$oldest_id" "$old_id" "$new_id"; do
    [ -n "$built" ] || continue
    timeout -k 5 120 docker image rm -f "$built" >/dev/null 2>&1 || echo "WARNING: could not remove image $built for $run_id" >&2
  done
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
    restart: on-failure:20
    command: ['sh', '-c', '${APP_COMMAND:-exec timeout 300 nice -n 10 python -m http.server 3000 --bind 0.0.0.0}']
    ports:
      - '${TEST_LOOPBACK:-127.0.0.1}:0:3000'
    healthcheck:
      test: ['CMD', 'node', '/app/deploy/healthcheck.mjs']
      interval: 1s
      timeout: 2s
      retries: 20
COMPOSE
export TEST_LOOPBACK="${E2E_LOOPBACK:-127.0.0.1}"
# Recreate the current image with a failing command, leaving the normal command and pin unchanged.
crash_loop() {
  APP_COMMAND='exit 1' compose up -d --no-deps app > "$temporary/output" 2>&1
  container=$(compose ps -aq app)
  for _ in $(seq 20); do
    app_status=$(docker inspect "$container" --format '{{.State.Status}}')
    [ "$app_status" != restarting ] || break
    sleep 0.1
  done
  [ "$app_status" = restarting ]
}
printf 'COMPOSE_PROJECT_NAME=%s\nAPP_IMAGE=%s\n' "$run_id" "$run_id:new" > "$ROOT/.env"
history_record v1.1.0 "$oldest_id" install v1.1.0 -
history_record v1.2.0 "$old_id" update v1.1.0 00000000-0000-4000-8000-000000000003
history_record v1.3.0 "$new_id" update v1.1.0 00000000-0000-4000-8000-000000000001
write_schema_guard v1.1.0 v1.3.0 00000000-0000-4000-8000-000000000001
write_schema_guard v1.1.0 v1.3.1 00000000-0000-4000-8000-000000000009
grep -q 00000000-0000-4000-8000-000000000001 "$ROOT/schema-compatibility.yaml"
grep -qx 'COMPOSE_FILE=compose.yaml:schema-compatibility.yaml' "$ROOT/.env"
compose up -d --wait --wait-timeout 30 > "$temporary/output" 2>&1
# A stopped app can be rolled back; the snapshot runs independently of it.
compose stop app > "$temporary/output" 2>&1
sh "$ROOT/update.sh" --rollback > "$temporary/output" 2>&1
grep -q 'Rollback: updated' "$temporary/output"
[ "$(read_env APP_IMAGE)" = "$old_id" ]
port=$(compose port app 3000 | sed 's/.*://')
[ "$(curl --fail --silent "http://$TEST_LOOPBACK:$port/")" = 1.2.0 ]
tail -n 1 "$ROOT/version-history.tsv" | grep -q "$(printf '\trollback\t')"
# A second rollback keeps walking back, and never forward to the version just left; at the bottom there is nowhere to go.
crash_loop
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
for app_state in stopped restarting; do
  if [ "$app_state" = stopped ]; then compose stop app > "$temporary/output" 2>&1
  else crash_loop
  fi
  if sh "$ROOT/update.sh" --rollback > "$temporary/output" 2>&1; then echo "Accepted rollback below the floor with app $app_state." >&2; exit 1; fi
  grep -q 'Cannot roll back' "$temporary/output"
  [ "$before" = "$(cat "$ROOT/.env" "$ROOT/version-history.tsv" | sha256sum)" ]
done

# Images from a registry: --rollback pins NAME:TAG@DIGEST like an update, so after the image is removed (a prune, a
# disk cleanup) the app starts again by pulling it. A throwaway registry on the daemon's loopback, on this run's port.
compose down --volumes --remove-orphans > "$temporary/output" 2>&1
registry_name="$run_id-registry"
port=$((20000 + $$ % 20000))
registry="localhost:$port"
docker run -d --name "$registry_name" --network host -e "REGISTRY_HTTP_ADDR=127.0.0.1:$port" \
  registry:3@sha256:b3419cf99f8ec65bbda73e8a950fd26861012689beaf7b6577ee938995aa7d3f > /dev/null
for _ in $(seq 30); do curl --silent --fail "http://$registry/v2/" > /dev/null 2>&1 && break; sleep 1; done
curl --silent --fail "http://$registry/v2/" > /dev/null || { echo "The registry on $registry did not start." >&2; docker logs "$registry_name" >&2; exit 1; }
name="$registry/$run_id/app"
for tagged in old:v1.2.0 new:v1.3.0; do
  docker tag "$run_id:${tagged%%:*}" "$name:${tagged#*:}"
  docker push -q "$name:${tagged#*:}" > /dev/null
done
new_digest=$(docker image inspect "$new_id" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -F "$name@" | head -n 1)
old_digest=$(docker image inspect "$old_id" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -F "$name@" | head -n 1)
[ -n "$new_digest" ] && [ -n "$old_digest" ]
rm -f "$ROOT/version-history.tsv" "$ROOT/schema-compatibility.yaml"
printf 'COMPOSE_PROJECT_NAME=%s\nAPP_IMAGE=%s\n' "$run_id" "$name:v1.3.0@${new_digest#*@}" > "$ROOT/.env"
history_record v1.2.0 "$old_id" install v1.2.0 -
history_record v1.3.0 "$new_id" update v1.2.0 00000000-0000-4000-8000-000000000004
compose up -d --wait --wait-timeout 30 > "$temporary/output" 2>&1
printf '%s\t%s\tv1.2.0\n' "$name:v1.2.0@${old_digest#*@}" "$old_id" > "$ROOT/auto-update-images.tsv"
docker image rm -f "$old_id" > /dev/null
if docker image inspect "$old_id" > /dev/null 2>&1; then echo 'The previous image is still local.' >&2; exit 1; fi
sh "$ROOT/update.sh" --rollback > "$temporary/output" 2>&1
[ "$(read_env APP_IMAGE)" = "$name:v1.2.0@${old_digest#*@}" ]
# The image goes, every name of it included; the next start pulls it back by the pin and serves the same version.
compose down --volumes --remove-orphans > "$temporary/output" 2>&1
docker image rm -f "$old_id" > /dev/null
if docker image inspect "$old_id" > /dev/null 2>&1; then echo 'The rolled-back image is still on disk.' >&2; exit 1; fi
compose up -d --wait --wait-timeout 60 > "$temporary/output" 2>&1
port=$(compose port app 3000 | sed 's/.*://')
[ "$(curl --fail --silent "http://$TEST_LOOPBACK:$port/")" = 1.2.0 ]

echo 'PASS: rollback from stopped and restarting apps serves the previous digest, walks back, records history, still refuses below the floor, and pins a registry image by name, tag and digest so it starts again after a prune.'
