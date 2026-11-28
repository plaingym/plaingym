// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, root } from './version.mjs';
import { chooseFloor, nightlyPattern, planOutputs, planPrerelease, prereleaseNotes, prereleaseVersion } from './prerelease.mjs';

test('a nightly is the next minor after the base release, numbered on from every existing nightly of that minor', () => {
  assert.equal(prereleaseVersion({ base: 'v1.0.3', tags: [] }), 'v1.1.0-nightly.1');
  assert.equal(prereleaseVersion({ base: 'v1.0.3', tags: ['v1.1.0-nightly.1', 'v1.1.0-nightly.9', 'v1.1.0-nightly.10', 'v1.0.3'] }), 'v1.1.0-nightly.11');
  // Other minors' nightlies, malformed ones and releases don't count.
  assert.equal(prereleaseVersion({ base: 'v1.1.0', tags: ['v1.1.0-nightly.7', 'v1.2.0-nightly.01', 'v1.2.1-nightly.4', 'v1.2.0', ''] }), 'v1.2.0-nightly.1');
  assert.equal(prereleaseVersion({ base: 'v2.9.0', tags: ['v2.10.0-nightly.2'] }), 'v2.10.0-nightly.3');
  for (const base of ['v0.9.0', 'v1.1.0-nightly.1', '1.0.0', 'v1.0']) assert.throws(() => prereleaseVersion({ base, tags: [] }), /Not a release/);
  for (const tag of ['v1.1.0-nightly.1', 'v0.1.0-nightly.12']) assert.match(tag, nightlyPattern);
  for (const tag of ['v1.1.1-nightly.1', 'v1.1.0-nightly.0', 'v1.1.0-nightly.01', 'v01.1.0-nightly.1', 'v1.1.0', 'v1.1.0-nightly.1+0.gabc1234'])
    assert.doesNotMatch(tag, nightlyPattern);
});

