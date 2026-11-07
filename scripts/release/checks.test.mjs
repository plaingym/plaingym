// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './version.mjs';
import { checkCommits, checkMessage } from './check-commits.mjs';
import { checkMigrations } from './check-migrations.mjs';
import { previousCode } from '../../deploy/release/previous-code.mjs';

test('conventional subjects and session attribution', () => {
  for (const value of ['fix: health', 'feat(api)!: require a setting', 'chore(release): v1.2.0', 'docs: changelog for v1.2.1'])
    assert.doesNotThrow(() => checkMessage(value));
  for (const value of ['Merge branch main', 'fix:no space', 'feat: ', 'fix: health\n\nClaude-Session: private', 'fix: health\n\nhttps://claude.ai/code/session_123'])
    assert.throws(() => checkMessage(value));
});

test('only the requested commits are checked; migrations and old journal entries cannot change', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'r118-checks-'));
  const run = (...args) => git(args, cwd);
  const directory = 'packages/db/src/migrations';
  const write = (path, text) => writeFileSync(join(cwd, path), text);
  const commit = (subject) => { run('add', '-A'); run('commit', '-m', subject); return run('rev-parse', 'HEAD'); };
  try {
    run('init', '-b', 'main'); run('config', 'user.name', 'Release'); run('config', 'user.email', 'release@example.test');
    run('config', 'commit.gpgsign', 'false');
    mkdirSync(join(cwd, directory, 'meta'), { recursive: true });
    write(`${directory}/0000_first.sql`, 'create table example ();\n');
    write(`${directory}/meta/_journal.json`, '{"version":"7","entries":[{"idx":0,"tag":"0000_first","when":1000}]}\n');
    const base = commit('old nonconventional history');
    write(`${directory}/0001_next.sql`, 'alter table example add column name text;\n');
    write(`${directory}/meta/_journal.json`, '{"version":"7","entries":[{"idx":0,"tag":"0000_first","when":1000},{"idx":1,"tag":"0001_next","when":2000}]}\n');
    const good = commit('feat: add a name');
    assert.equal(checkCommits(base, good, cwd), 1);
    checkMigrations(base, good, cwd);
    write(`${directory}/0000_first.sql`, 'create table example (changed text);\n');
    commit('fix: edit migration');
    assert.throws(() => checkMigrations(base, 'HEAD', cwd), /edited/);
    run('reset', '--hard', good);
    rmSync(join(cwd, directory, '0000_first.sql')); commit('fix: remove migration');
    assert.throws(() => checkMigrations(base, 'HEAD', cwd), /removed/);
    run('reset', '--hard', good);
    write(`${directory}/meta/_journal.json`, '{"version":"7","entries":[{"idx":0,"tag":"changed"}]}\n');
    commit('Bad subject');
    assert.throws(() => checkMigrations(base, 'HEAD', cwd), /append/);
    assert.throws(() => checkCommits(good, 'HEAD', cwd), /conventional/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

for (const [order, when, valid] of [['older', 1500, false], ['equal', 2000, false], ['increasing', 3000, true]]) {
  test(`migration journal timestamp order: ${order}`, () => {
    const cwd = mkdtempSync(join(tmpdir(), 'migration-order-checks-'));
    const run = (...args) => git(args, cwd);
    const directory = 'packages/db/src/migrations';
    const write = (path, text) => writeFileSync(join(cwd, path), text);
    const commit = () => { run('add', '-A'); run('commit', '-m', 'feat: add a migration'); return run('rev-parse', 'HEAD'); };
    const entries = [
      { idx: 0, tag: '0000_first', when: 1000 },
      { idx: 1, tag: '0001_next', when: 2000 },
    ];
    try {
      run('init', '-b', 'main'); run('config', 'user.name', 'Release'); run('config', 'user.email', 'release@example.test');
      run('config', 'commit.gpgsign', 'false');
      write('README.md', 'Migration checks\n');
      const beforeJournal = commit();
      mkdirSync(join(cwd, directory, 'meta'), { recursive: true });
      write(`${directory}/0000_first.sql`, 'create table example ();\n');
      write(`${directory}/0001_next.sql`, 'alter table example add column name text;\n');
      write(`${directory}/meta/_journal.json`, JSON.stringify({ version: '7', entries }) + '\n');
      const base = commit();
      entries.push({ idx: 2, tag: '0002_appended', when });
      write(`${directory}/0002_appended.sql`, 'alter table example add column enabled boolean;\n');
      write(`${directory}/meta/_journal.json`, JSON.stringify({ version: '7', entries }) + '\n');
      const head = commit();
      // Check the full head journal even if the range predates it or contains no changes.
      for (const from of [beforeJournal, base, head]) {
        if (valid) assert.doesNotThrow(() => checkMigrations(from, head, cwd));
        else assert.throws(() => checkMigrations(from, head, cwd), /strictly increasing: 0001_next \(2000\) then 0002_appended \(\d+\)\. Regenerate the migration/);
      }
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

test('the previous code check picks the newest release, or the branch start before the first one', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'r118-previous-'));
  const run = (...args) => git(args, cwd);
  const directory = 'packages/db/src/migrations', floor = 'deploy/release/rollback-floor.txt';
  const commit = (path, text) => { writeFileSync(join(cwd, path), text); run('add', '-A'); run('commit', '-m', 'fix: step'); return run('rev-parse', 'HEAD'); };
  try {
    run('init', '-b', 'main'); run('config', 'user.name', 'Release'); run('config', 'user.email', 'release@example.test');
    run('config', 'commit.gpgsign', 'false');
    mkdirSync(join(cwd, directory), { recursive: true }); mkdirSync(join(cwd, 'deploy/release'), { recursive: true });
    const before = commit(`${directory}/0000_first.sql`, 'create table example ();\n');
    const promised = commit(floor, '0.4.0\n');
    assert.match(previousCode(promised, cwd).skip, /No migration/);
    assert.throws(() => previousCode(undefined, cwd), /started from/);
    const migrated = commit(`${directory}/0001_next.sql`, 'alter table example add column name text;\n');
    assert.deepEqual(previousCode(promised, cwd), { commit: promised });
    assert.match(previousCode(before, cwd).skip, /predates/);
    run('tag', 'v1.0.0', promised);
    run('tag', 'v0.9.9', before);
    assert.deepEqual(previousCode(migrated, cwd), { commit: 'v1.0.0' });
    commit(floor, '1.1.0\n');
    assert.match(previousCode(migrated, cwd).skip, /boundary above v1.0.0/);
    commit(floor, '1.0.0\n');
    run('tag', 'v1.1.0', migrated);
    assert.match(previousCode(promised, cwd).skip, /No migration/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
