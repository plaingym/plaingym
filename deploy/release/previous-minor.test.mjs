// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { git } from '../../scripts/release/version.mjs';
import { prereleaseFloor, withFetchedPreviousTree } from './previous-minor.mjs';

test('fetches just the previous tag into a shallow checkout and removes its worktree on success or failure', () => {
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
      if (fails) assert.throws(operation, /schema mismatch/); else operation();
      assert.equal(existsSync(tree), false);
    }
    assert.throws(() => withFetchedPreviousTree('v9.9.0', () => assert.fail('must not run'), checkout), /fetch/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a prerelease keeps the previous one as its floor only when that image passes on the new schema', () => {
  const logs = [];
  const log = (line) => logs.push(line);
  const smoked = [];
  const passes = (image, previous) => { smoked.push([image, previous]); };
  const fails = () => { throw new Error('schema mismatch'); };
  assert.equal(prereleaseFloor('plaingym:new', 'v0.5.0', undefined, { smoke: () => assert.fail('no previous to run'), log }), 'v0.5.0');
  assert.match(logs.pop(), /first prerelease/);
  assert.equal(prereleaseFloor('plaingym:new', 'v0.5.1', 'v0.5.0', { smoke: passes, log }), 'v0.5.0');
  assert.deepEqual(smoked, [['plaingym:new', 'v0.5.0']]);
  // A failure, including one pulling the previous image, only raises the floor to the release itself.
  assert.equal(prereleaseFloor('plaingym:new', 'v0.6.0', 'v0.5.1', { smoke: fails, log }), 'v0.6.0');
  assert.match(logs.pop(), /^::warning::v0\.5\.1 did not pass on v0\.6\.0's schema \(schema mismatch\)/);
  for (const [tag, previous] of [['v1.0.0', undefined], ['v0.6.0', 'v1.0.0'], ['0.6.0', undefined], ['v0.6.0+0.gabc1234', undefined]])
    assert.throws(() => prereleaseFloor('plaingym:new', tag, previous, { smoke: passes, log }), /v0\.Y\.Z/);
});

test('an interrupted pull is rethrown instead of raising the floor', () => {
  const logs = [];
  const log = (line) => logs.push(line);
  const interrupted = Object.assign(new Error('pull'), { status: 130 });
  assert.throws(() => prereleaseFloor('plaingym:new', 'v0.6.0', 'v0.5.1', { smoke: () => { throw interrupted; }, log }),
    (error) => error === interrupted);
  assert.deepEqual(logs, []);
  assert.equal(prereleaseFloor('plaingym:new', 'v0.6.0', 'v0.5.1', { smoke: () => { throw new Error('schema mismatch'); }, log }), 'v0.6.0');
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
  for (const [removal, status, floor] of [[0, 0, 'floor=v0.5.1\n'], [130, 130, '']]) {
    rmSync(pulled, { force: true });
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./previous-minor.mjs', import.meta.url)), 'plaingym:new', 'v0.6.0', '--prerelease', 'v0.5.1'], {
      encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
      env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, STUB_REMOVAL_STATUS: String(removal) },
    });
    assert.equal(result.status, status, result.stdout + result.stderr);
    // The smoke's own description lines go to stdout too; only the floor line is the result.
    assert.equal(result.stdout.split('\n').filter((line) => line.startsWith('floor=')).map((line) => `${line}\n`).join(''), floor, result.stdout + result.stderr);
  }
});
