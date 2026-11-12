#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Stream host files into private app-owned staging; the maintenance helper removes them after success or failure.
set -eu
[ "$#" -eq 3 ] || { echo 'Usage: ./restore.sh SNAPSHOT_ID CONFIG_JSON KEY_FILE' >&2; exit 2; }
snapshot=$1
config=$2
key=$3
if [ ! -r "$config" ] || [ ! -r "$key" ]; then
  echo 'The config and key must be readable files.' >&2
  exit 1
fi
config=$(realpath "$config")
key=$(realpath "$key")
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"
{
  count=$(wc -c < "$config")
  printf '%s\n' "$count"
  cat "$config"
  cat "$key"
} | docker compose exec -T app node /app/maintenance.mjs restore-files "$snapshot"
