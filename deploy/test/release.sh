#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Tests the release scripts the release workflow runs. check-tag.sh runs against a scratch Git repository:
# tag formats, the branch rules, and a patch release that changes a migration. publish.sh then runs a dry
# release against a throwaway registry on this machine: two small single-file images (amd64 and arm64, no
# emulation needed), a multi-arch index, and a manifest signed with a throwaway key, which update.sh's own
# checks then accept, listing the deploy archive (built from this repository's HEAD) with its SHA-256; then a
# dry run with the build-metadata version a tagged commit gets. Needs git, Node.js, GNU tar, OpenSSL 3 and
# Docker; it removes the registry, keys and images it made.
set -eu
umask 077
source_dir=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=deploy/lib.sh
. "$source_dir/lib.sh"
temporary=$(mktemp -d)
run_id="release-test-$$-$(date +%s)"
registry_name=
registry=
cleanup() {
  status=$?
  if [ "$status" -ne 0 ] && [ -f "$temporary/output" ]; then echo '--- last output:' >&2; cat "$temporary/output" >&2; fi
  if [ -n "$registry_name" ]; then
    timeout -k 5 120 docker rm -f -v "$registry_name" >/dev/null 2>&1 || echo "Cleanup incomplete: $registry_name" >&2
    docker image ls --format '{{.Repository}}:{{.Tag}}' | while read -r cleanup_image; do
      case "$cleanup_image" in "$registry/release-test/app:"*|"$run_id:"*)
        timeout -k 5 120 docker image rm -f "$cleanup_image" >/dev/null 2>&1 || echo "Cleanup incomplete: $cleanup_image" >&2 ;;
      esac
    done
  fi
  rm -rf -- "$temporary"
}
trap cleanup EXIT
check_tag="$source_dir/release/check-tag.sh"
# Exercise the exact release-branch workflow commands in the scratch repository below.
sed -n '/# release-migrations-start/,/# release-migrations-end/p' "$source_dir/../.github/workflows/ci.yml" | sed 's/^          //' > "$temporary/check-branch.sh"
test -s "$temporary/check-branch.sh"
expect_refusal() { # MESSAGE ARGS...
  message=$1; shift
  if sh "$check_tag" "$@" > "$temporary/output" 2>&1; then echo "Accepted: $*" >&2; exit 1; fi
  grep -q "$message" "$temporary/output" || { echo "Expected \"$message\" for: $*" >&2; exit 1; }
}

# --- check-tag.sh -------------------------------------------------------------------------------------------
repository="$temporary/repository"
git init -q -b main "$repository"
cd "$repository"
git config user.name Release; git config user.email release@example.org; git config commit.gpgsign false; git config tag.gpgsign false
set_version() { printf '{\n  "version": "%s"\n}\n' "$1" > package.json; }
set_version 1.2.0
mkdir -p packages/db/src/migrations/meta
printf 'create table a ();\n' > packages/db/src/migrations/0000_first.sql
printf '{"entries":[0]}\n' > packages/db/src/migrations/meta/_journal.json
printf 'one\n' > app.txt
git add -A; git commit -q -m 'feat: first'
git tag -a v1.2.0 -m v1.2.0
# The Release dry run's version on a commit that already carries its tag (a release commit pushed to main) still has
# build metadata, which publish.sh needs for a dry run; the publish dry run below uses it.
dry_version=$(node "$source_dir/../scripts/release/version-cli.mjs" --dry-run)
[ "$dry_version" = "1.2.0+0.g$(git rev-parse --short=7 HEAD)" ] || { echo "Unexpected dry run version: $dry_version" >&2; exit 1; }
git branch release/1.2
git checkout -q release/1.2
printf 'fixed\n' > app.txt
set_version 1.2.1
git commit -q -am 'fix: one'
fixed=$(git rev-parse HEAD)
[ "$(sh "$check_tag" v1.2.1 "$fixed")" = v1.2.0 ]
GITHUB_REF_NAME=release/1.2 sh "$temporary/check-branch.sh"
# A fix that adds a migration, or changes only the journal, is not a patch release.
printf 'alter table a add b int;\n' > packages/db/src/migrations/0001_second.sql
git add -A; git commit -q -m 'fix: migration'
expect_refusal 'migrations differ from v1.2.0' v1.2.1
if GITHUB_REF_NAME=release/1.2 sh "$temporary/check-branch.sh" > "$temporary/branch-output" 2>&1; then
  echo 'Release branch accepted a migration.' >&2; exit 1
