// SPDX-License-Identifier: AGPL-3.0-only
// The memory check (deploy/test/memory/README.md): the shipped Compose stack under its shipped limits, then again without
// limits, each sampled while a representative workload runs, judged against budget.mjs.
//
//   node deploy/test/memory/run.mjs [--mode capped|uncapped|both] [--image TAG] [--inject-leak] [--out DIR]
//
// Exit codes: 0 within the budget, 2 the budget was exceeded or something was killed, 1 the harness itself failed
// (a failed run proves nothing and is never reported as a pass).
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { budget, evaluate, report, summarize } from './budget.mjs';

const here = fileURLToPath(new URL('./', import.meta.url)), deploy = resolve(here, '../..'), root = resolve(deploy, '..');
const nodeImage = 'node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205';
const options = { mode: 'both', image: process.env.MEMORY_IMAGE ?? '', leak: false, out: join(here, 'out') };
for (let index = 2; index < process.argv.length; index++) {
  const flag = process.argv[index];
  if (flag === '--mode') options.mode = process.argv[++index];
  else if (flag === '--image') options.image = process.argv[++index];
  else if (flag === '--out') options.out = resolve(process.argv[++index]);
  else if (flag === '--inject-leak') options.leak = true;
  else throw new Error('Unknown option ' + flag);
}
if (!['capped', 'uncapped', 'both'].includes(options.mode)) throw new Error('--mode is capped, uncapped or both');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const log = (line) => console.log(`[memory ${new Date().toISOString().slice(11, 19)}] ${line}`);

