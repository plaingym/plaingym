// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { adaptPreviousSmoke, removeImage, removeSmokeProject, smokePreviousImage, withPreviousTree } from './previous-smoke.mjs';

test('the production smoke table assertion accepts schema additions only in compatibility runs', () => {
  const source = readFileSync(new URL('../test/smoke.mjs', import.meta.url), 'utf8');
  // Execute the real assertion block, without Docker or the unrelated HTTP smoke checks.
  const start = source.indexOf('  const tableCount =');
  const end = source.indexOf('  assert.equal(sql(', start);
  assert.ok(start >= 0 && end > start, 'Production table assertion block must be present');
  const block = source.slice(start, end);
  // Read the count, so a migration that bumps it in smoke.mjs doesn't have to change this test.
  const expected = Number(/const expectedTables = (\d+);/.exec(block)?.[1]);
  assert.ok(expected > 0, 'Production table assertion must name its expected count');
  const check = (count, migrateImage) => runInNewContext(block, {
    assert, process: { env: { SMOKE_MIGRATE_IMAGE: migrateImage } },
    sql: (query) => {
      assert.equal(query, "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'");
      return ` ${count}\n`;
    },
  });
  for (const migrateImage of [undefined, 'new-image']) {
    check(expected, migrateImage);
    assert.throws(() => check(expected - 1, migrateImage), { code: 'ERR_ASSERTION' });
  }
  check(expected + 1, 'new-image');
  assert.throws(() => check(expected + 1, undefined), { code: 'ERR_ASSERTION' });
});

test('previous smoke ignores a newer-only assertion but catches a real incompatibility', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'previous-smoke-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const oldTree = join(directory, 'old'), newTree = join(directory, 'new');
  for (const tree of [oldTree, newTree]) mkdirSync(join(tree, 'deploy/test'), { recursive: true });
  const harness = `import { join } from 'node:path';
const root = 'original';
const project = 'original';
const envFile = 'unused';
const prefix = [];
const compose = (args, options) => docker([...prefix, ...args], options);
`;
  writeFileSync(join(oldTree, 'deploy/test/smoke.mjs'), harness + `
    import assert from 'node:assert/strict';
    assert.equal(process.env.SMOKE_MIGRATE_IMAGE, 'new-image');
    assert.equal(process.env.VERSION, '1.0.0');
    assert.equal(process.env.SOURCE_URL, 'old-source');
    assert.equal(process.argv[2], 'compatible-old-image');
  `);
  writeFileSync(join(newTree, 'deploy/test/smoke.mjs'), harness + "throw new Error('new feature missing in old image');");
  const run = (binary, args, options) => binary === 'docker'
    ? (args[0] === 'image' ? JSON.stringify([{ Config: { Env: ['APP_VERSION=1.0.0', 'SOURCE_URL=old-source'] } }]) : '')
    : execFileSync(binary, args, { ...options, stdio: 'pipe' });
  assert.throws(() => smokePreviousImage('compatible-old-image', 'new-image', newTree, 'new-ref', run), /new feature missing/);
  smokePreviousImage('compatible-old-image', 'new-image', oldTree, 'old-ref', run);
  assert.throws(() => smokePreviousImage('incompatible-old-image', 'new-image', oldTree, 'old-ref', run),
    /Smoke test old-ref:deploy\/test\/smoke.mjs .*against incompatible-old-image, schema migrated by new-image.*failed/s);
});

test('compatibility migration always uses current files, with older assertions and the selected rollback files', () => {
  const calls = [];
  const original = readFileSync(new URL('../test/smoke.mjs', import.meta.url), 'utf8');
  const adapted = adaptPreviousSmoke(original, '/old/deploy', '/current/deploy', 'unique-project');
  // Execute the adapted composition functions from the real harness, without booting Docker.
  const block = adapted.slice(adapted.indexOf('const deploymentRoot ='), adapted.indexOf('const sql ='));
  runInNewContext(block + `
compose(['up'], { env: { APP_IMAGE: 'new-image' } });
compose(['up']);`, {
    join, root: '/old/deploy', envFile: 'fixture.env', project: 'unique-project',
    process: { env: { SMOKE_MIGRATE_IMAGE: 'new-image' } }, docker: (args) => calls.push(args),
  });
  assert.ok(calls[0].includes(join('/current/deploy', 'compose.yaml')));
  assert.ok(calls[1].includes(join('/old/deploy', 'compose.yaml')));
  assert.ok(calls.every(args => args.includes('unique-project')));
  assert.ok(adapted.includes("new URL('../', import.meta.url)"), 'assertion fixtures stay beside the older harness');
  assert.throws(() => adaptPreviousSmoke('unknown harness', '/old', '/new', 'project'), /no supported/);
});

