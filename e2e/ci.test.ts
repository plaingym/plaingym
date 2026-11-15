// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { changedSpecs, fileFilters, reportTests, verifyShards } from './ci.mjs';

describe('browser CI selection and completeness', () => {
  it('selects only specs in the default suite, including new names from a rename', () => {
    expect(changedSpecs(['e2e/specs/new.spec.ts', 'e2e/multi/isolation.spec.ts', 'e2e/support.ts',
      'e2e/ux-pass/browsers.spec.ts', 'e2e/specs/ux-pass.spec.ts', 'e2e/specs/vm.spec.ts', 'apps/web/a.spec.ts']))
      .toEqual(['e2e/specs/new.spec.ts', 'e2e/multi/isolation.spec.ts']);
    expect(changedSpecs(['e2e/playwright.config.ts', 'README.md'])).toEqual([]);
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
    expect(() => reportTests({ errors: [{ message: 'collection failed' }], suites: [] })).toThrow('collect');
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
});
