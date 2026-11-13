// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { compare } from './release.mjs';
import { releasePattern } from './version.mjs';

/** A backport must never move GitHub's latest release backwards. */
export function isLatest(version, releases) {
  if (!releasePattern.test(version.replace(/^v/, ''))) throw new Error('Expected a stable release version');
  return !releases.some(item => !item.isDraft && !item.isPrerelease &&
    releasePattern.test(item.tagName.replace(/^v/, '')) && compare(item.tagName, version) > 0);
}

export function latestReleaseFlag(version, run = execFileSync, repository = process.env.GITHUB_REPOSITORY ?? 'plaingym/plaingym') {
  const releases = JSON.parse(run('gh', ['api', '--paginate', '--slurp',
    `repos/${repository}/releases?per_page=100`],
  { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' })).flat()
    .map(item => ({ tagName: item.tag_name, isDraft: item.draft, isPrerelease: item.prerelease }));
  return isLatest(version, releases);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  console.log(latestReleaseFlag(process.argv[2] ?? ''));