fi
grep -q 0001_second.sql "$temporary/branch-output"
git reset -q --hard "$fixed"
printf '{"entries":[0,1]}\n' > packages/db/src/migrations/meta/_journal.json
git commit -q -am 'fix: journal'
expect_refusal 'migrations differ from v1.2.0' v1.2.1
git reset -q --hard "$fixed"
git tag -a v1.2.1 -m v1.2.1
printf 'fixed again\n' > app.txt
set_version 1.2.3
git commit -q -am 'fix: two'
# The latest earlier patch is the one compared, also after a skipped number.
[ "$(sh "$check_tag" v1.2.3)" = v1.2.1 ]
expect_refusal 'does not match the root package.json version' v1.2.4
# A minor release may add migrations, and needs no earlier tag.
git checkout -q main
set_version 1.3.0
printf 'alter table a add c int;\n' > packages/db/src/migrations/0001_third.sql
git add -A; git commit -q -m 'feat: next'
[ -z "$(sh "$check_tag" v1.3.0)" ]
expect_refusal 'no earlier v1.4 release' v1.4.1
for bad in v1.2 1.2.3 v01.2.3 v1.2.3-rc.1 v1.2.3.4 latest; do expect_refusal 'Release tags are vX.Y.Z' "$bad"; done
expect_refusal 'Usage' v1.3.0 HEAD --everywhere
# Publishing: a minor release is tagged on main, a patch on its release branch, as origin has them.
git clone -q --bare "$repository" "$temporary/origin.git"
git remote add origin "$temporary/origin.git"
git fetch -q origin '+refs/heads/*:refs/remotes/origin/*'
sh "$check_tag" v1.3.0 HEAD --branches > /dev/null
expect_refusal 'must be tagged on release/1.2' v1.2.2 HEAD --branches
sh "$check_tag" v1.2.3 release/1.2 --branches > /dev/null
expect_refusal 'must be tagged on main' v1.4.0 release/1.2 --branches
cd "$source_dir"

# --- publish.sh: a dry release to a throwaway registry ---------------------------------------------------
if ! docker info > /dev/null 2>&1; then echo 'SKIP: no Docker for the publish dry run.' >&2; echo 'PASS: check-tag.sh.'; exit 0; fi
registry_name="$run_id-registry"
# On the daemon's own loopback, where it pushes over plain HTTP, and on a port of this run's own. A published
# port isn't on the daemon's loopback everywhere (Docker Desktop); the host network is.
port=$((20000 + $$ % 20000))
registry="localhost:$port"
docker run -d --name "$registry_name" --network host -e "REGISTRY_HTTP_ADDR=127.0.0.1:$port" \
  registry:3@sha256:b3419cf99f8ec65bbda73e8a950fd26861012689beaf7b6577ee938995aa7d3f > /dev/null
for _ in $(seq 30); do curl --silent --fail "http://$registry/v2/" > /dev/null 2>&1 && break; sleep 1; done
curl --silent --fail "http://$registry/v2/" > /dev/null || { echo "The registry on $registry did not start." >&2; docker logs "$registry_name" >&2; exit 1; }
# The deploy archive is built from this repository's commit, so the images claim to come from it too.
revision=$(git -C "$source_dir/.." rev-parse HEAD)
mkdir "$temporary/rootfs"
printf 'release test\n' > "$temporary/rootfs/marker"
tar -C "$temporary/rootfs" -cf "$temporary/rootfs.tar" marker
for arch in amd64 arm64; do
  docker import --platform "linux/$arch" --change "LABEL org.opencontainers.image.version=v1.2.3" \
    --change "LABEL org.opencontainers.image.revision=$revision" "$temporary/rootfs.tar" "$run_id:$arch" > /dev/null
  docker save "$run_id:$arch" -o "$temporary/$arch.tar"
