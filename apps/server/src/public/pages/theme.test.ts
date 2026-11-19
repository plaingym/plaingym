// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { themeCss } from './page.js';

it('measures dark contrast against the dark surfaces in the shared stylesheet', () => {
  const css = readFileSync(fileURLToPath(new URL('../../../../web/src/app/styles.css', import.meta.url)), 'utf8');
  const blocks = [...css.matchAll(/(?:\.dark|\.theme-system) \{([^}]*--color-background[^}]*)\}/g)].map(match => match[1]!);
  expect(blocks).toHaveLength(2);
  for (const block of blocks) {
    expect(block).toMatch(/--color-background: #0c1514;/);
    expect(block).toMatch(/--color-card: #111d1c;/);
  }
});

function luminance(hex: string) {
  const weights = [0.2126, 0.7152, 0.0722];
  return [1, 3, 5].reduce((sum, offset, i) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return sum + weights[i]! * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  }, 0);
}

function contrast(a: string, b: string) {
  const one = luminance(a) + 0.05, two = luminance(b) + 0.05;
  return Math.max(one, two) / Math.min(one, two);
}

it.each([
  ['navy', '#08152E', true],
  ['black', '#000000', true],
  ['pale yellow', '#fff9a8', false],
  ['mid-tone', '#6587a8', false],
] as const)('keeps the light %s and gives it accessible dark tokens', (_name, primary, adjusted) => {
  const css = themeCss(primary);
  const rule = /--color-primary:(#[0-9a-f]{6});--color-primary-foreground:(#[0-9a-f]{6})/i;
  const light = css.match(new RegExp('^:root\\{' + rule.source, 'i'));
  const dark = css.match(new RegExp('@media screen\\{\\.dark\\{' + rule.source, 'i'));
  const device = css.match(new RegExp('@media screen and \\(prefers-color-scheme: dark\\)\\{\\.theme-system\\{' + rule.source, 'i'));
  expect(light?.[1]).toBe(primary);
  expect(contrast(light![1]!, light![2]!)).toBeGreaterThanOrEqual(4.5);
  expect(device?.slice(1)).toEqual(dark?.slice(1));
  const [, darkPrimary, darkForeground] = dark!;
  expect(darkPrimary !== primary).toBe(adjusted);
  for (const surface of ['#0c1514', '#111d1c']) expect(contrast(darkPrimary!, surface)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(darkPrimary!, darkForeground!)).toBeGreaterThanOrEqual(4.5);
});

it.each([null, '', '#12a', '#00112233', '#001122}', 'red; background:url(https://invalid.example)'])('rejects invalid brand color %s', value => {
  expect(themeCss(value)).toBe('');
});
