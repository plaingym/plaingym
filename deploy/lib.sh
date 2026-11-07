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
  if [ -f "$ROOT/schema-compatibility.yaml" ]; then
    docker compose --project-directory "$ROOT" --env-file "$ROOT/.env" -f "$ROOT/compose.yaml" -f "$ROOT/schema-compatibility.yaml" "$@"
    return
  fi
  docker compose --project-directory "$ROOT" --env-file "$ROOT/.env" -f "$ROOT/compose.yaml" "$@"
}
# A release version: vX.Y.Z without leading zeros or a suffix.
valid_version() {
  printf '%s\n' "$1" | grep -Eq '^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
}
version_at_least() { # VERSION FLOOR (release versions only)
  valid_version "$1" && valid_version "$2" || return 1
  awk -v version="${1#v}" -v floor="${2#v}" 'BEGIN { split(version, v, "."); split(floor, f, "."); for (i=1;i<=3;i++) { if (v[i]+0 > f[i]+0) exit 0; if (v[i]+0 < f[i]+0) exit 1 } exit 0 }'
}
default_rollback_floor() { # VERSION: previous minor, or itself at a major boundary
  base=${1#v}; base=${base%%+*}
  major=${base%%.*}; minor=${base#*.}; minor=${minor%%.*}
  if [ "$minor" -gt 0 ]; then printf 'v%s.%s.0\n' "$major" "$((minor - 1))"; else printf 'v%s.0.0\n' "$major"; fi
}
installed_version() {
  label=$(docker image inspect "$1" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null) || return 1
  if valid_version "v${label#v}"; then printf 'v%s\n' "${label#v}"; else printf '%s\n' "$label"; fi
}
# An append-only local record: UTC time, version, immutable image ID, outcome, rollback floor, snapshot ID.
history_record() { # VERSION IMAGE_ID OUTCOME FLOOR SNAPSHOT
  printf '%s\n' "$1" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+([+.-][A-Za-z0-9.+-]+)?$' || return 0
  printf '%s\n' "$2" | grep -Eq '^sha256:[a-f0-9]{64}$' || return 0
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "$3" "${4:--}" "$5" >> "$ROOT/version-history.tsv"
}
history_install() { # Called after a successful installation, and once for an existing install without history.
  [ ! -s "$ROOT/version-history.tsv" ] || return 0
  history_version=$(installed_version "$(read_env APP_IMAGE)") || return 0
  history_image_id=$(docker image inspect "$(read_env APP_IMAGE)" --format '{{.Id}}') || return 0
  history_floor=$history_version
  valid_version "$history_floor" || history_floor=-
  history_record "$history_version" "$history_image_id" install "$history_floor" -
}
schema_floor() { # The largest floor attempted, even if the newer image did not become healthy, unless the schema didn't change.
  [ -f "$ROOT/version-history.tsv" ] || return 0
  awk -F '\t' '
    function newer(a,b, x,y,i) { split(substr(a,2),x,".");split(substr(b,2),y,".");for(i=1;i<=3;i++){if(x[i]+0>y[i]+0)return 1;if(x[i]+0<y[i]+0)return 0}return 0 }
    function raise(value) { if (value ~ /^v[0-9]+\.[0-9]+\.[0-9]+$/ && (floor == "" || newer(value,floor))) floor=value }
    $4 == "abandoned" { pending=""; next }
    $4 == "failed" && pending != "" { next }
    { raise(pending); pending="" }
    $4 == "starting" { pending=$5; next }
    { raise($5) }
    END { raise(pending); print floor }' "$ROOT/version-history.tsv"
}
floor_snapshot() { # FLOOR: the snapshot from before the first attempt that kept this floor
  awk -F '\t' -v floor="$1" '
    $4 == "abandoned" { if ($6 == found) found=""; next }
    found == "" && $4 == "starting" && $5 == floor && $6 != "-" { found=$6 }
    END { print found }' "$ROOT/version-history.tsv"
}
# The history as a stack of installed versions: a rollback unstacks down to the version it went back to, so the next one
# walks further back. `left` holds the versions a rollback left, until one is installed again.
# shellcheck disable=SC2016
history_stack='
  $4 ~ /^(install|update)$/ { n++; line[n]=$0; image[n]=$3; version[n]=$2; delete left[$2]; next }
  $4 == "rollback" { for (i=n;i>0;i--) if (image[i]==$3) break; if (i>0) while (n>i) { left[version[n]]=1; n-- } }
'
previous_version() { # CURRENT_IMAGE_ID: the history row a rollback goes back to
  [ -f "$ROOT/version-history.tsv" ] || return 0
  awk -F '\t' -v current="$1" "$history_stack"'END { while (n>0 && image[n]==current) n--; if (n>0) print line[n] }' "$ROOT/version-history.tsv"
}
declined_patch() { # TAG: whether the owner rolled back from this release or a newer patch of its minor
  [ -f "$ROOT/version-history.tsv" ] || return 1
  declined_versions=$(awk -F '\t' "$history_stack"'END { for (name in left) print name }' "$ROOT/version-history.tsv")
  for declined in $declined_versions; do
    case "$declined" in "${1%.*}".*) if version_at_least "$declined" "$1"; then return 0; fi ;; esac
  done
  return 1
}
schema_state() { # The migrations the database has applied, or nothing when it can't be read.
  # shellcheck disable=SC2016
  compose exec -T postgres sh -c 'psql -X -U postgres -d "$POSTGRES_DB" -qtAc "select count(*), max(created_at) from drizzle.__drizzle_migrations"' 2>/dev/null || true
}
keep_schema_guard() { # Before write_schema_guard: what restore_schema_guard puts back.
  rm -f "$ROOT/schema-compatibility.yaml.before"
  if [ -f "$ROOT/schema-compatibility.yaml" ]; then cp -p "$ROOT/schema-compatibility.yaml" "$ROOT/schema-compatibility.yaml.before"; fi
}
restore_schema_guard() { # The guard as keep_schema_guard found it, or none, with Compose's list of files to match.
  if [ -f "$ROOT/schema-compatibility.yaml.before" ]; then
    mv "$ROOT/schema-compatibility.yaml.before" "$ROOT/schema-compatibility.yaml"
    return
  fi
  rm -f "$ROOT/schema-compatibility.yaml"
  composition=$(read_env COMPOSE_FILE)
  composition=${composition%:schema-compatibility.yaml}
  awk '!/^COMPOSE_FILE=/' "$ROOT/.env" > "$ROOT/.env.guard-next"
  if [ -n "$composition" ] && [ "$composition" != compose.yaml ]; then printf 'COMPOSE_FILE=%s\n' "$composition" >> "$ROOT/.env.guard-next"; fi
  mv "$ROOT/.env.guard-next" "$ROOT/.env"
}
write_schema_guard() { # FLOOR RELEASE SNAPSHOT; only verified values reach Compose, never shell source.
  if ! valid_version "$1" || ! valid_version "$2"; then fail 'Invalid schema compatibility state.'; fi
  printf '%s\n' "$3" | grep -Eq '^([a-f0-9-]{36}|-)$' || fail 'Invalid pre-upgrade snapshot identifier.'
  guard_floor=
  if [ -f "$ROOT/schema-compatibility.yaml" ]; then
    guard_floor=$(awk '$1 == "SCHEMA_ROLLBACK_FLOOR:" { gsub(/\047/, "", $2); print $2 }' "$ROOT/schema-compatibility.yaml")
  fi
  # Keep the snapshot from before this boundary, not a later patch's already-incompatible snapshot.
  if [ "$guard_floor" != "$1" ]; then
    printf "services:\n  app:\n    environment:\n      SCHEMA_ROLLBACK_FLOOR: '%s'\n      SCHEMA_RELEASE: '%s'\n      SCHEMA_SNAPSHOT: '%s'\n" "$1" "$2" "$3" > "$ROOT/schema-compatibility.yaml.next"
    mv "$ROOT/schema-compatibility.yaml.next" "$ROOT/schema-compatibility.yaml"
  fi
  # Ordinary `docker compose up` must retain the same guard as the updater's explicit -f arguments.
  composition=$(read_env COMPOSE_FILE)
  case ":$composition:" in
    *:schema-compatibility.yaml:*) ;;
    *)
      composition="${composition:-compose.yaml}:schema-compatibility.yaml"
      awk '!/^COMPOSE_FILE=/' "$ROOT/.env" > "$ROOT/.env.guard-next"
      printf 'COMPOSE_FILE=%s\n' "$composition" >> "$ROOT/.env.guard-next"
      mv "$ROOT/.env.guard-next" "$ROOT/.env" ;;
  esac
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
  awk '!/^[a-z0-9._\/]+=[!-~]+$/ { bad = 1 } { sub(/=.*/, ""); if (seen[$0]++) bad = 1 } END { exit bad }' "$1" || return 1
  case "$(manifest_value "$1" format)" in
    plaingym-release-manifest/1) ;;
    plaingym-release-manifest/2)
      floor=$(manifest_value "$1" rollback_floor)
      valid_version "$floor" || return 1
      manifest_base=${2%%+*}
      version_at_least "v${manifest_base#v}" "$floor" || return 1 ;;
    *) return 1 ;;
  esac
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
