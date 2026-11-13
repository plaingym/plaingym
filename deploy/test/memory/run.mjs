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
import { buildInfo } from '../../../scripts/release/version.mjs';

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

export function run(binary, args, { input, allowFailure = false, quiet = true, cwd = root, cleanup = false,
  timeout = cleanup ? cleanupTimeoutMs : commandTimeoutMs, exitGraceMs = 2_000 } = {}) {
  return new Promise((done, fail) => {
    const grouped = cleanup && process.platform !== 'win32';
    const child = spawn(binary, args, { cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true,
      detached: grouped, signal: cleanup ? undefined : controller.signal, killSignal: 'SIGKILL' });
    let out = '', error = '', spawnError, grace, settled = false, timedOut = false;
    const kill = () => {
      try { if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') spawnError ??= error; }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    child.stdout.on('data', (chunk) => { out += chunk; if (!quiet) process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { error += chunk; if (!quiet) process.stderr.write(chunk); });
    child.on('error', (error) => { spawnError = error; });
    if (input !== undefined) child.stdin.end(input);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      const ended = code === null ? `was killed (${signal})` : `exited ${code}`;
      if (spawnError) fail(spawnError);
      else if (timedOut && !allowFailure) fail(new Error(`${binary} timed out after ${timeout} ms`));
      else if (code === 0 || allowFailure) done({ code, out, error, timedOut });
      else fail(new Error(`${binary} ${args.slice(0, 3).join(' ')} ${ended}: ${(error || out).slice(-600)}`));
    };
    child.on('close', finish);
    // Descendants can keep a cleanup command's pipes open after the client exits, so bound that drain too.
    // Other commands wait for 'close': their output is read, and a Compose plugin may still be working.
    if (cleanup) child.on('exit', (code, signal) => {
      grace = setTimeout(() => { kill(); finish(code, signal); }, exitGraceMs);
    });
  });
}
const docker = (...args) => run('docker', args);

/** A sampler publishes a record only once its newline has been written. */
export function parseSamples(text) {
  return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export async function removeContainers(project, names, command = run, settleMs = 10_000) {
  const removed = await command('docker', ['rm', '-f', '-v', ...names], { allowFailure: true, cleanup: true });
  // A --rm loader's own removal can still be finishing, and `docker ps -a` lists it until it does.
  const deadline = Date.now() + settleMs;
  let leftovers;
  for (;;) {
    const remaining = await command('docker', ['ps', '-a', '--filter', `name=${project}`, '--format', '{{.Names}}'], { cleanup: true });
    leftovers = remaining.out.trim().split('\n').filter(name => names.includes(name.trim()));
    if (!leftovers.length || Date.now() >= deadline) break;
    await delay(250);
  }
  if (removed.timedOut || leftovers.length) throw new Error(`Container cleanup ${removed.timedOut ? 'timed out' : 'incomplete'}; remaining: ${leftovers.join(', ') || 'none'}${removed.error ? `: ${removed.error.trim()}` : ''}`);
}

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
    const identity = buildInfo(root);
    const build = spawn('docker', ['build', '--build-arg', `VERSION=${identity.version}`, '--build-arg', `REVISION=${identity.commit}`, '-t', tag, '-f', 'deploy/Dockerfile', '-'], { ...childOptions, stdio: ['pipe', 'inherit', 'inherit'] });
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
  const envFile = join(work, '.env'), caFile = join(work, 'caddy-root.crt');
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
  let autoUpdateCheckPeakRssBytes = null;
  const mark = (name) => {
    // A restart may stop the sampler before it can record the final marks. Keep bounds for the samples it did record.
    phaseTimes[name] = Date.now();
    return docker('exec', sampler, 'node', '/harness/mark.mjs', name);
  };
  const loadContainer = (command, extra = []) => {
    const name = project + '-' + command;
    loaders.add(name);
    return ['run', '--rm', '--name', name, '--cpus', '1', '--network', project + '_web', '-v', `${out}:/out`, '-v', `${here}:/harness:ro`,
    '-v', `${caFile}:/ca/root.crt:ro`, '-e', 'CA_FILE=/ca/root.crt',
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
    // The loaders verify Caddy's certificate against its local CA, which it creates when it first issues one.
    for (let attempt = 0; ; attempt++) {
      if ((await run('docker', ['cp', short.caddy + ':/data/caddy/pki/authorities/local/root.crt', caFile], { allowFailure: true })).code === 0) break;
      if (attempt > 40) throw new Error('Caddy did not create its local CA');
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
      await attempt('autoUpdateCheckStart mark', () => mark('autoUpdateCheckStart'));
      // The CLI's own kernel high-water RSS catches peaks shorter than the cgroup sampler's 500 ms interval.
      const nodeOptions = mode === 'capped' ? '--max-old-space-size=256' : '--no-deprecation';
      const probe = "process.on('exit',()=>console.error('AUTO_UPDATE_CHECK_MAX_RSS='+process.resourceUsage().maxRSS*1024))";
      const checked = await run('docker', [...compose, 'exec', '-T', '-e',
        `NODE_OPTIONS=${nodeOptions} --import=data:text/javascript,${encodeURIComponent(probe)}`,
        'app', 'gym-app', 'auto-update', 'check']);
      autoUpdateCheckPeakRssBytes = Number(/AUTO_UPDATE_CHECK_MAX_RSS=(\d+)/.exec(checked.error)?.[1]);
      if (!(autoUpdateCheckPeakRssBytes > 0) || !checked.out.includes('setup=true')) throw new Error('Missing automatic update check memory evidence');
      log(`auto-update check peak RSS: ${(autoUpdateCheckPeakRssBytes / 1024 ** 2).toFixed(1)} MiB`);
      await attempt('autoUpdateCheckEnd mark', () => mark('autoUpdateCheckEnd'));
      await sleep(2000);
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
    const facts = { containers: {}, nodeOptions: undefined, jobs: [], autoUpdateCheckPeakRssBytes };
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
      const samples = parseSamples(await readFile(join(out, 'samples.jsonl'), 'utf8'));
      summary = summarize(samples, marks);
    });
    const finished = { mode, image, budget, summary, facts, marks, clock, ...assessRun(summary, { mode, facts, failures, bookkeepingFailures }),
      failures, bookkeepingFailures, cleanupFailures: [], leakInjected: options.leak, leakMiB: options.leak ? options.leakMiB : 0 };
    // Written before cleanup so a hung teardown can't lose the result, and again afterwards for its failures.
    await saveSummary(finished);
    return finished;
  }, [
    // Abort stops Docker clients, not their containers. Remove the named loaders too, then the Compose volumes.
    ['remove sampler and loaders', () => removeContainers(project, [sampler, ...loaders])],
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
      console.warn('WARNING: could not remove built image ' + built + ': ' + error.message);
    }
    finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    }
  }
}
if (import.meta.main) await main();
