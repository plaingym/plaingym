// SPDX-License-Identifier: AGPL-3.0-only
import { buildInfo } from './version.mjs';

// Keep command execution outside the helper imported into application bundles.
const info = buildInfo(process.cwd());
console.log(process.argv[2] === '--json' ? JSON.stringify(info) : info.version);
