// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, root } from './version.mjs';
import { release, proposal, changelogSection, insertSection, pushPathFilter, skippedByFilter, unreleasedNotes } from './release.mjs';

test('proposal follows fix, feature, migration and breaking changes', () => {
  assert.equal(proposal(undefined, [], false), '1.0.0');
  assert.equal(proposal('v1.2.3', [], false), null);
  assert.equal(proposal('v1.2.3', ['fix: health'], false), '1.2.4');
  assert.equal(proposal('v1.2.3', ['feat(api): health'], false), '1.3.0');
  assert.equal(proposal('v1.2.3', ['fix: health'], true), '1.3.0');
  assert.equal(proposal('v1.2.3', ['fix!: require a setting'], false), '2.0.0');
  assert.equal(proposal('v1.2.3', ['fix: health\n\nBREAKING CHANGE: require a setting'], false), '2.0.0');
});

test('changelog extraction and patch insertion preserve Unreleased and version order', () => {
  const text = '# Changelog\n\n## [Unreleased]\n\nNew work.\n\n## [1.3.0] - 2026-01-02\n\nThree.\n\n## [1.2.0] - 2026-01-01\n\nTwo.\n';
  const section = '## [1.2.1] - 2026-01-03\n\nFixed.\n';
  const result = insertSection(text, section);
  assert.equal(changelogSection(result, 'v1.2.1'), section);
  assert(result.indexOf('[1.3.0]') < result.indexOf('[1.2.1]'));
  assert(result.indexOf('[1.2.1]') < result.indexOf('[1.2.0]'));
  assert(result.includes('New work.'));
});

test('path filters match how GitHub skips a workflow, read from the workflows themselves', () => {
  const workflows = ['ci.yml', 'compliance.yml', 'image.yml'].map((file) => pushPathFilter(readFileSync(join(root, '.github/workflows', file), 'utf8')));
  const [ci, compliance, image] = workflows;
  assert.deepEqual(ci, { paths: [], ignored: ['**/*.md'] });
  assert.deepEqual(compliance, { paths: [], ignored: [] });
  assert.ok(image.paths.includes('deploy/**') && image.paths.includes('tsconfig*.json') && !image.ignored.length);
  assert.equal(skippedByFilter(ci, ['CHANGELOG.md', 'docs/updating.md']), true);
  assert.equal(skippedByFilter(ci, ['CHANGELOG.md', 'deploy/update.sh']), false);
  assert.equal(skippedByFilter(compliance, ['CHANGELOG.md']), false);
  assert.equal(skippedByFilter(image, ['CHANGELOG.md', 'docs/updating.md', '.github/workflows/ci.yml']), true);
  assert.equal(skippedByFilter(image, ['CHANGELOG.md', 'apps/server/src/app.ts']), false);
  assert.equal(skippedByFilter(image, ['tsconfig.base.json']), false);
  assert.equal(skippedByFilter(image, ['deep/tsconfig.base.json']), true);
  assert.equal(skippedByFilter(image, ['.github/workflows/image-scan.yml']), false);
});