test('the rollback floor is the previous prerelease only when its image passed on the new schema', () => {
  assert.equal(chooseFloor('v1.1.0-nightly.2', 'v1.1.0-nightly.1', true), 'v1.1.0-nightly.1');
  assert.equal(chooseFloor('v1.1.0-nightly.3', 'v1.1.0-nightly.2', false), 'v1.1.0-nightly.3');
  assert.equal(chooseFloor('v1.1.0-nightly.1', undefined, true), 'v1.1.0-nightly.1');
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'prerelease-'));
  const run = (...args) => git(args, directory);
  run('init', '-q', '-b', 'main');
  for (const [key, value] of [['user.name', 'Release'], ['user.email', 'release@example.test'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) run('config', key, value);
  const write = (path, content) => { mkdirSync(dirname(join(directory, path)), { recursive: true }); writeFileSync(join(directory, path), content); };
  const commit = (message) => { run('add', '-A'); run('commit', '-q', '-m', message); return run('rev-parse', 'HEAD'); };
  write('package.json', '{\n  "version": "1.0.0"\n}\n');
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

test('main publishes next\'s head as the next nightly only when next moved and CI and Repo compliance passed on it', () => {
  const f = fixture();
  try {
    const ran = new Map();
    const plan = (ref = 'refs/heads/main') => planPrerelease({ cwd: f.directory, ref, repo: 'example/app', gh: fakeGh(ran) });
    const next = (commit) => f.run('update-ref', 'refs/remotes/origin/next', commit);
    // v1.0.0 on main; v1.0.3 on release/1.0, which next never merges; next two commits past v1.0.0; main one past it.
    f.run('tag', 'v1.0.0');
    f.run('checkout', '-q', '-b', 'release/1.0');
    f.write('apps/server/src/app.ts', 'patched\n');
    f.commit('fix: patched');
    f.run('tag', 'v1.0.3');
    f.run('checkout', '-q', '-b', 'next', 'v1.0.0');
    f.write('apps/server/src/app.ts', 'two\n');
    f.commit('feat: two');
    f.write('apps/server/src/app.ts', 'three\n');
    const head = f.commit('feat: three');
    next(head);
    f.run('checkout', '-q', 'main');
    f.write('README.md', 'main only\n');
    const mainOnly = f.commit('docs: main only');
    // CI not green: failed, still running, or missing. Nothing is built or published.
    for (const runs of [[['CI', 'failure'], ['Repo compliance']], [['CI'], ['Repo compliance', null, 'in_progress']], [['CI']]]) {
      ran.set(head, runs);
      const result = plan();
      assert.equal(result.publish, false); assert.equal(result.build, false);
      assert.match(result.reason, /has not passed.*nothing is published/);
      assert.equal(planOutputs(result), `build=false\npublish=false\nprevious=\ncommit=${head}`);
    }
    ran.set(head, green);
    // The plan is next's head, not main's (HEAD here), from the newest release merged into next.
    const first = plan();
    assert.deepEqual([first.version, first.buildVersion, first.publish, first.build, first.previous, first.base, first.commit],
      ['v1.1.0-nightly.1', '1.1.0-nightly.1', true, true, undefined, 'v1.0.0', head]);
    assert.notEqual(first.commit, mainOnly);
    assert.equal(planOutputs(first), `build=true\npublish=true\nprevious=\ncommit=${head}\nversion=v1.1.0-nightly.1\nbuild_version=1.1.0-nightly.1\nimage_tag=1.1.0-nightly.1`);
    // Any other ref is a dry run of that ref's own commit, with build metadata, that never publishes and needs no CI.
    f.run('checkout', '-q', '-b', 'task/r1-x', head);
    f.write('apps/server/src/app.ts', 'task\n');
    const task = f.commit('fix: task');
    const dry = planPrerelease({ cwd: f.directory, ref: 'refs/heads/task/r1-x', repo: 'example/app', gh: () => assert.fail('no CI lookup') });
    assert.deepEqual([dry.version, dry.publish, dry.build, dry.commit], ['v1.1.0-nightly.1', false, true, task]);
    assert.equal(dry.buildVersion, `1.1.0-nightly.1+0.g${task.slice(0, 7)}`);
    assert.match(planOutputs(dry), new RegExp(`^image_tag=1\\.1\\.0-nightly\\.1_0\\.g${task.slice(0, 7)}$`, 'm'));
    f.run('checkout', '-q', 'next');
    // The previous nightly is the tag GitHub creates on next's head; a new commit is the next number.
    f.run('tag', 'v1.1.0-nightly.1', head);
    assert.match(plan().reason, /^next has not moved since v1\.1\.0-nightly\.1\.$/);
    f.write('apps/server/src/app.ts', 'four\n');
    const fourth = f.commit('fix: four');
    next(fourth);
    ran.set(fourth, green);
    const second = plan();
    assert.deepEqual([second.version, second.previous, second.publish], ['v1.1.0-nightly.2', 'v1.1.0-nightly.1', true]);
    // A Markdown-only commit, which CI's path filter skips, is covered by CI on the code before it; Repo compliance
    // has no path filter and must have run on the commit itself. CI isn't looked for past the previous nightly.
    f.write('docs/guide.md', 'guide\n');
    const docs = f.commit('docs: guide');
    next(docs);
    ran.set(docs, [['Repo compliance']]);
    assert.equal(plan().version, 'v1.1.0-nightly.2');
    assert.equal(plan().publish, true);
    ran.set(fourth, [['CI', 'failure'], ['Repo compliance']]);
    assert.match(plan().reason, /CI has not passed/);
    ran.set(fourth, green);
    // A failing lookup is an error, not a quiet "not green".
    assert.throws(() => planPrerelease({ cwd: f.directory, ref: 'refs/heads/main', repo: 'example/app', gh: () => { throw new Error('HTTP 502'); } }), /HTTP 502/);
    f.run('tag', 'v1.1.0-nightly.2', docs);
    assert.match(plan().reason, /^next has not moved since v1\.1\.0-nightly\.2\.$/);
    assert.equal(plan().build, false);
    // No next branch: nothing to plan.
    f.run('update-ref', '-d', 'refs/remotes/origin/next');
    assert.deepEqual(plan(), { build: false, publish: false, reason: 'No next branch.' });
    assert.equal(planOutputs(plan()), 'build=false\npublish=false\nprevious=\ncommit=');
    // v1.1.0 released on main but not merged into next: a nightly would sort below it, so none is built.
    f.write('apps/server/src/app.ts', 'five\n');
    const fifth = f.commit('fix: five');
    next(fifth);
    ran.set(fifth, green);
    f.run('tag', 'v1.1.0', mainOnly);
    const unmerged = plan();
    assert.deepEqual([unmerged.build, unmerged.publish], [false, false]);
    assert.equal(unmerged.reason, 'v1.1.0 is released but not merged into next; merge main into next.');
    // Merged into next, v1.1.0 is the base: the next minor's first nightly, after the previous minor's nightlies.
    f.run('merge', '-q', '--no-ff', '-m', 'Merge main into next', 'main');
    const merge = f.run('rev-parse', 'HEAD');
    next(merge);
    ran.set(merge, green);
    const minor = plan();
    assert.deepEqual([minor.version, minor.base, minor.previous, minor.publish], ['v1.2.0-nightly.1', 'v1.1.0', 'v1.1.0-nightly.2', true]);
    // CI failed on the head: nothing is published.
    ran.set(merge, [['CI', 'failure'], ['Repo compliance']]);
    const failed = plan();
    assert.deepEqual([failed.build, failed.publish], [false, false]);
    assert.match(failed.reason, /CI has not passed/);
  } finally { f.cleanup(); }
});

test('the notes say what a prerelease is and list the commits since the previous one', () => {
  const f = fixture();
  try {
    const first = f.run('rev-parse', 'HEAD');
    const opening = prereleaseNotes({ cwd: f.directory, commit: first, floor: 'v1.1.0-nightly.1' });
    assert.match(opening, /Nightly prerelease of `next` at [a-f0-9]{40}/);
    assert.match(opening, /prerelease-signing\.pem/);
    assert.match(opening, /Migrations: first nightly prerelease\./);
    assert.match(opening, /Rollback floor: v1\.1\.0-nightly\.1\./);
    assert.match(opening, /First nightly prerelease\./);
    f.run('tag', 'v1.1.0-nightly.1');
    f.write('apps/server/src/app.ts', 'two\n');
    const fix = f.commit('fix: two');
    const patch = prereleaseNotes({ cwd: f.directory, previous: 'v1.1.0-nightly.1', commit: fix, floor: 'v1.1.0-nightly.1' });
    assert.match(patch, /### Commits since v1\.1\.0-nightly\.1\n\n- fix: two \([a-f0-9]{7}\)\n/);
    assert.doesNotMatch(patch, /feat: first/);
    assert.match(patch, /Migrations: none since v1\.1\.0-nightly\.1\./);
    f.write('packages/db/src/migrations/0001_second.sql', 'alter table a add b int;\n');
    const migration = f.commit('feat: column');
    assert.match(prereleaseNotes({ cwd: f.directory, previous: 'v1.1.0-nightly.1', commit: migration, floor: 'v1.1.0-nightly.3' }),
      /Migrations: yes, since v1\.1\.0-nightly\.1/);
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
  assert.match(nightly, /gh release create "\$VERSION" .*--target "\$COMMIT" --prerelease --latest=false/);
  // The dry run has no secrets, and nothing commits, pushes a branch or moves a ref on GitHub.
  assert.doesNotMatch(job(release, 'dry-run'), /secrets\./);
  for (const text of [release, prerelease]) assert.doesNotMatch(text, /git (?:push|commit|tag )|git\/refs/);
  // release.yml takes no secrets from its caller; prerelease.yml's one call inherits them (see its comment).
  assert.doesNotMatch(release, /secrets: inherit|workflow_call:\n(?: {4,}[^\n]*\n)*? {4}secrets:/);
  // The nightly schedule, before the demo's update window, calls the Release workflow's own steps.
  assert.match(prerelease, /- cron: '30 5 \* \* \*'/);
  assert.match(prerelease, /^ {4}uses: \.\/\.github\/workflows\/release\.yml\n {4}secrets: inherit\n {4}with:\n {6}prerelease: true$/m);
  assert.equal([...prerelease.matchAll(/^\s*secrets:/gm)].length, 1);
  assert.doesNotMatch(prerelease, /secrets\./);
  // The pruning job holds no secret and no environment, and deletes only what its own two permissions allow.
  const prune = job(prerelease, 'prune');
  assert.match(prune, /^ {4}permissions:\n {6}contents: write\n {6}packages: write\n {4}steps:/m);
  assert.match(prune, /^ {4}needs: \[prerelease\]$/m);
  assert.match(prune, /^ {4}if: \$\{\{ !cancelled\(\) && github\.ref == 'refs\/heads\/main' \}\}$/m);
  assert.doesNotMatch(prune, /environment:|secrets/);
  assert.match(prune, /node scripts\/release\/prune-nightlies\.mjs "\$GITHUB_REPOSITORY"/);
});

test('a prerelease run on main builds and publishes next\'s head, the commit its plan picked', () => {
  const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const prepare = job(release, 'prepare');
  // The plan sees next as origin has it, and its commit is the one every later job checks out and labels.
  assert.ok(prepare.includes("git fetch --no-tags origin '+refs/heads/next:refs/remotes/origin/next'"));
  assert.match(prepare, /next_status=0; git ls-remote --exit-code --heads origin refs\/heads\/next >\/dev\/null \|\| next_status=\$\?/);
  assert.match(prepare, /^ {6}commit: \$\{\{ steps\.prerelease\.outputs\.commit \|\| github\.sha \}\}$/m);
  assert.match(prepare, /check-tag\.sh "\$\(sed -n 's\/\^version=\/\/p' "\$RUNNER_TEMP\/plan\.txt"\)" "\$\(sed -n 's\/\^commit=\/\/p' "\$RUNNER_TEMP\/plan\.txt"\)" --prerelease/);
  const nightly = job(release, 'publish-prerelease');
  assert.match(nightly, /^ {4}environment: prerelease-main$/m);
  assert.match(nightly, /^ {4}if: inputs\.prerelease && needs\.prepare\.outputs\.prerelease == 'true' && github\.ref == 'refs\/heads\/main'$/m);
  for (const name of ['build', 'dry-run', 'publish-prerelease']) {
    const text = job(release, name);
    assert.doesNotMatch(text, /github\.sha|GITHUB_SHA/, name);
    const checkouts = text.match(/^ {6}- uses: actions\/checkout@.*\n(?: {8}.*\n)*/gm) ?? [];
    assert.ok(checkouts.length > 0, `${name} checks out`);
    for (const checkout of checkouts) assert.match(checkout, /^ {10}ref: \$\{\{ needs\.prepare\.outputs\.commit \}\}$/m, name);
  }
  const build = job(release, 'build');
  assert.match(build, /^ {6}COMMIT: \$\{\{ needs\.prepare\.outputs\.commit \}\}$/m);
  assert.match(build, /REVISION=\$\{\{ env\.COMMIT \}\}/);
  assert.match(build, /image\.revision"\}\}'\)" = "\$COMMIT"/);
  assert.match(build, /&& needs\.prepare\.outputs\.version \|\| needs\.prepare\.outputs\.commit \}\}$/m);
  assert.match(job(release, 'dry-run'), /--revision "\$COMMIT"/);
  assert.match(nightly, /--revision "\$COMMIT"/);
  assert.match(nightly, /prerelease\.mjs notes "\$PREVIOUS" "\$COMMIT" "\$floor"/);
});

test('the prerelease publish refuses lookup errors, existing releases and image tags from another commit', () => {
  const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const nightly = job(release, 'publish-prerelease');
  assert.deepEqual(nightly.match(/^ {6}- uses: .+$/gm), [
    '      - uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6',
    '      - uses: actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6',
    '      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2',
    '      - uses: actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2',
  ]);
  // Only exit 2 from the tag lookup means "not tagged"; a failure to look is not an answer.
  assert.match(nightly, /tag_status=0; git ls-remote --exit-code --tags origin "refs\/tags\/\$VERSION" >\/dev\/null \|\| tag_status=\$\?/);
  assert.match(nightly, /if \[ "\$tag_status" -eq 0 \]; then echo "::error::\$VERSION is already tagged\."; exit 1; fi/);
  assert.match(nightly, /if \[ "\$tag_status" -ne 2 \]; then echo "::error::Could not check whether \$VERSION is tagged\."; exit 1; fi/);
  // Only a 404 from the release lookup means "not released"; a failure to look is not an answer.
  assert.match(nightly, /if release_error=\$\(gh api "repos\/\$GITHUB_REPOSITORY\/releases\/tags\/\$VERSION" --silent 2>&1\); then echo "::error::\$VERSION is already released\."; exit 1; fi/);
  assert.match(nightly, /case "\$release_error" in \*"\(HTTP 404\)"\*\) ;; \*\) echo "::error::Could not check whether \$VERSION is released\."; exit 1 ;; esac/);
  assert.doesNotMatch(nightly, /gh release view/);
  assert.ok(nightly.includes("drafts=$(gh api \"repos/$GITHUB_REPOSITORY/releases?per_page=100\" --paginate --jq '.[] | select(.tag_name == env.VERSION) | .id')"));
  assert.match(nightly, /\|\| \{ echo "::error::Could not check whether \$VERSION has a draft release\."; exit 1; \}/);
  assert.match(nightly, /if \[ -n "\$drafts" \]; then echo "::error::A draft release for \$VERSION exists .*Delete it in the repository's Releases, then run Prerelease again\."; exit 1; fi/);
  // An image tag from an earlier night is only pushed again for this commit; all three tags are checked.
  for (const suffix of ['', '-amd64', '-arm64']) assert.match(nightly, new RegExp(`"ghcr\\.io/\\$owner/app:\\$image_tag${suffix}"`));
  // imagetools' `json` template pretty-prints, so the label is only compact after whitespace is stripped.
  assert.match(nightly, /tr -d '\[:space:\]'.*org\.opencontainers\.image\.revision/);
  assert.match(nightly, /org\.opencontainers\.image\.revision.*\$COMMIT/);
  const conflict = nightly.indexOf('already exists for another commit; nothing was published.');
  const recovery = nightly.indexOf("::error::An earlier night pushed $VERSION's images for commit");
  assert.ok(conflict >= 0 && recovery > conflict, 'the recovery message follows the image conflict');
  assert.match(nightly.slice(recovery), /commit \$\{found:-unknown\}.*versions tagged \$image_tag, \$image_tag-amd64 and \$image_tag-arm64/);
  assert.match(nightly, /Could not read the revision of \$ref\./);
  assert.match(nightly, /Could not check whether \$ref exists\./);
  assert.ok(nightly.includes("grep -Eqi 'manifest unknown|no such manifest'"));
  assert.doesNotMatch(nightly, /\|not found'/);
  // The image guard runs once the registry login is done and before publish.sh pushes anything.
  const login = nightly.indexOf('docker login ghcr.io');
  const guard = nightly.indexOf('docker manifest inspect');
  const push = nightly.indexOf('publish.sh --prerelease');
  assert.ok(login >= 0 && guard > login && push > guard, 'the image guard sits after docker login and before publish.sh');
  // All lookups finish before the signing key is written.
  const key = nightly.indexOf('> "$RUNNER_TEMP/key.pem"');
  const tagGuard = nightly.indexOf('tag_status=0');
  const releaseGuard = nightly.indexOf('case "$release_error"');
  const draftGuard = nightly.indexOf('drafts=$(gh api');
  assert.ok(tagGuard >= 0 && releaseGuard > tagGuard && draftGuard > releaseGuard && login > draftGuard,
    'the tag, published release and draft guards run before registry login');
  const guardEnd = nightly.indexOf('\n          done', guard);
  assert.ok(guardEnd > guard && key > guardEnd && push > key,
    'key.pem is written after the image guard and before publish.sh');
});

test('the prerelease image guard accepts missing manifests and refuses a credential helper error', (t) => {
  const bash = spawnSync('bash', ['--version'], { encoding: 'utf8', timeout: 5_000 });
  if (bash.error?.code === 'ENOENT') return t.skip('bash is unavailable');
  // On Windows, `bash` may be the WSL launcher, which doesn't pass this test's environment through.
  if (process.platform === 'win32' && !/msys|cygwin/i.test(bash.stdout ?? '')) return t.skip('bash is not Git Bash');
  assert.ifError(bash.error);
  assert.equal(bash.status, 0);

  const release = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const nightly = job(release, 'publish-prerelease');
  const loop = nightly.match(/^ {10}for ref in .*; do\n[\s\S]*?^ {10}done$/m);
  assert.ok(loop, 'the image guard loop');
  const directory = mkdtempSync(join(tmpdir(), 'prerelease-image-guard-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'docker'), '#!/bin/sh\nprintf "%s\\n" "$DOCKER_INSPECT_ERROR" >&2\nexit 1\n', { mode: 0o755 });
  const script = 'export PATH="$PWD:$PATH" RUNNER_TEMP="$PWD"\nowner=x\nimage_tag=v1.1.0-nightly.3\n' + loop[0];

  for (const [stderr, status] of [
    ['manifest unknown', 0],
    ['no such manifest: ghcr.io/x/app:v1.1.0-nightly.3', 0],
    ['error getting credentials - err: exec: "docker-credential-x": executable file not found in $PATH', 1],
  ]) {
    const result = spawnSync('bash', ['-euo', 'pipefail', '-c', script], {
      cwd: directory,
      env: { ...process.env, DOCKER_INSPECT_ERROR: stderr, COMMIT: 'current-commit' },
      encoding: 'utf8',
      timeout: 5_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, status, stderr);
    if (status === 1) assert.match(result.stdout, /Could not check whether ghcr\.io\/x\/app:v1\.1\.0-nightly\.3 exists/);
  }
});
