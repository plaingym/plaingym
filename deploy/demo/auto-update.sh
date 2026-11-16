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
demo_auto_finish() {
  if [ "$automatic" != true ]; then fail "Demo release update refused: $2"; fi
  demo_auto_report "$1" "$2"; exit 0
}
demo_refuse() {
  if [ "$automatic" = true ]; then demo_state_set "refused.$tag" "$1"; fi
  demo_auto_finish skipped "$1"
}

# GitHub prereleases use plain v0.Y.Z tags. Their signed channel must agree with
# GitHub's flag; the flag selects exactly one trust key, never a fallback key.
demo_select_release() { # CURRENT RELEASES_JSON CHANNEL [EXPLICIT_TAG]
  python3 -c 'import json,re,sys
current=tuple(map(int,sys.argv[1][1:].split("."))) if sys.argv[1] else None
releases=json.load(open(sys.argv[2]))
requested=sys.argv[5]
if requested and isinstance(releases,dict): releases=[releases]
if not isinstance(releases,list) or any(not isinstance(r,dict) for r in releases): raise ValueError("Invalid release list")
choices={}
for release in releases:
    tag=release.get("tag_name")
    if release.get("draft") or not isinstance(tag,str) or not re.fullmatch(sys.argv[3],tag): continue
    kind="prerelease" if release.get("prerelease") else "stable"
    version=tuple(map(int,tag[1:].split(".")))
    if requested:
        if tag!=requested: continue
    elif version[0]!=current[0] or version<=current or (sys.argv[4]=="stable" and kind!="stable"): continue
    if version in choices and choices[version]!=kind: raise ValueError("Conflicting release channels")
    choices[version]=kind
if choices:
    version=(max if sys.argv[4]=="stable" else min)(choices)
    print("v"+".".join(map(str,version)),choices[version])' "$1" "$2" "$version_pattern" "$3" "${4:-}"
}

demo_release_context() {
  repository=$(read_env RELEASE_REPOSITORY)
  repository=${repository:-plaingym/plaingym}
  valid_repository "$repository" || demo_auto_finish skipped invalid_repository
  work=$(mktemp -d "$ROOT/.demo-release.XXXXXXXX")
}

demo_release_list() {
  # Follow all pages before selecting the oldest newer prerelease. A truncated
  # history must never silently jump over an intermediate rollback floor.
  page=1
  printf '[]\n' > "$work/releases.json"
  while :; do
    url="https://api.github.com/repos/$repository/releases?per_page=100"
    [ "$page" -eq 1 ] || url="$url&page=$page"
    download "$url" "$work/page.json" 5000000 || demo_auto_finish skipped release_list_unavailable
    count=$(python3 -c 'import json,sys
page=json.load(open(sys.argv[1])); path=sys.argv[2]
if not isinstance(page,list) or any(not isinstance(r,dict) for r in page): raise ValueError("Invalid release list")
previous=json.load(open(path))
with open(path,"w") as output: json.dump(previous+page,output)
print(len(page))' "$work/page.json" "$work/releases.json") || demo_auto_finish skipped release_list_invalid
    [ "$count" -ge 100 ] && [ "$channel" = prerelease ] || break
    # Bound the API work; refuse an incomplete history rather than skipping it.
    [ "$page" -lt 10 ] || demo_auto_finish skipped release_list_incomplete
    page=$((page + 1))
  done
}
demo_auto_schedule() {
  touch "$ROOT/auto-update.state"
  [ "$(read_env DEMO_AUTO_UPDATE)" != off ] || exit 0
  zone=$(read_env DEMO_UPDATE_TIMEZONE)
  zone=${zone:-America/New_York}
  valid_timezone "$zone" || demo_auto_finish skipped invalid_timezone
  if [ "$now" = false ]; then
    in_window "$zone" || exit 0
    night=$(TZ="$zone" date +%F)
    [ "$(demo_state night)" != "$night" ] || exit 0
    # A timezone change cannot cause two nights within six hours.
    last=$(demo_state night_at)
    if [[ "$last" =~ ^[0-9]+$ ]] && [ $(($(date -u +%s) - last)) -lt 21600 ]; then exit 0; fi
  fi
  demo_state_set night "$(TZ="$zone" date +%F)"
  demo_state_set night_at "$(date -u +%s)"
}
demo_prepare_release() {
  release_work="$work/$tag"
  mkdir "$release_work"
  signing_key="$ROOT/release-signing.pem"
  [ "$release_kind" != prerelease ] || signing_key="$ROOT/prerelease-signing.pem"
  [ -f "$signing_key" ] || demo_auto_finish skipped no_signing_key
  base="https://github.com/$repository/releases/download/$tag"
  { download "$base/release-manifest.txt" "$release_work/manifest" && download "$base/release-manifest.txt.sig" "$release_work/manifest.sig"; } || demo_auto_finish skipped manifest_unavailable
  manifest_verify "$signing_key" "$release_work/manifest" "$release_work/manifest.sig" || demo_refuse signature_invalid
  manifest_check "$release_work/manifest" "$tag" || demo_refuse manifest_invalid
  signed_channel=$(manifest_value "$release_work/manifest" channel)
  case "$release_kind:$signed_channel" in stable:|prerelease:prerelease) ;; *) demo_refuse channel_mismatch ;; esac
  # As self-hosted: a failed update must be able to restart the running release on the migrated database.
  floor=$(manifest_value "$release_work/manifest" rollback_floor)
  [ -n "$floor" ] || floor=$(default_rollback_floor "$tag")
  if [ "$automatic" = true ]; then
    version_at_least "$from_version" "$floor" || demo_auto_finish skipped rollback_floor_above_running
  fi
  image=$(manifest_value "$release_work/manifest" image)
  digest=$(manifest_value "$release_work/manifest" digest)
  target="$image:$tag@$digest"
  if [ -n "${requested_image:-}" ]; then
    [ "$requested_image" = "$image:$tag" ] || demo_refuse image_mismatch
  fi
  # host_download verifies the signed archive hash, host-file digests and unchanged trust key.
  [ "$(manifest_value "$release_work/manifest" host_format)" = 1 ] || demo_refuse deploy_archive_missing
  host_status=0
  host_download "$release_work/manifest" "$base" "$release_work" "$signing_key" || host_status=$?
  [ "$host_status" -ne 2 ] || demo_auto_finish skipped deploy_archive_unavailable
  [ "$host_status" -eq 0 ] || demo_refuse deploy_archive_invalid
  local_args=()
  [ "$(read_env DEMO_LOCAL_TEST)" != true ] || local_args=(--local)
  python3 "$ROOT/deploy-files.py" prepare "$release_work/host.tar.gz" "$release_work/deploy" "${local_args[@]}" || demo_refuse deploy_archive_invalid
  cmp -s "$ROOT/caddy.Dockerfile" "$release_work/deploy/caddy.Dockerfile" || demo_refuse caddy_image_required
  # Check what Compose would actually run, including both overlays. Its rendered
  # environment contains credentials, so it stays in this private temporary directory.
  APP_IMAGE="$target" CADDY_IMAGE="$(read_env CADDY_IMAGE)" docker compose --project-directory "$ROOT" --env-file "$ROOT/.env" \
    -f "$release_work/deploy/compose.yaml" -f "$release_work/deploy/demo.compose.yaml" config --format json > "$release_work/compose.json" || demo_refuse deploy_config_invalid
  config_status=0
  python3 -c 'import json,sys; services=json.load(open(sys.argv[1])).get("services",{}); sys.exit(2 if services.get("caddy",{}).get("image")!=sys.argv[3] else int(any(services.get(name,{}).get("image")!=sys.argv[2] for name in ("app","migrate"))))' \
    "$release_work/compose.json" "$target" "$(read_env CADDY_IMAGE)" || config_status=$?
  [ "$config_status" -ne 2 ] || demo_refuse caddy_image_required
  [ "$config_status" -eq 0 ] || demo_refuse deploy_image_mismatch
  docker pull "$target" >/dev/null || demo_auto_finish skipped pull_failed
  docker image inspect "$target" --format '{{range .RepoDigests}}{{println .}}{{end}}' | grep -qxF "$image@$digest" || demo_refuse digest_mismatch
  [ "$(installed_version "$target" || true)" = "$tag" ] || demo_refuse label_mismatch
  deploy_source=
  deploy_changed=$(python3 "$ROOT/deploy-files.py" changed "$ROOT" "$release_work/deploy") || demo_refuse deploy_archive_invalid
  if [ "$deploy_changed" = yes ]; then deploy_source="$release_work/deploy"; fi
}

