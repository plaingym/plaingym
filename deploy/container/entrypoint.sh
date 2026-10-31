#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
umask 077
if [ "${TENANCY:-single}" = multi ]; then
  # Multi-gym mode: the app never holds the maintenance role (BYPASSRLS), so one compromised process
  # can't reach every gym. `database.sh prepare` has already run as its own one-shot step.
  # The server repeats this check at start-up (core/maintenance-credentials.ts) for runs outside this image.
  for name in MAINTENANCE_PASSWORD MAINTENANCE_DATABASE_URL; do
    if [ -n "$(printenv "$name" || true)" ]; then
      echo "$name must not be set when TENANCY=multi; refusing startup" >&2
      exit 1
    fi
  done
  /app/deploy/database.sh wait
  exec "$@"
fi
/app/deploy/database.sh wait
/app/deploy/database.sh roles
# Resume verified restore state before migrations or any request/worker starts.
node /app/maintenance.mjs resume
/app/deploy/database.sh migrate
exec "$@"
