#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Tests the release scripts the release workflow runs. lib.sh orders releases and nightly prereleases. check-tag.sh
# runs against a scratch Git repository: tag formats, the branch rules, a patch release that changes a migration, and
# nightly prereleases of next (--prerelease). publish.sh refuses a prerelease that isn't a nightly, a nightly that
# isn't a prerelease, the release key for a prerelease and the prerelease key for a release, then runs a dry
# release against a throwaway registry on this machine: two small single-file images (amd64 and arm64, no
# emulation needed), a multi-arch index, and a manifest signed with a throwaway key, which update.sh's own
# checks then accept, listing the deploy archive (built from this repository's HEAD) with its SHA-256; then a
# dry nightly prerelease, whose signed manifest says channel=prerelease, and a dry run with the build-metadata version a
# tagged commit gets. Needs git, Node.js, GNU tar, OpenSSL 3 and
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
pulled_ref=
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
  if [ -n "$pulled_ref" ] && docker image inspect "$pulled_ref" >/dev/null 2>&1; then
    timeout -k 5 120 docker image rm "$pulled_ref" >/dev/null 2>&1 || echo "Cleanup incomplete: $pulled_ref" >&2
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

# --- lib.sh: one order for releases and nightly prereleases ----------------------------------------------------
ordered='v1.0.9 v1.1.0-nightly.1 v1.1.0-nightly.2 v1.1.0-nightly.10 v1.1.0 v1.1.1 v1.2.0-nightly.1'
left_index=0
for left in $ordered; do
  left_index=$((left_index + 1)); right_index=0
  for right in $ordered; do
    right_index=$((right_index + 1)); expected=0
    if [ "$left_index" -lt "$right_index" ]; then expected=-1; elif [ "$left_index" -gt "$right_index" ]; then expected=1; fi
    [ "$(version_order "$left" "$right")" = "$expected" ] || { echo "version_order $left $right is not $expected" >&2; exit 1; }
  done
done
[ "$(version_order v0.9.0 v1.1.0-nightly.1)" = -1 ]
version_at_least v1.1.0 v1.1.0-nightly.10
version_at_least v1.1.0-nightly.2 v1.1.0-nightly.2
version_at_least v1.1.0-nightly.2 v1.0.3
if version_at_least v1.1.0-nightly.2 v1.1.0; then echo 'A nightly ranked at least its minor.' >&2; exit 1; fi
for bad in v1.1.0-rc.1 v1.1.1-nightly.1 v1.1.0-nightly.0 v1.1.0-nightly.01 1.1.0-nightly.1 v1.1.0-nightly.1+0.gabc1234; do
  if valid_published_version "$bad" || version_order "$bad" v1.0.0 > /dev/null; then echo "Accepted the version $bad" >&2; exit 1; fi
done
valid_published_version v1.1.0 && valid_published_version v1.1.0-nightly.1
if valid_version v1.1.0-nightly.1; then echo 'valid_version accepted a nightly.' >&2; exit 1; fi

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
RELEASE_BRANCH=release/1.2 sh "$temporary/check-branch.sh"
# A fix that adds a migration, or changes only the journal, is not a patch release.
printf 'alter table a add b int;\n' > packages/db/src/migrations/0001_second.sql
git add -A; git commit -q -m 'fix: migration'
expect_refusal 'migrations differ from v1.2.0' v1.2.1
if RELEASE_BRANCH=release/1.2 sh "$temporary/check-branch.sh" > "$temporary/branch-output" 2>&1; then
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
for bad in v1.2 1.2.3 v01.2.3 v1.2.3-rc.1 v1.2.3.4 v1.4.0-nightly.1 latest; do expect_refusal 'Release tags are vX.Y.Z' "$bad"; done
expect_refusal 'Usage' v1.3.0 HEAD --everywhere
# Publishing: a minor release is tagged on main, a patch on its release branch, as origin has them.
git clone -q --bare "$repository" "$temporary/origin.git"
git remote add origin "$temporary/origin.git"
git fetch -q origin '+refs/heads/*:refs/remotes/origin/*'
sh "$check_tag" v1.3.0 HEAD --branches > /dev/null
expect_refusal 'must be tagged on release/1.2' v1.2.2 HEAD --branches
sh "$check_tag" v1.2.3 release/1.2 --branches > /dev/null
expect_refusal 'must be tagged on main' v1.4.0 release/1.2 --branches
# A prerelease is a vX.Y.0-nightly.N version of a commit on next, as origin has it. Its version comes from the tags,
# so package.json (1.3.0 here) isn't compared, and a nightly is never a patch release.
git checkout -q -b next
printf 'next\n' > app.txt
git commit -q -am 'feat: on next'
git push -q origin next
git fetch -q origin '+refs/heads/next:refs/remotes/origin/next'
on_next=$(git rev-parse HEAD)
git checkout -q main
printf 'main only\n' > main.txt
git add main.txt; git commit -q -m 'docs: main only'
[ -z "$(sh "$check_tag" v1.1.0-nightly.1 "$on_next" --prerelease)" ]
# next's history is on next too: main's commit before next branched.
sh "$check_tag" v1.4.0-nightly.12 HEAD^ --prerelease
expect_refusal 'The v1.1.0-nightly.1 prerelease must be a commit on next.' v1.1.0-nightly.1 HEAD --prerelease
expect_refusal 'must be a commit on next' v1.1.0-nightly.1 release/1.2 --prerelease
for bad in v1.1.0 v0.9.0 v1.1.1-nightly.1 v1.1.0-nightly.01 v1.1.0-nightly.0 v1.1.0-nightly.1+0.gabc1234 v1.1.0-rc.1; do
  expect_refusal 'Prereleases are vX.Y.0-nightly.N versions' "$bad" "$on_next" --prerelease
