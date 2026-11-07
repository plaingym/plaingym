// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { git } from '../../scripts/release/version.mjs';

/** Cleanup must neither replace the check's result nor skip subsequent cleanup. */
export function removeImage(image, run = execFileSync, warn = console.warn) {
  // SIGKILL: the default SIGTERM leaves execFileSync blocked past its timeout if the client ignores it.
  try { run('docker', ['image', 'rm', '--force', image], { stdio: 'pipe', timeout: 120_000, killSignal: 'SIGKILL' }); }
  catch (error) { warn(`::warning::Could not remove image ${image}: ${error.message}`); }
}

/** Keep the smoke script beside its own Compose configuration and other fixtures. */
export function withPreviousTree(commit, operation, runGit = git, warn = console.warn) {
  const worktree = resolve(runGit(['rev-parse', '--path-format=absolute', '--git-common-dir']), '..', '.worktrees', `previous-code-${randomUUID()}`);
  runGit(['worktree', 'add', '--detach', worktree, commit]);
  try { return operation(worktree); }
  finally {
    try { runGit(['worktree', 'remove', '--force', worktree]); }
    catch (error) { warn(`::warning::Could not remove worktree ${worktree}: ${error.message}`); }
  }
}

/** The production smoke test on `previousImage`, started on a database `image` migrated first. */
export function smokePreviousImage(previousImage, image, tree, commit, run = execFileSync) {
  const script = resolve(tree, 'deploy/test/smoke.mjs');
  const description = `Smoke test ${commit}:deploy/test/smoke.mjs (${script}) against ${previousImage}, schema migrated by ${image}`;
  console.log(description);
  try {
    const configuration = JSON.parse(run('docker', ['image', 'inspect', previousImage], { encoding: 'utf8' }))[0];
    const variable = (key) => configuration.Config.Env.find((entry) => entry.startsWith(key + '='))?.slice(key.length + 1);
    run(process.execPath, [script, previousImage], { cwd: tree, stdio: 'inherit', timeout: 900_000,
      env: { ...process.env, SMOKE_MIGRATE_IMAGE: image, VERSION: variable('APP_VERSION'), SOURCE_URL: variable('SOURCE_URL') } });
  } catch (error) { throw new Error(`${description} failed: ${error.message}`, { cause: error }); }
}
