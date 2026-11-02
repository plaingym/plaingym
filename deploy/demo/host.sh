#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# The demo shares the gym installer's host setup without starting its single-gym stack.
# The Compose 2.24 check (`require_compose` in lib.sh) runs in install.sh before this does.
set -eu
DEPLOY=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
sh "$DEPLOY/host.sh"
