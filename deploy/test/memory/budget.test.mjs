// SPDX-License-Identifier: AGPL-3.0-only
// node --test deploy/test/memory/budget.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessRun, budget, evaluate, summarize } from './budget.mjs';

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
