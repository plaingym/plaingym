// SPDX-License-Identifier: AGPL-3.0-only
// The memory check (deploy/test/memory/README.md): the shipped Compose stack under its shipped limits, then again without
// limits, each sampled while a representative workload runs, judged against budget.mjs.
//
//   node deploy/test/memory/run.mjs [--mode capped|uncapped|both] [--image TAG] [--inject-leak [--leak-mib N]] [--out DIR]
//
// Exit codes: 0 within the budget, 2 the budget was exceeded or something was killed, 1 the harness itself failed
// (a failed run proves nothing and is never reported as a pass).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assessRun, budget, report, resolveMarks, summarize } from './budget.mjs';

const here = fileURLToPath(new URL('./', import.meta.url)), deploy = resolve(here, '../..'), root = resolve(deploy, '..');
const nodeImage = 'node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205';
const options = { mode: 'both', image: process.env.MEMORY_IMAGE ?? '', leak: false, leakMiB: 160, out: join(here, 'out') };
for (let index = 2; import.meta.main && index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === '--mode') options.mode = process.argv[++index];
  else if (flag === '--image') options.image = process.argv[++index];
  else if (flag === '--out') options.out = resolve(process.argv[++index]);
  else if (flag === '--inject-leak') options.leak = true;
  else if (flag === '--leak-mib') options.leakMiB = Number(process.argv[++index]);
  else throw new Error('Unknown option ' + flag);
}
if (!['capped', 'uncapped', 'both'].includes(options.mode)) throw new Error('--mode is capped, uncapped or both');
if (!Number.isSafeInteger(options.leakMiB) || options.leakMiB < 1 || options.leakMiB > 4096) throw new Error('--leak-mib must be an integer from 1 to 4096');
const controller = new AbortController();
const sleep = (ms) => delay(ms, undefined, { signal: controller.signal });
const log = (line) => console.log(`[memory ${new Date().toISOString().slice(11, 19)}] ${line}`);

// A hung command is killed after this long. It sits above the slowest step's own limits: the loaders' `timeout 600`,
// and `compose up --wait-timeout 240` after its image pulls.
const commandTimeoutMs = 900_000, cleanupTimeoutMs = 120_000;

