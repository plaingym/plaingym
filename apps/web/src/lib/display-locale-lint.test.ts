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
    'new globalThis.Intl.NumberFormat();',
    'window.Intl.DateTimeFormat();',
    '(5).toLocaleString([,]);',
    'new Intl.NumberFormat(...[,]);',
    'new Intl.DateTimeFormat([,,]);',
    'new (globalThis as typeof globalThis).Intl.NumberFormat();',
    'window!.Intl.DateTimeFormat();',
    'new self.Intl.Collator();',
    'Intl!.NumberFormat();',
    'new (Intl as typeof Intl).PluralRules();',
    '(globalThis.Intl satisfies typeof Intl).NumberFormat();',
    'Intl.NumberFormat!();',
    '(Intl.Collator as any)();',
    'new (Intl.DateTimeFormat as typeof Intl.DateTimeFormat)();',
    '(5).toLocaleString!();',
    'new (globalThis?.Intl).NumberFormat();',
    'Intl.NumberFormat?.();',
    '(Intl.DateTimeFormat?.()).format(date);',
    'new Intl.NumberFormat().resolvedOptions().locale;',
    'Intl.DateTimeFormat().resolvedOptions()?.locale;',
    "Intl.DateTimeFormat().resolvedOptions()['timeZone'];",
    'const { locale } = new Intl.NumberFormat().resolvedOptions();',
    'const options = Intl.DateTimeFormat().resolvedOptions();',
    'new Intl.DateTimeFormat().resolvedOptions;',
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
    "new globalThis.Intl.NumberFormat('en');",
    "window.Intl.DateTimeFormat('en', {});",
    "new self.Intl.Collator('en');",
    "globalThis['Intl'].NumberFormat();",
    '(new Intl.DateTimeFormat() as Intl.DateTimeFormat).resolvedOptions();',
    'new Intl.DateTimeFormat()!.resolvedOptions();',
    '(Intl.DateTimeFormat?.()).resolvedOptions();',
    '(Intl?.DateTimeFormat())!.resolvedOptions();',
    '((Intl.DateTimeFormat?.()) as Intl.DateTimeFormat).resolvedOptions();',
    "Intl.NumberFormat!('en');",
    'Intl.DateTimeFormat().resolvedOptions()?.timeZone;',
    'const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;',
    '(Intl.DateTimeFormat().resolvedOptions() as Intl.ResolvedDateTimeFormatOptions).timeZone;',
    // Nested global paths aren't followed.
    'new window.globalThis.Intl.NumberFormat();',
  ])('allows %s', async code => {
    expect(await restricted(code)).toHaveLength(0);
  });

  it('refuses angle-bracket type assertions around Intl and its object in .ts', async () => {
    expect(await restricted('new (<any>Intl).NumberFormat();', probeTs)).toHaveLength(1);
    expect(await restricted('new (<any>self).Intl.NumberFormat();', probeTs)).toHaveLength(1);
  });

  it.each(['probe.mjs', 'probe.cts'])('covers %s', async name => {
    const file = resolve(root, 'apps/web/src/features/probe', name);
    expect(await restricted('new Intl.NumberFormat();', file)).toHaveLength(1);
  });

  it('leaves .test.mjs files alone', async () => {
    const ignored = resolve(root, 'apps/web/src/features/probe/probe.test.mjs');
    expect(await restricted('new Intl.NumberFormat();', ignored)).toHaveLength(0);
  });

  it('leaves test files alone', async () => {
    const ignored = resolve(root, 'apps/web/src/features/probe/probe.test.tsx');
    expect(await restricted('(5).toLocaleString();', ignored)).toHaveLength(0);
  });
});
