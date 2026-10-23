#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# The demo shares the gym installer's host setup without starting its single-gym stack.
set -eu
DEPLOY=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
sh "$DEPLOY/host.sh"
