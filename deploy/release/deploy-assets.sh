#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# deploy-assets.sh: the two install assets of a release (deploy/README.md, "Releases"). publish.sh runs it before
# anything is pushed, and lists the archive's SHA-256 in the signed release manifest.
#
#   deploy-assets.sh --revision COMMIT --version VERSION --repository OWNER/REPO --public-key PUBLIC.pem --out DIR
#
# DIR gets plaingym-deploy-VERSION.tar.gz, the deploy/ folder of COMMIT in this repository with PUBLIC.pem as its
# release-signing.pem, and bootstrap.sh, COMMIT's deploy/bootstrap.sh with VERSION, OWNER/REPO and PUBLIC.pem filled
# in. A release passes the committed key, so its archive is the tag's deploy/ folder as it is. The archive is built
# from Git, never the working tree, with fixed owners, modes and times, so the same inputs give the same bytes.
set -eu
umask 077
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=deploy/lib.sh
. "$ROOT/lib.sh"
repository_dir=$(CDPATH='' cd -- "$ROOT/.." && pwd)
revision=
version=
repository=
public=
out=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --revision|--version|--repository|--public-key|--out)
      [ "$#" -ge 2 ] || fail "Missing value for $1"
      case "$1" in
        --revision) revision=$2 ;; --version) version=$2 ;; --repository) repository=$2 ;;
        --public-key) public=$2 ;; --out) out=$2 ;;
      esac
      shift 2 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done
printf '%s\n' "$revision" | grep -Eq '^[a-f0-9]{40}$' || fail 'Use --revision with a full commit SHA.'
# A release version, or a dry run's version with build metadata.
printf '%s\n' "$version" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+(\+[A-Za-z0-9.-]+)?$' || fail "Invalid --version: $version"
valid_repository "$repository" || fail "Invalid --repository: $repository"
[ -f "$public" ] || fail "Missing --public-key: $public"
[ -n "$out" ] || fail 'Give --out.'
openssl pkey -pubin -in "$public" -noout -text 2>/dev/null | grep -q '^ED25519 Public-Key:' || fail "$public is not an Ed25519 public key."
# The repository may belong to another user than the one running this (a root test on a runner's checkout).
run_git() { git -c safe.directory="$repository_dir" -C "$repository_dir" "$@"; }
run_git cat-file -e "$revision^{commit}" 2>/dev/null || fail "$revision is not a commit of $repository_dir."
stage=$(mktemp -d)
trap 'rm -rf -- "$stage"' EXIT
# Each step writes a file rather than a pipe, so a failed git, tar or gzip stops the script (sh has no pipefail) and
# a partial archive is never hashed into a manifest.
run_git archive --format=tar -o "$stage/source.tar" "$revision" deploy
tar -x -C "$stage" -f "$stage/source.tar"
if [ ! -f "$stage/deploy/install.sh" ] || [ ! -f "$stage/deploy/bootstrap.sh" ]; then fail "$revision has no deploy/install.sh and deploy/bootstrap.sh."; fi
openssl pkey -pubin -in "$public" -pubout -out "$stage/deploy/release-signing.pem"
key=$(sed '/^-----/d' "$stage/deploy/release-signing.pem" | tr -d '\r\n')
printf '%s\n' "$key" | grep -Eq '^[A-Za-z0-9+/]{1,64}={0,2}$' || fail 'The public key does not fit on one PEM line.'
mkdir -p "$out"
archive="$out/plaingym-deploy-$version.tar.gz"
# GNU tar and gzip -n: sorted names, the commit's time, root owner and plain modes, no gzip name or time.
tar --sort=name --format=gnu --mtime="@$(run_git show -s --format=%ct "$revision")" --owner=0 --group=0 --numeric-owner \
  --mode='u+rwX,go+rX,go-w' -C "$stage" -cf "$stage/deploy.tar" deploy
gzip -9 -n < "$stage/deploy.tar" > "$archive"
# Fill in the three stamp lines, each found exactly once, or fail.
awk -v version="$version" -v repository="$repository" -v key="$key" '
  $0 == "release_version=" { print "release_version=" version; found++; next }
  $0 == "release_repository=" { print "release_repository=" repository; found++; next }
  $0 == "release_key=" { print "release_key=" key; found++; next }
  { print }
  END { exit found == 3 ? 0 : 1 }' "$stage/deploy/bootstrap.sh" > "$out/bootstrap.sh" || fail "$revision's bootstrap.sh lacks its release stamp lines."
chmod 0644 "$archive" "$out/bootstrap.sh"