test('a release accepts the nearest checked commit only across commits the workflow skips', () => {
  const f = fixture();
  // gh's answer for each commit: only the workflows named ran, unless a test says otherwise.
  const ran = new Map();
  const gh = (args) => JSON.stringify((ran.get(args[5]) ?? []).map(([workflowName, conclusion = 'success', status = 'completed']) => ({ workflowName, conclusion, status, createdAt: '2026-01-01' })));
  const all = ['CI', 'Repo compliance', 'Image checks'].map((name) => [name]);
  try {
    const first = f.run('rev-parse', 'HEAD');
    ran.set(first, all);
    release({ ...f.options, gh, version: '1.0.0' }); f.publishFixture();
    ran.set(f.run('rev-parse', 'HEAD'), all);
    // Code, then a Markdown change: CI and Image checks ran on the code, Repo compliance on both.
    f.write('apps/server/src/app.ts', 'code\n'); f.commit('feat: code');
    const code = f.run('rev-parse', 'HEAD');
    f.write('docs/guide.md', 'guide\n'); f.commit('docs: guide'); f.publishFixture();
    const docs = f.run('rev-parse', 'HEAD');
    ran.set(code, all); ran.set(docs, [['Repo compliance']]);
    const head = () => f.run('rev-parse', 'HEAD');
    const refused = (reason) => { const before = head(); assert.throws(() => release({ ...f.options, gh }), reason); assert.equal(head(), before); };
    // The nearest run of a skipped workflow decides: a failure there refuses the release.
    ran.set(code, [['CI', 'failure'], ['Repo compliance'], ['Image checks']]);
    refused(/CI has not passed/);
    ran.set(code, [['CI'], ['Repo compliance'], ['Image checks', null, 'in_progress']]);
    refused(/Image checks has not passed/);
    // Repo compliance has no filter: it must have run on HEAD itself.
    ran.set(code, all); ran.set(docs, []);
    refused(/Repo compliance has not passed/);
    ran.set(docs, [['Repo compliance']]);
    assert.equal(release({ ...f.options, gh }).version, '1.1.0');
    f.publishFixture();
    ran.set(head(), all);
    // A commit the workflow doesn't skip, with no run of its own, can't be passed over.
    f.write('apps/server/src/app.ts', 'more\n'); f.commit('feat: more code');
    const unchecked = head();
    f.write('docs/guide.md', 'more\n'); f.commit('docs: more'); f.publishFixture();
    ran.set(unchecked, [['Repo compliance']]); ran.set(head(), [['Repo compliance']]);
    refused(/CI has not passed/);
    // The walk stops at the previous release: nothing before it counts for this one.
    ran.set(unchecked, [['Repo compliance'], ['CI'], ['Image checks']]);
    f.run('reset', '--hard', 'v1.1.0'); f.run('push', '--force', 'origin', 'HEAD:main');
    f.write('docs/guide.md', 'other\n'); f.commit('feat: other'); f.publishFixture();
    ran.set(head(), [['Repo compliance']]); ran.delete(f.run('rev-parse', 'v1.1.0^{commit}'));
    refused(/CI has not passed/);
  } finally { f.close(); }
});

