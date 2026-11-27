#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Shared host-side helpers. Do not enable shell tracing: .env contains secrets.
plaingym_shared_helpers_loaded() { :; }
fail() { printf '%s\n' "$*" >&2; exit 1; }
valid_image() {
  printf '%s\n' "$1" | grep -Eq '^([a-zA-Z0-9][a-zA-Z0-9._:/-]*)(:v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.-]+)?|@sha256:[a-f0-9]{64})$'
}
read_env() { # KEY [FILE] [UNIQUE]; the last value wins unless UNIQUE is true.
  # The installer writes unquoted single-line values. Never source a config file.
  awk -v key="$1" -v single="${3:-false}" 'index($0, key "=") == 1 { n++; sub(/^[^=]*=/, ""); value=$0 } END { if (single != "true" || n == 1) print value }' "${2:-$ROOT/.env}"
}
# env_install NEXT KEY...: make NEXT the install's .env, but only when it keeps every other line of .env unchanged and
# in order, so a write cut short (a full disk) can never replace .env and lose its secrets. On any mismatch or error
# NEXT is removed and .env stays as it was. Prints nothing.
env_install() {
  env_next=$1; shift
  env_keys=$(printf '%s|' "$@")
  env_keys="^(${env_keys%|})="
  # A failed read adds a different marker to each side, so two failures never match.
  if [ -s "$env_next" ] \
    && env_kept=$({ awk -v keys="$env_keys" '$0 !~ keys' "$ROOT/.env" || echo 'unreadable .env'; } | sha256sum) \
    && env_next_kept=$({ awk -v keys="$env_keys" '$0 !~ keys' "$env_next" || echo 'unreadable next .env'; } | sha256sum) \
    && [ "$env_kept" = "$env_next_kept" ] \
    && chmod 0600 "$env_next" \
    && mv "$env_next" "$ROOT/.env"; then
    return 0
  fi
  rm -f "$env_next"
  return 1
}
image_name_pattern='^[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?(/[a-z0-9][a-z0-9._-]*)+$'
version_pattern='^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$'
valid_image_name() { printf '%s\n' "$1" | grep -Eq "$image_name_pattern"; }
# The only PostgreSQL and Caddy images a release may name: major 18 on the default variant, and Caddy 2 on Alpine,
# each by digest (docs/update-reference.md, "PostgreSQL and Caddy images").
postgres_image_pattern='^postgres:18(\.[0-9]{1,3})?@sha256:[a-f0-9]{64}$'
caddy_image_pattern='^caddy:2\.[0-9]{1,3}\.[0-9]{1,3}-alpine@sha256:[a-f0-9]{64}$'
compose_image() { # FILE SERVICE: the first image: value in SERVICE's block under services:, or nothing
  # Written for compose.yaml's own layout: two-space service names and four-space keys.
  awk -v service="$2" '
    /^[^ #]/ { services = ($0 ~ /^services:[[:space:]]*$/); inside = 0; next }
    services && /^  [^ #]/ { inside = ($0 ~ ("^  " service ":[[:space:]]*$")); next }
    inside && /^    image:/ {
      value = $0; sub(/^    image:[[:space:]]*/, "", value); sub(/[[:space:]]+$/, "", value)
      if (value ~ /^\047.*\047$/ || value ~ /^".*"$/) value = substr(value, 2, length(value) - 2)
      print value; exit
    }' "$1"
}
infrastructure_file() { # SERVICE...: the text of infrastructure-images.yaml for these services (postgres, caddy)
  # Each service defaults to the image compose.yaml names, so the file changes nothing until .env names another.
  printf '%s\n' "# Written by update.sh; don't edit. PostgreSQL and Caddy run the images .env names (POSTGRES_IMAGE, CADDY_IMAGE)." 'services:'
  for infrastructure_service do
    case "$infrastructure_service" in
      postgres) infrastructure_variable=POSTGRES_IMAGE ;;
      caddy) infrastructure_variable=CADDY_IMAGE ;;
      *) return 1 ;;
    esac
    printf "  %s:\n    image: '\${%s:-%s}'\n" "$infrastructure_service" "$infrastructure_variable" \
      "$(compose_image "$ROOT/compose.yaml" "$infrastructure_service")" || return 1
  done
}
valid_repository() {
  printf '%s\n' "$1" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || return 1
  # Dot-only path segments normalize outside the requested repository.
  ! printf '%s\n' "$1" | grep -Eq '(^|/)\.+(/|$)'
}
compose() (
  # The exec replaces only this subshell, so the calling script can continue.
  compose_exec "$@"
)
# The install's own Compose files that exist, one per line in their COMPOSE_FILE order: the entries other than
# compose.yaml and the two files update.sh manages, or, with no COMPOSE_FILE value, the override file Compose loads by
# default (compose.override.yml when both exist). Unlike `docker compose`, a listed file that is gone is left out, so a
# stale entry can't stop an update or its rollback. OWN_COMPOSE_FILES=off lists none: a rollback's last try.
owner_compose_files() {
  [ "${OWN_COMPOSE_FILES:-on}" != off ] || return 0
  owner_listed=$(read_env COMPOSE_FILE)
  if [ -z "$owner_listed" ]; then
    if [ -e "$ROOT/compose.override.yml" ]; then printf '%s\n' "$ROOT/compose.override.yml"
    elif [ -e "$ROOT/compose.override.yaml" ]; then printf '%s\n' "$ROOT/compose.override.yaml"; fi
    return 0
  fi
  printf '%s\n' "$owner_listed" | awk -F: -v root="$ROOT" '{
    for (i = 1; i <= NF; i++) {
      path = $i; sub(/^\.\//, "", path)
      if (path == "") continue
      if (path !~ /^\//) path = root "/" path
      if (path == root "/compose.yaml" || path == root "/schema-compatibility.yaml" || path == root "/infrastructure-images.yaml") continue
      print path
    } }' | while IFS= read -r owner_path; do [ ! -e "$owner_path" ] || printf '%s\n' "$owner_path"; done
}
compose_exec() {
  # Files listed later win: compose.yaml, the install's own files, then the schema guard, then the images update.sh
  # manages. Loading the owner's files keeps their settings (a mount, a limit) through every update and rollback.
  if [ -f "$ROOT/infrastructure-images.yaml" ]; then set -- -f "$ROOT/infrastructure-images.yaml" "$@"; fi
  if [ -f "$ROOT/schema-compatibility.yaml" ]; then
    set -- -f "$ROOT/schema-compatibility.yaml" "$@"
  fi
  # Prepended last first, so they keep their order. This runs just before exec, so IFS and noglob need no restoring.
  owner_files=$(owner_compose_files | awk '{ line[NR] = $0 } END { for (i = NR; i > 0; i--) print line[i] }')
  IFS='
'
  set -f
  for owner_file in $owner_files; do set -- -f "$owner_file" "$@"; done
  exec docker compose --project-directory "$ROOT" --env-file "$ROOT/.env" -f "$ROOT/compose.yaml" "$@"
}
# A release version: vX.Y.Z without leading zeros or a suffix.
valid_version() {
  printf '%s\n' "$1" | grep -Eq "$version_pattern"
}
version_at_least() { # VERSION FLOOR (release versions only)
  valid_version "$1" && valid_version "$2" || return 1
  awk -v version="${1#v}" -v floor="${2#v}" 'BEGIN { split(version, v, "."); split(floor, f, "."); for (i=1;i<=3;i++) { if (v[i]+0 > f[i]+0) exit 0; if (v[i]+0 < f[i]+0) exit 1 } exit 0 }'
}
default_rollback_floor() { # Legacy format-1 manifests only; publishers must supply an explicit floor.
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
guard_floor_snapshot() { # [FLOOR]: the active guard's restore point, optionally restricted to a floor
  if [ -f "$ROOT/schema-compatibility.yaml" ]; then
    guard_snapshot=$(awk -v floor="${1:-}" '
      $1 == "SCHEMA_ROLLBACK_FLOOR:" { gsub(/\047/, "", $2); matches=($2 != "" && (floor == "" || $2 == floor)) }
      $1 == "SCHEMA_SNAPSHOT:" && matches { gsub(/\047/, "", $2); print $2 }' "$ROOT/schema-compatibility.yaml")
    if [ -n "$guard_snapshot" ] && [ "$guard_snapshot" != - ]; then printf '%s\n' "$guard_snapshot"; fi
  fi
}
floor_snapshot() { # FLOOR: the snapshot from before the first attempt that kept this floor
  # A recovery may raise the floor again. Its guard keeps the original restore point after recovery succeeds,
  # while each history row still records the snapshot taken immediately before that particular attempt.
  guard_snapshot=$(guard_floor_snapshot "$1")
  if [ -n "$guard_snapshot" ]; then printf '%s\n' "$guard_snapshot"; return; fi
  awk -F '\t' -v floor="$1" '
    $4 == "abandoned" { if ($6 == found) found=""; next }
    found == "" && $4 == "starting" && $5 == floor && $6 != "-" { found=$6 }
    END { print found }' "$ROOT/version-history.tsv"
}
# The history as a stack of installed versions: a rollback unstacks down to the version it went back to, so the next one
# walks further back. `left` holds the versions a rollback left, until one is installed again. A `trimmed` row takes an
# old entry off the stack once its image is no longer kept (update.sh, prune_images).
# shellcheck disable=SC2016
history_stack='
  $4 ~ /^(install|update)$/ { n++; line[n]=$0; image[n]=$3; version[n]=$2; delete left[$2]; next }
  $4 == "rollback" { for (i=n;i>0;i--) if (image[i]==$3) break; if (i>0) while (n>i) { left[version[n]]=1; n-- } }
  $4 == "trimmed" { k=0; for (i=1;i<=n;i++) if (image[i]!=$3) { k++; line[k]=line[i]; image[k]=image[i]; version[k]=version[i] } n=k }
'
# How many stack entries keep their images after a patch update: the current image and the two before it.
# shellcheck disable=SC2034
rollback_depth=3
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
  listed=$(read_env COMPOSE_FILE)
  # The guard leaves the list wherever it is in it; every other entry stays, in order.
  composition=$(printf '%s\n' "$listed" | awk -F: '{ for (i = 1; i <= NF; i++) if ($i != "schema-compatibility.yaml") { out = out sep $i; sep = ":" } } END { print out }') || return 1
  # .env never got the guard (its rewrite failed, as on a full disk): only the guard file goes, .env stays as it is.
  if [ "$composition" = "$listed" ]; then
    rm -f "$ROOT/schema-compatibility.yaml"
    return
  fi
  # This runs during a rollback, where set -e is off: check every step, and keep the guard until .env is rewritten.
  awk '!/^COMPOSE_FILE=/' "$ROOT/.env" > "$ROOT/.env.guard-next" || { rm -f "$ROOT/.env.guard-next"; return 1; }
  if [ -n "$composition" ] && [ "$composition" != compose.yaml ]; then
    printf 'COMPOSE_FILE=%s\n' "$composition" >> "$ROOT/.env.guard-next" || { rm -f "$ROOT/.env.guard-next"; return 1; }
  fi
  env_install "$ROOT/.env.guard-next" COMPOSE_FILE || return 1
  rm -f "$ROOT/schema-compatibility.yaml"
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
      # Compose loads an override file by default only while COMPOSE_FILE is unset, so the first list names it.
      # With both present, Compose loads only compose.override.yml.
      if [ -z "$composition" ]; then
        composition=compose.yaml
        if [ -e "$ROOT/compose.override.yml" ]; then composition="$composition:compose.override.yml"
        elif [ -e "$ROOT/compose.override.yaml" ]; then composition="$composition:compose.override.yaml"; fi
      fi
      composition="$composition:schema-compatibility.yaml"
      { awk '!/^COMPOSE_FILE=/' "$ROOT/.env" > "$ROOT/.env.guard-next" \
        && printf 'COMPOSE_FILE=%s\n' "$composition" >> "$ROOT/.env.guard-next" \
        && env_install "$ROOT/.env.guard-next" COMPOSE_FILE; } \
        || { rm -f "$ROOT/.env.guard-next"; fail 'Could not rewrite .env. Nothing was changed.'; } ;;
  esac
}
# Release manifests (release-manifest.txt, deploy/README.md "Releases") are `key=value` lines,
# signed with Ed25519 over the file's exact bytes (release-manifest.txt.sig, 64 raw bytes).
manifest_verify() { # PUBLIC_KEY MANIFEST SIGNATURE
  [ "$(wc -c < "$3")" -eq 64 ] || return 1
  openssl pkeyutl -verify -pubin -inkey "$1" -rawin -in "$2" -sigfile "$3" >/dev/null 2>&1
}
# Bounded HTTPS downloads shared by the self-hosted and demo release updaters.
download() { # URL FILE [MAX_BYTES]
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 60 \
    --max-filesize "${3:-65536}" -H 'User-Agent: plaingym-update' "$1" -o "$2"
}
manifest_value() { # MANIFEST KEY; missing or repeated keys have no value.
  read_env "$2" "$1" true
}
# A verified manifest for VERSION whose fields update.sh relies on are well formed.
manifest_check() { # MANIFEST VERSION
  [ "$(wc -c < "$1")" -le 4096 ] || return 1
  # Every line is key=value without spaces or carriage returns, and no key repeats.
  awk '!/^[a-z0-9._\/-]+=[!-~]+$/ { bad = 1 } { sub(/=.*/, ""); if (seen[$0]++) bad = 1 } END { exit bad }' "$1" || return 1
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
  valid_image_name "$(manifest_value "$1" image)" || return 1
  manifest_value "$1" digest | grep -Eq '^sha256:[a-f0-9]{64}$' || return 1
  manifest_value "$1" revision | grep -Eq '^[a-f0-9]{40}$' || return 1
  manifest_value "$1" migrations | grep -Eq '^sha256:[a-f0-9]{64}$' || return 1
  # The PostgreSQL and Caddy images of the release's compose.yaml: both or neither (releases before they were listed).
  if grep -Eq '^(postgres|caddy)_image=' "$1"; then
    manifest_value "$1" postgres_image | grep -Eq "$postgres_image_pattern" || return 1
    manifest_value "$1" caddy_image | grep -Eq "$caddy_image_pattern" || return 1
  fi
  if [ -n "$(manifest_value "$1" host_format)" ]; then
    [ "$(manifest_value "$1" host_format)" = 1 ] || return 1
    [ "$(manifest_value "$1" deploy_archive)" = "plaingym-deploy-$2.tar.gz" ] || return 1
    manifest_value "$1" deploy_archive_sha256 | grep -Eq '^sha256:[a-f0-9]{64}$' || return 1
    for host_file in $host_files; do
      manifest_value "$1" "host.$(printf '%s' "$host_file" | tr '[:upper:]' '[:lower:]')" | grep -Eq '^sha256:[a-f0-9]{64}$' || return 1
    done
  elif grep -q '^host\.' "$1"; then return 1; fi
}
# Only these release-owned files may be installed. Configuration, secrets, state and local overrides stay outside it.
host_files='update.sh lib.sh rotate-key.sh restore.sh release-signing.pem systemd/plaingym-update.service systemd/plaingym-update.timer'
host_units='plaingym-update.service plaingym-update.timer'
host_units_dir() { printf '%s\n' "${SYSTEMD_UNIT_DIR:-/etc/systemd/system}"; }
host_mode() { case "$1" in update.sh|rotate-key.sh|restore.sh|auto-update.sh|deploy-files.py|snapshots.py) echo 0700 ;; *) echo 0644 ;; esac; }
# Prepare only data from the already verified manifest; no script from the archive is sourced or executed.
# Returns 2 when the archive can't be downloaded, and 1 when it or a file fails a check.
host_download() { # MANIFEST BASE_URL WORK [TRUSTED_PUBLIC_KEY]
  [ -n "$(manifest_value "$1" host_format)" ] || return 0 # Releases predating host updates.
  download "$2/$(manifest_value "$1" deploy_archive)" "$3/host.tar.gz" 52428800 || return 2
  printf '%s  %s\n' "$(manifest_value "$1" deploy_archive_sha256 | sed 's/^sha256://')" "$3/host.tar.gz" | sha256sum -c - >/dev/null 2>&1 || return 1
  mkdir "$3/host" || return 1
  # Expand only the fixed allowlist, and decompress the archive once.
  host_manifest=$1; host_base=$2; host_archive=$3; host_public=${4:-$ROOT/release-signing.pem}
  set --
  for host_file in $host_files; do set -- "$@" "deploy/$host_file"; done
  tar -xzf "$host_archive/host.tar.gz" -C "$host_archive/host" --no-same-owner -- "$@" || return 1
  set -- "$host_manifest" "$host_base" "$host_archive"
  for host_file in $host_files; do
    host_path="$3/host/deploy/$host_file"
    [ -f "$host_path" ] && [ ! -L "$host_path" ] || return 1
    host_hash=$(manifest_value "$1" "host.$(printf '%s' "$host_file" | tr '[:upper:]' '[:lower:]')")
    [ "sha256:$(sha256sum "$host_path" | cut -d' ' -f1)" = "$host_hash" ] || return 1
  done
  # Trust never transfers just because an archive names another key. Rotation is a separate, explicit host step.
  openssl pkey -pubin -in "$host_public" -outform DER -out "$3/trusted.der" || return 1
  openssl pkey -pubin -in "$3/host/deploy/release-signing.pem" -outform DER -out "$3/release.der" || return 1
  cmp -s "$3/trusted.der" "$3/release.der" || return 1
  # update.sh uses this prepared directory only after host_download succeeds.
  # shellcheck disable=SC2034
  host_source="$3/host/deploy"
}
host_capture() { # DESTINATION [FILES UNITS]: keep originals, including their absence.
  host_capture_files=${2-$host_files}; host_capture_units=${3-$host_units}
  mkdir -p "$1/files" "$1/units" || return 1
  for host_file in $host_capture_files; do
    if [ -e "$ROOT/$host_file" ]; then
      mkdir -p "$1/files/$(dirname "$host_file")" || return 1
      cp -p "$ROOT/$host_file" "$1/files/$host_file" || return 1
    fi
  done
  for host_unit in $host_capture_units; do
    [ ! -e "$(host_units_dir)/$host_unit" ] || cp -p "$(host_units_dir)/$host_unit" "$1/units/$host_unit" || return 1
  done
}
host_replace() { # SOURCE DEST MODE: rename within the destination filesystem; running shells retain the old inode.
  mkdir -p "$(dirname "$2")" || return 1
  install -m "$3" "$1" "$2.host-next" || return 1
  mv -f "$2.host-next" "$2"
}
host_restore() { # SNAPSHOT [FILES UNITS]: repeatable after an interrupted restoration.
  host_restore_files=${2-$host_files}; host_restore_units=${3-$host_units}
  for host_file in $host_restore_files; do
    # An explicit trust-key change made since a snapshot must never be undone by an image rollback.
    [ "$host_file" != release-signing.pem ] || continue
    if [ -f "$1/files/$host_file" ]; then
      host_replace "$1/files/$host_file" "$ROOT/$host_file" "$(host_mode "$host_file")" || return 1
    else rm -f "$ROOT/$host_file" || return 1; fi
  done
  for host_unit in $host_restore_units; do
    if [ -f "$1/units/$host_unit" ]; then
      host_replace "$1/units/$host_unit" "$(host_units_dir)/$host_unit" 0644 || return 1
    else rm -f "$(host_units_dir)/$host_unit" || return 1; fi
  done
  sync -f "$ROOT" "$(host_units_dir)" || return 1
  # The restored files stay in place even when systemd is unavailable; the journal retries the reload.
  systemctl daemon-reload
}
host_recover() { # [FILES UNITS]; the pin commits the transaction.
  host_recover_files=${1-$host_files}; host_recover_units=${2-$host_units}
  host_prefix=${HOST_JOURNAL_PREFIX:-.host}
  # These directories are never authoritative once their rename has completed (or before it starts).
  for host_leftover in "$ROOT/$host_prefix"-prepare.* "$ROOT/$host_prefix"-retired.* "$ROOT/$host_prefix"-history/*.next; do
    [ ! -d "$host_leftover" ] || rm -rf -- "$host_leftover" || return 1
  done
  [ -d "$ROOT/$host_prefix-update" ] || return 0
  [ -s "$ROOT/$host_prefix-update/target" ] && [ -d "$ROOT/$host_prefix-update/before/files" ] || return 1
  if [ "$(read_env APP_IMAGE)" != "$(cat "$ROOT/$host_prefix-update/target")" ]; then
    echo 'Restoring host files from the unfinished update.' >&2
    host_restore "$ROOT/$host_prefix-update/before" "$host_recover_files" "$host_recover_units" || return 1
  fi
  # Persist the pin (or restoration) before retiring the journal. A kill during recursive deletion must not
  # leave a half-deleted directory that the next invocation could mistake for a complete recovery snapshot.
  sync -f "$ROOT" "$(host_units_dir)" || return 1
  host_retired=$(mktemp -d "$ROOT/$host_prefix-retired.XXXXXX") || return 1
  mv "$ROOT/$host_prefix-update" "$host_retired/transaction" || return 1
  sync -f "$ROOT" || return 1
  rm -rf -- "$host_retired"
}
host_install_units() { # SOURCE JOURNAL [UNITS]; demo supplies its systemd quoting renderer.
  for host_unit in ${3-$host_units}; do
    sed "s#@ROOT@#$ROOT#g" "$1/systemd/$host_unit" > "$2/$host_unit" || return 1
    host_replace "$2/$host_unit" "$(host_units_dir)/$host_unit" 0644 || return 1
  done
  systemctl daemon-reload
}
host_apply() { # SOURCE TARGET_PIN PREVIOUS_IMAGE_ID [FILES UNITS]; empty ID skips history.
  host_apply_files=${4-$host_files}; host_apply_units=${5-$host_units}
  host_prefix=${HOST_JOURNAL_PREFIX:-.host}
  host_journal=$(mktemp -d "$ROOT/$host_prefix-prepare.XXXXXX") || return 1
  if ! host_capture "$host_journal/before" "$host_apply_files" "$host_apply_units" || ! printf '%s\n' "$2" > "$host_journal/target"; then
    rm -rf -- "$host_journal"; return 1
  fi
  # Keep the journal implementation that wrote this transaction, even if the refresh replaces lib.sh.
  if [ -n "${HOST_JOURNAL_HELPER:-}" ]; then
    cp "$HOST_JOURNAL_HELPER" "$host_journal/helper.sh" || { rm -rf -- "$host_journal"; return 1; }
  fi
  # Preserve the first copy for this image; a later rollback must not rewrite its original host generation.
  if [ -n "$3" ] && [ ! -d "$ROOT/$host_prefix-history/${3#sha256:}" ]; then
    if ! mkdir -p "$ROOT/$host_prefix-history" ||
      ! rm -rf -- "$ROOT/$host_prefix-history/${3#sha256:}.next" ||
      ! cp -Rp "$host_journal/before" "$ROOT/$host_prefix-history/${3#sha256:}.next" ||
      ! mv "$ROOT/$host_prefix-history/${3#sha256:}.next" "$ROOT/$host_prefix-history/${3#sha256:}"; then
      rm -rf -- "$host_journal" "$ROOT/$host_prefix-history/${3#sha256:}.next"; return 1
    fi
  fi
  mv "$host_journal" "$ROOT/$host_prefix-update" || { rm -rf -- "$host_journal"; return 1; }
  sync -f "$ROOT" || return 1
  if [ -d "$1/files" ]; then
    host_restore "$1" "$host_apply_files" "$host_apply_units" || return 1
  else
    for host_file in $host_apply_files; do
      host_replace "$1/$host_file" "$ROOT/$host_file" "$(host_mode "$host_file")" || return 1
    done
    host_install_units "$1" "$ROOT/$host_prefix-update" "$host_apply_units" || return 1
    sync -f "$ROOT" "$(host_units_dir)" || return 1
  fi
}
valid_timezone() { printf '%s\n' "$1" | grep -Eq '^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$' && [ -f "/usr/share/zoneinfo/$1" ]; }
# in_window ZONE [START]: the hour in ZONE is within the three hours from START (0 to 21; default 2), which ends by midnight.
in_window() {
  window_from=${2:-2}; hour=$(TZ="$1" date +%H); hour=${hour#0}
  [ "$hour" -ge "$window_from" ] && [ "$hour" -lt $((window_from + 3)) ]
}
# The newest patch of VERSION's minor among TAGS (one per line), or nothing if VERSION is the newest.
newest_patch() { # VERSION TAGS
  printf '%s\n' "$2" | grep -E "$version_pattern" | awk -v current="$1" '
    function part(v, n,   p) { split(substr(v, 2), p, "."); return p[n] + 0 }
    part($0, 1) == part(current, 1) && part($0, 2) == part(current, 2) {
      if (part($0, 3) > best) { best = part($0, 3); tag = $0 }
    }
    BEGIN { best = part(current, 3) }
    END { if (tag != "") print tag }'
}
# Whether an IPv4 or IPv6 address is inside one of the ranges in a list such as
# cloudflare-ranges.txt (one CIDR per line, # comments). Written for mawk: no hex helpers.
in_cloudflare_ranges() {
  awk -v address="$1" '
    function hex(text,   i, digit, value) {
      value = 0; text = tolower(text)
      if (text == "" || length(text) > 4) invalid = 1
      for (i = 1; i <= length(text); i++) {
        digit = index("0123456789abcdef", substr(text, i, 1)) - 1
        if (digit < 0) invalid = 1
        value = value * 16 + digit
      }
      return value
    }
    function expand6(text, out,   n, halves, left, right, a, b, i, k) {
      n = split(text, halves, "::"); if (n > 2) return 0
      a = halves[1] == "" ? 0 : split(halves[1], left, ":")
      b = (n == 2 && halves[2] != "") ? split(halves[2], right, ":") : 0
      if ((n == 1 && a != 8) || (n == 2 && a + b > 7)) return 0
      k = 0
      for (i = 1; i <= a; i++) out[++k] = hex(left[i])
      for (i = 0; i < 8 - a - b; i++) out[++k] = 0
      for (i = 1; i <= b; i++) out[++k] = hex(right[i])
      return 1
    }
    function expand4(text, out,   parts, i) {
      if (split(text, parts, ".") != 4) return 0
      for (i = 1; i <= 4; i++) {
        if (parts[i] !~ /^[0-9]+$/ || parts[i] + 0 > 255) return 0
        out[i] = parts[i] + 0
      }
      return 1
    }
    # Compare the first `prefix` bits of two addresses held as units of `width` bits.
    function within(a, b, width, prefix,   i, full, rest, scale) {
      full = int(prefix / width); rest = prefix % width
      for (i = 1; i <= full; i++) if (a[i] != b[i]) return 0
      if (rest == 0) return 1
      scale = 2 ^ (width - rest)
      return int(a[full + 1] / scale) == int(b[full + 1] / scale)
    }
    # Anything that is not a plain address (an embedded IPv4 in IPv6, stray characters) matches no range.
    BEGIN { family = index(address, ":") ? 6 : 4; invalid = 0; if (!(family == 6 ? expand6(address, mine) : expand4(address, mine)) || invalid) exit 1 }
    /^[[:space:]]*(#|$)/ { next }
    {
      split($1, range, "/"); if ((index(range[1], ":") ? 6 : 4) != family) next
      delete network
      if (!(family == 6 ? expand6(range[1], network) : expand4(range[1], network))) next
      if (within(mine, network, family == 6 ? 16 : 8, range[2] + 0)) { found = 1; exit }
    }
    END { exit found ? 0 : 1 }' "$2"
}
# Every address the hostname resolves to must belong to this server, so the
# certificate and the private setup link work. Runs before any host change.
# Addresses in CLOUDFLARE_RANGES (when set) are Cloudflare's proxy in front of this
# server: they pass, and dns_proxied=true tells the installer to trust the proxy. The
# installer then proves the name reaches this server through it before printing the
# setup link (install.sh, the origin check).
valid_public_address() { # ADDRESS FAMILY: canonical public unicast, without trusting a proxy's response body.
  python3 -c '
import ipaddress, sys
try:
    text, family = sys.argv[1], int(sys.argv[2])
    address = ipaddress.ip_address(text)
    if address.version != family or str(address) != text or "%" in text:
        sys.exit(1)
    # Python before 3.13 labels most of this special-purpose /24 global; retain only its public anycast pair.
    if family == 4 and address in ipaddress.ip_network("192.0.0.0/24") and text not in ("192.0.0.9", "192.0.0.10"):
        sys.exit(1)
    # is_global also passes IPv6 outside global unicast (fec0::/10, 64:ff9b::/96), which check_dns never treats as public.
    if family == 6 and address not in ipaddress.ip_network("2000::/3"):
        sys.exit(1)
    sys.exit(not address.is_global or address.is_multicast)
except ValueError:
    sys.exit(1)
' "$1" "$2"
}

# Prefer the zone's own DNS response code to an unrelated name's availability.
dns_response_code() { # HOSTNAME
  if command -v dig >/dev/null 2>&1; then
    for record_type in A AAAA; do
      response=$(dig +time=5 +tries=1 "$1" "$record_type" 2>/dev/null) || { echo FAILED; return; }
      code=$(printf '%s\n' "$response" | sed -n 's/.*status: \([A-Z]*\),.*/\1/p')
      case "$code" in NOERROR|NXDOMAIN) ;; *) echo FAILED; return ;; esac
      # getent failed: address records from a second resolver mean disagreement, not a missing record.
      # A CNAME alone (a dangling one answers NXDOMAIN) still leaves the name without an address.
      answers=$(printf '%s\n' "$response" | awk -v type="$record_type" '/^;; ANSWER SECTION:/ { section = 1; next } /^$/ { section = 0 } section && $4 == type { count++ } END { print count + 0 }')
      [ "$answers" = 0 ] || { echo FAILED; return; }
    done
    echo "$code"
  elif command -v resolvectl >/dev/null 2>&1; then
    if response=$(LC_ALL=C resolvectl query "$1" 2>&1); then echo FAILED
    else
      # If the local service is unavailable, leave classification to the getent probe below.
      case "$response" in
        *"'$1' not found"*) echo NXDOMAIN ;;
        *"'$1' does not have any RR"*) echo NOERROR ;;
        *'Unit dbus-org.freedesktop.resolve1.service not found'*|*'Failed to connect to bus'*|*'Could not activate remote peer'*|*'Connection refused'*) ;;
        *) echo FAILED ;;
      esac
    fi
  fi
}

