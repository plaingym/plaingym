// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { changedSpecs, fileFilters, reportTests, shardFiles, shardNumbers, verifyShards } from './ci.mjs';

describe('browser CI selection and completeness', () => {
  it('selects only specs in the default suite, including new names from a rename', () => {
    expect(changedSpecs(['e2e/specs/new.spec.ts', 'e2e/multi/isolation.spec.ts', 'e2e/support.ts',
      'e2e/ux-pass/browsers.spec.ts', 'e2e/specs/ux-pass.spec.ts', 'e2e/specs/vm.spec.ts', 'apps/web/a.spec.ts']))
      .toEqual(['e2e/specs/new.spec.ts', 'e2e/multi/isolation.spec.ts']);
    expect(changedSpecs(['e2e/playwright.config.ts', 'README.md'])).toEqual([]);
  });

  it('selects importing specs when only a helper changes, through re-exports and nested helpers', () => {
    const sources = new Map([
      ['e2e/multi/probe.ts', 'export const probe = 1;'],
      ['e2e/multi/isolation-sweep.ts', 'export { probe } from "./probe.js";'],
      ['e2e/multi/isolation.spec.ts', 'import { probe } from "./isolation-sweep.js";'],
      ['e2e/specs/mobile-admin.ts', 'import "../multi/probe.js";'],
      ['e2e/specs/mobile.spec.ts', 'import { walk } from "./mobile-admin.js";'],
      ['e2e/specs/other.spec.ts', 'import "../support.js";'],
      ['e2e/specs/vm.spec.ts', 'import "../multi/probe.js";'],
      ['e2e/specs/ux-pass.spec.ts', 'import "../multi/probe.js";'],
    ]);
    expect(changedSpecs(['e2e/multi/probe.ts'], sources)).toEqual([
      'e2e/multi/isolation.spec.ts', 'e2e/specs/mobile.spec.ts',
    ]);
    expect(changedSpecs(['e2e/specs/mobile-admin.ts'], sources)).toEqual(['e2e/specs/mobile.spec.ts']);
    expect(changedSpecs(['e2e/multi/probe.ts'], new Map([...sources].reverse())).sort()).toEqual([
      'e2e/multi/isolation.spec.ts', 'e2e/specs/mobile.spec.ts',
    ]);
    expect(changedSpecs(['e2e/specs/other.spec.ts'], sources)).toEqual(['e2e/specs/other.spec.ts']);
  });

  it('passes literal file names through Playwright regex matching without widening the selection', () => {
    const [filter] = fileFilters(['e2e/specs/a+[phone].spec.ts']);
    const regex = new RegExp(filter!);
    expect(regex.test('/checkout/e2e/specs/a+[phone].spec.ts')).toBe(true);
    expect(regex.test('/checkout/e2e/specs/aaaaaphone.spec.ts')).toBe(false);
    expect(() => fileFilters([])).toThrow();
    expect(() => fileFilters(['e2e/support.ts'])).toThrow();
  });

  it('counts projects separately and visits nested describes', () => {
    expect(reportTests({ suites: [{ specs: [], suites: [{ specs: [{ id: 'same', tests: [
      { projectName: 'fresh-setup' }, { projectName: 'members-mat' },
    ] }] }] }] })).toEqual(['fresh-setup:same', 'members-mat:same']);
  });

  it('reports errors with the collection message or the prefix supplied by the caller', () => {
    const report = { errors: [{ message: 'worker teardown timeout' }], suites: [] };
    expect(() => reportTests(report))
      .toThrow('Playwright could not collect the suite: [{"message":"worker teardown timeout"}]');
    expect(() => reportTests(report, 'Merged report failed'))
      .toThrow('Merged report failed: [{"message":"worker teardown timeout"}]');
  });

  it('charges each shared fixture to a stack only when it takes its first file from that project', () => {
    const spec = (file: string, projectName: string) => ({ file, id: file, tests: [{ projectName }] });
    const wizard = 'fresh-setup.spec.ts', first = '../multi/a.spec.ts', second = '../multi/b.spec.ts';
    const third = '../multi/c.spec.ts', single = 'single.spec.ts';
    const report = { suites: [{ specs: [
      spec(wizard, 'fresh-setup'), spec(first, 'multi-gym'), spec(second, 'multi-gym'),
      spec(third, 'multi-gym'), spec(single, 'members-mat'),
    ] }] };
    const durations = { [wizard]: 8_000, [first]: 6_000, [second]: 5_000, [third]: 4_000, [single]: 3_000 };
    expect(shardFiles(report, 2, durations)).toEqual([
      [`[fresh-setup] > ${wizard}`, `[multi-gym] > ${third}`],
      [`[multi-gym] > ${first}`, `[multi-gym] > ${second}`, `[members-mat] > ${single}`],
    ]);
    // A single-gym file can also reuse its fixture on a stack that already ran that project.
    const singleReport = { suites: [{ specs: [
      spec(wizard, 'fresh-setup'), spec('a.spec.ts', 'members-mat'), spec('b.spec.ts', 'members-mat'),
    ] }] };
    expect(shardFiles(singleReport, 2, { [wizard]: 700, 'a.spec.ts': 600, 'b.spec.ts': 500 })).toEqual([
      [`[fresh-setup] > ${wizard}`],
      ['[members-mat] > a.spec.ts', '[members-mat] > b.spec.ts'],
    ]);
  });

  it('rejects missing and duplicate tests even when the total count matches', () => {
    expect(verifyShards(['wizard', 'a', 'b', 'c'], [['wizard'], ['a'], ['b'], ['c']]))
      .toEqual({ single: 4, shards: [1, 1, 1, 1], total: 4 });
    expect(() => verifyShards(['wizard', 'a', 'b'], [['wizard'], ['a', 'a']])).toThrow('Suite mismatch');
    expect(() => verifyShards(['wizard', 'a'], [['wizard'], ['a', 'other']])).toThrow();
    expect(() => verifyShards(['wizard', 'a'], [['wizard']])).toThrow();
    expect(() => verifyShards([], [[], [], [], []])).toThrow();
    expect(() => verifyShards(['a', 'a'], [['a']])).toThrow();
  });

  it('places largest files on the least-loaded stack, counts the wizard and keeps nested describes together', () => {
    const spec = (file: string, projectName = 'multi-gym') => ({ file, id: file, tests: [{ projectName }] });
    const report = { suites: [
      { specs: [spec('fresh-setup.spec.ts', 'fresh-setup')] },
      { specs: [spec('../multi/a.spec.ts'), spec('../multi/b.spec.ts')], suites: [
        { specs: [spec('../multi/a.spec.ts'), spec('../multi/c.spec.ts'), spec('../multi/d.spec.ts')] },
      ] },
    ] };
    const durations = { 'fresh-setup.spec.ts': 30, '../multi/a.spec.ts': 100, '../multi/b.spec.ts': 90,
      '../multi/c.spec.ts': 20, '../multi/d.spec.ts': 10 };
    expect(shardFiles(report, 3, durations)).toEqual([
      ['[fresh-setup] > fresh-setup.spec.ts', '[multi-gym] > ../multi/c.spec.ts', '[multi-gym] > ../multi/d.spec.ts'],
      ['[multi-gym] > ../multi/a.spec.ts'], ['[multi-gym] > ../multi/b.spec.ts'],
    ]);
    // Missing timings still assign every file exactly once, without splitting its describes.
    expect(shardFiles(report, 3, {}).flat().sort()).toEqual([
      '[fresh-setup] > fresh-setup.spec.ts', '[multi-gym] > ../multi/a.spec.ts', '[multi-gym] > ../multi/b.spec.ts',
      '[multi-gym] > ../multi/c.spec.ts', '[multi-gym] > ../multi/d.spec.ts',
    ]);
    expect(() => shardFiles({ suites: [] })).toThrow('wizard');
    expect(() => shardFiles({ errors: [{ message: 'collection failed' }], suites: [] })).toThrow('collect');
  });

  it('uses declaration locations inside describes and rejects tests declared in helpers', () => {
    const report = { suites: [{ file: 'fresh-setup.spec.ts', specs: [
      { file: 'fresh-setup.spec.ts', id: 'wizard', tests: [{ projectName: 'fresh-setup' }] },
    ] }, { file: 'wrapper.spec.ts', suites: [{ file: 'wrapper.spec.ts', specs: [
      { file: 'actual.spec.ts', id: 'nested', tests: [{ projectName: 'members-mat' }] },
    ] }] }] };
    expect(shardFiles(report).flat()).toContain('[members-mat] > actual.spec.ts');
    report.suites[1]!.suites![0]!.specs[0]!.file = 'helper.ts';
    expect(() => shardFiles(report)).toThrow('Test declared outside a spec file: helper.ts');
  });

  it('shares the workflow shard count with matrix generation and inventory selections', () => {
    const workflow = readFileSync(new URL('../.github/workflows/e2e.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('shard: ${{ fromJSON(needs.shards.outputs.shards) }}');
    expect(workflow).toContain('run: node e2e/ci.mjs matrix');
    expect(workflow).toContain('run: node e2e/ci.mjs inventory');
    const shardGate = "!cancelled() && !inputs.ux_pass && needs.reuse.outputs.passed != 'true'";
    expect(workflow).toContain(`\n  shards:\n    needs: reuse\n    if: \${{ ${shardGate} }}\n`);
    expect(workflow).toContain(`\n  e2e:\n    needs: [reuse, shards]\n    if: \${{ ${shardGate} && needs.shards.result == 'success' }}\n`);
    expect(workflow).toContain(`\n  report:\n    needs: [reuse, shards, e2e]\n    if: \${{ ${shardGate} && needs.shards.result == 'success' }}\n`);
    const count = workflow.match(/^ {2}E2E_SHARD_COUNT: '(\d+)'/m)![1]!;
    expect(shardNumbers(count)).toHaveLength(Number(count));
    vi.stubEnv('E2E_SHARD_COUNT', '3');
    try {
      expect(shardNumbers()).toEqual([1, 2, 3]);
      expect(shardFiles({ suites: [{ specs: [
        { file: 'fresh-setup.spec.ts', id: 'wizard', tests: [{ projectName: 'fresh-setup' }] },
      ] }] })).toHaveLength(3);
    } finally { vi.unstubAllEnvs(); }
    for (const invalid of ['', '0', '-1', '1.5', 'bad', '65']) expect(() => shardNumbers(invalid)).toThrow('E2E_SHARD_COUNT');
  });
});
