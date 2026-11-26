// SPDX-License-Identifier: AGPL-3.0-only
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from '../../scripts/release/version.mjs';

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
 * Run a child without blocking the event loop, so signal listeners run while it works. It takes the options
 * execFileSync takes here and settles the same way: stdout (a string with `encoding`, else a Buffer, or '' when
 * stdout isn't piped); on a timeout, kills the child with `killSignal` and rejects with code ETIMEDOUT; on a
 * non-zero exit, rejects with `status`, `signal`, `stdout` and `stderr`. As there, a piped stdin is closed at once, and
 * without `stdio` the child's stderr is also written to this process's stderr.
 */
export function runChild(binary, args, options = {}) {
  const { cwd, env, stdio = 'pipe', encoding, timeout, killSignal = 'SIGTERM' } = options;
  const echoStderr = options.stdio === undefined;
  const command = [binary, ...args].join(' ');
  return new Promise((resolvePromise, reject) => {
    let child, timer, timedOut = false, settled = false;
    const settle = (action) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    try { child = spawn(binary, args, { cwd, env, stdio, windowsHide: true }); }
    catch (error) { reject(error); return; }
    child.stdin?.on('error', () => { /* A child that exits first closes its end. */ });
    child.stdin?.end();
    const stdout = [], stderr = [];
    child.stdout?.on('data', (chunk) => stdout.push(chunk));
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    const output = (chunks, stream) => {
      if (!stream) return encoding ? '' : null;
      const buffer = Buffer.concat(chunks);
      return encoding ? buffer.toString(encoding) : buffer;
    };
    // A descendant holding a pipe open must not keep a timed-out call waiting, whether the child exits before or after
    // the timeout.
    let exited = false;
    const release = () => { child.stdout?.destroy(); child.stderr?.destroy(); };
    if (timeout > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        if (exited) release();
        else try { child.kill(killSignal); } catch { /* The child already exited. */ }
      }, timeout);
    }
    child.once('error', (error) => settle(() => reject(error)));
    child.once('exit', () => { exited = true; if (timedOut) release(); });
    child.once('close', (status, signal) => settle(() => {
      if (echoStderr && stderr.length) process.stderr.write(Buffer.concat(stderr));
      const out = output(stdout, child.stdout), err = output(stderr, child.stderr);
      if (timedOut) {
        reject(Object.assign(new Error(`${command} ETIMEDOUT after ${timeout} ms`),
          { code: 'ETIMEDOUT', status, signal: signal ?? killSignal, stdout: out, stderr: err }));
      } else if (status !== 0 || signal) {
        const detail = err?.length ? `\n${err.toString()}` : '';
        reject(Object.assign(new Error(`Command failed: ${command}${detail}`), { status, signal, stdout: out, stderr: err }));
      } else resolvePromise(child.stdout ? out : '');
    }));
  });
}

