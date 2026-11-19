// SPDX-License-Identifier: AGPL-3.0-only
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('./styles.css', import.meta.url)), 'utf8');
const index = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

/** The first block for a selector that carries token declarations (skips the colour-scheme-only one). */
function tokenBlock(selector: string, source = css): string {
  let from = 0;
  while (true) {
    const found = source.indexOf(`${selector} {`, from);
    if (found === -1) throw new Error(`No token block for ${selector}`);
    const open = found + selector.length + 1;
    let depth = 0, end = -1;
    for (let index = open; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1;
      else if (source[index] === '}' && --depth === 0) { end = index; break; }
    }
    if (end === -1) throw new Error(`Unclosed block for ${selector}`);
    const block = source.slice(open + 1, end);
    if (block.includes('--color-')) return block;
    from = open + 1;
  }
}

function tokens(selector: string, source = css): Record<string, string> {
  const found: Record<string, string> = {};
  for (const match of tokenBlock(selector, source).matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})\s*;/gi)) found[match[1]!] = match[2]!.toLowerCase();
  return found;
}

function luminance(hex: string): number {
  const [red, green, blue] = hex.match(/[0-9a-f]{2}/gi)!.map(part => Number.parseInt(part, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

const light = tokens('@theme');
// Limit both dark palettes to screen media so the light tokens remain active in print.
const dark = tokens('.dark', tokenBlock('@media screen'));
const systemDark = tokens('.theme-system', tokenBlock('@media screen and (prefers-color-scheme: dark)'));
const surfaces = ['background', 'card', 'muted', 'secondary'] as const;
// `primary-foreground` and `destructive-foreground` are text on their own fills only, so they are checked as pairs, not on surfaces.
const surfaceText = ['foreground', 'card-foreground', 'secondary-foreground', 'muted-foreground', 'accent-foreground',
  'success', 'warning', 'destructive', 'primary'] as const;
const paired = [['foreground', 'background'], ['card-foreground', 'card'], ['primary-foreground', 'primary'],
  ['secondary-foreground', 'secondary'], ['muted-foreground', 'muted'], ['accent-foreground', 'accent'],
  ['destructive-foreground', 'destructive']] as const;

it('opts the SPA into System and declares both scheme colours', () => {
  expect(index).toContain('<html lang="en" class="theme-system">');
  expect(index).toContain('<meta name="color-scheme" content="light dark" />');
  expect(index.match(/name="theme-color"/g)).toHaveLength(2);
  expect(index).toContain('media="(prefers-color-scheme: light)"');
  expect(index).toContain('media="(prefers-color-scheme: dark)"');
  expect(index).toContain('<script src="/src/lib/theme-init.js"></script>');
});

it('gives every light token a dark value, in both dark selectors', () => {
  expect(Object.keys(light).sort()).toEqual(Object.keys(dark).sort());
  expect(systemDark).toEqual(dark);
});

describe.each([['light', light], ['dark', dark]] as const)('%s token contrast', (_name, palette) => {
  it('keeps every text token readable on its own and every surface', () => {
    for (const [foreground, background] of paired) {
      expect(contrast(palette[foreground]!, palette[background]!), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
    for (const foreground of surfaceText) {
      for (const background of surfaces) {
        expect(contrast(palette[foreground]!, palette[background]!), `${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it('keeps borders, inputs and focus rings visible on the page background', () => {
    for (const token of ['border', 'input', 'ring'] as const) {
      expect(contrast(palette[token]!, palette.background!), `${token} on background`).toBeGreaterThanOrEqual(3);
    }
  });
});
