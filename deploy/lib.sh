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
  dns_retry="If you recently added or changed the record, cached answers can remain until their TTL expires, which can take an hour or more; retry the installer after that. Nothing was changed."
  dns_status=0
  case "$1" in
    # RFC 6761 names resolve locally (test guests map them in /etc/hosts).
    *.localhost) resolved=$(getent ahosts "$1") || dns_status=$? ;;
    # Ask DNS directly: /etc/hosts may map the server's own name to 127.0.1.1.
    *) resolved=$(getent -s dns ahosts "$1") || dns_status=$? ;;
  esac
  resolved=$(printf '%s\n' "$resolved" | awk '{print $1}' | sort -u)
  if [ "$dns_status" -ne 0 ] || [ -z "$resolved" ]; then
    # getent returns 2 both for a missing record and for a resolver failure.
    # Probe the existing public-address service's name before suggesting a wait.
    if getent -s dns ahosts api.ipify.org >/dev/null 2>&1; then
      fail "$1 does not resolve yet. Check that its A record (and AAAA, if used) points at this server. $dns_retry"
    fi
    fail "This server could not query DNS for $1 or api.ipify.org. Check the server's DNS resolver and network connectivity, then retry the installer. Nothing was changed."
  fi
  own=$(ip -o address show | awk '{sub(/\/.*/, "", $4); print $4}')
  # Global unicast IPv6 uses 2000::/3; link-local and private addresses do not
  # establish that this server can have a public IPv6 address behind NAT.
  global6=$(printf '%s\n' "$own" | grep -E '^[23][[:xdigit:]]{3}:' || true)
  public4_failed=true
  public6_failed=true
  if command -v curl >/dev/null 2>&1; then
    # Covers providers that NAT the public address. Each family can fail separately.
    for url in https://api.ipify.org https://api6.ipify.org; do
      if public=$(curl --fail --silent --max-time 5 --proto '=https' "$url") && [ -n "$public" ]; then
        own="$own
$public"
        case "$url" in
          https://api.ipify.org) public4_failed=false ;;
          https://api6.ipify.org) public6_failed=false ;;
        esac
      fi
    done
  fi
  dns_mismatch=''
  dns_unconfirmed=''
  for address in $resolved; do
    case "$address" in
      127.*|::1) case "$1" in *.localhost) continue ;; esac
        fail "$1 resolves to a loopback address. Point it at this server's public IP. $dns_retry" ;;
    esac
    if ! printf '%s\n' "$own" | grep -qxF "$address"; then
      case "$address" in
        *:*)
          lookup_failed=$public6_failed
          if [ "$lookup_failed" = true ] && [ -z "$global6" ]; then
            dns_mismatch="$1 resolves to $address, but this server has no global IPv6 address. Remove the AAAA record or configure working public IPv6. $dns_retry"
            continue
          fi ;;
        *) lookup_failed=$public4_failed ;;
      esac
      if [ "$lookup_failed" = true ]; then
        dns_unconfirmed="$1 resolves to $address, which is not assigned to this server's network interfaces. The public-address lookup failed, so the installer could not confirm this server's public address. Check that curl is installed and outbound HTTPS works, then retry the installer. Nothing was changed."
      else
        dns_mismatch="$1 resolves to $address, which is not this server. Use a DNS-only record (no proxy) that points here. $dns_retry"
      fi
    fi
  done
  # Inspect every answer: an unconfirmed address must not hide a known mismatch.
  [ -z "$dns_mismatch" ] || fail "$dns_mismatch"
  [ -z "$dns_unconfirmed" ] || fail "$dns_unconfirmed"
}
