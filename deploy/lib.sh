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
# A release version: vX.Y.Z without leading zeros or a suffix.
valid_version() {
  printf '%s\n' "$1" | grep -Eq '^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
}
# Release manifests (release-manifest.txt, deploy/README.md "Releases") are `key=value` lines,
# signed with Ed25519 over the file's exact bytes (release-manifest.txt.sig, 64 raw bytes).
manifest_verify() { # PUBLIC_KEY MANIFEST SIGNATURE
  [ "$(wc -c < "$3")" -eq 64 ] || return 1
  openssl pkeyutl -verify -pubin -inkey "$1" -rawin -in "$2" -sigfile "$3" >/dev/null 2>&1
}
manifest_value() { # MANIFEST KEY: the value of the key's only line; nothing if it is missing or repeated
  awk -v key="$2" 'index($0, key "=") == 1 { n++; value = substr($0, length(key) + 2) } END { if (n == 1) print value }' "$1"
}
# A verified manifest for VERSION whose fields update.sh relies on are well formed.
manifest_check() { # MANIFEST VERSION
  [ "$(wc -c < "$1")" -le 4096 ] || return 1
  # Every line is key=value without spaces or carriage returns, and no key repeats.
  awk '!/^[a-z0-9.\/]+=[!-~]+$/ { bad = 1 } { sub(/=.*/, ""); if (seen[$0]++) bad = 1 } END { exit bad }' "$1" || return 1
  [ "$(manifest_value "$1" format)" = plaingym-release-manifest/1 ] || return 1
  [ "$(manifest_value "$1" version)" = "$2" ] || return 1
  manifest_value "$1" image | grep -Eq '^[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?(/[a-z0-9][a-z0-9._-]*)+$' || return 1
  manifest_value "$1" digest | grep -Eq '^sha256:[a-f0-9]{64}$' || return 1
  manifest_value "$1" revision | grep -Eq '^[a-f0-9]{40}$' || return 1
  manifest_value "$1" migrations | grep -Eq '^sha256:[a-f0-9]{64}$'
}
# The newest patch of VERSION's minor among TAGS (one per line), or nothing if VERSION is the newest.
newest_patch() { # VERSION TAGS
  printf '%s\n' "$2" | awk -v current="$1" '
    function part(v, n,   p) { split(substr(v, 2), p, "."); return p[n] + 0 }
    $0 ~ /^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/ && part($0, 1) == part(current, 1) && part($0, 2) == part(current, 2) {
      if (part($0, 3) > best) { best = part($0, 3); tag = $0 }
    }
    BEGIN { best = part(current, 3) }
    END { if (tag != "") print tag }'
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
  [ -n "$resolved" ] || fail "$1 does not resolve yet. Point its A record (and AAAA, if used) at this server. If you recently changed the record, it can take a few minutes to reach this server; re-run the same command to try again. Nothing was changed."
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
        fail "$1 resolves to a loopback address. Point it at this server's public IP. If you recently changed the record, it can take a few minutes to reach this server; re-run the same command to try again. Nothing was changed." ;;
    esac
    printf '%s\n' "$own" | grep -qxF "$address" \
      || fail "$1 resolves to $address, which is not this server. Use a DNS-only record (no proxy) that points here. If you recently changed the record, it can take a few minutes to reach this server; re-run the same command to try again. Nothing was changed."
  done
}
