// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

export const sizes = [{ width: 360, height: 740 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }];

/** Browser-only helpers: this package is installed independently of the application. */
export async function accessibleLayout(page: Page, info: TestInfo, name: string) {
  // Let finite CSS transitions and animations settle first: axe measuring a button mid-transition reports
  // colors nobody sees at rest. Infinite ones (spinners) never finish, so they're skipped.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => Number.isFinite(Number(animation.effect?.getComputedTiming().endTime ?? Infinity)))
    .map((animation) => animation.finished.catch(() => undefined))));
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    if (root.scrollWidth <= root.clientWidth) return undefined;
    // Each element's clipping style is read once; ancestors are shared by many elements.
    const styles = new Map<Element, { position: string; overflowX: string }>();
    const styleOf = (element: Element) => {
      let style = styles.get(element);
      if (!style) { const computed = getComputedStyle(element); style = { position: computed.position, overflowX: computed.overflowX }; styles.set(element, style); }
      return style;
    };
    // Fixed elements and children of a clipping container can't widen the page. An absolutely positioned element's
    // containing block is its nearest positioned ancestor: clipping ancestors between the two don't clip it.
    const clips = new Map<Element, boolean>();
    const clipped = (element: Element): boolean => {
      if (element === document.body) return false;
      let known = clips.get(element);
      if (known === undefined) {
        const { position } = styleOf(element);
        let parent = element.parentElement;
        if (position === 'absolute') while (parent && parent !== document.body && styleOf(parent).position === 'static') parent = parent.parentElement;
        known = position === 'fixed' || (!!parent && parent !== document.body && (styleOf(parent).overflowX !== 'visible' || clipped(parent)));
        clips.set(element, known);
      }
      return known;
    };
    const depth = (element: Element) => { let count = 0; for (let parent = element.parentElement; parent; parent = parent.parentElement) count++; return count; };
    let widest: { element: Element; right: number; depth: number } | undefined;
    for (const element of document.querySelectorAll('body *')) {
      const right = element.getBoundingClientRect().right;
      if (right <= root.clientWidth || clipped(element)) continue;
      // An element and its wrappers end at the same edge: name the deepest one.
      const level = depth(element);
      if (!widest || Math.round(right) > Math.round(widest.right) || (Math.round(right) === Math.round(widest.right) && level > widest.depth)) widest = { element, right, depth: level };
    }
    if (!widest) return `page is ${root.scrollWidth}px wide in a ${root.clientWidth}px viewport (no element reaches past it)`;
    const { element, right } = widest, label = element.getAttribute('aria-label') || element.textContent?.trim().replace(/\s+/g, ' ').slice(0, 40);
    // With no accessible name or text, the classes still point somewhere.
    const classes = label ? '' : [...element.classList].slice(0, 2).map((name) => '.' + name).join('');
    return `${element.tagName.toLowerCase()}${element.id ? '#' + element.id : ''}${classes}${element.getAttribute('role') ? `[role=${element.getAttribute('role')}]` : ''}`
      + `${label ? ` "${label}"` : ''} ends at ${Math.round(right)}px in a ${root.clientWidth}px viewport`;
  });
  expect(overflow, name + ': horizontal scroll').toBeUndefined();
  // An open modal dialog makes the rest of the page inert, so only its own controls can be touched.
  const small = await page.evaluate(() => [...(document.querySelector('dialog:modal')?.querySelectorAll('button, input, select, a')
    ?? document.querySelectorAll('main button, main input, main select, main a, aside button, aside a, dialog button'))].flatMap((element) => {
    const target = element.matches('input[type="checkbox"], input[type="radio"]') ? element.closest('label') ?? element : element;
    const box = target.getBoundingClientRect();
    return box.width > 0 && (box.height < 44 || box.width < 44) ? [(target.textContent || element.getAttribute('aria-label') || element.id).trim()] : [];
  }));
  expect(small, name + ': targets smaller than 44px').toEqual([]);
  // Message previews deliberately forbid scripts. Audit the surrounding app and
  // dialog without trying to inject axe into the untrusted email document.
  const result = await new AxeBuilder({ page }).exclude('iframe[sandbox]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  await info.attach(name + '-axe', { body: JSON.stringify(result.violations, null, 2), contentType: 'application/json' });
  expect(result.violations, name + ': axe A/AA').toEqual([]);
}

export async function reachable(action: Locator, page: Page) {
  const box = await action.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
}
