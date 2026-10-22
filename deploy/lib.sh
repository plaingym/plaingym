#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Shared host-side helpers. Do not enable shell tracing: .env contains secrets.
fail() { printf '%s\n' "$*" >&2; exit 1; }
valid_image() {
  printf '%s\n' "$1" | grep -Eq '^([a-zA-Z0-9][a-zA-Z0-9._:/-]*)(:v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?|@sha256:[a-f0-9]{64})$'
}
read_env() {
  # The installer writes unquoted single-line values. Never source a config file.
  awk -v key="$1" 'index($0, key "=") == 1 { sub(/^[^=]*=/, ""); value=$0 } END { print value }' "$ROOT/.env"
}
compose() {
  docker compose --project-directory "$ROOT" --env-file "$ROOT/.env" -f "$ROOT/compose.yaml" "$@"
}