function run(binary, args, { input, allowFailure = false, quiet = true, cwd = root, cleanup = false } = {}) {
  return new Promise((done, fail) => {
    const timeout = cleanup ? cleanupTimeoutMs : commandTimeoutMs;
    const child = spawn(binary, args, { cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: cleanup && process.platform !== 'win32',
      signal: cleanup ? undefined : controller.signal, timeout, killSignal: 'SIGKILL' });
    let out = '', error = '', spawnError;
    child.stdout.on('data', (chunk) => { out += chunk; if (!quiet) process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { error += chunk; if (!quiet) process.stderr.write(chunk); });
    child.on('error', (error) => { spawnError = error; });
    if (input !== undefined) child.stdin.end(input);
    child.on('close', (code, signal) => {
      const ended = code === null ? `was killed (${signal}${signal === 'SIGKILL' ? `, possibly after its ${timeout / 1000} s limit` : ''})` : `exited ${code}`;
      if (spawnError) fail(spawnError);
      else if (code === 0 || allowFailure) done({ code, out, error });
      else fail(new Error(`${binary} ${args.slice(0, 3).join(' ')} ${ended}: ${(error || out).slice(-600)}`));
    });
  });
}
const docker = (...args) => run('docker', args);

/** Cleanup must attempt every step and preserve either a completed result or the original run error. */
export async function withCleanup(operation, cleanups, logFailure = console.error) {
  let result;
  try {
    result = await operation();
    return result;
  } finally {
    for (const [name, cleanup] of cleanups) {
      try { await cleanup(); }
      catch (error) {
        const message = `${name}: ${error.message}`;
        logFailure('Cleanup failed: ' + message);
        if (result) {
          (result.cleanupFailures ??= []).push(message);
          result.exitCode = Math.max(1, result.exitCode);
        }
      }
    }
  }
}

/** Build the committed source into the production image, as the End-to-end workflow does. */
async function buildImage(tag) {
  log('building ' + tag + ' from committed HEAD');
  await new Promise((done, fail) => {
    const childOptions = { cwd: root, windowsHide: true, signal: controller.signal, timeout: 1_200_000, killSignal: 'SIGKILL' };
    const archive = spawn('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'archive', 'HEAD'], { ...childOptions, stdio: ['ignore', 'pipe', 'inherit'] });
    const build = spawn('docker', ['build', '-t', tag, '-f', 'deploy/Dockerfile', '-'], { ...childOptions, stdio: ['pipe', 'inherit', 'inherit'] });
    archive.stdout.pipe(build.stdin);
    build.stdin.on('error', () => {});
    let pending = 2, failure;
    for (const child of [archive, build]) {
      child.on('error', (error) => { failure ??= error; });
      child.on('close', (code) => {
        if (code !== 0) {
          failure ??= new Error('Image build failed');
          for (const other of [archive, build]) if (other !== child) other.kill('SIGKILL');
        }
        if (--pending === 0) { if (failure) fail(failure); else done(); }
      });
    }
  });
}

async function oneRun(mode, image) {
  const id = randomBytes(4).toString('hex'), project = 'plaingym-memory-' + id, sampler = project + '-sampler';
  const loaders = new Set();
  const work = await mkdtemp(join(tmpdir(), project + '-')), out = join(options.out, mode);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const token = () => randomBytes(24).toString('hex');
  const secrets = { setupToken: token(), s3Access: 'memory' + token().slice(0, 8), s3Secret: token() };
  const limit = mode === 'capped' ? {} : { APP_MEMORY_LIMIT: '16g', POSTGRES_MEMORY_LIMIT: '16g', CADDY_MEMORY_LIMIT: '16g', NODE_OPTIONS: '--no-deprecation' };
  const envFile = join(work, '.env');
  await writeFile(envFile, Object.entries({
    APP_IMAGE: image, GYM_HOSTNAME: 'gym.localhost', ACME_EMAIL: 'memory@example.invalid',
    POSTGRES_PASSWORD: token(), APP_PASSWORD: token(), MAINTENANCE_PASSWORD: token(),
    APP_ENCRYPTION_KEY: randomBytes(32).toString('hex'), AUTH_SECRET: token() + token(), SETUP_TOKEN: secrets.setupToken,
    // The traffic comes from one address; the default 300 a minute per gym and address would turn most of it into 429s.
    RATE_LIMIT_PER_MINUTE: '100000', MEMORY_S3_ACCESS_KEY: secrets.s3Access, MEMORY_S3_SECRET_KEY: secrets.s3Secret, ...limit,
  }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
  const compose = ['compose', '--project-name', project, '--project-directory', deploy, '--env-file', envFile,
    '-f', join(deploy, 'compose.yaml'), '-f', join(here, 'compose.memory.yaml')];
  const saveSummary = (result) => writeFile(join(out, 'summary.json'), JSON.stringify(result, null, 2));
  const phaseTimes = {};
  const mark = (name) => {
    // A restart may stop the sampler before it can record the final marks. Keep bounds for the samples it did record.
    phaseTimes[name] = Date.now();
    return docker('exec', sampler, 'node', '/harness/mark.mjs', name);
  };
  const loadContainer = (command, extra = []) => {
    const name = project + '-' + command;
    loaders.add(name);
    return ['run', '--rm', '--name', name, '--cpus', '1', '--network', project + '_web', '-v', `${out}:/out`, '-v', `${here}:/harness:ro`,
    '-e', 'GYM_HOST=gym.localhost', '-e', 'PROXY_HOST=caddy', '-e', 'SETUP_TOKEN=' + secrets.setupToken, '-e', 'S3_ENDPOINT=http://s3:7070',
    '-e', 'S3_ACCESS_KEY=' + secrets.s3Access, '-e', 'S3_SECRET_KEY=' + secrets.s3Secret, '-e', 'STATE_FILE=/out/state.json', ...extra,
    nodeImage, 'nice', '-n', '10', 'timeout', '600', 'node', '/harness/load.mjs', command];
  };
  const psql = (sql) => run('docker', [...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'plaingym', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);
  const result = await withCleanup(async () => {
    log(`${mode}: starting ${project}`);
    await run('docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '240'], { quiet: false });
    const ids = {}, short = {};
    for (const service of ['app', 'postgres', 'caddy']) {
      short[service] = (await run('docker', [...compose, 'ps', '-q', service])).out.trim();
      ids[service] = (await docker('inspect', '--format', '{{.Id}}', short[service])).out.trim();
    }
    await run('docker', ['run', '-d', '--name', sampler, '--privileged', '--pid=host', '--cgroupns=host', '--cpus', '0.25',
      '-v', `${out}:/out`, '-v', `${here}:/harness:ro`, '-e', 'SERVICES=' + JSON.stringify(ids), '-e', 'SAMPLES_OUT=/out/samples.jsonl',
      nodeImage, 'nice', '-n', '10', 'timeout', '3000', 'node', '/harness/sampler.mjs']);
    for (let attempt = 0; ; attempt++) {
      if ((await run('docker', ['exec', sampler, 'test', '-s', '/out/samples.jsonl'], { allowFailure: true })).code === 0) break;
      if (attempt > 40) throw new Error('The sampler produced no samples: ' + (await docker('logs', sampler)).error.slice(-400));
      await sleep(500);
    }
    const failures = [], bookkeepingFailures = [];
    const attempt = async (name, operation, target = bookkeepingFailures) => {
      try { return await operation(); }
      catch (error) {
        controller.signal.throwIfAborted();
        target.push(`${name}: ${error.message}`);
      }
    };
    await attempt('ready mark', () => mark('ready'));
    await attempt('workload', async () => {
      log('stack up; running the setup wizard through the API');
      await run('docker', loadContainer('setup'), { quiet: false });
      await run('docker', loadContainer('seed'), { quiet: false });
      // A database bigger than shared_buffers, fully cached: Postgres at its warm worst, as the spike measured it.
      await psql('create extension if not exists pg_prewarm');
      await psql("create table memory_ballast as select g as id, repeat(md5(g::text), 20) as payload from generate_series(1, 180000) g");
      await psql('grant select on memory_ballast to maintenance');
      await psql("select pg_prewarm('memory_ballast')");
      log('seeded; settling before the load');
      await sleep(10_000);
      await attempt('loadStart mark', () => mark('loadStart'));
      // Attach handlers immediately: a failed spawn or an interrupt must not leave an unhandled rejection.
      const observe = (name, operation) => attempt(name, async () => {
        const result = await operation();
        if (result.code !== 0) failures.push(`${name} exited ${result.code}: ${(result.error || result.out).slice(-500)}`);
      }, failures);
      await Promise.allSettled([
        observe('load', () => run('docker', loadContainer('load', ['-e', 'LOAD_SECONDS=45', '-e', 'LOAD_WORKERS=20']), { allowFailure: true, quiet: false })),
        observe('backup', async () => {
          await sleep(5000);
          return run('docker', [...compose, 'exec', '-T', 'app', 'node', '/app/maintenance.mjs', 'snapshot'], { allowFailure: true });
        }),
        options.leak ? attempt('leak injection', async () => {
          // A process in the app's cgroup retains touched buffers, up to --leak-mib (160 MiB by default).
          await sleep(8000);
          await run('docker', [...compose, 'exec', '-T', '-d', 'app', 'node', '-e',
            `const keep=[];let left=${options.leakMiB};const t=setInterval(()=>{const n=Math.min(8,left);keep.push(Buffer.alloc(n*1048576,1));if((left-=n)<=0)clearInterval(t)},100);setTimeout(()=>{},120000)`]);
        }, failures) : Promise.resolve(),
      ]);
      controller.signal.throwIfAborted();
    }, failures);
    await attempt('loadEnd mark', () => mark('loadEnd'));
    await sleep(12_000);
    await attempt('settled mark', () => mark('settled'));
    await attempt('stop sampler', () => docker('stop', '-t', '5', sampler));
    const facts = { containers: {}, nodeOptions: undefined, jobs: [] };
    for (const service of ['app', 'postgres', 'caddy']) {
      await attempt('inspect ' + service, async () => {
        const [state] = JSON.parse((await docker('inspect', short[service])).out);
        facts.containers[service] = { oomKilled: state.State.OOMKilled, restarts: state.RestartCount, exitCode: state.State.ExitCode };
        if (service === 'app') facts.nodeOptions = (state.Config.Env.find((entry) => entry.startsWith('NODE_OPTIONS=')) ?? '').slice(13);
      });
    }
    await attempt('job counts', async () => { facts.jobs = (await psql('select status || \':\' || count(*) from jobs group by status order by status')).out.trim().split('\n'); });
    let summary = null, { marks, clock } = resolveMarks(phaseTimes, {});
    await attempt('phase marks', async () => {
      let recorded = '';
      try { recorded = await readFile(join(out, 'marks.jsonl'), 'utf8'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      ({ marks, clock } = resolveMarks(phaseTimes, Object.fromEntries(recorded.trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line)).map((entry) => [entry.mark, entry.at]))));
    });
    await attempt('sampler results', async () => {
      const samples = (await readFile(join(out, 'samples.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      summary = summarize(samples, marks);
    });
    const finished = { mode, image, budget, summary, facts, marks, clock, ...assessRun(summary, { mode, facts, failures, bookkeepingFailures }),
      failures, bookkeepingFailures, cleanupFailures: [], leakInjected: options.leak, leakMiB: options.leak ? options.leakMiB : 0 };
    // Written before cleanup so a hung teardown can't lose the result, and again afterwards for its failures.
    await saveSummary(finished);
    return finished;
  }, [
    // Abort stops Docker clients, not their containers. Remove the named loaders too, then the Compose volumes.
    ['remove sampler and loaders', async () => {
      const removed = await run('docker', ['rm', '-f', '-v', sampler, ...loaders], { allowFailure: true, cleanup: true });
      // Loaders use --rm, and an interrupted setup may never have created the sampler.
      const errors = removed.error.trim().split('\n').filter(Boolean);
      if (removed.code !== 0 && (!errors.length || errors.some((line) => !line.startsWith('Error response from daemon: No such container:')))) {
        throw new Error(removed.error || removed.out || 'docker rm failed');
      }
    }],
    ['compose down', () => run('docker', [...compose, 'down', '--volumes', '--remove-orphans'], { cleanup: true })],
    ['remove temporary files', () => rm(work, { recursive: true, force: true })],
  ]);
  await saveSummary(result);
  if (result.summary) console.log(report(result.summary, [...result.violations, ...result.cleanupFailures], mode));
  else console.error('No memory summary: ' + result.violations.join('; '));
  console.log('jobs: ' + (result.facts.jobs.join(', ') || 'none'));
  return result;
}

async function main() {
  let built = '', interrupted;
  const onSignal = (signal) => {
    if (interrupted) return;
    interrupted = signal;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    log(signal + ': stopping the run and removing its resources');
    controller.abort(new Error('Interrupted by ' + signal));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const image = options.image || 'plaingym:memory-' + randomBytes(4).toString('hex');
    if (!options.image) {
      await buildImage(image);
      built = image;
    }
    const modes = options.mode === 'both' ? ['capped', 'uncapped'] : [options.mode];
    const violations = [];
    for (const mode of modes) {
      controller.signal.throwIfAborted();
      const result = await oneRun(mode, image);
      controller.signal.throwIfAborted();
      violations.push(...[...result.violations, ...result.cleanupFailures].map((line) => `${mode}: ${line}`));
      process.exitCode = Math.max(process.exitCode ?? 0, result.exitCode);
    }
    if (violations.length) console.error('\nMemory check FAILED:\n  - ' + violations.join('\n  - '));
    else console.log('\nMemory check passed.');
  } catch (error) {
    console.error('Memory check could not run: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = interrupted === 'SIGINT' ? 130 : interrupted === 'SIGTERM' ? 143 : 1;
  } finally {
    try {
      if (built) await run('docker', ['rmi', built], { cleanup: true });
    } catch (error) {
      console.error('Cleanup failed: remove built image: ' + error.message);
      process.exitCode = Math.max(1, process.exitCode ?? 0);
    }
    finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
}
if (import.meta.main) await main();
