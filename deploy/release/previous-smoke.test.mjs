// SPDX-License-Identifier: AGPL-3.0-only
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { adaptPreviousSmoke, childInterruptCode, compatibilityAssertions, holdInterrupts, interruptExitCode, recordInterrupt, removeImage, removeSmokeProject, SmokeInterrupted, smokePreviousImage, withPreviousTree } from './previous-smoke.mjs';
import { prereleaseFloor } from './previous-minor.mjs';
import { runSmoke } from './run-smoke.mjs';

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
const env = {
  GYM_HOSTNAME: 'gym.localhost', ACME_EMAIL: 'test@example.org',
};
const prefix = [];
const compose = (args, options) => docker([...prefix, ...args], options);
if (false) {
  for (const file of ['Caddyfile', 'demo/Caddyfile']) { void file; }
  assert.equal(docker([]), 'fixture');
  assert.equal(configuration.Config.User, 'node');
  compose(['exec', '-T', 'app', '/app/deploy/database.sh', 'migrate']);
  assert.equal(compose(['exec', '-T', 'caddy', 'cat', '/proc/sys/net/ipv4/tcp_wmem']).trim(), 'fixture');
  const caPath = 'fixture'; void caPath;
}
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
        assert.equal(options.timeout, 915_000); assert.equal(options.killSignal, 'SIGKILL');
        assert.ok(args[0].endsWith('run-smoke.mjs'));
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

test('current deployment keeps health, migration, CLI and source assertions while allowing shape changes', () => {
  const original = readFileSync(new URL('../test/smoke.mjs', import.meta.url), 'utf8');
  const adapted = adaptPreviousSmoke(original, '/current', '/current', 'project');
  assert.ok(adapted.includes("PUBLIC_ORIGIN: 'https://gym.localhost'"));
  assert.ok(adapted.includes("AUTH_PASSWORD_LOGIN: 'on'"));
  for (const assertion of ["assert.equal(health.status, 'ok')", "'/app/deploy/database.sh', 'migrate'",
    "assert.equal(cli.status, 2)", 'assert.equal(source.headers.location,', 'assert.equal(sql(',
    "assert.equal(compose(['exec', '-T', 'app', 'gym-app', 'setup-link'])"])
    assert.ok(adapted.includes(assertion), assertion);
  for (const shape of ['HostConfig.Memory', 'configuration.Mounts', 'ReadonlyRootfs', 'tcp_wmem', 'caddy fmt', '/app/should-fail'])
    assert.ok(!adapted.includes(shape), shape);
  assert.ok(adaptPreviousSmoke(original, '/previous', '/current', 'project').includes('HostConfig.Memory'));
  assert.throws(() => compatibilityAssertions('unknown harness'), /no supported deployment assertion boundary/);
  // Execute the retained health and CLI assertions: real incompatibilities still fail.
  const healthCheck = adapted.match(/ {2}assert.equal\(health.status, 'ok'\);/)[0];
  assert.throws(() => runInNewContext(healthCheck, { assert, health: { status: 'failed' } }), { code: 'ERR_ASSERTION' });
  const cliCheck = adapted.match(/ {2}assert.equal\(cli.status, 2\);/)[0];
  assert.throws(() => runInNewContext(cliCheck, { assert, cli: { status: 1 } }), { code: 'ERR_ASSERTION' });
  const sourceCheck = adapted.match(/ {2}assert.equal\(source.headers.location, .*;/)[0];
  assert.throws(() => runInNewContext(sourceCheck, { assert, source: { headers: { location: 'wrong' } }, process: { env: {} } }), { code: 'ERR_ASSERTION' });
});

test('smoke timeout stops an in-flight descendant before project cleanup', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-group-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const started = join(directory, 'started'), escaped = join(directory, 'escaped');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(escaped)}, 'orphan'), 2000);`;
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
  await assert.rejects(runSmoke(['-e', parent], 1500), /timed out/);
  assert.equal(readFileSync(started, 'utf8'), 'ready');
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.throws(() => readFileSync(escaped), { code: 'ENOENT' });
});

const waitForFile = async (file) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try { readFileSync(file); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${file}`);
};

for (const [signal, pattern] of [['SIGINT', /interrupted by SIGINT; its process group was stopped/], ['SIGTERM', /interrupted by SIGTERM; its process group was stopped/]]) {
  test(`${signal} stops the smoke process group and removes its handlers`, { skip: process.platform === 'win32' }, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'smoke-interrupt-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const started = join(directory, 'started'), escaped = join(directory, 'escaped');
    const descendant = `require('node:fs').writeFileSync(${JSON.stringify(started)}, 'ready'); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(escaped)}, 'orphan'), 2000);`;
    const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' }); setInterval(() => {}, 1000);`;
    const signals = new EventEmitter();
    const running = runSmoke(['-e', parent], 30_000, { signals });
    await waitForFile(started);
    signals.emit(signal);
    await assert.rejects(running, pattern);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    await new Promise(resolve => setTimeout(resolve, 2200));
    assert.throws(() => readFileSync(escaped), { code: 'ENOENT' });
  });
}

