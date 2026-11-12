#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# gym-app <command>: owner recovery, gym creation (multi mode), and restore.
set -eu
cd /app
# shellcheck disable=SC2086 # PLAINGYM_NODE_FLAGS is a space-separated option list (deploy/Dockerfile)
exec node ${PLAINGYM_NODE_FLAGS:-} /app/server.mjs "$@"
