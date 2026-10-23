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
# Every address the hostname resolves to must belong to this server, so the
# certificate and the private setup link work. Runs before any host change.
check_dns() {
  case "$1" in
    # RFC 6761 names resolve locally (test guests map them in /etc/hosts).
    *.localhost) resolved=$(getent ahosts "$1" | awk '{print $1}' | sort -u) ;;
    # Ask DNS directly: /etc/hosts may map the server's own name to 127.0.1.1.
    *) resolved=$(getent -s dns ahosts "$1" | awk '{print $1}' | sort -u) ;;
  esac
  [ -n "$resolved" ] || fail "$1 does not resolve yet. Point its A record (and AAAA, if used) at this server, then retry. Nothing was changed."
  own=$(ip -o address show | awk '{sub(/\/.*/, "", $4); print $4}')
  if command -v curl >/dev/null 2>&1; then
    # Covers providers that NAT the public address; failures are tolerated.
    for url in https://api.ipify.org https://api6.ipify.org; do
      own="$own
$(curl --fail --silent --max-time 5 --proto '=https' "$url" || true)"
    done
  fi
  for address in $resolved; do
    case "$address" in
      127.*|::1) case "$1" in *.localhost) continue ;; esac
        fail "$1 resolves to a loopback address. Point it at this server's public IP, then retry. Nothing was changed." ;;
    esac
    printf '%s\n' "$own" | grep -qxF "$address" \
      || fail "$1 resolves to $address, which is not this server. Use a DNS-only record (no proxy) that points here, then retry. Nothing was changed."
  done
}
