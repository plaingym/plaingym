// SPDX-License-Identifier: AGPL-3.0-only
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
/** Production sources that render or take amounts; tests may spell expected amounts out. */
const sources = globSync(['apps/*/src/**/*.{ts,tsx,mjs}', 'packages/*/src/**/*.{ts,tsx,mjs}', 'e2e/stripe/*.mjs'], {
  cwd: root, exclude: ['**/node_modules/**', '**/dist/**', '**/*.test.ts', '**/*.test.tsx', '**/*.test-helper.ts', '**/*.test-helper.tsx', '**/*.gen.ts'],
}).map(file => file.replaceAll('\\', '/')).sort();

/** The one module that converts between minor units and displayed or typed amounts. */
const helper = 'packages/shared/src/money.ts';
/**
 * Shapes of a hand-rolled money conversion: a factor of 100 (or 100n), two fixed decimals, or a currency format.
 * `100` followed by a digit, `_`, `.` or `e` is a different number, and 10_000 for tax rates is not matched.
 */
const patterns: [string, RegExp][] = [
  ['divides or multiplies by 100', /[/*]\s*100n?(?![\d_.e])|(?<![\d_.])100n?\s*[*/](?!\/)/],
  ['fixes two decimals', /\.toFixed\(\s*2\s*\)/],
  ['formats a currency itself', /style:\s*['"]currency['"]/],
];
/** Matches reviewed as not money, each with its reason. Keep this list short; amounts go through the helper. */
const reviewed: Record<string, string> = {};

describe('money conversions', () => {
  it('scans the app sources', () => {
    expect(sources).toContain(helper);
    expect(sources).toContain('apps/server/src/core/money.ts');
    expect(sources).toContain('apps/web/src/features/billing/catalog/format.ts');
    expect(sources.some(file => file.includes('.test.'))).toBe(false);
  });

  it('happen only in the shared money helper', () => {
    const found: string[] = [];
    for (const file of sources) {
      if (file === helper) continue;
      // Comment lines are scanned too: a continued expression (`  * 100)`) looks just like a doc comment line.
      readFileSync(root + file, 'utf8').split('\n').forEach((line, index) => {
        for (const [what, pattern] of patterns) {
          const where = file + ':' + (index + 1);
          if (pattern.test(line) && !reviewed[where]) found.push(where + ' ' + what + ': ' + line.trim());
        }
      });
    }
    expect(found).toEqual([]);
  });

  it('catch the conversions they are meant to', () => {
    const hits = (line: string) => patterns.filter(([, pattern]) => pattern.test(line)).map(([what]) => what);
    expect(hits('format(cents / 100)')).toEqual(['divides or multiplies by 100']);
    expect(hits('Math.round(value * 100)')).toEqual(['divides or multiplies by 100']);
    expect(hits('BigInt(whole) * 100n')).toEqual(['divides or multiplies by 100']);
    expect(hits('100 * dollars')).toEqual(['divides or multiplies by 100']);
    expect(hits('    * 100);')).toEqual(['divides or multiplies by 100']);
    expect(hits('(value / 100).toFixed(2)')).toEqual(['divides or multiplies by 100', 'fixes two decimals']);
    expect(hits("new Intl.NumberFormat('en', { style: 'currency', currency })")).toEqual(['formats a currency itself']);
    expect(hits('rateMillionths / 10_000')).toEqual([]);
    expect(hits('limit: 100, offset: 0')).toEqual([]);
    expect(hits('value / 1000')).toEqual([]);
    expect(hits('percent / 100.5')).toEqual([]);
  });
});
