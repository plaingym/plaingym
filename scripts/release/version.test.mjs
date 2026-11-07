// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInfo, git } from './version.mjs';

test('source archives have an unknown development identity', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'r163-archive-'));
  try {
    writeFileSync(join(cwd, 'package.json'), '{"version":"1.2.0"}\n');
    assert.deepEqual(buildInfo(cwd, {}), { version: '1.2.0+unknown', commit: 'unknown' });
    assert.deepEqual(buildInfo(cwd, { APP_BUILD_VERSION: '', APP_BUILD_REVISION: '' }), { version: '1.2.0+unknown', commit: 'unknown' });
    const supplied = { APP_BUILD_VERSION: '1.2.0', APP_BUILD_REVISION: 'a'.repeat(40) };
    assert.deepEqual(buildInfo(cwd, supplied), { version: '1.2.0', commit: 'a'.repeat(40) });
    for (const env of [{ APP_BUILD_VERSION: '1.2.0' }, { APP_BUILD_REVISION: 'a'.repeat(40) },
      { ...supplied, APP_BUILD_VERSION: '' }, { ...supplied, APP_BUILD_REVISION: '' }])
      assert.throws(() => buildInfo(cwd, env), /Supply both/);
    git(['init', '-b', 'main'], cwd);
    assert.throws(() => buildInfo(cwd, {})); // A broken/empty repository must not masquerade as an archive.
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('build identity before a tag, on a tag, after a tag and with local changes', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'r118-version-'));
  const run = (...args) => git(args, cwd);
  try {
    run('init', '-b', 'main');
    run('config', 'user.name', 'Release Test');
    run('config', 'user.email', 'release@example.test');
    run('config', 'commit.gpgsign', 'false');
    run('config', 'tag.gpgsign', 'false');
    writeFileSync(join(cwd, 'package.json'), '{"version":"1.2.0"}\n');
    run('add', '.'); run('commit', '-m', 'feat: first');
    const commit = run('rev-parse', 'HEAD');
    assert.deepEqual(buildInfo(cwd), { version: `1.2.0+0.g${commit.slice(0, 7)}`, commit });
    const cli = fileURLToPath(new URL('./version-cli.mjs', import.meta.url));
    assert.deepEqual(JSON.parse(execFileSync(process.execPath, [cli, '--json'], { cwd, encoding: 'utf8' })), buildInfo(cwd));
    run('tag', '-a', 'v1.2.0', '-m', 'v1.2.0');
    assert.equal(buildInfo(cwd).version, '1.2.0');
    writeFileSync(join(cwd, 'change'), 'fix\n');
    assert.equal(buildInfo(cwd).version, `1.2.0+0.g${commit.slice(0, 7)}.dirty`);
    run('add', '.'); run('commit', '-m', 'fix: next');
    assert.equal(buildInfo(cwd).version, `1.2.0+1.g${run('rev-parse', 'HEAD').slice(0, 7)}`);
    // A non-release tag must not replace the nearest release.
    run('tag', '-a', 'v2.0.0-rc.1', '-m', 'candidate');
    assert.match(buildInfo(cwd).version, /^1\.2\.0\+1\.g/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
