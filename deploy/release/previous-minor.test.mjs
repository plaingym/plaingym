// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { git } from '../../scripts/release/version.mjs';
import { prereleaseFloor, withFetchedPreviousTree } from './previous-minor.mjs';

test('fetches just the previous tag into a shallow checkout and removes its worktree on success or failure', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'previous-minor-'));
  try {
    const origin = join(directory, 'origin'), checkout = join(directory, 'checkout');
    git(['init', '-b', 'main', origin], directory);
    const run = (...args) => git(args, origin);
    run('config', 'user.name', 'Release'); run('config', 'user.email', 'release@example.test');
    run('config', 'commit.gpgsign', 'false'); run('config', 'tag.gpgsign', 'false');
    writeFileSync(join(origin, 'fixture'), 'old'); run('add', '.'); run('commit', '-m', 'fix: old'); run('tag', 'v1.0.0');
    writeFileSync(join(origin, 'fixture'), 'new'); run('commit', '-am', 'fix: new');
    git(['clone', '--depth=1', '--no-tags', pathToFileURL(origin).href, checkout], directory);
    let tree;
    const checkedGit = (args, cwd, options) => {
      if (args[0] === 'fetch') {
        assert.ok(args.includes('--depth=1')); assert.equal(options.timeout, 120_000);
      }
      return git(args, cwd, options);
    };
    for (const fails of [false, true]) {
      const operation = () => withFetchedPreviousTree('v1.0.0', path => {
        tree = path; assert.equal(readFileSync(join(path, 'fixture'), 'utf8'), 'old');
        if (fails) throw new Error('schema mismatch');
      }, checkout, checkedGit);
      if (fails) await assert.rejects(operation(), /schema mismatch/); else await operation();
      assert.equal(existsSync(tree), false);
    }
    await assert.rejects(withFetchedPreviousTree('v9.9.0', () => assert.fail('must not run'), checkout), /fetch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a prerelease keeps the previous one as its floor only when that image passes on the new schema', async () => {
  const logs = [];
  const log = (line) => logs.push(line);
  const smoked = [];
  const passes = async (image, previous) => { smoked.push([image, previous]); };
  const fails = async () => { throw new Error('schema mismatch'); };
  assert.equal(await prereleaseFloor('plaingym:new', 'v1.1.0-nightly.1', undefined, { smoke: () => assert.fail('no previous to run'), log }), 'v1.1.0-nightly.1');
  assert.match(logs.pop(), /first prerelease/);
  assert.equal(await prereleaseFloor('plaingym:new', 'v1.1.0-nightly.2', 'v1.1.0-nightly.1', { smoke: passes, log }), 'v1.1.0-nightly.1');
  // The previous nightly may be of the minor before, once that minor is released and merged into next.
  assert.equal(await prereleaseFloor('plaingym:new', 'v1.2.0-nightly.1', 'v1.1.0-nightly.9', { smoke: passes, log }), 'v1.1.0-nightly.9');
  assert.deepEqual(smoked, [['plaingym:new', 'v1.1.0-nightly.1'], ['plaingym:new', 'v1.1.0-nightly.9']]);
  // A failure, including one pulling the previous image, only raises the floor to the nightly itself.
  assert.equal(await prereleaseFloor('plaingym:new', 'v1.1.0-nightly.3', 'v1.1.0-nightly.2', { smoke: fails, log }), 'v1.1.0-nightly.3');
  assert.match(logs.pop(), /^::warning::v1\.1\.0-nightly\.2 did not pass on v1\.1\.0-nightly\.3's schema \(schema mismatch\)/);
  for (const [tag, previous] of [['v1.0.0', undefined], ['v0.5.1', undefined], ['v0.6.0', 'v0.5.1'], ['v1.1.0-nightly.2', 'v0.5.1'],
    ['v1.1.0-nightly.2', 'v1.1.0'], ['1.1.0-nightly.2', undefined], ['v1.1.0-nightly.2+0.gabc1234', undefined], ['v1.1.1-nightly.1', undefined]])
    await assert.rejects(prereleaseFloor('plaingym:new', tag, previous, { smoke: passes, log }), /vX\.Y\.0-nightly\.N/);
});

test('an interrupted pull is rethrown instead of raising the floor', async () => {
  const logs = [];
  const log = (line) => logs.push(line);
  const interrupted = Object.assign(new Error('pull'), { status: 130 });
  await assert.rejects(prereleaseFloor('plaingym:new', 'v1.1.0-nightly.3', 'v1.1.0-nightly.2', { smoke: async () => { throw interrupted; }, log }),
    (error) => error === interrupted);
  assert.deepEqual(logs, []);
  assert.equal(await prereleaseFloor('plaingym:new', 'v1.1.0-nightly.3', 'v1.1.0-nightly.2', { smoke: () => { throw new Error('schema mismatch'); }, log }), 'v1.1.0-nightly.3');
  assert.match(logs.pop(), /did not pass/);
});

// The real script, with Docker and git replaced on PATH, which takes executable scripts.
test('a prerelease prints its floor only when cleaning up was not interrupted', { skip: process.platform === 'win32' }, (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'prerelease-cleanup-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pulled = join(directory, 'pulled');
  // Only the markers the compatibility run rewrites or removes; the smoke itself passes at once.
  const harness = `import { join } from 'node:path';
const root = 'original';
const project = 'original';
const envFile = 'unused';
const env = {
  GYM_HOSTNAME: 'gym.localhost', ACME_EMAIL: 'test@example.org',
};
const prefix = [];
const compose = null;
process.exit(0);
/*
  for (const file of ['Caddyfile', 'demo/Caddyfile']) {
  assert.equal(docker(
  assert.equal(configuration.Config.User,
  compose(['exec', '-T', 'app', '/app/deploy/database.sh', 'migrate']);
  assert.equal(compose(['exec', '-T', 'caddy', 'cat', '/proc/sys/net/ipv4/tcp_wmem'])
  const caPath =
  // Rollback availability is read-only and must terminate with Postgres down, including pool startup/cleanup.
*/
`;
  const stub = (name, source) => writeFileSync(join(directory, name),
    `#!/usr/bin/env node\nconst fs = require('node:fs'), path = require('node:path'), args = process.argv.slice(2);\n${source}\n`, { mode: 0o755 });
  stub('docker', `const pulled = ${JSON.stringify(pulled)};
if (args[0] === 'pull') fs.writeFileSync(pulled, '');
if (args[0] === 'image' && args[1] === 'inspect') {
  if (!fs.existsSync(pulled)) process.exit(1);
  console.log(JSON.stringify([{ Config: { Env: [] } }]));
}
if (args[0] === 'image' && args[1] === 'rm') process.exit(Number(process.env.STUB_REMOVAL_STATUS));`);
  stub('git', `if (args[0] === 'rev-parse') console.log(${JSON.stringify(join(directory, '.git'))});
if (args[0] === 'worktree' && args[1] === 'add') {
  fs.mkdirSync(path.join(args[3], 'deploy/test'), { recursive: true });
  fs.writeFileSync(path.join(args[3], 'deploy/test/smoke.mjs'), ${JSON.stringify(harness)});
}
if (args[0] === 'worktree' && args[1] === 'remove') fs.rmSync(args[3], { recursive: true, force: true });`);
  for (const [removal, status, floor] of [[0, 0, 'floor=v1.1.0-nightly.2\n'], [130, 130, '']]) {
    rmSync(pulled, { force: true });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./previous-minor.mjs', import.meta.url)), 'plaingym:new', 'v1.1.0-nightly.3', '--prerelease', 'v1.1.0-nightly.2'], {
      encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
      env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, STUB_REMOVAL_STATUS: String(removal) },
    });
    assert.equal(result.status, status, result.stdout + result.stderr);
    // The smoke's own description lines go to stdout too; only the floor line is the result.
    assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('floor=')).map((line) => `${line}\n`).join(''), floor, result.stdout + result.stderr);
  }
});