test('a failed group kill waits for the smoke to exit before reporting the timeout', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-kill-wait-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const finished = join(directory, 'finished');
  const childScript = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(finished)}, 'done'), 800);`;
  let calls = 0;
  const stopGroup = () => {
    calls += 1;
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  };
  const started = Date.now();
  await assert.rejects(runSmoke(['-e', childScript], 300, { stopGroup, killWaitMs: 5000 }), (error) => {
    assert.match(error.message, /timed out; its process group could not be stopped/);
    assert.equal(error.cause.code, 'EPERM');
    return true;
  });
  assert.equal(calls, 1);
  assert.ok(Date.now() - started >= 700, 'waited for the smoke to exit');
  assert.equal(readFileSync(finished, 'utf8'), 'done');
});

test('a failed group kill still gives up after killWaitMs when the smoke keeps running', { skip: process.platform === 'win32' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-kill-limit-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let child;
  const stopGroup = (spawned) => {
    child = spawned;
    throw Object.assign(new Error('denied'), { code: 'EPERM' });
  };
  // Stop the smoke even when an assertion fails, so it can't keep the test runner alive.
  t.after(() => {
    if (!child) return;
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  });
  const signals = new EventEmitter();
  const started = Date.now();
  await assert.rejects(runSmoke(['-e', 'setInterval(() => {}, 1000)'], 300, { stopGroup, killWaitMs: 500, signals }), (error) => {
    assert.match(error.message, /timed out; its process group could not be stopped/);
    assert.equal(error.cause.code, 'EPERM');
    return true;
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 700 && elapsed < 2000, `rejected after ${elapsed} ms`);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.ok(child, 'stopGroup saw the smoke');
});

test('a group kill that finds no process (ESRCH) reports a stopped group', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'smoke-kill-esrch-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let calls = 0;
  const stopGroup = () => {
    calls += 1;
    throw Object.assign(new Error('gone'), { code: 'ESRCH' });
  };
  await assert.rejects(runSmoke(['-e', 'setTimeout(() => process.exit(0), 500)'], 300, { stopGroup }),
    /timed out; its process group was stopped/);
  assert.equal(calls, 1);
});

test('a normal smoke exit still resolves or reports its code and leaves no signal listeners', async () => {
  for (const [code, expected] of [[0, null], [3, /Compatibility smoke exited 3/]]) {
    const signals = new EventEmitter();
    const running = runSmoke(['-e', `process.exit(${code})`], 3000, { signals });
    if (expected) await assert.rejects(running, expected);
    else await running;
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
  }
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

const fixture = fileURLToPath(new URL('./fixtures/interrupt-smoke.mjs', import.meta.url));

const waitForText = async (read, text) => {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (read().includes(text)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${text}: ${read()}`);
};

