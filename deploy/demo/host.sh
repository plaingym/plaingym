#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# The demo shares the gym installer's host setup without starting its single-gym stack.
set -eu
DEPLOY=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
sh "$DEPLOY/host.sh"
# shellcheck source=deploy/lib.sh
. "$DEPLOY/lib.sh"
# The overlay's `!reset` (it keeps the maintenance credentials out of the app) needs Compose 2.24;
# an older Compose fails on the file, or ignores the tag and passes the credentials on.
compose_version=$(docker compose version --short 2>/dev/null) || fail 'Docker Compose is not installed.'
compose_version=${compose_version#v}
unreadable="Could not read the Docker Compose version '$compose_version'. The demo needs Docker Compose 2.24 or later."
case "$compose_version" in [0-9]*.[0-9]*) ;; *) fail "$unreadable" ;; esac
compose_major=${compose_version%%.*}
compose_minor=${compose_version#*.}
compose_minor=${compose_minor%%.*}
case "$compose_major$compose_minor" in *[!0-9]*) fail "$unreadable" ;; esac
if [ "$compose_major" -lt 2 ] || { [ "$compose_major" -eq 2 ] && [ "$compose_minor" -lt 24 ]; }; then
  fail "Docker Compose $compose_version is too old: the demo needs 2.24 or later. Upgrade the docker-compose-plugin package, then run the installer again."
fi
