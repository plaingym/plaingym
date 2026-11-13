// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { git, root } from '../../scripts/release/version.mjs';

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

/** Keep older assertions, while controlling configuration, migration and the project to clean after a hard timeout.
 * Refuse an unfamiliar harness rather than silently running the wrong configuration.
 */
export function adaptPreviousSmoke(source, deployment, currentDeployment, project) {
  const replace = (pattern, value) => {
    if (!pattern.test(source)) throw new Error(`Previous smoke harness has no supported ${pattern} marker`);
    source = source.replace(pattern, () => value);
  };
  // Keep root beside the older script: its assertion fixtures (for example proxy ranges) belong to the old image.
  replace(/^const prefix = .*;$/m, `const deploymentRoot = ${JSON.stringify(deployment)};
const prefix = ['compose', '--project-directory', deploymentRoot, '--env-file', envFile, '-p', project, '-f', join(deploymentRoot, 'compose.yaml')];`);
  replace(/^const project = .*;$/m, `const project = ${JSON.stringify(project)};`);
  replace(/^const compose = .*;$/m, `const migrationRoot = ${JSON.stringify(currentDeployment)};
const migrationPrefix = ['compose', '--project-directory', migrationRoot, '--env-file', envFile, '-p', project, '-f', join(migrationRoot, 'compose.yaml')];
const compose = (args, options) => {
  const migrating = options?.env?.APP_IMAGE === process.env.SMOKE_MIGRATE_IMAGE;
  try { return docker([...(migrating ? migrationPrefix : prefix), ...args], options); }
  catch (error) { throw new Error((migrating ? 'Migrate new image under current deployment files' : 'Run previous image under selected deployment files') + ': ' + error.message, { cause: error }); }
};`);
  return source;
}

/** Remove only the caller's unique project, even when the child never gets to its finally block. */
export function removeSmokeProject(project, run = execFileSync, warn = console.warn) {
  for (const [kind, list, remove] of [
    ['containers', ['ps', '-aq'], ['rm', '-f', '-v']],
    ['networks', ['network', 'ls', '-q'], ['network', 'rm']],
    ['volumes', ['volume', 'ls', '-q'], ['volume', 'rm']],
  ]) {
    try {
      const names = run('docker', [...list, '--filter', `label=com.docker.compose.project=${project}`],
        { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' }).trim().split(/\s+/).filter(Boolean);
      for (const name of names) {
        try { run('docker', [...remove, name], { stdio: 'pipe', timeout: 120_000, killSignal: 'SIGKILL' }); }
        catch (error) { warn(`::warning::Could not remove ${project} ${kind} ${name}: ${error.message}`); }
      }
    } catch (error) { warn(`::warning::Could not list ${project} ${kind}: ${error.message}`); }
  }
}

/** Both supported host-file paths: an upgraded install, and an install using the current deployment files. */
export function smokePreviousImage(previousImage, image, tree, commit, run = execFileSync) {
  const original = resolve(tree, 'deploy/test/smoke.mjs');
  const source = readFileSync(original, 'utf8');
  const configuration = JSON.parse(run('docker', ['image', 'inspect', previousImage], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' }))[0];
  const variable = key => configuration.Config.Env.find(entry => entry.startsWith(key + '='))?.slice(key.length + 1);
  for (const deployment of new Set([resolve(tree, 'deploy'), resolve(root, 'deploy')])) {
    const project = `plaingym-compat-${randomUUID()}`;
    const script = resolve(tree, 'deploy/test', `${project}.mjs`);
    const description = `Smoke test ${commit}:deploy/test/smoke.mjs (${original}) against ${previousImage}, schema migrated by ${image}, deployment files ${deployment}`;
    console.log(description);
    try {
      writeFileSync(script, adaptPreviousSmoke(source, deployment, resolve(root, 'deploy'), project));
      run(process.execPath, [script, previousImage], { cwd: tree, stdio: 'inherit', timeout: 900_000, killSignal: 'SIGKILL',
        env: { ...process.env, SMOKE_MIGRATE_IMAGE: image, VERSION: variable('APP_VERSION'), SOURCE_URL: variable('SOURCE_URL') } });
    } catch (error) { throw new Error(`${description} failed: ${error.message}`, { cause: error }); }
    finally {
      removeSmokeProject(project, run);
      try { rmSync(script, { force: true }); }
      catch (error) { console.warn(`::warning::Could not remove compatibility harness ${script}: ${error.message}`); }
    }
  }
}
