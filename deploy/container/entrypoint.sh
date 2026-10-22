#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
set -eu
umask 077
/app/deploy/database.sh roles
exec "$@"