check_dns() {
  # Read by install.sh after the call.
  # shellcheck disable=SC2034
  dns_proxied=false
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
    response_code=$(dns_response_code "$1")
    case "$response_code" in
      NXDOMAIN|NOERROR) missing=true ;;
      '')
        # getent alone cannot distinguish a missing record from a resolver failure.
        # This fallback name has both A and AAAA records, including on IPv6-only hosts.
        missing=false
        if getent -s dns ahosts api64.ipify.org >/dev/null 2>&1; then missing=true; fi ;;
      *) missing=false ;;
    esac
    if [ "$missing" = true ]; then
      fail "$1 does not resolve yet. Check that its A record (and AAAA, if used) points at this server. $dns_retry"
    fi
    fail "This server could not query DNS for $1. Check the server's DNS resolver and network connectivity, then retry the installer. Nothing was changed."
  fi
  own=$(ip -o address show | awk '{sub(/\/.*/, "", $4); print $4}')
  # Global unicast IPv6 uses 2000::/3; link-local and private addresses do not
  # establish that this server can have a public IPv6 address behind NAT.
  global6=$(printf '%s\n' "$own" | grep -E '^[23][[:xdigit:]]{3}:' || true)
  public4_state=unchecked
  public6_state=unchecked
  dns_problems=''
  for address in $resolved; do
    case "$address" in
      127.*|::1) case "$1" in *.localhost) continue ;; esac
        dns_problems="$dns_problems