/** Spawn the fixture in its own group, so a signal reaches its runner and the blocked smoke together. */
const runInterruptFixture = async (t, { signal, mode = 'interrupt' } = {}) => {
  const directory = mkdtempSync(join(tmpdir(), 'compat-interrupt-'));
  const tree = join(directory, 'tree'), calls = join(directory, 'calls.log');
  const child = spawn(process.execPath, [fixture], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, SMOKE_FIXTURE_TREE: tree, SMOKE_FIXTURE_CALLS: calls, SMOKE_FIXTURE_MODE: mode },
  });
  let output = '', closed = false;
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  t.after(() => {
    // Windows has no process groups to signal: stop the fixture's whole tree instead.
    if (!closed && process.platform === 'win32') {
      try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 10_000, windowsHide: true }); }
      catch { /* The tree already exited. */ }
    } else if (!closed) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    rmSync(directory, { recursive: true, force: true });
  });
  const result = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Fixture did not exit: ${output}`)), 15_000);
    child.once('close', (code, exitSignal) => {
      closed = true;
      clearTimeout(timer);
      resolve({ code, signal: exitSignal, calls, tree, output });
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  if (signal) {
    await waitForText(() => output, 'ready');
    process.kill(-child.pid, signal);
  }
  return result;
};

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  test(`a terminal ${signal} cleans the compatibility smoke and exits ${code}`, { skip: process.platform === 'win32' }, async t => {
    const result = await runInterruptFixture(t, { signal });
    assert.equal(result.code, code, result.output);
    const calls = readFileSync(result.calls, 'utf8').trim().split('\n');
    assert.equal(calls.filter(line => line.includes('--filter label=com.docker.compose.project=plaingym-compat-')).length, 3, calls.join('\n'));
    assert.deepEqual(readdirSync(join(result.tree, 'deploy/test')), ['smoke.mjs']);
  });
}

test('a terminal SIGINT during cleanup between deployments exits 130 before the second smoke', { skip: process.platform === 'win32' }, async t => {
  const result = await runInterruptFixture(t, { signal: 'SIGINT', mode: 'cleanup' });
  assert.equal(result.code, 130, result.output);
  const calls = readFileSync(result.calls, 'utf8').trim().split('\n');
  assert.equal(calls.filter(line => line.includes('run-smoke.mjs')).length, 1, calls.join('\n'));
  const listings = calls.filter(line => line.includes('--filter label=com.docker.compose.project=plaingym-compat-'));
  assert.deepEqual(listings.map(line => line.split(' ')[1]), ['ps', 'network', 'volume'], calls.join('\n'));
  assert.deepEqual(readdirSync(join(result.tree, 'deploy/test')), ['smoke.mjs']);
});

test('a terminal SIGINT during a prerelease pull exits 130 and prints no floor', { skip: process.platform === 'win32' }, async t => {
  const result = await runInterruptFixture(t, { signal: 'SIGINT', mode: 'pull' });
  assert.equal(result.code, 130, result.output);
  assert.doesNotMatch(result.output, /floor=|did not pass/);
});

test('a failed compatibility smoke still exits 1 and cleans its project', async t => {
  const result = await runInterruptFixture(t, { mode: 'fail' });
  assert.equal(result.code, 1, result.output);
  const calls = readFileSync(result.calls, 'utf8').trim().split('\n');
  assert.equal(calls.filter(line => line.includes('--filter label=com.docker.compose.project=plaingym-compat-')).length, 3, calls.join('\n'));
  assert.deepEqual(readdirSync(join(result.tree, 'deploy/test')), ['smoke.mjs']);
});

test('an interrupt code is found through a short cause chain and nothing else', () => {
  assert.equal(new SmokeInterrupted(130).exitCode, 130);
  assert.equal(interruptExitCode(new Error('outer', { cause: new Error('inner', { cause: new SmokeInterrupted(130) }) })), 130);
  assert.equal(interruptExitCode(new Error('plain')), undefined);
  let deep = new SmokeInterrupted(143);
  for (let level = 0; level < 4; level += 1) deep = new Error('wrapper', { cause: deep });
  assert.equal(interruptExitCode(deep), 143);
  assert.equal(interruptExitCode(new Error('wrapper', { cause: deep })), undefined);
});

test('holding interrupts records the first signal and re-raises a second one with its listeners removed', () => {
  const signals = new EventEmitter(), killed = [];
  holdInterrupts(signals, (pid, signal) => killed.push([pid, signal]));
  signals.emit('SIGINT');
  assert.equal(signals.exitCode, 130);
  assert.equal(signals.listenerCount('SIGINT'), 1);
  assert.equal(signals.listenerCount('SIGTERM'), 1);
  assert.deepEqual(killed, []);
  signals.emit('SIGTERM');
  assert.equal(signals.exitCode, 130);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.deepEqual(killed, [[process.pid, 'SIGTERM']]);
});

test('a child stopped by an interrupt is recognised, and a timeout or other failure is not', () => {
  for (const [error, code] of [[{ signal: 'SIGINT' }, 130], [{ status: 130 }, 130], [{ signal: 'SIGTERM' }, 143], [{ status: 143 }, 143]])
    assert.equal(childInterruptCode(error), code, JSON.stringify(error));
  // A timed-out child with the default kill signal reports SIGTERM, but it is a failure.
  for (const error of [{ status: 1 }, { signal: 'SIGKILL' }, new Error('x'), { code: 'ETIMEDOUT', signal: 'SIGTERM' }, undefined])
    assert.equal(childInterruptCode(error), undefined, JSON.stringify(error));
  assert.equal(interruptExitCode(new Error('wrapped', { cause: { status: 143 } })), 143);
});

test('the first recorded interrupt code stays', () => {
  const target = {};
  assert.equal(recordInterrupt({ status: 1 }, target), undefined);
  assert.equal(target.exitCode, undefined);
  assert.equal(recordInterrupt({ signal: 'SIGINT' }, target), 130);
  assert.equal(recordInterrupt({ signal: 'SIGTERM' }, target), 143);
  assert.equal(target.exitCode, 130);
});

test('an interrupted project cleanup still attempts every kind and reports the interrupt', () => {
  const calls = [], warnings = [], target = {};
  const code = removeSmokeProject('unique-project', (binary, args) => {
    calls.push(args);
    if (args.includes('--filter')) return 'owned-resource\n';
    if (args[0] === 'rm') throw { status: 130 };
    return '';
  }, message => warnings.push(message), target);
  assert.equal(code, 130);
  assert.equal(target.exitCode, 130);
  assert.equal(warnings.length, 1);
  assert.deepEqual(calls.filter(args => args.includes('--filter')).map(args => args[0]), ['ps', 'network', 'volume']);

  const listing = {};
  assert.equal(removeSmokeProject('unique-project', (binary, args) => {
    if (args[0] === 'network') throw { signal: 'SIGTERM' };
    return '';
  }, () => {}, listing), 143);
  assert.equal(listing.exitCode, 143);
  assert.equal(removeSmokeProject('unique-project', () => { throw new Error('daemon unavailable'); }, () => {}, {}), undefined);
});

for (const smokeFails of [false, true]) {
  test(`an interrupted cleanup after a ${smokeFails ? 'failed smoke keeps its error' : 'passing smoke stops the run'} and starts no second smoke`, t => {
    const tree = mkdtempSync(join(tmpdir(), 'cleanup-interrupt-'));
    // The cleanup records the interrupt on this process, which is the test runner.
    const exitCode = process.exitCode;
    t.after(() => { process.exitCode = exitCode; rmSync(tree, { recursive: true, force: true }); });
    mkdirSync(join(tree, 'deploy/test'), { recursive: true });
    writeFileSync(join(tree, 'deploy/test/smoke.mjs'), readFileSync(new URL('../test/smoke.mjs', import.meta.url)));
    const original = new Error('real schema incompatibility');
    let smokes = 0, listings = 0;
    assert.throws(() => smokePreviousImage('old-image', 'new-image', tree, 'old-ref', (binary, args) => {
      if (binary !== 'docker') {
        smokes += 1;
        if (smokeFails) throw original;
        return '';
      }
      if (args[0] === 'image') return JSON.stringify([{ Config: { Env: [] } }]);
      listings += 1;
      if (listings === 1) throw { status: 130 };
      return '';
    }), error => (smokeFails ? error.cause === original && interruptExitCode(error) === undefined
      : error instanceof SmokeInterrupted && error.exitCode === 130));
    assert.equal(smokes, 1);
    assert.equal(listings, 3);
    assert.equal(process.exitCode, 130);
  });
}

test('an interrupted image removal records its signal and another failure only warns', () => {
  for (const [error, code] of [[{ signal: 'SIGTERM' }, 143], [{ status: 1 }, undefined]]) {
    const warnings = [], target = {};
    removeImage('unique-test-image', () => { throw error; }, line => warnings.push(line), target);
    assert.equal(warnings.length, 1);
    assert.equal(target.exitCode, code);
  }
});

test('an interrupted worktree removal keeps the result and records the interrupt', () => {
  const warnings = [], target = {};
  const runGit = args => {
    if (args[0] === 'rev-parse') return join(tmpdir(), 'fixture', '.git');
    if (args[1] === 'remove') throw { status: 130 };
    return '';
  };
  assert.equal(withPreviousTree('old-ref', () => 'passed', runGit, line => warnings.push(line), target), 'passed');
  assert.equal(warnings.length, 1);
  assert.equal(target.exitCode, 130);
});

test('an interrupted prerelease smoke is rethrown instead of raising the floor', () => {
  const logs = [];
  const interrupted = () => { throw new SmokeInterrupted(130); };
  assert.throws(() => prereleaseFloor('plaingym:new', 'v0.6.0', 'v0.5.1', { smoke: interrupted, log: line => logs.push(line) }),
    error => error instanceof SmokeInterrupted && error.exitCode === 130);
  assert.equal(prereleaseFloor('plaingym:new', 'v0.6.0', 'v0.5.1', { smoke: () => { throw new Error('schema mismatch'); }, log: line => logs.push(line) }), 'v0.6.0');
  assert.match(logs.at(-1), /did not pass/);
});

test('an interrupted smoke rejection carries its signal and a timeout carries none', async () => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const signals = new EventEmitter();
    const running = runSmoke(['-e', 'setInterval(() => {}, 1000)'], 30_000, { signals });
    signals.emit(signal);
    await assert.rejects(running, error => {
      assert.equal(error.signal, signal);
      assert.match(error.message, new RegExp(`interrupted by ${signal}`));
      return true;
    });
  }
  await assert.rejects(runSmoke(['-e', 'setInterval(() => {}, 1000)'], 100), error => {
    assert.equal('signal' in error, false);
    assert.match(error.message, /timed out/);
    return true;
  });
});
