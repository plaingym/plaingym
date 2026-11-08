// SPDX-License-Identifier: AGPL-3.0-only
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { evaluate } from './budget.mjs';

function cappedPeak(result, label) {
  const peak = result?.summary?.stack?.peakProcessBytes;
  if (result?.mode !== 'capped' || result?.exitCode !== 0 || !Number.isFinite(peak) || peak <= 0)
    throw new Error(`${label}: a successful capped memory run with sampler evidence is required`);
  const violations = evaluate(result.summary, { mode: 'capped', facts: result.facts });
  if (violations.length) throw new Error(`${label}: general capped budget failed: ${violations.join('; ')}`);
  return peak;
}

/** Compare back-to-back runs on the same machine, with the same allocator defaults. */
export function checkWaiverBudget(baseline, result, state) {
  const baselinePeak = cappedPeak(baseline, 'Baseline');
  const peak = cappedPeak(result, 'PDF run');
  if (state?.document?.pages !== 20 || state?.document?.bytes !== 10 * 1024 ** 2 || state?.signatures?.length !== 6)
    throw new Error('The memory run must use the 20-page, 10 MiB uploaded PDF and six signed copies');
  const increase = peak - baselinePeak;
  if (increase > 100_000_000) throw new Error(`PDF workload stack peak increase ${increase} bytes exceeds 100 MB over baseline`);
  return { documentPages: 20, documentBytes: state.document.bytes, baselineStackPeakBytes: baselinePeak,
    stackPeakBytes: peak, increaseBytes: increase, budgetBytes: 100_000_000 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node waiver-budget.mjs <baseline capped directory> <PDF capped directory>');
  const baseline = JSON.parse(await readFile(resolve(process.argv[2], 'summary.json'), 'utf8'));
  const directory = resolve(process.argv[3]);
  const result = JSON.parse(await readFile(resolve(directory, 'summary.json'), 'utf8'));
  const state = JSON.parse(await readFile(resolve(directory, 'state.json'), 'utf8'));
  console.log(JSON.stringify(checkWaiverBudget(baseline, result, state)));
}
