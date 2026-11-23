// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compare } from '../../scripts/release/release.mjs';
import { smokePreviousImage, removeImage, withPreviousTree, holdInterrupts, interruptExitCode } from './previous-smoke.mjs';
import { git } from '../../scripts/release/version.mjs';
import { chooseFloor } from '../../scripts/release/prerelease.mjs';

/** Shallow release checkouts need the previous release's source tag, not its full history. */
export function withFetchedPreviousTree(previous, operation, cwd = process.cwd(), runGit = git) {
  runGit(['fetch', '--depth=1', '--no-tags', 'origin', `refs/tags/${previous}:refs/tags/${previous}`], cwd, { timeout: 120_000 });
  return withPreviousTree(previous, operation, (args) => runGit(args, cwd));
}

export function previousMinor(image, tag) {
  if (!image || !/^v\d+\.\d+\.0$/.test(tag ?? '')) {
    console.log('::notice::Previous-minor smoke testing applies to vX.Y.0 releases.');
    return;
  }
  const repository = process.env.GITHUB_REPOSITORY ?? 'plaingym/plaingym';
  const releases = JSON.parse(execFileSync('gh', ['release', 'list', '-R', repository, '--limit', '100', '--json', 'tagName,isDraft,isPrerelease'], { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' }));
  const older = releases.filter((item) => !item.isDraft && !item.isPrerelease && /^v\d+\.\d+\.\d+$/.test(item.tagName) && compare(item.tagName, tag) < 0)
    .map((item) => item.tagName).sort((a, b) => compare(b, a));
  const previous = older[0];
  if (!previous) { console.log('::notice::No earlier published release exists; previous-minor smoke test skipped.'); return; }
  const floor = readFileSync('deploy/release/rollback-floor.txt', 'utf8').trim();
  if (compare(previous, floor) < 0) {
    if (tag.split('.')[1] !== '0') throw new Error(`${tag} excludes the previous minor ${previous}; use a major release for this boundary`);
    console.log(`::notice::${tag} explicitly starts a new rollback boundary at ${floor}.`);
    return;
  }
  smokePublished(image, previous, repository);
}

/** Pull a published release's image and run it, with its own smoke test, on the schema IMAGE migrated to. */
function smokePublished(image, previous, repository) {
  const previousImage = `ghcr.io/${repository.split('/')[0].toLowerCase()}/app:${previous}`;
  let existed = true;
  try { execFileSync('docker', ['image', 'inspect', previousImage], { stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' }); } catch { existed = false; }
  try {
    execFileSync('docker', ['pull', previousImage], { stdio: 'inherit', timeout: 300_000, killSignal: 'SIGKILL' });
    withFetchedPreviousTree(previous, (worktree) => smokePreviousImage(previousImage, image, worktree, previous));
  } finally {
    if (!existed) removeImage(previousImage);
  }
}

/**
 * A prerelease's rollback floor (scripts/release/prerelease.mjs, chooseFloor): the previous prerelease when its image
 * passes the smoke test on the schema this release migrated to, else the release itself. A failure only raises the
 * floor, so it is reported as a warning rather than stopping the prerelease.
 */
export function prereleaseFloor(image, tag, previous, { smoke = smokePublished, log = console.log } = {}) {
  if (!/^v0\.\d+\.\d+$/.test(tag ?? '') || (previous && !/^v0\.\d+\.\d+$/.test(previous))) throw new Error('Prerelease versions are v0.Y.Z');
  if (!previous) {
    log(`::notice::${tag} is the first prerelease; it is its own rollback floor.`);
    return chooseFloor(tag, previous, false);
  }
  let passed = false;
  try {
    smoke(image, previous, process.env.GITHUB_REPOSITORY ?? 'plaingym/plaingym');
    passed = true;
  } catch (error) {
    if (interruptExitCode(error) !== undefined) throw error;
    log(`::warning::${previous} did not pass on ${tag}'s schema (${error.message}); ${tag} is its own rollback floor.`);
  }
  return chooseFloor(tag, previous, passed);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  holdInterrupts();
  try {
    const [image, tag, mode, previous] = process.argv.slice(2);
    if (mode === '--prerelease') console.log(`floor=${prereleaseFloor(image, tag, previous || undefined, { log: console.error })}`);
    else previousMinor(image, tag);
  } catch (error) {
    const code = interruptExitCode(error);
    if (code === undefined) throw error;
    console.error(error.message);
    process.exitCode = code;
  }
}
