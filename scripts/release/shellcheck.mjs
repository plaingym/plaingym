// SPDX-License-Identifier: AGPL-3.0-only
import { spawnSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { root } from './version.mjs';

// Multi-architecture manifest from the publisher's v0.11.0 release. Same binary in local checks and CI.
const image = 'koalaman/shellcheck:v0.11.0@sha256:61862eba1fcf09a484ebcc6feea46f1782532571a34ed51fedf90dd25f925a8d';
const files = globSync(['deploy/*.sh', 'deploy/container/*.sh', 'deploy/release/*.sh', 'deploy/test/*.sh', 'deploy/demo/*.sh'], { cwd: root });
const result = spawnSync('docker', ['run', '--rm', '--network', 'none', '--mount', `type=bind,src=${root.replace(/[\\/]$/, '')},dst=/mnt,readonly`,
  '--workdir', '/mnt', image, '-x', ...files.map(file => file.replaceAll('\\', '/'))],
{ cwd: root, stdio: 'inherit', timeout: 180_000, killSignal: 'SIGKILL', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
