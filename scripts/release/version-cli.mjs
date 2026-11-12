// SPDX-License-Identifier: AGPL-3.0-only
import { buildInfo, dryRunVersion } from './version.mjs';

// Keep command execution outside the helper imported into application bundles.
const info = buildInfo(process.cwd());
const mode = process.argv[2];
console.log(mode === '--json' ? JSON.stringify(info) : mode === '--dry-run' ? dryRunVersion(info) : info.version);
