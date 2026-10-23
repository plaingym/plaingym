#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# One command on a fresh Ubuntu server: fetch a deployment bundle, verify its
# SHA256, and run install.sh with the bundled image. Safe to re-run.
set -eu
umask 077
usage='Usage: bootstrap.sh (--bundle-url HTTPS_URL | --bundle-file PATH) --sha256 SHA256 -- --hostname DNS_NAME --email EMAIL'
bundle_url=
bundle_file=
expected=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle-url|--bundle-file|--sha256)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 1; }
      case "$1" in --bundle-url) bundle_url=$2 ;; --bundle-file) bundle_file=$2 ;; --sha256) expected=$2 ;; esac
      shift 2 ;;
    --) shift; break ;;
    *) echo "$usage" >&2; exit 1 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo 'Run with sudo.' >&2; exit 1; }
if [ -n "$bundle_url" ] && [ -n "$bundle_file" ]; then echo "$usage" >&2; exit 1; fi
if [ -n "$bundle_url" ]; then
  case "$bundle_url" in https://*) ;; *) echo 'A trusted HTTPS bundle URL is required.' >&2; exit 1 ;; esac
elif [ -z "$bundle_file" ] || [ ! -f "$bundle_file" ]; then
  echo "$usage" >&2; exit 1
fi
printf '%s\n' "$expected" | grep -Eq '^[a-fA-F0-9]{64}$' || { echo 'The bundle SHA256 is required.' >&2; exit 1; }
work=$(mktemp -d)
# Only the installed files remain after success or failure.
trap 'rm -rf -- "$work"' EXIT
trap 'exit 130' HUP INT TERM
if [ -n "$bundle_url" ]; then
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$bundle_url" -o "$work/bundle.tar"
else
  # Verify a private copy, so the checked bytes are the installed bytes.
  cp "$bundle_file" "$work/bundle.tar"
fi
printf '%s  %s\n' "$expected" "$work/bundle.tar" | sha256sum -c - >/dev/null \
  || { echo 'The bundle does not match its SHA256. Nothing was changed.' >&2; exit 1; }
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
  || { echo "This bundle is for $architecture; build one for $(dpkg --print-architecture). Nothing was changed." >&2; exit 1; }
sh "$work/deploy/install.sh" --image "$image" --image-archive "$work/deploy/images/app.tar" "$@"
