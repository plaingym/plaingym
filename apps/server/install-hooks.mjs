// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);
// Source archives and CI do not need local Git hooks.
if (!process.env.CI && existsSync(new URL('.git', root))) {
  execFileSync(process.execPath, [
    fileURLToPath(new URL('node_modules/simple-git-hooks/cli.js', root)),
  ], { cwd: root, stdio: 'inherit' });
}