test('a killed compatibility smoke is cleaned before its error is returned', () => {
  const tree = mkdtempSync(join(tmpdir(), 'killed-compat-'));
  try {
    mkdirSync(join(tree, 'deploy/test'), { recursive: true });
    writeFileSync(join(tree, 'deploy/test/smoke.mjs'), readFileSync(new URL('../test/smoke.mjs', import.meta.url)));
    const cleaned = [], original = new Error('smoke timed out');
    assert.throws(() => smokePreviousImage('old-image', 'new-image', tree, 'old-ref', (binary, args, options) => {
      if (binary !== 'docker') {
        assert.equal(options.timeout, 900_000); assert.equal(options.killSignal, 'SIGKILL');
        throw original;
      }
      if (args[0] === 'image') return JSON.stringify([{ Config: { Env: [] } }]);
      cleaned.push(args);
      return '';
    }), error => error.cause === original);
    assert.equal(cleaned.length, 3);
    assert.ok(cleaned.every(args => args.at(-1).startsWith('label=com.docker.compose.project=plaingym-compat-')));
  } finally { rmSync(tree, { recursive: true, force: true }); }
});

test('hard-timeout cleanup attempts containers, networks and volumes and preserves later cleanup on a failure', () => {
  const calls = [], warnings = [];
  removeSmokeProject('unique-project', (binary, args, options) => {
    calls.push(args);
    assert.equal(options.killSignal, 'SIGKILL');
    if (args.includes('--filter')) {
      assert.ok(args.includes('label=com.docker.compose.project=unique-project'));
      return 'owned-resource\n';
    }
    assert.equal(options.timeout, 120_000);
    throw new Error('ETIMEDOUT');
  }, message => warnings.push(message));
  assert.equal(warnings.length, 3);
  assert.deepEqual(calls.filter(args => !args.includes('--filter')), [
    ['rm', '-f', '-v', 'owned-resource'], ['network', 'rm', 'owned-resource'], ['volume', 'rm', 'owned-resource'],
  ]);
});

for (const removal of ['failure', 'timeout']) {
  for (const fails of [false, true]) {
    test(`${removal} removing an image preserves ${fails ? 'failure' : 'success'} and removes the worktree`, () => {
      const calls = [], warnings = [], original = new Error('real schema incompatibility');
      const runGit = (args) => { calls.push(args); return args[0] === 'rev-parse' ? join(tmpdir(), 'fixture', '.git') : ''; };
      const runRemoval = (binary, args, options) => {
        assert.equal(binary, 'docker');
        assert.deepEqual(args, ['image', 'rm', '--force', 'unique-test-image']);
        assert.equal(options.timeout, 120_000);
        assert.equal(options.killSignal, 'SIGKILL');
        if (removal === 'failure') throw new Error('image in use');
        // A real blocked child that ignores SIGTERM, with removeImage's own kill signal and a shortened timeout.
        execFileSync(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { timeout: 500, killSignal: options.killSignal });
      };
      const operation = () => withPreviousTree('old-ref', () => {
        try { if (fails) throw original; return 'passed'; }
        finally { removeImage('unique-test-image', runRemoval, (line) => warnings.push(line)); }
      }, runGit);
      if (fails) assert.throws(operation, (error) => error === original);
      else assert.equal(operation(), 'passed');
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], removal === 'timeout' ? /ETIMEDOUT/ : /image in use/);
      assert.deepEqual(calls.map((args) => args.slice(0, 2)), [['rev-parse', '--path-format=absolute'], ['worktree', 'add'], ['worktree', 'remove']]);
      assert.equal(calls[1][3], calls[2][3]);
    });
  }
}

for (const fails of [false, true]) {
  test(`a failed worktree removal warns and preserves ${fails ? 'failure' : 'success'}`, () => {
    const warnings = [], original = new Error('real schema incompatibility');
    const runGit = (args) => {
      if (args[0] === 'rev-parse') return join(tmpdir(), 'fixture', '.git');
      if (args[1] === 'remove') throw new Error('worktree locked');
      return '';
    };
    const operation = () => withPreviousTree('old-ref', () => { if (fails) throw original; return 'passed'; }, runGit, (line) => warnings.push(line));
    if (fails) assert.throws(operation, (error) => error === original);
    else assert.equal(operation(), 'passed');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^::warning::Could not remove worktree .*worktree locked/);
  });
}
