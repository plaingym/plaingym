// SPDX-License-Identifier: AGPL-3.0-only
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../..');
const eslint = new ESLint({ cwd: root });
const probe = resolve(root, 'apps/web/src/features/probe/probe.tsx');
const probeTs = resolve(root, 'apps/web/src/features/probe/probe.ts');
const restricted = async (code: string, filePath = probe) => {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter(message => message.ruleId === 'locale/display-locale');
};

describe('display locale lint rule', () => {
  it.each([
    '(5).toLocaleString();',
    'new Date().toLocaleDateString();',
    "new Date().toLocaleString(undefined, { hour: 'numeric' });",
    'new Intl.NumberFormat();',
    'new Intl.DateTimeFormat(undefined, {});',
    'Intl.NumberFormat();',
    '(5).toLocaleString([]);',
    'new Date().toLocaleDateString(null);',
    'new Date().toLocaleTimeString(void 0, {});',
    'new Intl.DateTimeFormat([], {});',
    'new Intl.NumberFormat(null);',
    'new Intl.RelativeTimeFormat();',
    'new Intl.PluralRules(undefined);',
    'new Intl.ListFormat([]);',
    "new Intl.DisplayNames(undefined, { type: 'region' });",
    'new Intl.Collator();',
    'new Intl.Collator(undefined, { numeric: true });',
    'new Intl.Segmenter();',
    'new Intl.NumberFormat(undefined as never);',
    '(5).toLocaleString(undefined!);',
    '(5).toLocaleString(...[]);',
    'new Intl.NumberFormat(null as never);',
    'new Intl.NumberFormat(undefined satisfies string | undefined);',
    '(5).toLocaleString(undefined as any as string);',
    'new Intl.DateTimeFormat(...([] as string[]));',
    'new Intl.Collator(undefined!, {});',
  ])('refuses %s', async code => {
    expect(await restricted(code)).toHaveLength(1);
  });

  it('refuses angle-bracket type assertion around undefined in .ts', async () => {
    expect(await restricted('new Intl.NumberFormat(<any>undefined);', probeTs)).toHaveLength(1);
  });

  it.each([
    "(5).toLocaleString('en');",
    "new Intl.NumberFormat('en');",
    "new Intl.DateTimeFormat('en-GB', {});",
    'Intl.DateTimeFormat().resolvedOptions().timeZone;',
    "'A'.toLocaleLowerCase();",
    "(5).toLocaleString(['en']);",
    "new Intl.RelativeTimeFormat('en', { numeric: 'always' });",
    "new Intl.DisplayNames('en', { type: 'region' });",
    "new Intl.PluralRules('en');",
    "new Intl.Collator('en').compare('a', 'b');",
    "new Intl.Segmenter('en', { granularity: 'word' });",
    "new Intl.NumberFormat('en' as const);",
    'new Intl.DateTimeFormat(...args);',
    "new Intl.NumberFormat(...['en', { style: 'percent' }]);",
    "new Intl.NumberFormat('en' satisfies string);",
    "new Intl.DateTimeFormat('en' as string, {});",
  ])('allows %s', async code => {
    expect(await restricted(code)).toHaveLength(0);
  });

  it('leaves test files alone', async () => {
    const ignored = resolve(root, 'apps/web/src/features/probe/probe.test.tsx');
    expect(await restricted('(5).toLocaleString();', ignored)).toHaveLength(0);
  });
});