function run(binary, args, { input, allowFailure = false, quiet = true, cwd = root } = {}) {
  return new Promise((done, fail) => {
    const child = spawn(binary, args, { cwd, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '', error = '';
    child.stdout.on('data', (chunk) => { out += chunk; if (!quiet) process.stdout.write(chunk); });
    child.stderr.on('data', (chunk) => { error += chunk; if (!quiet) process.stderr.write(chunk); });
    child.on('error', fail);
    if (input !== undefined) child.stdin.end(input);
    child.on('exit', (code) => (code === 0 || allowFailure ? done({ code, out, error }) : fail(new Error(`${binary} ${args.slice(0, 3).join(' ')} exited ${code}: ${(error || out).slice(-600)}`))));
  });
}
const docker = (...args) => run('docker', args);

/** Build the committed source into the production image, as the End-to-end workflow does. */
async function buildImage() {
  const tag = 'plaingym:memory-' + randomBytes(4).toString('hex');
  log('building ' + tag + ' from committed HEAD');
  await new Promise((done, fail) => {
    const archive = spawn('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, 'archive', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
    const build = spawn('docker', ['build', '-t', tag, '-f', 'deploy/Dockerfile', '-'], { cwd: root, stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true });
    archive.stdout.pipe(build.stdin);
    build.stdin.on('error', () => {});
    let pending = 2, failed = false;
    for (const child of [archive, build]) {
      child.on('error', fail);
      child.on('exit', (code) => { if (code !== 0 && !failed) { failed = true; fail(new Error('Image build failed')); } if (--pending === 0 && !failed) done(); });
    }
  });
  return tag;
}

async function oneRun(mode, image) {
  const id = randomBytes(4).toString('hex'), project = 'plaingym-memory-' + id, sampler = project + '-sampler';
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
  const mark = (name) => docker('exec', sampler, 'node', '/harness/mark.mjs', name);
  const loadContainer = (command, extra = []) => ['run', '--rm', '--cpus', '1', '--network', project + '_web', '-v', `${out}:/out`, '-v', `${here}:/harness:ro`,
    '-e', 'GYM_HOST=gym.localhost', '-e', 'PROXY_HOST=caddy', '-e', 'SETUP_TOKEN=' + secrets.setupToken, '-e', 'S3_ENDPOINT=http://s3:7070',
    '-e', 'S3_ACCESS_KEY=' + secrets.s3Access, '-e', 'S3_SECRET_KEY=' + secrets.s3Secret, '-e', 'STATE_FILE=/out/state.json', ...extra,
    nodeImage, 'nice', '-n', '10', 'timeout', '600', 'node', '/harness/load.mjs', command];
  const psql = (sql) => run('docker', [...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'plaingym', '-v', 'ON_ERROR_STOP=1', '-At', '-c', sql]);
  try {
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
    await mark('ready');
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
    await mark('loadStart');
    const traffic = run('docker', loadContainer('load', ['-e', 'LOAD_SECONDS=45', '-e', 'LOAD_WORKERS=20']), { allowFailure: true, quiet: false });
    await sleep(5000);
    const backup = run('docker', [...compose, 'exec', '-T', 'app', 'node', '/app/maintenance.mjs', 'snapshot'], { allowFailure: true });
    if (options.leak) {
      // A stand-in for a leak: a process in the app's cgroup that keeps 160 MiB it has touched.
      await sleep(3000);
      await run('docker', [...compose, 'exec', '-T', '-d', 'app', 'node', '-e',
        "const keep=[];let n=0;const t=setInterval(()=>{keep.push(Buffer.alloc(8<<20,1));if(++n>=20)clearInterval(t)},100);setTimeout(()=>{},120000)"]);
    }
    const [load, snapshot] = await Promise.all([traffic, backup]);
    await mark('loadEnd');
    if (load.code !== 0) throw new Error('The load did not run cleanly (exit ' + load.code + '): ' + load.out.slice(-500));
    if (snapshot.code !== 0) throw new Error('The backup under load failed: ' + (snapshot.error || snapshot.out).slice(-400));
    await sleep(12_000);
    await mark('settled');
    await docker('stop', '-t', '5', sampler);
    const facts = { containers: {}, nodeOptions: undefined, jobs: (await psql('select status || \':\' || count(*) from jobs group by status order by status')).out.trim().split('\n') };
    for (const service of ['app', 'postgres', 'caddy']) {
      const [state] = JSON.parse((await docker('inspect', short[service])).out);
      facts.containers[service] = { oomKilled: state.State.OOMKilled, restarts: state.RestartCount };
      if (service === 'app') facts.nodeOptions = (state.Config.Env.find((entry) => entry.startsWith('NODE_OPTIONS=')) ?? '').slice(13);
    }
    const samples = (await readFile(join(out, 'samples.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    const marks = Object.fromEntries((await readFile(join(out, 'marks.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line)).map((entry) => [entry.mark, entry.at]));
    const summary = summarize(samples, marks);
    const violations = evaluate(summary, { mode, facts });
    await writeFile(join(out, 'summary.json'), JSON.stringify({ mode, image, budget, summary, facts, marks, violations, leakInjected: options.leak }, null, 2));
    console.log(report(summary, violations, mode));
    console.log('jobs: ' + (facts.jobs.join(', ') || 'none'));
    return violations;
  } finally {
    await run('docker', ['rm', '-f', '-v', sampler], { allowFailure: true });
    await run('docker', [...compose, 'down', '--volumes', '--remove-orphans'], { allowFailure: true });
    await rm(work, { recursive: true, force: true });
  }
}

let built = '';
try {
  const image = options.image || (built = await buildImage());
  const modes = options.mode === 'both' ? ['capped', 'uncapped'] : [options.mode];
  const violations = [];
  for (const mode of modes) violations.push(...(await oneRun(mode, image)).map((line) => `${mode}: ${line}`));
  if (violations.length) {
    console.error('\nMemory check FAILED:\n  - ' + violations.join('\n  - '));
    process.exitCode = 2;
  } else console.log('\nMemory check passed.');
} catch (error) {
  console.error('Memory check could not run: ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
} finally {
  if (built) await run('docker', ['rmi', built], { allowFailure: true });
}
