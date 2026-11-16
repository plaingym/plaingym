// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
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
