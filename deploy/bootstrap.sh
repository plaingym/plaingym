#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# One command on a fresh Ubuntu server. Nothing is installed until every check passes, only the installed files
# remain afterwards, and it is safe to re-run.
#
# Release mode (docs/install.md, Route 1): the bootstrap.sh asset of a GitHub release carries that release's version,
# repository and signing public key. It downloads the release manifest and its signature, verifies them with that
# key, downloads the deploy archive the manifest lists and checks its SHA-256, then runs the archive's install.sh
# with the manifest's image digest. Options other than its own go to install.sh.
#
#   curl -fsSL https://github.com/OWNER/REPO/releases/download/vX.Y.Z/bootstrap.sh | sudo sh -s -- --hostname DNS_NAME --email EMAIL
#
# Bundle mode (deploy/README.md, "One command from a bundle"): a maintainer's bundle, by URL or file, checked against
# the SHA256 given, installed with the image inside it.
set -eu
umask 077
# release-stamp-start: deploy/release/deploy-assets.sh fills these in for a release's bootstrap.sh.
release_version=
release_repository=
release_key=
# release-stamp-end
usage='Usage: bootstrap.sh --hostname DNS_NAME --email EMAIL [installer options]
       bootstrap.sh (--bundle-url HTTPS_URL | --bundle-file PATH) --sha256 SHA256 -- --hostname DNS_NAME --email EMAIL'
fail() { printf '%s\n' "$*" >&2; exit 1; }
# Everything runs from main, called on the last line: piped into sh, a download cut short is a syntax error that runs
# nothing, and no command runs before the whole script has been read.
main() {
bundle_url=
bundle_file=
expected=
# Take out this script's options; everything else, and everything after --, goes to install.sh in its order.
count=$#
rest=false
while [ "$count" -gt 0 ]; do
  argument=$1; shift; count=$((count - 1))
  if [ "$rest" = true ]; then set -- "$@" "$argument"; continue; fi
  case "$argument" in
    --) rest=true ;;
    --bundle-url|--bundle-file|--sha256)
      [ "$count" -gt 0 ] || fail "Missing value for $argument"
      case "$argument" in --bundle-url) bundle_url=$1 ;; --bundle-file) bundle_file=$1 ;; --sha256) expected=$1 ;; esac
      shift; count=$((count - 1)) ;;
    *) set -- "$@" "$argument" ;;
  esac
done
[ "$(id -u)" -eq 0 ] || fail 'Run with sudo.'
work=
# Only the installed files remain after success or failure.
trap '[ -z "$work" ] || rm -rf -- "$work"' EXIT
trap 'exit 130' HUP INT TERM

if [ -n "$bundle_url" ] || [ -n "$bundle_file" ]; then
  if [ -n "$bundle_url" ] && [ -n "$bundle_file" ]; then fail "$usage"; fi
  if [ -n "$bundle_url" ]; then
    case "$bundle_url" in https://*) ;; *) fail 'A trusted HTTPS bundle URL is required.' ;; esac
  elif [ ! -f "$bundle_file" ]; then
    fail "$usage"
  fi
  printf '%s\n' "$expected" | grep -Eq '^[a-fA-F0-9]{64}$' || fail 'The bundle SHA256 is required.'
  work=$(mktemp -d)
  if [ -n "$bundle_url" ]; then
    curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$bundle_url" -o "$work/bundle.tar"
  else
    # Verify a private copy, so the checked bytes are the installed bytes.
    cp "$bundle_file" "$work/bundle.tar"
  fi
  printf '%s  %s\n' "$expected" "$work/bundle.tar" | sha256sum -c - >/dev/null \
    || fail 'The bundle does not match its SHA256. Nothing was changed.'
  python3 - "$work/bundle.tar" "$work" <<'PY'
# SPDX-License-Identifier: AGPL-3.0-only
import sys
import tarfile
with tarfile.open(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2], filter="data")
PY
  # Read the bundle's image pin as data; never source a downloaded file.
  image=$(awk -F= '$1 == "APP_IMAGE" { print $2 }' "$work/deploy/images.env")
  architecture=$(awk -F= '$1 == "BUNDLE_ARCHITECTURE" { print $2 }' "$work/deploy/images.env")
  [ "$architecture" = "$(dpkg --print-architecture)" ] \
    || fail "This bundle is for $architecture; build one for $(dpkg --print-architecture). Nothing was changed."
  sh "$work/deploy/install.sh" --image "$image" --image-archive "$work/deploy/images/app.tar" "$@"
  exit
fi

