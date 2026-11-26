// SPDX-License-Identifier: AGPL-3.0-only
// Image checks: the newest release's code (before the first release, the code this branch started from) runs the
// production smoke test on the schema this commit migrated, so a schema the previous code can't run on is found when
// its migration lands, not when the Release workflow's previous-minor check meets it.
//
//   node deploy/release/previous-code.mjs IMAGE BASE
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { compare } from '../../scripts/release/release.mjs';
import { git, releasePattern } from '../../scripts/release/version.mjs';
import {
  smokePreviousImage, removeImage, withPreviousTree, holdInterrupts, interruptExitCode, childInterruptCode, checkInterrupt, runChild,
} from './previous-smoke.mjs';

const migrations = 'packages/db/src/migrations';
const floorFile = 'deploy/release/rollback-floor.txt';
/** The commit whose code must run on HEAD's schema, or why there is nothing to check. */
export function previousCode(base, cwd = process.cwd(), runGit = git) {
  const run = (...args) => runGit(args, cwd);
  const tag = run('tag', '--merged', 'HEAD', '--list', 'v*').split('\n').filter((name) => releasePattern.test(name.slice(1)))
    .sort((a, b) => compare(b, a))[0];
  const commit = tag ?? base;
  if (!commit) throw new Error('Give the commit this branch started from');
  if (!run('diff', '--name-only', commit, 'HEAD', '--', migrations)) return { skip: `No migration since ${commit}.` };
  try { run('cat-file', '-e', `${commit}:${floorFile}`); }
  catch (error) {
    // An interrupted read is not a missing file: the check must not pass as skipped.
    if (childInterruptCode(error) !== undefined) throw error;
    return { skip: `${commit} predates the compatibility promise.` };
  }
  const floor = readFileSync(join(cwd, floorFile), 'utf8').trim();
  if (tag && compare(tag, floor) < 0) return { skip: `The rollback floor ${floor} declares a boundary above ${tag}.` };
  return { commit };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  holdInterrupts();
  try {
    const [image, base] = process.argv.slice(2);
    if (!image) throw new Error('Usage: node deploy/release/previous-code.mjs IMAGE BASE');
    const { commit, skip } = previousCode(base);
    if (!commit) console.log(`::notice::Previous code check skipped. ${skip}`);
    else {
      const previousImage = `plaingym:previous-code-${randomUUID()}`;
      await withPreviousTree(commit, async (worktree) => {
        checkInterrupt();
        try {
          await runChild(process.execPath, ['scripts/release/build-image.mjs', previousImage], { cwd: worktree, stdio: 'inherit', timeout: 1_800_000 });
          await smokePreviousImage(previousImage, image, worktree, commit);
        } finally {
          await removeImage(previousImage);
        }
      });
    }
  } catch (error) {
    const code = interruptExitCode(error);
    if (code === undefined) throw error;
    console.error(error.message);
    if (process.exitCode !== 130 && process.exitCode !== 143) process.exitCode = code;
  }
}
