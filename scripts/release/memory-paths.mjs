// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Preserve full checks on main and integrations; task pushes check the paths that affect the memory budget. */
export function needsMemory(ref, files) {
  return !ref.startsWith('refs/heads/task/') || files.some(file =>
    /^(?:apps\/server\/src\/(?:infra\/pdf\/|areas\/waivers\/|core\/rate-limit)|deploy\/|\.github\/workflows\/memory\.yml$)/.test(file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(needsMemory(process.argv[2] ?? '', readFileSync(process.argv[3], 'utf8').split('\n')));