test('notes under Unreleased reach the release, with and without a notes file, and leave Unreleased empty', () => {
  const f = fixture();
  try {
    f.write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n\n### Fixed\n\n- A note written by hand.\n');
    f.commit('docs: note'); f.publishFixture();
    release({ ...f.options, version: '1.0.0' }); f.publishFixture();
    const first = readFileSync(join(f.cwd, 'CHANGELOG.md'), 'utf8');
    assert.match(changelogSection(first, '1.0.0'), /A note written by hand/);
    assert.equal(unreleasedNotes(first), '');
    f.write('CHANGELOG.md', first.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Changed\n\n- Another note.\n'));
    f.write('feature', 'new\n'); f.commit('feat: feature'); f.publishFixture();
    const notes = join(f.temporary, 'notes.md');
    writeFileSync(notes, '### Added\n\n- From the file.\n\n### Upgrade notes\n\n- Migrations: none.\n- Rollback floor: 1.0.0.\n- Manual steps: none.\n');
    release({ ...f.options, notesFile: notes });
    const second = readFileSync(join(f.cwd, 'CHANGELOG.md'), 'utf8');
    assert.match(changelogSection(second, '1.1.0'), /Another note[\s\S]*From the file/);
    assert.equal(unreleasedNotes(second), '');
  } finally { f.close(); }
});

test('the default floor is the previous release\'s minor, which the previous minor check can start', () => {
  const f = fixture();
  try {
    release({ ...f.options, version: '1.2.0' }); f.publishFixture();
    f.write('feature', 'new\n'); f.commit('feat: feature'); f.publishFixture();
    // Versions skip past 1.3 and 1.4: their floor can't name a release that never existed.
    assert.equal(release({ ...f.options, version: '1.5.0' }).floor, '1.2.0');
    assert.equal(readFileSync(join(f.cwd, 'deploy/release/rollback-floor.txt'), 'utf8'), '1.2.0\n');
    f.publishFixture();
    f.write('feature', 'newer\n'); f.commit('feat: another'); f.publishFixture();
    // The Release workflow would refuse this tag after the push, so it never gets one.
    const before = f.run('rev-parse', 'HEAD');
    assert.throws(() => release({ ...f.options, rollbackFloor: '1.6.0' }), /excludes the previous release v1\.5\.0/);
    assert.equal(f.run('rev-parse', 'HEAD'), before);
    assert.equal(release(f.options).floor, '1.5.0');
    f.publishFixture();
    f.write('feature', 'break\n'); f.commit('feat!: require a setting'); f.publishFixture();
    assert.equal(release(f.options).floor, '2.0.0');
  } finally { f.close(); }
});

test('upgrade notes name every host file the installer copies', () => {
  const f = fixture();
  try {
    release({ ...f.options, version: '1.0.0' }); f.publishFixture();
    const hostFiles = ['deploy/compose.yaml', 'deploy/Caddyfile', 'deploy/rotate-key.sh', 'deploy/postgres/01-roles.sh', 'deploy/update.sh'];
    for (const path of hostFiles) f.write(path, 'changed\n');
    f.write('deploy/release/publish.sh', 'not on the host\n');
    f.commit('fix: host files'); f.publishFixture();
    const { section } = release({ ...f.options, version: '1.1.0' });
    for (const path of hostFiles) assert.ok(section.includes(path), path);
    assert.ok(!section.includes('deploy/release/publish.sh'));
  } finally { f.close(); }
});

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'r118-release-'));
  const cwd = join(temporary, 'repo'), origin = join(temporary, 'origin.git');
  mkdirSync(cwd);
  const run = (...args) => git(args, cwd);
  const write = (path, value) => { const file = join(cwd, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  const commit = (subject) => { run('add', '-A'); run('commit', '-m', subject); };
  run('init', '-b', 'main'); run('config', 'user.name', 'Release'); run('config', 'user.email', 'release@example.test');
  run('config', 'commit.gpgsign', 'false'); run('config', 'tag.gpgsign', 'false');
  run('config', 'plaingym.repository', 'example/app');
  const key = join(temporary, 'key');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], { stdio: 'pipe' });
  run('config', 'gpg.format', 'ssh'); run('config', 'user.signingkey', key);
  const signers = join(temporary, 'signers');
  writeFileSync(signers, `release@example.test ${readFileSync(key + '.pub', 'utf8')}`);
  run('config', 'gpg.ssh.allowedSignersFile', signers);
  for (const path of ['package.json', 'apps/server/package.json', 'apps/web/package.json', 'packages/db/package.json', 'packages/shared/package.json'])
    write(path, '{"name":"test","version":"0.4.0","private":true}\n');
  write('CHANGELOG.md', '# Changelog\n\n## [Unreleased]\n');
  write('deploy/release/rollback-floor.txt', '0.4.0\n');
  write('packages/db/src/migrations/meta/_journal.json', '{"entries":[0]}\n');
  write('packages/db/src/migrations/0000_first.sql', 'create table example ();\n');
  commit('feat: first');
  run('clone', '--bare', cwd, origin); run('remote', 'add', 'origin', origin); run('fetch', 'origin');
  const gh = (args) => {
    assert.deepEqual(args.slice(0, 5), ['run', 'list', '-R', 'example/app', '--commit']);
    assert.equal(args[5].length, 40);
    return JSON.stringify(['CI', 'Repo compliance', 'Image checks'].map((workflowName) => ({ workflowName, conclusion: 'success', status: 'completed', createdAt: '2026-01-01' })));
  };
  const edit = (path) => writeFileSync(path, readFileSync(path, 'utf8').replace('<!-- Write a short first-release summary here. -->', '- The first release.'));
  const options = { cwd, gh, edit, log: () => {} };
  const publishFixture = () => run('push', 'origin', 'HEAD', '--tags');
  return { temporary, cwd, origin, run, write, commit, options, publishFixture, close: () => rmSync(temporary, { recursive: true, force: true }) };
}

test('real first release, signed tag, no push, explicit minor, and patch changelog back on main', () => {
  const f = fixture();
  try {
    const originHead = git(['rev-parse', 'main'], f.origin);
    assert.equal(release({ ...f.options, version: '1.0.0' }).version, '1.0.0');
    assert.equal(f.run('log', '-1', '--format=%s'), 'chore(release): v1.0.0');
    assert.equal(f.run('cat-file', '-t', 'v1.0.0'), 'tag');
    f.run('verify-tag', 'v1.0.0');
    assert.equal(git(['rev-parse', 'main'], f.origin), originHead);
    assert.equal(git(['tag', '--list'], f.origin), '');
    assert.match(readFileSync(join(f.cwd, 'CHANGELOG.md'), 'utf8'), /The first release/);
    f.publishFixture();
    assert.equal(release(f.options), null);
    f.write('feature', 'new\n'); f.commit('feat: new feature'); f.publishFixture();
    assert.equal(release({ ...f.options, version: '1.2.0' }).version, '1.2.0');
    f.publishFixture();
    f.run('checkout', '-b', 'release/1.2'); f.run('push', 'origin', 'release/1.2');
    f.write('fix', 'fixed\n'); f.commit('fix: correct health'); f.publishFixture();
    const mainVersion = f.run('show', 'main:package.json');
    assert.equal(release(f.options).version, '1.2.1');
    f.run('verify-tag', 'v1.2.1');
    assert.equal(f.run('show', 'main:package.json'), mainVersion);
    assert.equal(f.run('log', '-1', '--format=%s', 'main'), 'docs: changelog for v1.2.1');
    assert.equal(changelogSection(f.run('show', 'main:CHANGELOG.md'), '1.2.1'), changelogSection(f.run('show', 'HEAD:CHANGELOG.md'), '1.2.1'));
    assert.equal(git(['tag', '--list', 'v1.2.1'], f.origin), '');
    assert.equal(f.run('status', '--porcelain'), '');
  } finally { f.close(); }
});

