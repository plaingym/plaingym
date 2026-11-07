#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# check-tag.sh VERSION [COMMIT] [--branches]: may COMMIT (default HEAD) of the repository in the current
# directory be released as VERSION? Prints the previous release of the same minor version, if any.
#
# * Release tags are vX.Y.Z.
# * A patch release (Z > 0) follows a vX.Y release, and its migrations (packages/db/src/migrations, journal
#   included) are exactly those of the latest earlier vX.Y tag. Installs apply patch releases on their own
#   each night and roll one back by starting the previous image, so a patch must never change the database.
# * With --branches (when publishing), vX.Y.0 must be on main and vX.Y.Z on release/X.Y, as origin has them.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
# shellcheck source=deploy/lib.sh
. "$ROOT/lib.sh"
version=${1:-}
commit=${2:-HEAD}
branches=${3:-}
if [ "$#" -gt 3 ] || { [ -n "$branches" ] && [ "$branches" != --branches ]; }; then fail 'Usage: check-tag.sh vX.Y.Z [COMMIT] [--branches]'; fi
valid_version "$version" || fail "Release tags are vX.Y.Z without leading zeros or a suffix: $version"
git rev-parse --verify --quiet "$commit^{commit}" >/dev/null || fail "Unknown commit: $commit"
minor=${version%.*}
patch=${version##*.}
previous=$(git tag --list "$minor.*" | awk -F. -v want="$patch" '
  /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/ && $3 + 0 < want + 0 && (tag == "" || $3 + 0 > best) { best = $3 + 0; tag = $0 }
  END { print tag }')
if [ "$branches" = --branches ]; then
  branch=main
  [ "$patch" = 0 ] || branch="release/${minor#v}"
  git merge-base --is-ancestor "$commit" "refs/remotes/origin/$branch" \
    || fail "$version must be tagged on $branch."
fi
if [ "$patch" != 0 ]; then
  [ -n "$previous" ] || fail "$version is a patch release, but there is no earlier $minor release to compare it with."
  git diff --quiet "$previous" "$commit" -- packages/db/src/migrations \
    || fail "$version is a patch release, but its migrations differ from $previous (packages/db/src/migrations). Patch releases never change the database; release it as the next minor version instead."
fi
[ "${version#v}" = "$(git show "$commit:package.json" | sed -n 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')" ] \
  || fail "$version does not match the root package.json version at $commit."
[ -z "$previous" ] || printf '%s\n' "$previous"
