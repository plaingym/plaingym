// SPDX-License-Identifier: AGPL-3.0-only
// node --test deploy/test/memory/budget.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessRun, budget, evaluate, resolveMarks, summarize } from './budget.mjs';
import { withCleanup } from './run.mjs';

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