test('preflight refusals leave the repository unchanged', () => {
  const f = fixture();
  const unchanged = (action, reason) => {
    const before = f.run('rev-parse', 'HEAD'), status = f.run('status', '--porcelain'), tags = f.run('tag', '--list');
    assert.throws(action, reason);
    assert.equal(f.run('rev-parse', 'HEAD'), before); assert.equal(f.run('status', '--porcelain'), status); assert.equal(f.run('tag', '--list'), tags);
  };
  try {
    unchanged(() => release({ ...f.options, version: '0.9.0' }), /start at 1.0.0/);
    unchanged(() => release({ ...f.options, edit: () => {} }), /nonempty/);
    f.write('dirty', 'dirty'); unchanged(() => release(f.options), /clean/); rmSync(join(f.cwd, 'dirty'));
    f.run('config', '--unset', 'user.signingkey'); f.run('config', '--unset', 'gpg.format');
    unchanged(() => release(f.options), /signingkey/);
    f.run('config', 'gpg.format', 'ssh'); f.run('config', 'user.signingkey', join(f.temporary, 'key'));
    for (const name of ['CI', 'Repo compliance', 'Image checks']) {
      unchanged(() => release({ ...f.options, gh: (args) => JSON.stringify(JSON.parse(f.options.gh(args)).filter((run) => run.workflowName !== name)) }), new RegExp(name));
    }
    f.run('checkout', '-b', 'task/example'); f.run('push', 'origin', 'task/example');
    unchanged(() => release(f.options), /released on main/);
    f.run('checkout', 'main');
    f.write('fix', 'fix'); f.commit('fix: pending');
    unchanged(() => release(f.options), /level with origin/);
    f.publishFixture(); release(f.options); f.publishFixture();
    f.write('feature', 'feature'); f.commit('feat: feature'); f.publishFixture();
    unchanged(() => release({ ...f.options, version: '1.0.1' }), /at least 1.1.0/);
    f.write('packages/db/src/migrations/0001_next.sql', 'alter table example add column value text;\n');
    f.commit('fix: migration'); f.publishFixture();
    unchanged(() => release({ ...f.options, version: '1.0.1' }), /at least 1.1.0/);
  } finally { f.close(); }
});

test('a tag that comes back unsigned is deleted with its release commit', () => {
  const f = fixture();
  try {
    const before = f.run('rev-parse', 'HEAD');
    // What Git does when the signer can't ask for a passphrase: exit 0 with an unsigned annotated tag.
    const unsigned = (tag, cwd) => git(['tag', '-a', tag, '-m', tag], cwd);
    assert.throws(() => release({ ...f.options, version: '1.0.0', tag: unsigned }), /v1\.0\.0 came back unsigned/);
    assert.equal(f.run('tag', '--list'), '');
    assert.equal(f.run('rev-parse', 'HEAD'), before);
    assert.equal(f.run('status', '--porcelain'), '');
    // A signer that fails outright leaves the same state.
    assert.throws(() => release({ ...f.options, version: '1.0.0', tag: () => { throw new Error('signer failed'); } }), /signer failed/);
    assert.equal(f.run('tag', '--list'), '');
    assert.equal(f.run('rev-parse', 'HEAD'), before);
    // The default signer, with the terminal attached, signs.
    assert.equal(release({ ...f.options, version: '1.0.0' }).version, '1.0.0');
    f.run('verify-tag', 'v1.0.0');
  } finally { f.close(); }
});

test('a cleanup failure keeps the signer error as the cause and attaches cleanup errors', () => {
  const f = fixture();
  const signerError = new Error('original signer failure');
  try {
    assert.throws(() => release({ ...f.options, version: '1.0.0', tag: () => {
      // An independent Git process holding the index lock prevents cleanup's reset.
      writeFileSync(join(f.cwd, '.git/index.lock'), 'fixture lock');
      throw signerError;
    } }), error => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, signerError);
      assert.equal(error.errors[0], signerError);
      assert.match(error.errors[1].message, /index.lock/);
      return true;
    });
  } finally { f.close(); }
});
