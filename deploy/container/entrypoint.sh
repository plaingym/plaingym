#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
umask 077
/app/deploy/database.sh roles
# Resume verified restore state before migrations or any request/worker starts.
node /app/maintenance.mjs resume
/app/deploy/database.sh migrate
exec "$@"