/** `git` from scripts/release/version.mjs, through runChild. */
export async function gitChild(args, cwd = root, { timeout = 120_000 } = {}) {
  const output = await runChild('git', args, { cwd, encoding: 'utf8', timeout, killSignal: 'SIGKILL',
    env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
  return output.trim();
}

/**
 * Keep the process alive until a blocked child returns, then let its caller's finally blocks finish.
 * The first code recorded stays. A second signal that reaches these listeners gets its default action.
 */
export function holdInterrupts(signals = process, kill = (pid, signal) => process.kill(pid, signal)) {
  let held = false;
  const listeners = [['SIGINT', 130], ['SIGTERM', 143]].map(([signal, code]) => {
    const listener = () => {
      if (!held) {
        held = true;
        if (signals.exitCode !== 130 && signals.exitCode !== 143) signals.exitCode = code;
        return;
      }
      for (const [name, added] of listeners) signals.off(name, added);
      kill(process.pid, signal);
    };
    signals.on(signal, listener);
    return [signal, listener];
  });
}

/** Stop before starting another child once an interrupt is held. Never called before a cleanup child. */
export function checkInterrupt(target = process) {
  if (target.exitCode === 130 || target.exitCode === 143) throw new SmokeInterrupted(target.exitCode);
}

/** Cleanup must neither replace the check's result nor skip subsequent cleanup. */
export async function removeImage(image, run = runChild, warn = console.warn, target = process) {
  // SIGKILL: the default SIGTERM leaves the call blocked past its timeout if the client ignores it.
  try { await run('docker', ['image', 'rm', '--force', image], { stdio: 'pipe', timeout: 120_000, killSignal: 'SIGKILL' }); }
  catch (error) {
    warn(`::warning::Could not remove image ${image}: ${error.message}`);
    recordInterrupt(error, target);
  }
}

/** Keep the smoke script beside its own Compose configuration and other fixtures. */
export async function withPreviousTree(commit, operation, runGit = gitChild, warn = console.warn, target = process) {
  checkInterrupt(target);
  const worktree = resolve(await runGit(['rev-parse', '--path-format=absolute', '--git-common-dir']), '..', '.worktrees', `previous-code-${randomUUID()}`);
  checkInterrupt(target);
  await runGit(['worktree', 'add', '--detach', worktree, commit]);
  try { return await operation(worktree); }
  finally {
    try { await runGit(['worktree', 'remove', '--force', worktree]); }
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
 * Every kind is still attempted after an interrupted call, and a pass that recorded an interrupt gets one more pass
 * over every kind for what it left; returns the first interrupt's exit code.
 */
export async function removeSmokeProject(project, run = runChild, warn = console.warn, target = process) {
  let interrupted;
  const failed = (error, message) => {
    warn(`::warning::${message}: ${error.message}`);
    const code = recordInterrupt(error, target);
    interrupted ??= code;
  };
  const pass = async () => {
    for (const [kind, list, remove] of [
      ['containers', ['ps', '-aq'], ['rm', '-f', '-v']],
      ['networks', ['network', 'ls', '-q'], ['network', 'rm']],
      ['volumes', ['volume', 'ls', '-q'], ['volume', 'rm']],
    ]) {
      try {
        const names = (await run('docker', [...list, '--filter', `label=com.docker.compose.project=${project}`],
          { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' })).trim().split(/\s+/).filter(Boolean);
        for (const name of names) {
          try { await run('docker', [...remove, name], { stdio: 'pipe', timeout: 120_000, killSignal: 'SIGKILL' }); }
          catch (error) { failed(error, `Could not remove ${project} ${kind} ${name}`); }
        }
      } catch (error) { failed(error, `Could not list ${project} ${kind}`); }
    }
  };
  await pass();
  if (interrupted !== undefined) await pass();
  return interrupted;
}

/** Both supported host-file paths: an upgraded install, and an install using the current deployment files. */
export async function smokePreviousImage(previousImage, image, tree, commit, run = runChild) {
  const original = resolve(tree, 'deploy/test/smoke.mjs');
  const source = readFileSync(original, 'utf8');
  checkInterrupt();
  const configuration = JSON.parse(await run('docker', ['image', 'inspect', previousImage], { encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' }))[0];
  const variable = key => configuration.Config.Env.find(entry => entry.startsWith(key + '='))?.slice(key.length + 1);
  for (const deployment of new Set([resolve(tree, 'deploy'), resolve(root, 'deploy')])) {
    checkInterrupt();
    const project = `plaingym-compat-${randomUUID()}`;
    const script = resolve(tree, 'deploy/test', `${project}.mjs`);
    const description = `Smoke test ${commit}:deploy/test/smoke.mjs (${original}) against ${previousImage}, schema migrated by ${image}, deployment files ${deployment}`;
    console.log(description);
    let interrupted;
    try {
      writeFileSync(script, adaptPreviousSmoke(source, deployment, resolve(root, 'deploy'), project));
      await run(process.execPath, [fileURLToPath(new URL('./run-smoke.mjs', import.meta.url)), script, previousImage],
        { cwd: tree, stdio: 'inherit', timeout: 915_000, killSignal: 'SIGKILL',
        env: { ...process.env, SMOKE_MIGRATE_IMAGE: image, VERSION: variable('APP_VERSION'), SOURCE_URL: variable('SOURCE_URL') } });
    } catch (error) {
      const exitCode = childInterruptCode(error);
      if (exitCode !== undefined) throw new SmokeInterrupted(exitCode, { cause: error });
      throw new Error(`${description} failed: ${error.message}`, { cause: error });
    } finally {
      interrupted = await removeSmokeProject(project, run);
      try { rmSync(script, { force: true }); }
      catch (error) { console.warn(`::warning::Could not remove compatibility harness ${script}: ${error.message}`); }
    }
    // Reached only after a passing smoke: a smoke error is already on its way out and keeps priority.
    if (interrupted !== undefined) throw new SmokeInterrupted(interrupted);
  }
}