demo_explicit_release() {
  requested_image=$1
  tag=${1##*:}
  demo_release_context
  download "https://api.github.com/repos/$repository/releases/tags/$tag" "$work/release.json" 5000000 || demo_auto_finish skipped release_unavailable_or_unpublished
  selection=$(demo_select_release '' "$work/release.json" prerelease "$tag") || demo_auto_finish skipped release_list_invalid
  [ -n "$selection" ] || demo_auto_finish skipped release_not_published
  tag=${selection% *}; release_kind=${selection##* }
  demo_prepare_release
  demo_apply_update "$target" "$deploy_source"
}

demo_auto_run() {
  from_version=$(installed_version "$current" || true)
  valid_version "$from_version" && [ "$from_version" != v0.0.0 ] || demo_auto_finish skipped version_unknown
  channel=$(read_env DEMO_RELEASE_CHANNEL); channel=${channel:-prerelease}
  case "$channel" in stable|prerelease) ;; *) demo_auto_finish skipped invalid_release_channel ;; esac
  demo_release_context
  demo_release_list
  updated=false
  while :; do
    selection=$(demo_select_release "$from_version" "$work/releases.json" "$channel") || demo_auto_finish skipped release_list_invalid
    if [ -z "$selection" ]; then
      [ "$updated" = true ] || demo_auto_finish up_to_date -
      return 0
    fi
    tag=${selection% *}; release_kind=${selection##* }
    refused=$(demo_state "refused.$tag")
    [ -z "$refused" ] || demo_auto_finish skipped "previously_refused_$refused"
    failures=$(demo_state "attempts.$tag"); failures=${failures:-0}
    [ "$failures" -lt 2 ] || demo_auto_finish skipped repeated_failure
    demo_prepare_release
    if [ "$now" = false ] && ! in_window "$zone"; then
      [ "$updated" = false ] || return 0
      demo_auto_finish skipped window_closed
    fi
    # A stopped demo uses no attempt. Count before stopping, including killed updaters.
    compose ps --status running --services | grep -qx app || demo_auto_finish skipped app_not_running
    demo_state_set "attempts.$tag" "$((failures + 1))"
    auto_attempt=true
    demo_apply_update "$target" "$deploy_source"
    demo_auto_report updated -
    auto_attempt=false
    updated=true
    [ "$channel" != stable ] || return 0
    [ "$now" = true ] || in_window "$zone" || return 0
    current=$(read_env APP_IMAGE)
    from_version=$tag
  done
}
