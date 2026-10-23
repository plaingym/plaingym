#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Paste this command's download URL with a trusted bundle URL and SHA256.
set -eu
umask 077
bundle_url=
expected=
target=
ROOT=/opt/plaingym-demo
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle-url|--sha256|--update|--directory)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 1; }
      case "$1" in --bundle-url) bundle_url=$2 ;; --sha256) expected=$2 ;; --update) target=$2 ;; --directory) ROOT=$2 ;; esac
      shift 2 ;;
    --) shift; break ;;
    *) echo 'Usage: bootstrap.sh --bundle-url HTTPS_URL --sha256 SHA256 [--update IMAGE] [--directory DIR] [-- installer options]' >&2; exit 1 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo 'Run with sudo.' >&2; exit 1; }
case "$bundle_url" in https://*) ;; *) echo 'A trusted HTTPS bundle URL is required.' >&2; exit 1 ;; esac
printf '%s\n' "$expected" | grep -Eq '^[a-fA-F0-9]{64}$' || { echo 'The bundle SHA256 is required.' >&2; exit 1; }
work=$(mktemp -d)
# Leave only the installed files after success or failure, never a transfer of secrets.
trap 'rm -rf -- "$work"' EXIT
trap 'exit 130' HUP INT TERM
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$bundle_url" -o "$work/bundle.tar"
printf '%s  %s\n' "$expected" "$work/bundle.tar" | sha256sum -c - >/dev/null
python3 - "$work/bundle.tar" "$work" <<'PY'
# SPDX-License-Identifier: AGPL-3.0-only
import sys
import tarfile
with tarfile.open(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2], filter="data")
PY
# A verified new bundle refreshes deploy files/proxy even when the app pin stays put.
sh "$work/deploy/demo/install.sh" --directory "$ROOT" "$@"
if [ -n "$target" ]; then
  bash "$ROOT/update.sh" "$target" --bundle "$work/bundle.tar"
fi
