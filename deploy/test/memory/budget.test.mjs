// SPDX-License-Identifier: AGPL-3.0-only
// node --test deploy/test/memory/budget.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assessRun, budget, evaluate, resolveMarks, summarize } from './budget.mjs';
import { parseSamples, removeContainers, run as command, withCleanup } from './run.mjs';

test('sample parsing keeps complete records and drops only an unterminated tail', () => {
  assert.deepEqual(parseSamples('{"at":1}\n{"at":2}\n'), [{ at: 1 }, { at: 2 }]);
  assert.deepEqual(parseSamples('{"at":1}\n{"at":'), [{ at: 1 }]);
  assert.deepEqual(parseSamples('{"at":1}'), []);
  assert.deepEqual(parseSamples(''), []);
  assert.throws(() => parseSamples('{broken}\n{"at":1}\n'), SyntaxError);
});

test('commands report success, failure, spawn errors and timeouts', async () => {
  assert.equal((await command(process.execPath, ['-e', 'console.log(42)'])).out.trim(), '42');
  await assert.rejects(command(process.execPath, ['-e', 'process.exit(3)']), /exited 3/);
  assert.equal((await command(process.execPath, ['-e', 'process.exit(3)'], { allowFailure: true })).code, 3);
  await assert.rejects(command('nonexistent-memory-command', []), /ENOENT/);
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cleanup: true, timeout: 200 }), /timed out/);
  assert.equal((await command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cleanup: true, timeout: 200, allowFailure: true })).timedOut, true);
});