$1 resolves to a loopback address ($address). Point it at this server's public IP. $dns_retry"
        continue ;;
    esac
    if [ -n "${CLOUDFLARE_RANGES:-}" ] && in_cloudflare_ranges "$address" "$CLOUDFLARE_RANGES"; then
      # shellcheck disable=SC2034
      dns_proxied=true
      continue
    fi
    if ! printf '%s\n' "$own" | grep -qxF "$address"; then
      # Only consult the matching public-address service after a local miss,
      # once per family. This also covers providers that NAT the public address.
      case "$address" in
        *:*) state=$public6_state; family=6; url=https://api6.ipify.org ;;
        *) state=$public4_state; family=4; url=https://api.ipify.org ;;
      esac
      if [ "$state" = unchecked ]; then
        state=failed
        if command -v curl >/dev/null 2>&1 &&
          public=$(curl --fail --silent --max-time 5 --proto '=https' "$url") &&
          valid_public_address "$public" "$family"; then
          own="$own
$public"
          state=confirmed
        fi
        case "$family" in 4) public4_state=$state ;; 6) public6_state=$state ;; esac
      fi
      if printf '%s\n' "$own" | grep -qxF "$address"; then continue; fi
      if [ "$state" = failed ]; then
        extra=''
        if [ "$family" = 6 ] && [ -z "$global6" ]; then
          extra=' This server has no global IPv6 address: the AAAA record may be wrong, or outbound IPv6 may not be working (including behind IPv6 NAT). Remove the AAAA record or configure working public IPv6.'
        fi
        dns_problems="$dns_problems
$1 resolves to $address, which is not assigned to this server's network interfaces. The public-address lookup failed for IPv$family, so the installer could not confirm this server's public address.$extra Check that curl is installed and outbound HTTPS works with no filtering proxy or captive portal in the way, then retry the installer. Nothing was changed."
      else
        dns_problems="$dns_problems
$1 resolves to $address, which is not this server. Point the record here, DNS only or through Cloudflare's proxy; other proxies aren't supported. $dns_retry"
      fi
    fi
  done
  [ -z "$dns_problems" ] || fail "$dns_problems"
}
