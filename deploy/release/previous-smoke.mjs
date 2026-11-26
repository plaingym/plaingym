// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, root } from '../../scripts/release/version.mjs';

/** An interrupted compatibility run, carried through callers that only clean up and rethrow. */
export class SmokeInterrupted extends Error {
  /** @type {130 | 143} */
  #exitCode;

  /** @param {130 | 143} exitCode @param {{ cause?: Error }} [options] */
  constructor(exitCode, options) {
    super('Compatibility smoke interrupted', options);
    this.name = 'SmokeInterrupted';
    this.#exitCode = exitCode;
  }

  /** @returns {130 | 143} */
  get exitCode() { return this.#exitCode; }
}

/**
 * The exit code for a child stopped by an interrupt: killed by the signal, or exiting the way a shell reports it.
 * A timeout is a failure even when the signal that stopped the child was SIGTERM.
 */
export function childInterruptCode(error) {
  if (error?.code === 'ETIMEDOUT') return undefined;
  if (error?.signal === 'SIGINT' || error?.status === 130) return 130;
  if (error?.signal === 'SIGTERM' || error?.status === 143) return 143;
  return undefined;
}

/** Callers wrap and clean up; find the interrupt without treating it as a smoke failure. */
export function interruptExitCode(error) {
  let current = error;
  for (let level = 0; current && level < 5; level += 1) {
    const code = current instanceof SmokeInterrupted ? current.exitCode : childInterruptCode(current);
    if (code !== undefined) return code;
    current = current.cause;
  }
  return undefined;
}

/** An error that is only warned about must still end the run as interrupted. The first recorded code stays. */
export function recordInterrupt(error, target = process) {
  const code = childInterruptCode(error);
  if (code !== undefined && target.exitCode !== 130 && target.exitCode !== 143) target.exitCode = code;
  return code;
}

/**
 * Keep the process alive until a blocked child returns, then let its caller's finally blocks finish.
 * A second signal that reaches these listeners gets its default action.
 */
export function holdInterrupts(signals = process, kill = (pid, signal) => process.kill(pid, signal)) {
  let held = false;
  const listeners = [['SIGINT', 130], ['SIGTERM', 143]].map(([signal, code]) => {
    const listener = () => {
      if (!held) {
        held = true;
        signals.exitCode = code;
        return;
      }
      for (const [name, added] of listeners) signals.off(name, added);
      kill(process.pid, signal);
    };
    signals.on(signal, listener);
    return [signal, listener];
  });
}

/** Cleanup must neither replace the check's result nor skip subsequent cleanup. */
export function removeImage(image, run = execFileSync, warn = console.warn, target = process) {
  // SIGKILL: the default SIGTERM leaves execFileSync blocked past its timeout if the client ignores it.
  try { run('docker', ['image', 'rm', '--force', image], { stdio: 'pipe', timeout: 120_000, killSignal: 'SIGKILL' }); }
  catch (error) {
    warn(`::warning::Could not remove image ${image}: ${error.message}`);
    recordInterrupt(error, target);
  }
}

/** Keep the smoke script beside its own Compose configuration and other fixtures. */
export function withPreviousTree(commit, operation, runGit = git, warn = console.warn, target = process) {
  const worktree = resolve(runGit(['rev-parse', '--path-format=absolute', '--git-common-dir']), '..', '.worktrees', `previous-code-${randomUUID()}`);
  runGit(['worktree', 'add', '--detach', worktree, commit]);
  try { return operation(worktree); }
  finally {
    try { runGit(['worktree', 'remove', '--force', worktree]); }
    catch (error) {
      warn(`::warning::Could not remove worktree ${worktree}: ${error.message}`);
      recordInterrupt(error, target);
    }
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
  // Older parsers reject an empty operator setting. Supply explicit smoke inputs so the
  // current Compose file can delegate defaults to the new app without breaking the old harness.
  replace(/^ {2}GYM_HOSTNAME: .*$/m, `  GYM_HOSTNAME: 'gym.localhost', ACME_EMAIL: 'test@example.org',
  AUTH_PASSWORD_LOGIN: 'on', RATE_LIMIT_PER_MINUTE: '20000', DATABASE_POOL_MAX: '4',
  PUBLIC_ORIGIN: 'https://gym.localhost', PACKS_DIR: '/app/packs',`);
  replace(/^const compose = .*;$/m, `const migrationRoot = ${JSON.stringify(currentDeployment)};
const migrationPrefix = ['compose', '--project-directory', migrationRoot, '--env-file', envFile, '-p', project, '-f', join(migrationRoot, 'compose.yaml')];
const compose = (args, options) => {
  const migrating = options?.env?.APP_IMAGE === process.env.SMOKE_MIGRATE_IMAGE;
  try { return docker([...(migrating ? migrationPrefix : prefix), ...args], options); }
  catch (error) { throw new Error((migrating ? 'Migrate new image under current deployment files' : 'Run previous image under selected deployment files') + ': ' + error.message, { cause: error }); }
};`);
  if (deployment === currentDeployment) source = compatibilityAssertions(source);
  return source;
}

/** The current-files run checks the older application, without pinning the older deployment's shape.
 * Keep the previous-files run's complete assertions. Refuse unknown boundaries rather than removing
 * arbitrary assertions from a published harness.
 */
export function compatibilityAssertions(source) {
  for (const [start, end] of [
    ["  for (const file of ['Caddyfile', 'demo/Caddyfile']) {", "  assert.equal(docker("],
    ["  assert.equal(configuration.Config.User,", "  compose(['exec', '-T', 'app', '/app/deploy/database.sh', 'migrate']);"],
    ["  assert.equal(compose(['exec', '-T', 'caddy', 'cat', '/proc/sys/net/ipv4/tcp_wmem'])", "  const caPath ="],
  ]) {
    const first = source.indexOf(start), last = source.indexOf(end, first);
    if (first < 0 || last <= first) throw new Error(`Previous smoke harness has no supported deployment assertion boundary: ${start}`);
    source = source.slice(0, first) + source.slice(last);
  }
  return source.replace(/ {2}console\.log\('PASS: .*'\);/, "  console.log('PASS: previous application compatibility with current deployment files.');");
}

/**
 * Remove only the caller's unique project, even when the child never gets to its finally block.
 * Every kind is still attempted after an interrupted call; returns the first interrupt's exit code.
 */
export function removeSmokeProject(project, run = execFileSync, warn = console.warn, target = process) {
  let interrupted;
  const failed = (error, message) => {
    warn(`::warning::${message}: ${error.message}`);
    const code = recordInterrupt(error, target);
    interrupted ??= code;
  };
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
        catch (error) { failed(error, `Could not remove ${project} ${kind} ${name}`); }
      }
    } catch (error) { failed(error, `Could not list ${project} ${kind}`); }
  }
  return interrupted;
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
    let interrupted;
    try {
      writeFileSync(script, adaptPreviousSmoke(source, deployment, resolve(root, 'deploy'), project));
      run(process.execPath, [fileURLToPath(new URL('./run-smoke.mjs', import.meta.url)), script, previousImage],
        { cwd: tree, stdio: 'inherit', timeout: 915_000, killSignal: 'SIGKILL',
        env: { ...process.env, SMOKE_MIGRATE_IMAGE: image, VERSION: variable('APP_VERSION'), SOURCE_URL: variable('SOURCE_URL') } });
    } catch (error) {
      const exitCode = childInterruptCode(error);
      if (exitCode !== undefined) throw new SmokeInterrupted(exitCode, { cause: error });
      throw new Error(`${description} failed: ${error.message}`, { cause: error });
    } finally {
      interrupted = removeSmokeProject(project, run);
      try { rmSync(script, { force: true }); }
      catch (error) { console.warn(`::warning::Could not remove compatibility harness ${script}: ${error.message}`); }
    }
    // Reached only after a passing smoke: a smoke error is already on its way out and keeps priority.
    if (interrupted !== undefined) throw new SmokeInterrupted(interrupted);
  }
}