done
expect_refusal 'Release tags are vX.Y.Z' v1.1.0-nightly.1 "$on_next"
expect_refusal 'Release tags are vX.Y.Z' v1.1.0-nightly.1 "$on_next" --branches
cd "$source_dir"

# --- publish.sh: the release and prerelease keys are never interchangeable ------------------------------------
# Refused before the deploy assets are built or anything is pushed, so no Docker is needed.
openssl genpkey -algorithm ed25519 -out "$temporary/key.pem" 2>/dev/null
openssl pkey -in "$temporary/key.pem" -pubout -out "$temporary/public.pem"
head_revision=$(git -C "$source_dir/.." rev-parse HEAD)
refuse_publish() { # MESSAGE ARGS...
  message=$1; shift
  if sh "$source_dir/release/publish.sh" --registry ghcr.io --name release-test/app --revision "$head_revision" \
    --migrations "$source_dir/../packages/db/src/migrations" --archive "amd64=$temporary/missing.tar" --key "$temporary/key.pem" \
    --repository release-test/plaingym --out "$temporary/refused" "$@" > "$temporary/output" 2>&1; then echo "Published: $*" >&2; exit 1; fi
  grep -q "$message" "$temporary/output" || { echo "Expected \"$message\" for: $*" >&2; exit 1; }
  [ ! -e "$temporary/refused" ] || { echo "Refused only after writing assets: $*" >&2; exit 1; }
}
refuse_publish 'never signed with the release key' --prerelease --version v1.1.0-nightly.1 --rollback-floor v1.1.0-nightly.1 --public-key "$source_dir/release-signing.pem"
# A prerelease is a nightly, also in a dry run, and a nightly is only ever a prerelease.
for bad in v1.1.0 v0.9.0 v1.1.1-nightly.1 1.1.0+0.gabc1234; do
  refuse_publish 'A prerelease is a vX.Y.0-nightly.N version' --prerelease --version "$bad" --rollback-floor v1.0.0 --public-key "$temporary/public.pem"
done
refuse_publish 'give --prerelease for a vX.Y.0-nightly.N prerelease' --version v1.1.0-nightly.1 --rollback-floor v1.0.0 --public-key "$temporary/public.pem"
refuse_publish 'give --prerelease for a vX.Y.0-nightly.N prerelease' --version 1.1.0-nightly.1+0.gabc1234 --rollback-floor v1.0.0 --public-key "$temporary/public.pem" --insecure
refuse_publish 'Invalid --rollback-floor' --version v1.1.0 --rollback-floor v1.1.0-nightly.3 --public-key "$temporary/public.pem"
refuse_publish 'Invalid --rollback-floor' --prerelease --version v1.1.0-nightly.2 --rollback-floor v1.1.0-nightly.3 --public-key "$temporary/public.pem"
refuse_publish 'never signed with the prerelease key' --version v1.2.3 --rollback-floor v1.2.3 --public-key "$source_dir/prerelease-signing.pem"
[ "$(sed '/^-----/d' "$source_dir/release-signing.pem")" != "$(sed '/^-----/d' "$source_dir/prerelease-signing.pem")" ]