test('cleanup kills descendants holding pipes, on timeout and after client exit', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  for (const exits of [false, true]) {
    const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {stdio:'inherit'}); console.log(child.pid); ${exits ? 'process.exit(0)' : 'setInterval(()=>{},1000)'}`;
    const result = await command(process.execPath, ['-e', script], { cleanup: true, timeout: 1500, exitGraceMs: 50, allowFailure: true });
    assert.equal(result.timedOut, !exits);
    const pid = Number(result.out.trim());
    assert.ok(pid > 0);
    // Resolving promptly alone could hide an orphan whose pipes were merely destroyed.
    let alive = true;
    for (let attempt = 0; attempt < 50 && alive; attempt++) {
      try {
        process.kill(pid, 0);
        // Linux may retain a killed orphan as a zombie until the init process reaps it.
        if (process.platform === 'linux') alive = !/\) Z /.test(await readFile(`/proc/${pid}/stat`, 'utf8'));
      } catch (error) {
        if (!['ESRCH', 'ENOENT'].includes(error.code)) throw error;
        alive = false;
      }
      if (alive) await delay(20);
    }
    if (alive) process.kill(pid, 'SIGKILL'); // Clean up even if this regression fails.
    assert.equal(alive, false, 'the cleanup process group must leave no running descendant');
  }
});

test('a command that is not cleanup keeps reading output until its descendants close the pipes', { skip: process.platform === 'win32' }, async () => {
  const script = `const {spawn}=require('node:child_process'); spawn(process.execPath, ['-e','setTimeout(()=>console.log("late"),400)'], {stdio:'inherit'}); process.exit(0)`;
  assert.equal((await command(process.execPath, ['-e', script], { exitGraceMs: 50 })).out.trim(), 'late');
});

test('container cleanup uses remaining names, not docker rm stderr', async () => {
  for (const error of ['No such container', 'removal is already in progress', '']) {
    const calls = [];
    await removeContainers('fixture', ['fixture-sampler'], async (_binary, args) => {
      calls.push(args);
      return args[0] === 'rm' ? { code: 1, error } : { out: 'fixture-app-1\n' };
    });
    assert.deepEqual(calls[1], ['ps', '-a', '--filter', 'name=fixture', '--format', '{{.Names}}']);
  }
  await assert.rejects(removeContainers('fixture', ['fixture-sampler'], async (_binary, args) =>
    args[0] === 'rm' ? { code: 1, error: 'device or resource busy\n' } : { out: 'fixture-sampler\n' }, 0), /remaining: fixture-sampler: device or resource busy/);
  await assert.rejects(removeContainers('fixture', ['fixture-sampler'], async (_binary, args) =>
    args[0] === 'rm' ? { timedOut: true, error: 'No such container' } : { out: '' }), /timed out/);
  // A removal already in progress is still listed for a moment.
  let listings = 0;
  await removeContainers('fixture', ['fixture-sampler'], async (_binary, args) => {
    if (args[0] === 'rm') return { code: 1, error: 'removal is already in progress' };
    return { out: listings++ ? '' : 'fixture-sampler\n' };
  }, 5_000);
  assert.equal(listings, 2);
  await assert.rejects(removeContainers('fixture', ['fixture-sampler'], async (_binary, args) => {
    if (args[0] === 'ps') throw new Error('listing failed');
    return { code: 0 };
  }), /listing failed/);
});

const MiB = 1024 ** 2;
const limits = { app: 512 * MiB, postgres: 384 * MiB, caddy: 128 * MiB };
const start = 1_000_000;
const marks = { ready: start, loadStart: start + 20_000, loadEnd: start + 70_000, settled: start + 82_000 };

/** A 90 second run sampled every 500 ms. `shape(service, seconds)` gives that service's process MiB. */
function run({ shape, capped = true, events = () => ({ oom: 0, oom_kill: 0 }), skip = () => false, hostOom = 0 } = {}) {
  const samples = [];
  for (let tick = 0; tick <= 180; tick++) {
    if (skip(tick)) continue;
    const seconds = tick / 2, at = start + tick * 500;
    const service = (name) => {
      const mib = shape(name, seconds), bytes = mib * MiB;
      return { current: Math.round(bytes * 1.2), peak: Math.round(bytes * 1.2), max: capped ? String(limits[name]) : 'max', swap: 0,
        events: { max: 0, oom: 0, oom_kill: 0, ...events(name, seconds) }, rss: bytes, pss: bytes, procs: 3 };
    };
    samples.push({ at, hostOomKills: hostOom, services: { app: service('app'), postgres: service('postgres'), caddy: service('caddy') } });
  }
  return samples;
}
// What a healthy stack looks like: idle, a bump under load, back to idle.
const healthy = (name, seconds) => {
  const phases = { app: [200, 440, 290], postgres: [50, 205, 178], caddy: [52, 54, 53] }[name];
  return seconds >= 20 && seconds <= 70 ? phases[1] : seconds > 70 ? phases[2] : phases[0];
};
const judge = (samples, mode = 'capped', facts = { containers: { app: { oomKilled: false, restarts: 0 } }, nodeOptions: '--max-old-space-size=256' }) =>
  evaluate(summarize(samples, marks), { mode, facts });
const healthySummary = summarize(run({ shape: healthy, capped: false }), marks);
const judgeRun = (summary = healthySummary, failures = [], containers = {}) =>
  assessRun(summary, { mode: 'uncapped', failures, facts: { containers } });

test('healthy load passes; exceeding a memory ceiling exits 2', () => {
  assert.equal(judgeRun().exitCode, 0);
  const summary = structuredClone(healthySummary);
  summary.services.app.peakProcessBytes = 900 * MiB;
  assert.equal(judgeRun(summary).exitCode, 2);
});

test('a failed load or backup without kill evidence exits 1 and retains its failure', () => {
  for (const failure of ['load exited 3', 'backup exited 1']) {
    const result = judgeRun(healthySummary, [failure]);
    assert.equal(result.exitCode, 1);
    assert.ok(result.violations.includes(failure));
  }
});

test('a failed workload with Docker OOM, restart or kill evidence exits 2, even without samples', () => {
  for (const state of [{ oomKilled: true }, { restarts: 1 }, { exitCode: 137 }]) {
    for (const summary of [healthySummary, null]) {
      const result = judgeRun(summary, ['load exited 3', 'backup exited 1'], { app: state });
      assert.equal(result.exitCode, 2);
      assert.ok(result.violations.includes('load exited 3'));
      assert.ok(result.violations.includes('backup exited 1'));
    }
  }
});

test('sampled cgroup OOM or host kills override a failed workload even when Docker reports no kill', () => {
  for (const change of [
    (s) => { s.services.app.oomEvents = 1; },
    (s) => { s.services.app.oomKills = 1; },
    (s) => { s.hostOomKills = 1; },
  ]) {
    const summary = structuredClone(healthySummary);
    change(summary);
    assert.equal(judgeRun(summary, ['load exited 3']).exitCode, 2);
  }
});

test('without samples, an exit 2 still names the Docker kill evidence', () => {
  const result = judgeRun(null, ['load exited 3'], { app: { oomKilled: true, restarts: 2 } });
  assert.equal(result.exitCode, 2);
  assert.ok(result.violations.includes('app container was OOM killed'));
  assert.ok(result.violations.includes('app container restarted 2 time(s)'));
});

test('missing samples without kill evidence cannot pass', () => {
  assert.equal(judgeRun(null, ['sampler results: No samples']).exitCode, 1);
  assert.equal(judgeRun(null).exitCode, 1);
});

test('bookkeeping failures retain budget exit 2, but cannot turn a healthy summary into a budget failure', () => {
  for (const failure of ['ready mark', 'loadStart mark', 'loadEnd mark', 'settled mark', 'stop sampler', 'job counts', 'inspect app', 'inspect postgres', 'inspect caddy']) {
    const options = { mode: 'uncapped', facts: { containers: {} }, bookkeepingFailures: [failure] };
    const exceeded = structuredClone(healthySummary);
    exceeded.services.app.peakProcessBytes = 900 * MiB;
    const result = assessRun(exceeded, options);
    assert.equal(result.exitCode, 2);
    assert.ok(result.violations.includes(failure));
    assert.equal(assessRun(healthySummary, options).exitCode, 1);
    assert.equal(assessRun(exceeded, { ...options, failures: ['seed failed'] }).exitCode, 1);
  }
});

test('thin evidence left by a bookkeeping failure exits 1, unless a measured budget violation remains', () => {
  const thin = structuredClone(healthySummary);
  thin.coverage.warmSamples = 0;
  const options = { mode: 'uncapped', facts: { containers: {} }, bookkeepingFailures: ['loadEnd mark: sampler is gone'] };
  const result = assessRun(thin, options);
  assert.equal(result.exitCode, 1);
  assert.ok(result.violations.includes('no samples in the warm-idle window'));
  assert.equal(assessRun(thin, { ...options, bookkeepingFailures: [] }).exitCode, 2);
  thin.services.app.peakProcessBytes = 900 * MiB;
  assert.equal(assessRun(thin, options).exitCode, 2);
});

test('a cleanup failure keeps each run result, makes a pass exit 1, and allows the next mode', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'memory-cleanup-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logs = [], cleaned = [];
  for (const exitCode of [0, 1, 2]) {
    const original = { exitCode, violations: exitCode ? ['original failure'] : [] };
    const result = await withCleanup(async () => original, [
      ['compose down', async () => { throw new Error('fixture cleanup failure'); }],
      ['temporary files', async () => { cleaned.push(exitCode); }],
    ], (line) => logs.push(line));
    assert.equal(result, original);
    assert.equal(result.exitCode, exitCode || 1);
    assert.deepEqual(result.violations, exitCode ? ['original failure'] : []);
    assert.deepEqual(result.cleanupFailures, ['compose down: fixture cleanup failure']);
    const file = join(directory, 'summary.json');
    await writeFile(file, JSON.stringify(result));
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), result);
  }
  assert.deepEqual(cleaned, [0, 1, 2]);
  assert.equal(logs.length, 3);
});

test('cleanup attempts all steps and does not replace an original workload exception', async () => {
  const original = new Error('setup failed'), cleaned = [], logs = [];
  await assert.rejects(withCleanup(async () => { throw original; }, [
    ['compose down', async () => { throw new Error('cleanup failed'); }],
    ['temporary files', async () => { cleaned.push(true); }],
  ], (line) => logs.push(line)), (error) => error === original);
  assert.deepEqual(cleaned, [true]);
  assert.equal(logs.length, 1);
});

test('sampler phase marks override host fallbacks and the saved summary identifies each clock', () => {
  const fallback = { ...marks }, recorded = { ...marks, loadEnd: marks.loadEnd + 5000 };
  delete recorded.settled;
  const resolved = resolveMarks(fallback, recorded);
  const saved = JSON.parse(JSON.stringify({ ...resolved, summary: summarize(run({ shape: healthy }), resolved.marks) }));
  assert.equal(saved.marks.loadEnd, recorded.loadEnd);
  assert.equal(saved.marks.settled, fallback.settled);
  assert.equal(saved.clock.samples, 'sampler-container');
  assert.equal(saved.clock.marks.loadEnd, 'sampler-container');
  assert.equal(saved.clock.marks.settled, 'runner-host');
  assert.match(saved.clock.note, /may differ/);
  assert.deepEqual(resolveMarks(fallback, {}).marks, fallback);
  assert.ok(Object.values(resolveMarks(fallback, {}).clock.marks).every((clock) => clock === 'runner-host'));
});

test('a healthy run passes in both modes', () => {
  assert.deepEqual(judge(run({ shape: healthy })), []);
  assert.deepEqual(judge(run({ shape: healthy, capped: false }), 'uncapped'), []);
});

test('a leak in the app fails the capped run on the app and on the whole stack', () => {
  const leak = (name, seconds) => healthy(name, seconds) + (name === 'app' && seconds > 30 ? Math.min(180, (seconds - 30) * 6) : 0);
  const bad = judge(run({ shape: leak }));
  assert.ok(bad.some((line) => line.startsWith('app RSS peak')), bad.join('\n'));
  assert.ok(bad.length > 0);
});

test('a leak is also caught in the uncapped run, against the shipped limit', () => {
  const leak = (name, seconds) => healthy(name, seconds) + (name === 'postgres' && seconds > 30 ? 400 : 0);
  assert.ok(judge(run({ shape: leak, capped: false }), 'uncapped').some((line) => line.startsWith('Postgres uncapped PSS peak')));
});

test('an out-of-memory kill fails whatever the figures', () => {
  const killed = (name, seconds) => (name === 'app' && seconds > 50 ? { oom: 1, oom_kill: 1 } : {});
  const bad = judge(run({ shape: healthy, events: killed }));
  assert.ok(bad.some((line) => line.startsWith('app hit its memory limit')), bad.join('\n'));
  assert.ok(judge(run({ shape: healthy, hostOom: 0 }).map((s, i, all) => ({ ...s, hostOomKills: i === all.length - 1 ? 2 : 0 }))).some((line) => line.includes('host killed')));
  const facts = { containers: { postgres: { oomKilled: true, restarts: 1 } } };
  const flagged = judge(run({ shape: healthy }), 'capped', facts);
  assert.ok(flagged.some((line) => line.includes('OOM killed')) && flagged.some((line) => line.includes('restarted')));
});

test('a changed memory limit or heap flag fails the capped run', () => {
  assert.ok(judge(run({ shape: healthy, capped: false })).some((line) => line.includes('memory limit is unset')));
  assert.ok(judge(run({ shape: healthy }), 'capped', { containers: {}, nodeOptions: '--max-old-space-size=1024' }).some((line) => line.includes('old-space')));
});

test('a run the sampler barely saw fails, because it proves nothing', () => {
  const sparse = judge(run({ shape: healthy, skip: (tick) => tick % 3 !== 0 }));
  assert.ok(sparse.some((line) => line.includes('coverage')), sparse.join('\n'));
  const gap = judge(run({ shape: healthy, skip: (tick) => tick > 60 && tick < 80 }));
  assert.ok(gap.some((line) => line.includes('gap')), gap.join('\n'));
  assert.ok(judge(run({ shape: healthy }).slice(0, 30)).some((line) => line.includes('fewer than')));
});

test('the budget agrees with the shipped policy', () => {
  assert.deepEqual(budget.limits, { app: 512, postgres: 384, caddy: 128 });
  assert.equal(budget.nodeOldSpaceMiB, 256);
  // Postgres and Caddy can't use more than their limit, so a ceiling above it would check nothing. The app's RSS may pass its
  // limit, since it counts program files the cgroup does not charge to it.
  assert.ok(budget.capped.postgresPeakMiB <= budget.limits.postgres && budget.capped.caddyPeakMiB <= budget.limits.caddy);
  assert.ok(budget.capped.stackIdleMiB < budget.capped.stackPeakMiB);
});
