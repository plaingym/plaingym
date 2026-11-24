// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';

const script = readFileSync('apps/server/src/demo/screenshots/landing-menu.js', 'utf8');
let hidePopover: ReturnType<typeof vi.fn>;

beforeAll(() => {
  new Function(script)();
});

beforeEach(() => {
  document.body.innerHTML = `
    <button id="opener" type="button">Menu</button>
    <div id="site-menu">
      <ul>
        <li><a href="#features">Features</a></li>
        <li><a href="#strengths">Why PlainGym</a></li>
      </ul>
    </div>
    <h2 id="features">Features</h2>
    <h2 id="strengths" tabindex="0">Why PlainGym</h2>
    <button id="after" type="button">After</button>
  `;
  hidePopover = vi.fn();
  const menu = document.getElementById('site-menu')!;
  Object.defineProperty(menu, 'matches', { configurable: true, value: (selector: string) => selector === ':popover-open' });
  Object.defineProperty(menu, 'hidePopover', { configurable: true, value: hidePopover });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));

it('leaves focus where it was when a window listener cancels the click after the document listener', async () => {
  const opener = document.getElementById('opener')!;
  opener.focus();
  const cancel = (event: MouseEvent) => event.preventDefault();
  window.addEventListener('click', cancel);
  try {
    document.querySelector<HTMLAnchorElement>('a[href="#features"]')!.click();
    await nextFrame();
  } finally {
    window.removeEventListener('click', cancel);
  }
  expect(document.activeElement).toBe(opener);
  expect(document.getElementById('features')!.hasAttribute('tabindex')).toBe(false);
});

it('removes an added tabindex from the focused heading when it blurs', async () => {
  const features = document.getElementById('features')!;
  expect(features.hasAttribute('tabindex')).toBe(false);
  document.querySelector<HTMLAnchorElement>('a[href="#features"]')!.click();
  await nextFrame();
  expect(hidePopover).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(features);
  expect(features.getAttribute('tabindex')).toBe('-1');
  document.getElementById('after')!.focus();
  expect(features.hasAttribute('tabindex')).toBe(false);
});

it('keeps an existing tabindex on the focused heading after blur', async () => {
  const strengths = document.getElementById('strengths')!;
  expect(strengths.getAttribute('tabindex')).toBe('0');
  document.querySelector<HTMLAnchorElement>('a[href="#strengths"]')!.click();
  await nextFrame();
  expect(document.activeElement).toBe(strengths);
  expect(strengths.getAttribute('tabindex')).toBe('0');
  document.getElementById('after')!.focus();
  expect(strengths.getAttribute('tabindex')).toBe('0');
});
