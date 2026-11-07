#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# publish.sh: push tested per-architecture image archives as one multi-arch image, then write the release manifest,
# sign it, and check it the way installs do (deploy/README.md, "Releases"). The release workflow runs it against
# GHCR for a tag, and against a registry on the runner with a throwaway key for a dry run.
#
#   publish.sh --registry HOST[:PORT] --name OWNER/app --version vX.Y.Z --revision COMMIT --migrations DIR
#              --archive amd64=FILE [--archive arm64=FILE] --key PRIVATE.pem --public-key PUBLIC.pem --out DIR [--insecure]
#
# Each archive is a `docker save` of an image labelled with the version and revision. The output directory gets
# release-manifest.txt and release-manifest.txt.sig, the two assets of the GitHub release.
set -eu
umask 077
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=deploy/lib.sh
. "$ROOT/lib.sh"
registry=
name=
version=
revision=
migrations=
key=
public=
out=
insecure=
archives=
rollback_floor=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --insecure) insecure=--insecure; shift ;;
    --registry|--name|--version|--revision|--migrations|--archive|--key|--public-key|--out|--rollback-floor)
      [ "$#" -ge 2 ] || fail "Missing value for $1"
      case "$1" in
        --registry) registry=$2 ;; --name) name=$2 ;; --version) version=$2 ;; --revision) revision=$2 ;;
        --migrations) migrations=$2 ;; --key) key=$2 ;; --public-key) public=$2 ;; --out) out=$2 ;;
        --archive) archives="$archives $2" ;;
        --rollback-floor) rollback_floor="v${2#v}" ;;
      esac
      shift 2 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
if ! valid_version "$version"; then
  if [ "$insecure" != --insecure ] || ! printf '%s\n' "$registry" | grep -Eq '^localhost:[0-9]+$'; then fail 'Development releases may only use an insecure local test registry.'; fi
  printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\+[A-Za-z0-9.-]+$' || fail 'Use --version vX.Y.Z (or build metadata for a local dry run).'
fi
registry_tag=$(printf '%s' "$version" | tr '+' '_')
[ -n "$rollback_floor" ] || rollback_floor=$(default_rollback_floor "$version")
version_base=${version%%+*}
version_at_least "v${version_base#v}" "$rollback_floor" || fail 'Invalid --rollback-floor.'
printf '%s\n' "$revision" | grep -Eq '^[a-f0-9]{40}$' || fail 'Use --revision with a full commit SHA.'
for path in "$migrations" "$key" "$public"; do [ -e "$path" ] || fail "Missing --migrations, --key or --public-key: $path"; done
if [ -z "$out" ] || [ -z "$archives" ]; then fail 'Give --out and at least one --archive.'; fi
image="$registry/$name"
printf '%s\n' "$image" | grep -Eq '^[a-z0-9][a-z0-9.-]*(:[0-9]{1,5})?(/[a-z0-9][a-z0-9._-]*)+$' || fail "Invalid image name: $image"
mkdir -p "$out"
label() { docker image inspect "$1" --format "{{index .Config.Labels \"org.opencontainers.image.$2\"}}"; }

refs=
platforms=
for entry in $archives; do
  arch=${entry%%=*}
  file=${entry#*=}
  case "$arch" in amd64|arm64) ;; *) fail "Unknown architecture: $arch" ;; esac
  loaded=$(docker load -i "$file" | sed -n 's/^Loaded image: //p' | tail -n 1)
  [ -n "$loaded" ] || fail "$file holds no tagged image."
  [ "$(docker image inspect "$loaded" --format '{{.Os}}/{{.Architecture}}')" = "linux/$arch" ] || fail "$file is not a linux/$arch image."
  [ "$(label "$loaded" version | sed 's/^v//')" = "${version#v}" ] || fail "$file is not labelled $version."
  [ "$(label "$loaded" revision)" = "$revision" ] || fail "$file was not built from $revision."
  docker tag "$loaded" "$image:$registry_tag-$arch"
  pushed=$(docker push "$image:$registry_tag-$arch" | sed -n 's/.*digest: \(sha256:[a-f0-9]\{64\}\).*/\1/p' | tail -n 1)
  [ -n "$pushed" ] || fail "Pushing $arch returned no digest."
  refs="$refs $image@$pushed"
  platforms="${platforms}digest.linux/$arch=$pushed
"
done
# One index over exactly the pushed per-architecture images: installs pull by its digest.
# shellcheck disable=SC2086
docker manifest create $insecure "$image:$registry_tag" $refs >/dev/null
index=$(docker manifest push $insecure --purge "$image:$registry_tag" | grep -Eo 'sha256:[a-f0-9]{64}' | tail -n 1)
[ -n "$index" ] || fail 'Pushing the multi-arch index returned no digest.'
docker manifest inspect $insecure "$image@$index" > "$out/index.json"
for entry in $archives; do
  grep -q "\"architecture\": \"${entry%%=*}\"" "$out/index.json" || fail "The pushed index lacks ${entry%%=*}."
done

# The same digest of the migrations update.sh --patch compares between images (/app/migrations in the image).
migrations_hash=$(cd "$migrations" && find . -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -d' ' -f1)
manifest="$out/release-manifest.txt"
{
  printf 'format=plaingym-release-manifest/2\nversion=%s\nimage=%s\ndigest=%s\nrollback_floor=%s\n' "$version" "$image" "$index" "$rollback_floor"
  printf '%s' "$platforms"
  printf 'revision=%s\nmigrations=sha256:%s\nreleased=%s\n' "$revision" "$migrations_hash" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$manifest"
openssl pkeyutl -sign -inkey "$key" -rawin -in "$manifest" -out "$manifest.sig"
manifest_verify "$public" "$manifest" "$manifest.sig" || fail 'The signed manifest does not verify with the public key.'
manifest_check "$manifest" "$version" || fail 'The manifest is malformed.'
chmod 0644 "$manifest" "$manifest.sig"
cat "$manifest"
