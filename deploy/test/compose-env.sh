#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Renders deploy/compose.yaml (`docker compose config`) with and without each operator variable in .env, to
# show which ones reach the app container and with what default. Needs the Docker Compose plugin, not root.
set -eu
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
base="APP_IMAGE=example:v1.0.0
GYM_HOSTNAME=gym.example.org
ACME_EMAIL=owner@example.org
POSTGRES_PASSWORD=p
APP_PASSWORD=a
MAINTENANCE_PASSWORD=m
APP_ENCRYPTION_KEY=k
AUTH_SECRET=s
SETUP_TOKEN=t"
# The caller's own settings must not change a render: only the .env file given below is read.
# shellcheck disable=SC2016
# Compose prefers the shell's environment to --env-file, so drop every name the file interpolates, the
# operator variables below, and Compose's own settings.
for name in $(grep -Eo '\$\{[A-Z][A-Z0-9_]*' "$source_dir/compose.yaml" | tr -d '${') \
    AUTH_PASSWORD_LOGIN RATE_LIMIT_PER_MINUTE UPDATE_CHECK DATABASE_POOL_MAX PUBLIC_ORIGIN PACKS_DIR TENANCY BACKUP_RECIPIENT \
    UPLOADS_S3_BUCKET UPLOADS_S3_ENDPOINT UPLOADS_S3_REGION UPLOADS_S3_ACCESS_KEY_ID UPLOADS_S3_SECRET_ACCESS_KEY \
    COMPOSE_FILE COMPOSE_PROFILES COMPOSE_PROJECT_NAME COMPOSE_ENV_FILES; do
  unset "$name"
done

# render EXTRA_ENV_LINES: the app service's environment block, as `NAME: value` lines.
render() {
  printf '%s\n%s\n' "$base" "$1" > "$temporary/.env"
  docker compose --env-file "$temporary/.env" -f "$source_dir/compose.yaml" config > "$temporary/rendered"
  awk '/^  app:/ { app = 1; next } /^  [a-z]/ { app = 0 } app' "$temporary/rendered"
}
# expect NAME VALUE EXTRA: the app's NAME renders as VALUE (YAML shows scalars bare or quoted).
expect() {
  render "$3" | grep -Eq "^      $1: [\"']?$2[\"']?\$" || {
    echo "Expected $1 to render as $2 with: ${3:-nothing in .env}" >&2
    render "$3" | grep "^      $1:" >&2 || echo "($1 is not in the app's environment)" >&2
    exit 1
  }
}

# Each forwarded variable: its default when unset or empty, and the value from .env.
expect AUTH_PASSWORD_LOGIN auto ''
expect AUTH_PASSWORD_LOGIN auto 'AUTH_PASSWORD_LOGIN='
expect AUTH_PASSWORD_LOGIN on 'AUTH_PASSWORD_LOGIN=on'
expect AUTH_PASSWORD_LOGIN off 'AUTH_PASSWORD_LOGIN=off'
expect RATE_LIMIT_PER_MINUTE 300 ''
expect RATE_LIMIT_PER_MINUTE 300 'RATE_LIMIT_PER_MINUTE='
expect RATE_LIMIT_PER_MINUTE 1200 'RATE_LIMIT_PER_MINUTE=1200'
expect DATABASE_POOL_MAX 8 ''
expect DATABASE_POOL_MAX 8 'DATABASE_POOL_MAX='
expect DATABASE_POOL_MAX 12 'DATABASE_POOL_MAX=12'
expect UPDATE_CHECK on ""
expect UPDATE_CHECK on "UPDATE_CHECK="
expect UPDATE_CHECK off "UPDATE_CHECK=off"
# TENANCY stays single whatever .env says, and the variables the app reads an empty value of as a value
# are not passed at all.
expect TENANCY single 'TENANCY=multi'
for name in PUBLIC_ORIGIN PACKS_DIR UPLOADS_S3_BUCKET UPLOADS_S3_ENDPOINT UPLOADS_S3_REGION UPLOADS_S3_ACCESS_KEY_ID UPLOADS_S3_SECRET_ACCESS_KEY BACKUP_RECIPIENT; do
  if render "$name=https://example.org" | grep -q "^      $name:"; then
    echo "$name must not reach the app container" >&2
    exit 1
  fi
done
echo 'PASS: the forwarded operator variables render with their defaults and values; TENANCY stays single.'