# --- deploy-assets.sh: the PostgreSQL and Caddy images a release names --------------------------------------------
# A revision whose compose.yaml pins another PostgreSQL major gives no assets. Built from a scratch repository holding
# this deploy/ folder, with that one line changed.
pins="$temporary/pins"
mkdir "$pins"
cp -R "$source_dir" "$pins/deploy"
sed -i "s#^    image: postgres:18@#    image: postgres:19@#" "$pins/deploy/compose.yaml"
grep -q '^    image: postgres:19@sha256:' "$pins/deploy/compose.yaml"
git -C "$pins" init -q -b main
git -C "$pins" -c user.name=Release -c user.email=release@example.org -c commit.gpgsign=false add -A
git -C "$pins" -c user.name=Release -c user.email=release@example.org -c commit.gpgsign=false commit -q -m 'fix: postgres 19'
if sh "$pins/deploy/release/deploy-assets.sh" --revision "$(git -C "$pins" rev-parse HEAD)" --version v1.2.3 --repository release-test/plaingym \
  --public-key "$temporary/public.pem" --out "$temporary/pins-assets" > "$temporary/output" 2>&1; then echo 'Built assets for postgres:19.' >&2; exit 1; fi
grep -qF 'deploy/compose.yaml must pin postgres:18 and caddy:2.N.N-alpine by digest.' "$temporary/output"

# --- publish.sh: a dry release to a throwaway registry ---------------------------------------------------
if ! docker info > /dev/null 2>&1; then echo 'SKIP: no Docker for the publish dry run.' >&2; echo 'PASS: check-tag.sh and the publish key choice.'; exit 0; fi
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
if sh "$source_dir/release/publish.sh" --version v1.2.3 > "$temporary/output" 2>&1; then echo 'Published without an explicit floor.' >&2; exit 1; fi
grep -q 'Give --rollback-floor explicitly' "$temporary/output"
# An empty value (a missing rollback-floor.txt in the workflow) is the same omission.
if sh "$source_dir/release/publish.sh" --version v1.2.3 --rollback-floor '' > "$temporary/output" 2>&1; then echo 'Published with an empty floor.' >&2; exit 1; fi
grep -q 'Give --rollback-floor explicitly' "$temporary/output"
publish() { sh "$source_dir/release/publish.sh" --rollback-floor v1.1.0 --registry "$registry" --name release-test/app --insecure --version v1.2.3 \
  --revision "$revision" --migrations "$source_dir/../packages/db/src/migrations" --archive "amd64=$temporary/amd64.tar" \
  --archive "arm64=$temporary/arm64.tar" --key "$temporary/key.pem" --repository release-test/plaingym "$@" > "$temporary/output" 2>&1; }
# The wrong public key stops it before the manifest is published; a mislabelled image stops it before any push.
if publish --public-key "$temporary/other-public.pem" --out "$temporary/wrong"; then echo 'Published with a mismatched key.' >&2; exit 1; fi
grep -q 'does not verify' "$temporary/output"
if sh "$source_dir/release/publish.sh" --rollback-floor v1.1.0 --registry "$registry" --name release-test/app --insecure --version v1.2.4 --revision "$revision" \
  --migrations "$source_dir/../packages/db/src/migrations" --archive "amd64=$temporary/amd64.tar" --key "$temporary/key.pem" \
  --public-key "$temporary/public.pem" --repository release-test/plaingym --out "$temporary/mislabelled" > "$temporary/output" 2>&1; then echo 'Published a mislabelled image.' >&2; exit 1; fi
grep -q 'is not labelled v1.2.4' "$temporary/output"
publish --public-key "$temporary/public.pem" --out "$temporary/release"
manifest="$temporary/release/release-manifest.txt"
# update.sh --patch accepts what was published: the signature, the fields, and an index with both architectures.
manifest_verify "$temporary/public.pem" "$manifest" "$manifest.sig"
manifest_check "$manifest" v1.2.3
[ "$(manifest_value "$manifest" rollback_floor)" = v1.1.0 ]
# It names the PostgreSQL and Caddy images the revision's compose.yaml pins.
git -C "$source_dir/.." show "$revision:deploy/compose.yaml" > "$temporary/compose.yaml"
[ -n "$(manifest_value "$manifest" postgres_image)" ] && [ -n "$(manifest_value "$manifest" caddy_image)" ]
[ "$(manifest_value "$manifest" postgres_image)" = "$(compose_image "$temporary/compose.yaml" postgres)" ]
[ "$(manifest_value "$manifest" caddy_image)" = "$(compose_image "$temporary/compose.yaml" caddy)" ]
[ "$(manifest_value "$manifest" image)" = "$registry/release-test/app" ]
digest=$(manifest_value "$manifest" digest)
# The exact canonical reference the updater records can be removed without a global prune.
pulled_ref="$registry/release-test/app:v1.2.3@$digest"
docker pull "$pulled_ref" > "$temporary/pull-output" 2>&1
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
for file in install.sh lib.sh update.sh bootstrap.sh compose.yaml demo/compose.yaml Caddyfile; do
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