done
openssl genpkey -algorithm ed25519 -out "$temporary/key.pem" 2>/dev/null
openssl pkey -in "$temporary/key.pem" -pubout -out "$temporary/public.pem"
openssl genpkey -algorithm ed25519 -out "$temporary/other.pem" 2>/dev/null
openssl pkey -in "$temporary/other.pem" -pubout -out "$temporary/other-public.pem"
publish() { sh "$source_dir/release/publish.sh" --registry "$registry" --name release-test/app --insecure --version v1.2.3 \
  --revision "$revision" --migrations "$source_dir/../packages/db/src/migrations" --archive "amd64=$temporary/amd64.tar" \
  --archive "arm64=$temporary/arm64.tar" --key "$temporary/key.pem" --repository release-test/plaingym "$@" > "$temporary/output" 2>&1; }
# The wrong public key stops it before the manifest is published; a mislabelled image stops it before any push.
if publish --public-key "$temporary/other-public.pem" --out "$temporary/wrong"; then echo 'Published with a mismatched key.' >&2; exit 1; fi
grep -q 'does not verify' "$temporary/output"
if sh "$source_dir/release/publish.sh" --registry "$registry" --name release-test/app --insecure --version v1.2.4 --revision "$revision" \
  --migrations "$source_dir/../packages/db/src/migrations" --archive "amd64=$temporary/amd64.tar" --key "$temporary/key.pem" \
  --public-key "$temporary/public.pem" --repository release-test/plaingym --out "$temporary/mislabelled" > "$temporary/output" 2>&1; then echo 'Published a mislabelled image.' >&2; exit 1; fi
grep -q 'is not labelled v1.2.4' "$temporary/output"
publish --public-key "$temporary/public.pem" --out "$temporary/release"
manifest="$temporary/release/release-manifest.txt"
# update.sh --patch accepts what was published: the signature, the fields, and an index with both architectures.
manifest_verify "$temporary/public.pem" "$manifest" "$manifest.sig"
manifest_check "$manifest" v1.2.3
[ "$(manifest_value "$manifest" rollback_floor)" = v1.1.0 ]
[ "$(manifest_value "$manifest" image)" = "$registry/release-test/app" ]
digest=$(manifest_value "$manifest" digest)
# The exact canonical reference the updater records can be removed without a global prune.
docker pull "$registry/release-test/app:v1.2.3@$digest" > "$temporary/pull-output" 2>&1
timeout -k 5 30 docker image rm "$registry/release-test/app:v1.2.3@$digest" > "$temporary/remove-output" 2>&1
for arch in amd64 arm64; do
  manifest_value "$manifest" "digest.linux/$arch" | grep -Eq '^sha256:[a-f0-9]{64}$'
  grep -q "\"architecture\": \"$arch\"" "$temporary/release/index.json"
done
curl --silent --fail -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' -H 'Accept: application/vnd.oci.image.index.v1+json' \
  "http://$registry/v2/release-test/app/manifests/v1.2.3" -o "$temporary/served.json"
[ "sha256:$(sha256sum < "$temporary/served.json" | cut -d' ' -f1)" = "$digest" ]
[ "$(newest_patch v1.2.1 'v1.2.3')" = v1.2.3 ]
# A changed manifest, or one signed by another key, no longer verifies.
sed 's/^version=.*/version=v1.2.9/' "$manifest" > "$temporary/changed.txt"
if manifest_verify "$temporary/public.pem" "$temporary/changed.txt" "$manifest.sig"; then echo 'A changed manifest verified.' >&2; exit 1; fi
if manifest_verify "$temporary/other-public.pem" "$manifest" "$manifest.sig"; then echo 'Another key verified the manifest.' >&2; exit 1; fi

