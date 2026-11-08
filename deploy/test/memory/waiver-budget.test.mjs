// SPDX-License-Identifier: AGPL-3.0-only
import { test } from 'node:test';
import { deepEqual, throws } from 'node:assert/strict';
import { checkWaiverBudget } from './waiver-budget.mjs';

const state = { document: { pages: 20, bytes: 10 * 1024 ** 2 }, signatures: Array(6).fill('signature') };
const MiB = 1024 ** 2;
const service = (peak, warm, max) => ({ peakProcessBytes: peak * MiB, warmIdleBytes: warm * MiB,
  maxBytes: max * MiB, oomEvents: 0, oomKills: 0 });
const result = (peak = 650_000_000) => ({ mode: 'capped', exitCode: 0,
  facts: { nodeOptions: '--max-old-space-size=256', containers: {} },
  summary: {
    stack: { peakProcessBytes: peak, warmIdleBytes: 500 * MiB },
    services: { app: service(400, 250, 512), postgres: service(200, 180, 384), caddy: service(50, 40, 128) },
    coverage: { samples: 180, ratio: 1, maxGapMs: 500, freshSamples: 20, warmSamples: 20 },
    hostOomKills: 0,
  } });
test('the PDF gate allows exactly 100 decimal MB above baseline, including peaks above 600 MB', () => {
  deepEqual(checkWaiverBudget(result(), result(750_000_000), state), { documentPages: 20, documentBytes: 10 * 1024 ** 2,
    baselineStackPeakBytes: 650_000_000, stackPeakBytes: 750_000_000, increaseBytes: 100_000_000, budgetBytes: 100_000_000 });
  throws(() => checkWaiverBudget(result(), result(750_000_001), state), /exceeds 100 MB over baseline/);
  deepEqual(checkWaiverBudget(result(), result(640_000_000), state).increaseBytes, -10_000_000);
});
test('a failed, uncapped or missing run on either side cannot pass the PDF gate', () => {
  for (const invalid of [null, { ...result(), mode: 'uncapped' }, { ...result(), exitCode: 1 }, result(0), result(NaN)])
    for (const runs of [[invalid, result()], [result(), invalid]])
      throws(() => checkWaiverBudget(...runs, state), /successful capped memory run/);
});
test('a text-only or incomplete PDF workload cannot pass the PDF gate', () => {
  for (const invalid of [{}, { ...state, document: { pages: 2, bytes: 1024 } }, { ...state, signatures: [] }])
    throws(() => checkWaiverBudget(result(), result(), invalid), /20-page, 10 MiB/);
});
test('a relative pass cannot bypass the general capped budgets or sampler evidence', () => {
  const mutations = [
    run => { run.summary.services.app.warmIdleBytes = 360 * MiB + 1; },
    run => { run.summary.services.app.peakProcessBytes = 520 * MiB + 1; },
    run => { run.summary.stack.peakProcessBytes = 820 * MiB + 1; },
    run => { run.summary.stack.warmIdleBytes = 640 * MiB + 1; },
    run => { run.summary.services.app.oomEvents = 1; },
    run => { run.summary.coverage.ratio = 0.8; },
    run => { run.facts.containers.app = { restarts: 1 }; },
  ];
  for (const mutate of mutations) {
    const invalid = result();
    mutate(invalid);
    for (const runs of [[invalid, result()], [result(), invalid]])
      throws(() => checkWaiverBudget(...runs, state), /general capped budget failed/);
  }
});
