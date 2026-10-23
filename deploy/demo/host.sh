#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Reuse the existing installer's host setup without starting its single-gym stack.
# TODO(CCR): move this unchanged bootstrap block into a shared host helper when
# deploy/install.sh ownership is available. Fail closed if its boundaries change.
set -eu
DEPLOY=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
export DEMO_BASE_LIB="$DEPLOY/lib.sh"
block=$(awk '
  /^export DEBIAN_FRONTEND=noninteractive$/ { start++; active=1 }
  /^install -d -m 0700 "\$ROOT"$/ { end++; active=0 }
  active { print }
  END { if (start != 1 || end != 1) exit 1 }
' "$DEPLOY/install.sh") || { echo 'Shared installer bootstrap boundaries changed.' >&2; exit 1; }
# The variable belongs to the child shell, not this process.
# shellcheck disable=SC2016
{ printf '. "$DEMO_BASE_LIB"\n'; printf '%s\n' "$block"; } | sh -eu