# The deploy archive is in the signed manifest with its SHA-256: this commit's deploy/ folder, carrying the public key
# that verifies the manifest, and built the same way twice gives the same bytes.
archive="$temporary/release/plaingym-deploy-v1.2.3.tar.gz"
[ "$(manifest_value "$manifest" deploy_archive)" = plaingym-deploy-v1.2.3.tar.gz ]
[ "$(manifest_value "$manifest" deploy_archive_sha256)" = "sha256:$(sha256sum "$archive" | cut -d' ' -f1)" ]
mkdir "$temporary/archive"
tar -xzf "$archive" -C "$temporary/archive"
[ "$(manifest_value "$manifest" host_format)" = 1 ]
for file in $host_files; do
  field="host.$(printf '%s' "$file" | tr '[:upper:]' '[:lower:]')"
  [ "$(manifest_value "$manifest" "$field")" = "sha256:$(sha256sum "$temporary/archive/deploy/$file" | cut -d' ' -f1)" ]
done
for file in install.sh lib.sh update.sh bootstrap.sh compose.yaml Caddyfile; do
  git -C "$source_dir/.." show "$revision:deploy/$file" | cmp -s - "$temporary/archive/deploy/$file" || { echo "The archive's $file is not the commit's." >&2; exit 1; }
done
cmp -s "$temporary/public.pem" "$temporary/archive/deploy/release-signing.pem" || { echo 'The archive carries another public key.' >&2; exit 1; }
if tar -tzvf "$archive" | grep -v ' 0/0 '; then echo 'The archive has entries not owned by root.' >&2; exit 1; fi
sh "$source_dir/release/deploy-assets.sh" --revision "$revision" --version v1.2.3 --repository release-test/plaingym \
  --public-key "$temporary/public.pem" --out "$temporary/again"
cmp -s "$archive" "$temporary/again/plaingym-deploy-v1.2.3.tar.gz" || { echo 'The deploy archive is not reproducible.' >&2; exit 1; }
# The release's bootstrap.sh carries its version, repository and key, and is otherwise the commit's.
bootstrap="$temporary/release/bootstrap.sh"
grep -qx 'release_version=v1.2.3' "$bootstrap"
grep -qx 'release_repository=release-test/plaingym' "$bootstrap"
grep -qx "release_key=$(sed '/^-----/d' "$temporary/public.pem" | tr -d '\n')" "$bootstrap"
[ "$(diff "$temporary/archive/deploy/bootstrap.sh" "$bootstrap" | grep -c '^>')" = 3 ]

# A dry run on a commit that already carries its tag publishes with the build-metadata version from above.
for arch in amd64 arm64; do
  docker import --platform "linux/$arch" --change "LABEL org.opencontainers.image.version=$dry_version" \
    --change "LABEL org.opencontainers.image.revision=$revision" "$temporary/rootfs.tar" "$run_id:dry-$arch" > /dev/null
  docker save "$run_id:dry-$arch" -o "$temporary/dry-$arch.tar"
done
sh "$source_dir/release/publish.sh" --registry "$registry" --name release-test/app --insecure --version "$dry_version" \
  --revision "$revision" --migrations "$source_dir/../packages/db/src/migrations" --archive "amd64=$temporary/dry-amd64.tar" \
  --archive "arm64=$temporary/dry-arm64.tar" --key "$temporary/key.pem" --public-key "$temporary/public.pem" \
  --repository release-test/plaingym --out "$temporary/dry" > "$temporary/output" 2>&1
[ "$(manifest_value "$temporary/dry/release-manifest.txt" version)" = "$dry_version" ]
[ -f "$temporary/dry/plaingym-deploy-$dry_version.tar.gz" ]
echo 'PASS: check-tag.sh, the dry run version on a tagged commit, and dry releases to a local registry that update.sh accepts, with the deploy archive in the signed manifest.'
