// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { git } from '../../scripts/release/version.mjs';
import { withFetchedPreviousTree } from './previous-minor.mjs';

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