# A release's manifest names no channel; a nightly prerelease's says channel=prerelease, signed, and installs' checks
# accept its nightly version and floor only with that channel.
[ -z "$(manifest_value "$manifest" channel)" ]
for arch in amd64 arm64; do
  docker import --platform "linux/$arch" --change "LABEL org.opencontainers.image.version=1.1.0-nightly.1" \
    --change "LABEL org.opencontainers.image.revision=$revision" "$temporary/rootfs.tar" "$run_id:pre-$arch" > /dev/null
  docker save "$run_id:pre-$arch" -o "$temporary/pre-$arch.tar"
done
sh "$source_dir/release/publish.sh" --prerelease --rollback-floor v1.1.0-nightly.1 --registry "$registry" --name release-test/app --insecure \
  --version v1.1.0-nightly.1 --revision "$revision" --migrations "$source_dir/../packages/db/src/migrations" --archive "amd64=$temporary/pre-amd64.tar" \
  --archive "arm64=$temporary/pre-arm64.tar" --key "$temporary/key.pem" --public-key "$temporary/public.pem" \
  --repository release-test/plaingym --out "$temporary/prerelease" > "$temporary/output" 2>&1
prerelease_manifest="$temporary/prerelease/release-manifest.txt"
manifest_verify "$temporary/public.pem" "$prerelease_manifest" "$prerelease_manifest.sig"
manifest_check "$prerelease_manifest" v1.1.0-nightly.1
[ "$(manifest_value "$prerelease_manifest" version)" = v1.1.0-nightly.1 ]
[ "$(manifest_value "$prerelease_manifest" channel)" = prerelease ]
[ "$(manifest_value "$prerelease_manifest" rollback_floor)" = v1.1.0-nightly.1 ]
[ -f "$temporary/prerelease/plaingym-deploy-v1.1.0-nightly.1.tar.gz" ]
sed '/^channel=/d' "$prerelease_manifest" > "$temporary/no-channel.txt"
if manifest_check "$temporary/no-channel.txt" v1.1.0-nightly.1; then echo 'A nightly manifest without channel=prerelease passed.' >&2; exit 1; fi
if manifest_verify "$source_dir/release-signing.pem" "$prerelease_manifest" "$prerelease_manifest.sig"; then echo 'The release key verified a prerelease.' >&2; exit 1; fi

# A dry run on a commit that already carries its tag publishes with the build-metadata version from above.
for arch in amd64 arm64; do
  docker import --platform "linux/$arch" --change "LABEL org.opencontainers.image.version=$dry_version" \
    --change "LABEL org.opencontainers.image.revision=$revision" "$temporary/rootfs.tar" "$run_id:dry-$arch" > /dev/null
  docker save "$run_id:dry-$arch" -o "$temporary/dry-$arch.tar"
done
sh "$source_dir/release/publish.sh" --rollback-floor v1.1.0 --registry "$registry" --name release-test/app --insecure --version "$dry_version" \
  --revision "$revision" --migrations "$source_dir/../packages/db/src/migrations" --archive "amd64=$temporary/dry-amd64.tar" \
  --archive "arm64=$temporary/dry-arm64.tar" --key "$temporary/key.pem" --public-key "$temporary/public.pem" \
  --repository release-test/plaingym --out "$temporary/dry" > "$temporary/output" 2>&1
[ "$(manifest_value "$temporary/dry/release-manifest.txt" version)" = "$dry_version" ]
[ -f "$temporary/dry/plaingym-deploy-$dry_version.tar.gz" ]
echo 'PASS: version order, check-tag.sh (releases and nightly prereleases), the release and prerelease version and key choice, the dry run version on a tagged commit, and dry releases and nightly prereleases to a local registry that update.sh accepts, with the deploy archive in the signed manifest.'
