// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { buildInfo, imageSourceUrl, root } from './version.mjs';
const identity = buildInfo(root);
const tag = process.argv[2] ?? `plaingym:${identity.version.replace('+', '-')}`;
// --load: a container builder, which Image checks sets up, otherwise keeps the image in its own cache.
const result = spawnSync('docker', ['build', '--load', '-f', 'deploy/Dockerfile', '--build-arg', `VERSION=${identity.version}`,
  '--build-arg', `REVISION=${identity.commit}`, '--build-arg', `SOURCE_URL=${imageSourceUrl(identity)}`, '-t', tag, '.'],
{ cwd: root, stdio: 'inherit', windowsHide: true, timeout: 1_800_000 });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
if (process.exitCode === 0) console.log(`Built ${tag}: ${identity.version} (${identity.commit})`);