# Release mode.
[ -z "$expected" ] || fail "$usage"
if [ -z "$release_version" ] || [ -z "$release_repository" ] || [ -z "$release_key" ]; then
  fail "This copy of bootstrap.sh is not a release's, so it has no signing key to check one with. Download bootstrap.sh from the release you are installing (docs/install.md, Route 1). Nothing was changed."
fi
version=$release_version
printf '%s\n' "$version" | grep -Eq '^v(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$' \
  || fail "This bootstrap.sh is from a dry run ($version), not a release. Nothing was changed."
for argument in "$@"; do
  case "$argument" in
    --image|--image-archive|--local-image|--repository) fail "The release sets the image and repository; leave out $argument. Nothing was changed." ;;
  esac
done
architecture=$(dpkg --print-architecture)
work=$(mktemp -d)
base="https://github.com/$release_repository/releases/download/$version"
# fetch URL FILE MAX_BYTES
fetch() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' --max-time 300 \
    --max-filesize "$3" -H 'User-Agent: plaingym-bootstrap' -o "$2" "$1" \
    || fail "Could not download $1. Nothing was changed."
}
printf -- '-----BEGIN PUBLIC KEY-----\n%s\n-----END PUBLIC KEY-----\n' "$release_key" > "$work/release-signing.pem"
fetch "$base/release-manifest.txt" "$work/release-manifest.txt" 4096
[ "$(wc -c < "$work/release-manifest.txt")" -le 4096 ] || fail 'The release manifest is too large. Nothing was changed.'
fetch "$base/release-manifest.txt.sig" "$work/release-manifest.txt.sig" 4096
# The same check update.sh makes (manifest_verify in lib.sh): a 64-byte Ed25519 signature of the manifest's bytes.
if [ "$(wc -c < "$work/release-manifest.txt.sig")" -ne 64 ] \
  || ! openssl pkeyutl -verify -pubin -inkey "$work/release-signing.pem" -rawin -in "$work/release-manifest.txt" \
    -sigfile "$work/release-manifest.txt.sig" >/dev/null 2>&1; then
  fail "The $version release manifest does not verify with this bootstrap's signing key. Nothing was changed."
fi
# value KEY: a manifest field, or nothing when it is missing or repeated. The manifest is read as data, never sourced.
value() { awk -v key="$1" 'index($0, key "=") == 1 { n++; sub(/^[^=]*=/, ""); found = $0 } END { if (n == 1) print found }' "$work/release-manifest.txt"; }
if [ "$(value format)" != plaingym-release-manifest/2 ] || [ "$(value version)" != "$version" ]; then
  fail "The signed manifest is not the $version release's. Nothing was changed."
fi
archive=plaingym-deploy-$version.tar.gz
archive_sha256=$(value deploy_archive_sha256)
if [ "$(value deploy_archive)" != "$archive" ] || ! printf '%s\n' "$archive_sha256" | grep -Eq '^sha256:[a-f0-9]{64}$'; then
  fail "The $version manifest lists no deploy archive. Nothing was changed."
fi
fetch "$base/$archive" "$work/$archive" 52428800
printf '%s  %s\n' "${archive_sha256#sha256:}" "$work/$archive" | sha256sum -c - >/dev/null 2>&1 \
  || fail "$archive does not match the SHA-256 in the signed manifest. Nothing was changed."
tar -xzf "$work/$archive" -C "$work" --no-same-owner
[ -f "$work/deploy/install.sh" ] || fail "$archive has no deploy/install.sh. Nothing was changed."
# After authenticating the archive, use the same validator as its updater. No downloaded code runs before its hash
# has been checked against the signed manifest; a malformed manifest never reaches the installer.
sh -c '. "$1/deploy/lib.sh" && manifest_check "$2" "$3"' sh "$work" "$work/release-manifest.txt" "$version" \
  || fail 'The signed release manifest is malformed. Nothing was changed.'
value "digest.linux/$architecture" | grep -Eq '^sha256:[a-f0-9]{64}$' \
  || fail "The $version release has no $architecture image. Nothing was changed."
image=$(value image)
digest=$(value digest)
# The installer copies this key for update.sh, so later releases are checked with the key that checked this one.
if [ ! -f "$work/deploy/release-signing.pem" ] || [ "$(sed '/^-----/d' "$work/deploy/release-signing.pem" | tr -d '\r\n')" != "$release_key" ]; then
  fail "$archive carries another release signing key than this bootstrap's. Nothing was changed."
fi
sh "$work/deploy/install.sh" --image "$image:$version@$digest" --repository "$release_repository" "$@"
}
main "$@"