/**
 * The real prerelease run in its own process group, with docker, git and gh on PATH logging their calls: the previous
 * image is missing, and its pull prints `ready` and then runs for pullMs unless a signal stops it first.
 */
const startPrerelease = (t, pullMs) => {
  const directory = mkdtempSync(join(tmpdir(), 'prerelease-interrupt-'));
  const calls = join(directory, 'calls.log');
  for (const name of ['docker', 'git', 'gh']) {
    writeFileSync(join(directory, name), `#!/usr/bin/env node
const fs = require('node:fs'), args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(name)} + ' ' + args.join(' ') + '\\n');
if (${JSON.stringify(name)} === 'gh') process.exit(1);
if (${JSON.stringify(name)} === 'docker' && args[0] === 'image' && args[1] === 'inspect') process.exit(1);
if (${JSON.stringify(name)} === 'docker' && args[0] === 'pull') {
  console.log('ready');
  setTimeout(() => process.exit(0), ${pullMs});
}
`, { mode: 0o755 });
  }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./previous-minor.mjs', import.meta.url)), 'plaingym:new', 'v1.1.0-nightly.3', '--prerelease', 'v1.1.0-nightly.2'], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}` },
  });
  let output = '', closed = false;
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  t.after(() => {
    if (!closed) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Prerelease run did not exit: ${output}`)), 30_000);
    child.once('close', (code, signal) => {
      closed = true;
      clearTimeout(timer);
      resolve({ code, signal, output, calls: existsSync(calls) ? readFileSync(calls, 'utf8') : '' });
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  const ready = (async () => {
    for (let attempt = 0; attempt < 500 && !output.includes('ready'); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    if (!output.includes('ready')) throw new Error(`The pull never started: ${output}`);
  })();
  return { child, ready, result };
};

test('a terminal SIGINT during a prerelease pull exits 130 and prints no floor', { skip: process.platform === 'win32' }, async (t) => {
  const { child, ready, result } = startPrerelease(t, 60_000);
  await ready;
  process.kill(-child.pid, 'SIGINT');
  const { code, output, calls } = await result;
  assert.equal(code, 130, output + calls);
  assert.doesNotMatch(output, /floor=|did not pass/);
  // The image was missing before the pull, so it is removed after the interrupted one.
  assert.match(calls, /^docker image rm --force /m, calls);
});

test('a SIGTERM to the prerelease run alone during its pull stops it before the fetch and prints no floor', { skip: process.platform === 'win32' }, async (t) => {
  const { child, ready, result } = startPrerelease(t, 2_000);
  await ready;
  process.kill(child.pid, 'SIGTERM');
  const { code, output, calls } = await result;
  assert.equal(code, 143, output + calls);
  assert.doesNotMatch(output, /floor=|did not pass/);
  assert.match(calls, /^docker pull /m, calls);
  assert.doesNotMatch(calls, /fetch/, calls);
});
