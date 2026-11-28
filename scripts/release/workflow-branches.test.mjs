// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { checkMigrations } from './check-migrations.mjs';
import { migrations } from './migration-files.mjs';
import { git, root } from './version.mjs';

const read = (file) => readFileSync(join(root, '.github/workflows', file), 'utf8');

/** The lines of a block that starts at `header` and ends at the next line indented as far or less. */
function block(lines, header) {
  const start = lines.findIndex((line) => line === header);
  if (start < 0) return [];
  const indent = header.length - header.trimStart().length;
  const end = lines.findIndex((line, index) => index > start && line.trim() && line.length - line.trimStart().length <= indent);
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

const onBlock = (text) => block(text.split('\n'), 'on:');

/** The push trigger's inline branch list, as written in the workflow. */
function pushBranches(text) {
  const line = block(onBlock(text), '  push:').find((entry) => entry.startsWith('    branches: ['));
  assert.ok(line, 'push trigger has an inline branch list');
  return line.slice('    branches: ['.length, line.lastIndexOf(']')).split(',').map((item) => item.trim().replace(/^'|'$/g, ''));
}

const reuseJob = (text) => block(text.split('\n'), '  reuse:');
const reuseIf = "github.event_name == 'push' && (github.ref == 'refs/heads/main' || github.ref == 'refs/heads/next')";

test('the check workflows run on next, start by hand, and reuse a passed run on main and next pushes', () => {
  for (const file of ['ci.yml', 'compliance.yml', 'e2e.yml', 'memory.yml', 'image.yml']) {
    const text = read(file);
    const branches = pushBranches(text);
    assert.ok(branches.includes('main') && branches.includes('next'), `${file} pushes: ${branches}`);
    assert.ok(onBlock(text).some((line) => /^ {2}workflow_dispatch:/.test(line)), `${file} has workflow_dispatch`);
    const conditions = reuseJob(text).filter((line) => line.startsWith('    if: '));
    assert.deepEqual(conditions, [`    if: ${reuseIf}`], file);
  }
});

test('End-to-end reuses a push run, or a dispatch whose report job passed', () => {
  const step = reuseJob(read('e2e.yml')).join('\n');
  for (const needed of ['.event == "push"', 'workflow_dispatch', '"report"']) assert.ok(step.includes(needed), needed);
});

test('release and upgrade run on next; the other workflows keep their triggers', () => {
  for (const file of ['release.yml', 'upgrade.yml']) assert.ok(pushBranches(read(file)).includes('next'), file);
  assert.deepEqual(pushBranches(read('image-scan.yml')), ['task/**']);
  for (const file of ['prerelease.yml', 'advisories.yml', 'cla.yml']) assert.ok(!read(file).includes('next'), file);
});

/** Repo compliance's lines from `migration_base=$base` up to, not including, the append-only migration check. */
function migrationBaseLines() {
  const lines = read('compliance.yml').split('\n');
  const start = lines.findIndex((line) => line.trim() === 'migration_base=$base');
  const end = lines.findIndex((line, index) => index > start && line.includes('node scripts/release/check-migrations.mjs'));
  assert.ok(start >= 0 && end > start, 'compliance.yml sets migration_base before the append-only migration check');
  return lines.slice(start, end).join('\n');
}

describe('Repo compliance compares migrations with next where a branch left it', { skip: process.platform === 'win32' }, () => {
  let cwd = '', a = '', b = '', c = '';
  const run = (...args) => git(args, cwd);
  const write = (path, text) => writeFileSync(join(cwd, path), text);
  const commit = (subject) => { run('add', '-A'); run('commit', '-m', subject); return run('rev-parse', 'HEAD'); };
  const entry = (idx, tag, when) => ({ idx, tag, when });
  const writeJournal = (...entries) => write(`${migrations}/meta/_journal.json`, `${JSON.stringify({ version: '7', entries })}\n`);
  /** Runs the workflow's lines in bash with `head` at C and prints the migration base they choose. */
  const migrationBase = (ref, base) => execFileSync('bash', ['-euo', 'pipefail', '-c',
    `head=${c}\nbase=${base}\n${migrationBaseLines()}\necho "$migration_base"\n`],
  { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_REF: ref } }).trim();

  before(() => {
    cwd = mkdtempSync(join(tmpdir(), 'compliance-next-'));
    run('init', '-b', 'work'); run('config', 'user.name', 'Release'); run('config', 'user.email', 'release@example.test');
    run('config', 'commit.gpgsign', 'false');
    mkdirSync(join(cwd, migrations, 'meta'), { recursive: true });
    write(`${migrations}/0000_first.sql`, 'create table example ();\n');
    writeJournal(entry(0, '0000_first', 1000));
    a = commit('chore: main');
    write(`${migrations}/0001_a.sql`, 'alter table example add column name text;\n');
    writeJournal(entry(0, '0000_first', 1000), entry(1, '0001_a', 2000));
    b = commit('feat: landed on next');
    write(`${migrations}/0001_a.sql`, 'alter table example add column title text;\n');
    c = commit('fix: edit the landed migration');
    run('update-ref', 'refs/remotes/origin/main', a);
    run('update-ref', 'refs/remotes/origin/next', b);
  });
  after(() => { if (cwd) rmSync(cwd, { recursive: true, force: true }); });

  test('task, integration and pull-request refs compare with their merge base with next', () => {
    for (const ref of ['refs/heads/task/r1-x', 'refs/heads/integration/r1', 'refs/pull/1/merge'])
      assert.equal(migrationBase(ref, a), b, ref);
  });

  test('a push to next or main compares with its previous tip', () => {
    assert.equal(migrationBase('refs/heads/next', b), b);
    assert.equal(migrationBase('refs/heads/next', a), a);
    assert.equal(migrationBase('refs/heads/main', a), a);
  });

  test('without next on origin, a task ref compares with its merge base with main', () => {
    run('update-ref', '-d', 'refs/remotes/origin/next');
    try { assert.equal(migrationBase('refs/heads/task/r1-x', a), a); }
    finally { run('update-ref', 'refs/remotes/origin/next', b); }
  });

  test('a branch cannot edit a migration that landed on next', () => {
    const base = migrationBase('refs/heads/task/r1-x', a);
    assert.throws(() => checkMigrations(base, c, cwd), /Existing migration edited/);
  });
});
