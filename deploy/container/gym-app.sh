#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# gym-app <command>: owner recovery, gym creation (multi mode), and restore.
set -eu
cd /app
exec node /app/server.mjs "$@"
