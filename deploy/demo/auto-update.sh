#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only
# Sourced by update.sh; discovery and installation run under the install lock.
# shellcheck disable=SC2034,SC2154,SC2317,SC2329
demo_state() { read_env "$1" "$ROOT/auto-update.state"; }
demo_state_set() {
  { if [ -f "$ROOT/auto-update.state" ]; then awk -F= -v key="$1" '$1 != key' "$ROOT/auto-update.state"; fi
    printf '%s=%s\n' "$1" "$2"; } > "$ROOT/auto-update.state.next"
  mv "$ROOT/auto-update.state.next" "$ROOT/auto-update.state"
}
demo_auto_report() {
  printf 'Demo release update: %s; from=%s to=%s reason=%s at=%s\n' "$1" "${from_version:--}" "${tag:--}" "$2" "$(date -u +%FT%TZ)" > "$ROOT/auto-update.status.next"
  mv "$ROOT/auto-update.status.next" "$ROOT/auto-update.status"
  cat "$ROOT/auto-update.status"
}
demo_auto_finish() { demo_auto_report "$1" "$2"; exit 0; }
demo_refuse() {
  demo_state_set "refused.$tag" "$1"
  demo_auto_finish skipped "$1"
}
demo_auto_schedule() {
  touch "$ROOT/auto-update.state"
  [ "$(read_env DEMO_AUTO_UPDATE)" != off ] || exit 0
  zone=$(read_env DEMO_UPDATE_TIMEZONE)
  zone=${zone:-America/New_York}
  if ! printf '%s\n' "$zone" | grep -Eq '^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$' || [ ! -f "/usr/share/zoneinfo/$zone" ]; then demo_auto_finish skipped invalid_timezone; fi
  if [ "$now" = false ]; then
    hour=$(TZ="$zone" date +%H); hour=${hour#0}
    [ "$hour" -ge 2 ] && [ "$hour" -lt 5 ] || exit 0
    night=$(TZ="$zone" date +%F)
    [ "$(demo_state night)" != "$night" ] || exit 0
    # A timezone change cannot cause two nights within six hours.
    last=$(demo_state night_at)
    if [[ "$last" =~ ^[0-9]+$ ]] && [ $(($(date -u +%s) - last)) -lt 21600 ]; then exit 0; fi
  fi
  demo_state_set night "$(TZ="$zone" date +%F)"
  demo_state_set night_at "$(date -u +%s)"
}
demo_auto_run() {
  from_version=$(installed_version "$current" || true)
  valid_version "$from_version" && [ "$from_version" != v0.0.0 ] || demo_auto_finish skipped version_unknown
  [ -f "$ROOT/release-signing.pem" ] || demo_auto_finish skipped no_signing_key
  repository=$(read_env RELEASE_REPOSITORY)
  repository=${repository:-plaingym/plaingym}
  valid_repository "$repository" || demo_auto_finish skipped invalid_repository
  work=$(mktemp -d "$ROOT/.demo-release.XXXXXXXX")
  download "https://api.github.com/repos/$repository/releases?per_page=100" "$work/releases.json" 5000000 || demo_auto_finish skipped release_list_unavailable
  tag=$(python3 -c 'import json,re,sys; current=tuple(map(int,sys.argv[1][1:].split("."))); releases=json.load(open(sys.argv[2])); tags=[r.get("tag_name", "") for r in releases if not r.get("draft") and not r.get("prerelease")]; versions=[tuple(map(int,t[1:].split("."))) for t in tags if re.fullmatch(r"v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})",t)]; newer=[v for v in versions if v[0]==current[0] and v>current]; print("v"+".".join(map(str,max(newer))) if newer else "")' "$from_version" "$work/releases.json") || demo_auto_finish skipped release_list_invalid
  [ -n "$tag" ] || demo_auto_finish up_to_date -
  refused=$(demo_state "refused.$tag")
  [ -z "$refused" ] || demo_auto_finish skipped "previously_refused_$refused"
  failures=$(demo_state "attempts.$tag"); failures=${failures:-0}
  [ "$failures" -lt 2 ] || demo_auto_finish skipped repeated_failure
  base="https://github.com/$repository/releases/download/$tag"
  { download "$base/release-manifest.txt" "$work/manifest" && download "$base/release-manifest.txt.sig" "$work/manifest.sig"; } || demo_auto_finish skipped manifest_unavailable
  manifest_verify "$ROOT/release-signing.pem" "$work/manifest" "$work/manifest.sig" || demo_refuse signature_invalid
  manifest_check "$work/manifest" "$tag" || demo_refuse manifest_invalid
  # As self-hosted: a failed update must be able to restart the running release on the migrated database.
  floor=$(manifest_value "$work/manifest" rollback_floor)
  [ -n "$floor" ] || floor=$(default_rollback_floor "$tag")
  version_at_least "$from_version" "$floor" || demo_auto_finish skipped rollback_floor_above_running
  image=$(manifest_value "$work/manifest" image)
  digest=$(manifest_value "$work/manifest" digest)
  target="$image:$tag@$digest"
  # host_download verifies the signed archive hash, host-file digests and unchanged trust key.
  [ "$(manifest_value "$work/manifest" host_format)" = 1 ] || demo_refuse deploy_archive_missing
  host_status=0
  host_download "$work/manifest" "$base" "$work" || host_status=$?
  [ "$host_status" -ne 2 ] || demo_auto_finish skipped deploy_archive_unavailable
  [ "$host_status" -eq 0 ] || demo_refuse deploy_archive_invalid
  local_args=()
  [ "$(read_env DEMO_LOCAL_TEST)" != true ] || local_args=(--local)
  python3 "$ROOT/deploy-files.py" prepare "$work/host.tar.gz" "$work/deploy" "${local_args[@]}" || demo_refuse deploy_archive_invalid
  cmp -s "$ROOT/caddy.Dockerfile" "$work/deploy/caddy.Dockerfile" || demo_refuse caddy_image_required
  # Check what Compose would actually run, including both overlays. Its rendered
  # environment contains credentials, so it stays in this private temporary directory.
  APP_IMAGE="$target" CADDY_IMAGE="$(read_env CADDY_IMAGE)" docker compose --project-directory "$ROOT" --env-file "$ROOT/.env" \
    -f "$work/deploy/compose.yaml" -f "$work/deploy/demo.compose.yaml" config --format json > "$work/compose.json" || demo_refuse deploy_config_invalid
  config_status=0
  python3 -c 'import json,sys; services=json.load(open(sys.argv[1])).get("services",{}); sys.exit(2 if services.get("caddy",{}).get("image")!=sys.argv[3] else int(any(services.get(name,{}).get("image")!=sys.argv[2] for name in ("app","migrate"))))' \
    "$work/compose.json" "$target" "$(read_env CADDY_IMAGE)" || config_status=$?
  [ "$config_status" -ne 2 ] || demo_refuse caddy_image_required
  [ "$config_status" -eq 0 ] || demo_refuse deploy_image_mismatch
  docker pull "$target" >/dev/null || demo_auto_finish skipped pull_failed
  docker image inspect "$target" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -qxF "$image@$digest" || demo_refuse digest_mismatch
  [ "$(installed_version "$target" || true)" = "$tag" ] || demo_refuse label_mismatch
  deploy_source=
  deploy_changed=$(python3 "$ROOT/deploy-files.py" changed "$ROOT" "$work/deploy") || demo_refuse deploy_archive_invalid
  if [ "$deploy_changed" = yes ]; then deploy_source="$work/deploy"; fi
  # A stopped demo is not a failed attempt: leave both attempts for a night it is running.
  compose ps --status running --services | grep -qx app || demo_auto_finish skipped app_not_running
  # Count before stopping, so a killed updater also uses up one of the two attempts.
  demo_state_set "attempts.$tag" "$((failures + 1))"
  auto_attempt=true
  demo_apply_update "$target" "$deploy_source"
}
