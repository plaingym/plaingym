// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { compare } from '../../scripts/release/release.mjs';
import {
  smokePreviousImage, removeImage, withPreviousTree, holdInterrupts, interruptExitCode, childInterruptCode, checkInterrupt,
  gitChild, runChild, SmokeInterrupted,
} from './previous-smoke.mjs';
import { chooseFloor } from '../../scripts/release/prerelease.mjs';

/** Shallow release checkouts need the previous release's source tag, not its full history. */
export async function withFetchedPreviousTree(previous, operation, cwd = process.cwd(), runGit = gitChild) {
  checkInterrupt();
  await runGit(['fetch', '--depth=1', '--no-tags', 'origin', `refs/tags/${previous}:refs/tags/${previous}`], cwd, { timeout: 120_000 });
  return withPreviousTree(previous, operation, (args) => runGit(args, cwd));
}

export async function previousMinor(image, tag) {
  if (!image || !/^v\d+\.\d+\.0$/.test(tag ?? '')) {
    console.log('::notice::Previous-minor smoke testing applies to vX.Y.0 releases.');
    return;
  }
  const repository = process.env.GITHUB_REPOSITORY ?? 'plaingym/plaingym';
  checkInterrupt();
  const releases = JSON.parse(await runChild('gh', ['release', 'list', '-R', repository, '--limit', '100', '--json', 'tagName,isDraft,isPrerelease'], { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' }));
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
  await smokePublished(image, previous, repository);
}

/** Pull a published release's image and run it, with its own smoke test, on the schema IMAGE migrated to. */
export async function smokePublished(image, previous, repository, run = runChild) {
  const previousImage = `ghcr.io/${repository.split('/')[0].toLowerCase()}/app:${previous}`;
  let existed = true;
  checkInterrupt();
  try { await run('docker', ['image', 'inspect', previousImage], { stdio: 'ignore', timeout: 30_000, killSignal: 'SIGKILL' }); }
  catch (error) {
    // An interrupted inspect says nothing about the image: stop before pulling, and keep any image that was there.
    const code = childInterruptCode(error);
    if (code !== undefined) throw new SmokeInterrupted(code, { cause: error });
    existed = false;
  }
  checkInterrupt();
  try {
    await run('docker', ['pull', previousImage], { stdio: 'inherit', timeout: 300_000, killSignal: 'SIGKILL' });
    await withFetchedPreviousTree(previous, (worktree) => smokePreviousImage(previousImage, image, worktree, previous));
  } finally {
    if (!existed) await removeImage(previousImage, run);
  }
}

/**
 * A prerelease's rollback floor (scripts/release/prerelease.mjs, chooseFloor): the previous prerelease when its image
 * passes the smoke test on the schema this release migrated to, else the release itself. A failure only raises the
 * floor, so it is reported as a warning rather than stopping the prerelease.
 */
export async function prereleaseFloor(image, tag, previous, { smoke = smokePublished, log = console.log } = {}) {
  if (!/^v0\.\d+\.\d+$/.test(tag ?? '') || (previous && !/^v0\.\d+\.\d+$/.test(previous))) throw new Error('Prerelease versions are v0.Y.Z');
  if (!previous) {
    log(`::notice::${tag} is the first prerelease; it is its own rollback floor.`);
    return chooseFloor(tag, previous, false);
  }
  let passed = false;
  try {
    await smoke(image, previous, process.env.GITHUB_REPOSITORY ?? 'plaingym/plaingym');
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
    if (mode === '--prerelease') {
      const floor = await prereleaseFloor(image, tag, previous || undefined, { log: console.error });
      // An interrupt held while the last child ran, or one only recorded by cleanup, ends the run with no floor.
      if (process.exitCode !== 130 && process.exitCode !== 143) console.log(`floor=${floor}`);
    } else await previousMinor(image, tag);
  } catch (error) {
    const code = interruptExitCode(error);
    if (code === undefined) throw error;
    console.error(error.message);
    if (process.exitCode !== 130 && process.exitCode !== 143) process.exitCode = code;
  }
}
