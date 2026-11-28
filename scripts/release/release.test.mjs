// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { git, root } from './version.mjs';
import { release, proposal, changelogSection, insertSection, pushPathFilter, skippedByFilter, unreleasedNotes } from './release.mjs';
import { expectedSourceLocation, repositoryRoot } from '../../deploy/test/source-link.mjs';

const pinnedNodeImage = /(?<![\w-])node:[^\s"'`@]+-bookworm-slim@sha256:[0-9a-f]{64}/g;

/** The runtime image every Node helper container must use, as the Dockerfile declares it. */
function dockerfileNodeImage(text) {
  const [match] = text.matchAll(/^ARG NODE_IMAGE=(node:\S+)$/gm);
  assert.ok(match, 'deploy/Dockerfile must declare ARG NODE_IMAGE');
  return match[1];
}

/** Every pinned Node base image that differs from the Dockerfile's NODE_IMAGE, with the file that names it. */
function staleNodeImagePins(files, read) {
  const expected = dockerfileNodeImage(read('deploy/Dockerfile'));
  const stale = [];
  for (const file of files) {
    for (const [image] of read(file).matchAll(pinnedNodeImage)) {
      if (image !== expected) stale.push({ file, image, expected });
    }
  }
  return stale;
}

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
    f.run('reset', '--hard', 'v1.1.0'); f.run('push', '--force', 'origin', 'HEAD:next');
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
  // Releases are made on next, which starts at main's commit.
  run('checkout', '-b', 'next'); run('push', 'origin', 'next');
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

test('real first release, signed tag, no push, explicit minor, and patch changelog back on next', () => {
  const f = fixture();
  try {
    const originHead = git(['rev-parse', 'next'], f.origin), mainHead = f.run('rev-parse', 'main');
    assert.equal(release({ ...f.options, version: '1.0.0' }).version, '1.0.0');
    assert.equal(f.run('log', '-1', '--format=%s', 'next'), 'chore(release): v1.0.0');
    assert.equal(f.run('rev-parse', 'main'), mainHead);
    assert.equal(f.run('cat-file', '-t', 'v1.0.0'), 'tag');
    f.run('verify-tag', 'v1.0.0');
    assert.equal(git(['rev-parse', 'next'], f.origin), originHead);
    assert.equal(git(['rev-parse', 'main'], f.origin), mainHead);
    assert.equal(git(['tag', '--list'], f.origin), '');
    assert.match(readFileSync(join(f.cwd, 'CHANGELOG.md'), 'utf8'), /The first release/);
    f.publishFixture();
    assert.equal(release(f.options), null);
    f.write('feature', 'new\n'); f.commit('feat: new feature'); f.publishFixture();
    assert.equal(release({ ...f.options, version: '1.2.0' }).version, '1.2.0');
    assert.equal(f.run('log', '-1', '--format=%s', 'next'), 'chore(release): v1.2.0');
    assert.equal(f.run('rev-parse', 'main'), mainHead);
    f.publishFixture();
    f.run('checkout', '-b', 'release/1.2'); f.run('push', 'origin', 'release/1.2');
    f.write('fix', 'fixed\n'); f.commit('fix: correct health'); f.publishFixture();
    // The patch changelog goes on next, which must be level with origin first.
    f.run('branch', '-f', 'next', 'next~1');
    const before = f.run('rev-parse', 'HEAD');
    assert.throws(() => release(f.options), /next must be level with origin/);
    assert.equal(f.run('rev-parse', 'HEAD'), before); assert.equal(f.run('tag', '--list', 'v1.2.1'), '');
    f.run('branch', '-f', 'next', 'origin/next');
    const nextVersion = f.run('show', 'next:package.json');
    assert.equal(release(f.options).version, '1.2.1');
    f.run('verify-tag', 'v1.2.1');
    assert.equal(f.run('show', 'next:package.json'), nextVersion);
    assert.equal(f.run('log', '-1', '--format=%s', 'next'), 'docs: changelog for v1.2.1');
    assert.equal(changelogSection(f.run('show', 'next:CHANGELOG.md'), '1.2.1'), changelogSection(f.run('show', 'HEAD:CHANGELOG.md'), '1.2.1'));
    assert.equal(f.run('rev-parse', 'main'), mainHead);
    assert.equal(git(['tag', '--list', 'v1.2.1'], f.origin), '');
    assert.equal(f.run('status', '--porcelain'), '');
  } finally { f.close(); }
});

test('the first release ignores the nightly prerelease tags, even on the commit the last one tagged', () => {
  const f = fixture();
  try {
    f.run('tag', 'v0.5.0'); f.publishFixture();
    assert.equal(release({ ...f.options, version: '1.0.0' }).version, '1.0.0');
    const changelog = readFileSync(join(f.cwd, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /The first release/);
    assert.match(changelog, /Migrations: initial schema \(fresh installation\)\./);
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
    unchanged(() => release(f.options), /released on next/);
    f.run('checkout', 'main');
    unchanged(() => release(f.options), /must be released on next/);
    f.run('checkout', 'next');
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

test('every pinned Node base image matches NODE_IMAGE in the Dockerfile', () => {
  // NUL-separated so git never quotes a path; a tracked file deleted in the working tree has nothing to scan.
  const files = git(['ls-files', '-z'], root, { raw: true }).split('\0').filter((file) => file && existsSync(join(root, file)));
  const stale = staleNodeImagePins(files, (file) => readFileSync(join(root, file), 'utf8'));
  assert.deepEqual(stale, [], 'a base refresh must update every pinned Node image reference');
});

test('the Node base image pin check flags a stale digest and accepts a matching one', () => {
  const matching = 'node:24.22.1-bookworm-slim@sha256:' + 'a'.repeat(64);
  const stale = 'node:24.22.1-bookworm-slim@sha256:' + 'b'.repeat(64);
  const files = {
    'deploy/Dockerfile': `ARG NODE_IMAGE=${matching}\n`,
    'deploy/test/memory/run.mjs': `const nodeImage = '${matching}';\n`,
    'deploy/test/memory/tcp-throughput.mjs': `const nodeImage = '${matching}';\n`,
    'e2e/compose.yaml': `    image: ${stale}\n`,
    // A tag without a digest and another image's digest are not pinned Node base images.
    'deploy/README.md': 'docker buildx imagetools inspect node:24.22.1-bookworm-slim\n',
    'deploy/compose.yaml': '    image: caddy:2.11.7-alpine@sha256:' + 'c'.repeat(64) + '\n',
  };
  assert.deepEqual(staleNodeImagePins(Object.keys(files), (file) => files[file]),
    [{ file: 'e2e/compose.yaml', image: stale, expected: matching }]);
});

test('the image build refuses a SOURCE_URL the app would refuse', () => {
  const dockerfile = readFileSync(join(root, 'deploy/Dockerfile'), 'utf8');
  const identity = dockerfile.slice(0, dockerfile.indexOf('\nFROM ', dockerfile.indexOf(' AS identity')));
  const lines = identity.split('\n').filter((line) => line.startsWith('RUN node -e') && line.includes('SOURCE_URL'));
  assert.equal(lines.length, 1, 'the identity stage checks SOURCE_URL once');
  const check = lines[0].slice('RUN '.length);
  const run = (value) => {
    const result = spawnSync('sh', ['-c', check], { env: { ...process.env, SOURCE_URL: value }, encoding: 'utf8' });
    assert.equal(result.error, undefined, 'the check runs with sh from PATH');
    return result;
  };
  const refused = ['', 'github.com/me/gym', 'ftp://example.com/x', 'https://', 'http:/x', 'https://user:token@github.com/me/gym',
    'https://user@example.com/x', 'https://exa mple.com', 'https://[', 'https://github.com/me/gym\t', 'https://github.com/me/gym\n',
    ' https://github.com/me/gym', 'https://github.com/me/g\rym', 'https://github.com/me/my gym', 'https://github.com/me/gym\x7f',
    'https://github.com/me/g\x01ym', 'https://github.com/me/gym ', 'https://github.com/me/gym\u0085'];
  for (const value of refused) {
    const result = run(value);
    assert.notEqual(result.status, 0, `${JSON.stringify(value)} must fail`);
    assert.match(result.stderr, /^SOURCE_URL must be an http:\/\/ or https:\/\/ URL without a user name or password\. Leave it unset or empty for scripts\/release\/build-image\.mjs, or omit the build argument, to link to the project repository\.$/m);
  }
  for (const value of ['https://github.com/plaingym/plaingym', 'https://github.com/me/gym/tree/abc', 'http://localhost/x', 'HTTPS://github.com/me/gym',
    'https://github.com/me/my%20gym']) {
    const result = run(value);
    assert.equal(result.status, 0, `${value} must pass: ${result.stderr}`);
  }
});

test('the smoke test expects the image link for an unset, empty or root SOURCE_URL', () => {
  const image = 'https://github.com/plaingym/plaingym/tree/abc';
  for (const value of [undefined, '', repositoryRoot, `${repositoryRoot}/`, 'https://GitHub.com/plaingym/plaingym'])
    assert.equal(expectedSourceLocation(value, image), image, String(value));
  assert.equal(expectedSourceLocation('https://github.com/me/gym', image), 'https://github.com/me/gym');
  assert.equal(expectedSourceLocation(repositoryRoot, ''), repositoryRoot);
  // The app redirects to the parsed link: a bare origin gains its root path and the host is lower-cased.
  assert.equal(expectedSourceLocation('https://example.org', image), 'https://example.org/');
  assert.equal(expectedSourceLocation('https://GitHub.com/me/gym', image), 'https://github.com/me/gym');
  assert.equal(expectedSourceLocation(undefined, 'https://Example.org'), 'https://example.org/');
});

test('the smoke test uses the same repository root as the app', () => {
  const app = readFileSync(join(root, 'apps/server/src/core/source-link.ts'), 'utf8');
  assert.equal(app.match(/export const defaultSourceUrl = '([^']+)';/)?.[1], repositoryRoot);
});

test('a version that still ships code due for removal is refused before anything is written', () => {
  const f = fixture();
  const options = { ...f.options, removals: [{ from: '1.1.0', file: 'src/compat.ts', identifier: 'oldHelper' }] };
  try {
    // Below the listed version the code may stay.
    f.write('src/compat.ts', 'oldHelper\n'); f.commit('feat: compat'); f.publishFixture();
    assert.equal(release({ ...options, version: '1.0.0' }).version, '1.0.0');
    f.publishFixture();
    f.write('src/compat.ts', 'oldHelper // still here\n'); f.commit('feat: x'); f.publishFixture();
    const head = f.run('rev-parse', 'HEAD');
    assert.throws(() => release({ ...options, version: '1.1.0' }),
      /^Error: 1\.1\.0 .*oldHelper in src\/compat\.ts/);
    assert.equal(f.run('rev-parse', 'HEAD'), head);
    assert.equal(f.run('tag', '--list', 'v1.1.0'), '');
    assert.equal(f.run('status', '--porcelain'), '');
    // Once the listed file no longer holds it, the same version releases.
    f.write('src/compat.ts', 'removed\n'); f.commit('fix: drop the old helper'); f.publishFixture();
    assert.equal(release({ ...options, version: '1.1.0' }).version, '1.1.0');
  } finally { f.close(); }
});
