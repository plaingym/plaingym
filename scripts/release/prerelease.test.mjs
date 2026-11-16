// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, root } from './version.mjs';
import { chooseFloor, planOutputs, planPrerelease, prereleaseNotes, prereleaseVersion } from './prerelease.mjs';

test('the first prerelease follows package.json, later ones a patch, or a minor when migrations changed', () => {
  assert.equal(prereleaseVersion({ product: '0.4.0', migrationsChanged: false }), 'v0.5.0');
  assert.equal(prereleaseVersion({ previous: 'v0.5.0', product: '0.4.0', migrationsChanged: false }), 'v0.5.1');
  assert.equal(prereleaseVersion({ previous: 'v0.5.3', product: '0.4.0', migrationsChanged: true }), 'v0.6.0');
  // A breaking change doesn't bump the major before v1.0: only the migrations decide.
  assert.equal(prereleaseVersion({ previous: 'v0.9.9', product: '0.4.0', migrationsChanged: true }), 'v0.10.0');
  assert.throws(() => prereleaseVersion({ product: '1.0.0', migrationsChanged: false }), /0\.x/);
  assert.throws(() => prereleaseVersion({ previous: 'v1.2.0', product: '0.4.0', migrationsChanged: false }), /0\.x/);
});

test('the rollback floor is the previous prerelease only when its image passed on the new schema', () => {
  assert.equal(chooseFloor('v0.5.1', 'v0.5.0', true), 'v0.5.0');
  assert.equal(chooseFloor('v0.6.0', 'v0.5.1', false), 'v0.6.0');
  assert.equal(chooseFloor('v0.5.0', undefined, true), 'v0.5.0');
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'prerelease-'));
  const run = (...args) => git(args, directory);
  run('init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'Release'], ['user.email', 'release@example.test'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) run('config', key, value);
  const write = (path, content) => { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), content); };
  const commit = (message) => { run('add', '-A'); run('commit', '-q', '-m', message); return run('rev-parse', 'HEAD'); };
  write('package.json', '{\n  "version": "0.4.0"\n}\n');
  write('packages/db/src/migrations/0000_first.sql', 'create table a ();\n');
  write('apps/server/src/app.ts', 'one\n');
  commit('feat: first');
  return { directory, run, write, commit, cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

/** gh's answer: the named workflows ran on each commit, passing unless a test says otherwise. */
function fakeGh(ran) {
  return (args) => {
    assert.deepEqual(args.slice(0, 5), ['run', 'list', '-R', 'example/app', '--commit']);
    return JSON.stringify((ran.get(args[5]) ?? []).map(([workflowName, conclusion = 'success', status = 'completed']) =>
      ({ workflowName, conclusion, status, createdAt: '2026-11-15T00:00:00Z' })));
  };
}
const green = [['CI'], ['Repo compliance']];

test('main publishes only a commit that moved since the previous prerelease and passed CI and Repo compliance', () => {
  const f = fixture();
  try {
    const ran = new Map();
    const plan = (ref = 'refs/heads/main') => planPrerelease({ cwd: f.directory, ref, repo: 'example/app', gh: fakeGh(ran) });
    const first = f.run('rev-parse', 'HEAD');
    // CI not green: failed, still running, or missing. Nothing is built or published.
    for (const runs of [[['CI', 'failure'], ['Repo compliance']], [['CI'], ['Repo compliance', null, 'in_progress']], [['CI']]]) {
      ran.set(first, runs);
      const result = plan();
      assert.equal(result.publish, false); assert.equal(result.build, false);
      assert.match(result.reason, /has not passed.*nothing is published/);
      assert.equal(planOutputs(result), 'build=false\npublish=false\nprevious=');
    }
    ran.set(first, green);
    const published = plan();
    assert.deepEqual([published.version, published.buildVersion, published.publish, published.build, published.previous], ['v0.5.0', '0.5.0', true, true, undefined]);
    assert.equal(planOutputs(published), 'build=true\npublish=true\nprevious=\nversion=v0.5.0\nbuild_version=0.5.0\nimage_tag=0.5.0');
    // The previous prerelease is the tag GitHub creates on main's commit.
    f.run('tag', 'v0.5.0');
    const nothing = plan();
    assert.equal(nothing.build, false); assert.equal(nothing.publish, false);
    assert.match(nothing.reason, /not moved since v0\.5\.0/);
    // A code change without a migration is the next patch.
    f.write('apps/server/src/app.ts', 'two\n');
    const fix = f.commit('fix: two');
    ran.set(fix, green);
    assert.equal(plan().version, 'v0.5.1');
    // A Markdown-only commit, which CI's path filter skips, is covered by CI on the code before it; Repo compliance
    // has no path filter and must have run on the commit itself.
    f.write('docs/guide.md', 'guide\n');
    const docs = f.commit('docs: guide');
    ran.set(docs, [['Repo compliance']]);
    assert.equal(plan().publish, true);
    ran.set(fix, [['CI', 'failure'], ['Repo compliance']]);
    assert.match(plan().reason, /CI has not passed/);
    ran.set(fix, green);
    f.run('tag', 'v0.5.1');
    // A migration since the previous prerelease is the next minor.
    f.write('packages/db/src/migrations/0001_second.sql', 'alter table a add b int;\n');
    const migration = f.commit('fix: column');
    ran.set(migration, green);
    const minor = plan();
    assert.equal(minor.version, 'v0.6.0'); assert.equal(minor.previous, 'v0.5.1'); assert.equal(minor.migrationsChanged, true);
    // A failing lookup is an error, not a quiet "not green".
    assert.throws(() => planPrerelease({ cwd: f.directory, ref: 'refs/heads/main', repo: 'example/app', gh: () => { throw new Error('HTTP 502'); } }), /HTTP 502/);
    // Any other ref is a dry run of the same version, with build metadata, that never publishes and needs no CI.
    ran.clear();
    const dry = plan('refs/heads/task/r1-x');
    assert.deepEqual([dry.version, dry.publish, dry.build], ['v0.6.0', false, true]);
    assert.equal(dry.buildVersion, `0.6.0+0.g${migration.slice(0, 7)}`);
    assert.match(planOutputs(dry), /^image_tag=0\.6\.0_0\.g[a-f0-9]{7}$/m);
    // After the first stable release, nothing is published as a prerelease.
    f.run('tag', 'v1.0.0');
    f.write('apps/server/src/app.ts', 'three\n');
    ran.set(f.commit('fix: three'), green);
    assert.match(plan().reason, /v1\.0\.0 is a stable release/);
    assert.equal(plan().build, false);
  } finally { f.cleanup(); }
});

test('the notes say what a prerelease is and list the commits since the previous one', () => {
  const f = fixture();
  try {
    const first = f.run('rev-parse', 'HEAD');
    const opening = prereleaseNotes({ cwd: f.directory, commit: first, floor: 'v0.5.0' });
    assert.match(opening, /Nightly prerelease of `main` at [a-f0-9]{40}/);
    assert.match(opening, /prerelease-signing\.pem/);
    assert.match(opening, /Migrations: first prerelease\./);
    assert.match(opening, /Rollback floor: v0\.5\.0\./);
    assert.match(opening, /First prerelease\./);
    f.run('tag', 'v0.5.0');
    f.write('apps/server/src/app.ts', 'two\n');
    const fix = f.commit('fix: two');
    const patch = prereleaseNotes({ cwd: f.directory, previous: 'v0.5.0', commit: fix, floor: 'v0.5.0' });
    assert.match(patch, /### Commits since v0\.5\.0\n\n- fix: two \([a-f0-9]{7}\)\n/);
    assert.doesNotMatch(patch, /feat: first/);
    assert.match(patch, /Migrations: none since v0\.5\.0\./);
    f.write('packages/db/src/migrations/0001_second.sql', 'alter table a add b int;\n');
    const migration = f.commit('feat: column');
    assert.match(prereleaseNotes({ cwd: f.directory, previous: 'v0.5.0', commit: migration, floor: 'v0.6.0' }), /Migrations: yes, since v0\.5\.0/);
  } finally { f.cleanup(); }
});

/** The text of one top-level job of a workflow. */
function job(workflow, name) {
  const match = new RegExp(`^ {2}${name}:\\n((?: {4}.*\\n|\\n)*)`, 'm').exec(workflow);
  assert.ok(match, `job ${name}`);
  return match[1];
}

test('each signing key is reachable only from its own job, and no workflow writes to a branch', () => {
  const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const prerelease = readFileSync(join(root, '.github/workflows/prerelease.yml'), 'utf8');
  const stable = job(release, 'publish'), nightly = job(release, 'publish-prerelease');
  // RELEASE_SIGNING_KEY: only a release tag's own run, in the release environment.
  assert.equal([...release.matchAll(/secrets\.RELEASE_SIGNING_KEY/g)].length, 1);
  assert.match(stable, /secrets\.RELEASE_SIGNING_KEY/);
  assert.match(stable, /^ {4}environment: release$/m);
  assert.match(stable, /^ {4}if: .*github\.ref_type == 'tag'.*!inputs\.prerelease/m);
  // PRERELEASE_SIGNING_KEY: only prerelease.yml's run on main, in the prerelease-main environment.
  assert.equal([...release.matchAll(/secrets\.PRERELEASE_SIGNING_KEY/g)].length, 1);
  assert.match(nightly, /secrets\.PRERELEASE_SIGNING_KEY/);
  assert.match(nightly, /^ {4}environment: prerelease-main$/m);
  assert.match(nightly, /^ {4}if: inputs\.prerelease && .*github\.ref == 'refs\/heads\/main'/m);
  assert.match(nightly, /publish\.sh --prerelease .*/);
  assert.match(nightly, /--public-key deploy\/prerelease-signing\.pem/);
  assert.match(nightly, /gh release create "\$VERSION" .*--target "\$GITHUB_SHA" --prerelease --latest=false/);
  // The dry run has no secrets, and nothing commits, pushes a branch or moves a ref.
  assert.doesNotMatch(job(release, 'dry-run'), /secrets\./);
  for (const text of [release, prerelease]) assert.doesNotMatch(text, /git (?:push|commit|tag )|git\/refs/);
  // release.yml takes no secrets from its caller; prerelease.yml's one call inherits them (see its comment).
  assert.doesNotMatch(release, /secrets: inherit|workflow_call:\n(?: {4,}[^\n]*\n)*? {4}secrets:/);
  // The nightly schedule, before the demo's update window, calls the Release workflow's own steps.
  assert.match(prerelease, /- cron: '30 5 \* \* \*'/);
  assert.match(prerelease, /^ {4}uses: \.\/\.github\/workflows\/release\.yml\n {4}secrets: inherit\n {4}with:\n {6}prerelease: true$/m);
  assert.equal([...prerelease.matchAll(/^\s*secrets:/gm)].length, 1);
  assert.doesNotMatch(prerelease, /secrets\./);
});
