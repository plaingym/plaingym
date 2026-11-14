// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

export const sizes = [{ width: 360, height: 740 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }];

/** Runs in the page, so it uses nothing from this module. Returns a description of the widest element that makes the page
 * scroll sideways, or undefined when nothing does. */
function findHorizontalOverflow(): string | undefined {
  const root = document.documentElement;
  if (root.scrollWidth <= root.clientWidth) return undefined;
  // A hidden or clipped root can't scroll sideways, as with any clipping ancestor below.
  // With a visible root, the body's overflow applies to the viewport instead.
  const rootOverflow = getComputedStyle(root).overflowX;
  if (['hidden', 'clip'].includes(rootOverflow === 'visible' ? getComputedStyle(document.body).overflowX : rootOverflow)) return undefined;
  interface Style { position: string; clipsX: boolean; positioned: boolean; formsBlock: boolean }
  // Each element's style is read once; ancestors are shared by many elements.
  const styles = new Map<Element, Style>();
  const styleOf = (element: Element): Style => {
    let style = styles.get(element);
    if (!style) {
      const computed = getComputedStyle(element);
      // These properties make an element the containing block of its absolutely positioned and fixed descendants, even
      // when it is `position: static`. (A fixed element inside one isn't fixed to the viewport.)
      const formsBlock = computed.transform !== 'none' || computed.translate !== 'none' || computed.rotate !== 'none' || computed.scale !== 'none'
        || computed.filter !== 'none' || computed.backdropFilter !== 'none' || computed.perspective !== 'none'
        || /\b(layout|paint|strict|content)\b/.test(computed.contain) || /\b(transform|perspective|filter)\b/.test(computed.willChange)
        // `content-visibility` other than `visible` applies layout containment. `container-type` doesn't: it applies size and style containment only.
        || computed.contentVisibility !== 'visible';
      // Paint containment clips to the padding box like `overflow: hidden`, with no overflow setting: `contain: paint`, `strict`
      // and `content`, and `content-visibility: auto` or `hidden`.
      const clipsX = computed.overflowX !== 'visible' || /\b(paint|strict|content)\b/.test(computed.contain) || computed.contentVisibility !== 'visible';
      style = { position: computed.position, clipsX, positioned: computed.position !== 'static', formsBlock };
      styles.set(element, style);
    }
    return style;
  };
  // Fixed elements and children of a clipping container can't widen the page. An absolutely positioned element's
  // containing block is its nearest positioned ancestor, or one that forms a block: clipping ancestors between the two
  // don't clip it. A fixed element's is the viewport unless an ancestor forms a block.
  const clips = new Map<Element, boolean>();
  const clipped = (element: Element): boolean => {
    if (element === document.body || element === root) return false;
    let known = clips.get(element);
    if (known === undefined) {
      const { position } = styleOf(element);
      let parent = element.parentElement;
      if (position === 'absolute') {
        while (parent && parent !== document.body && parent !== root && !styleOf(parent).positioned && !styleOf(parent).formsBlock) parent = parent.parentElement;
      } else if (position === 'fixed') {
        while (parent && parent !== document.body && parent !== root && !styleOf(parent).formsBlock) parent = parent.parentElement;
        // No ancestor forms a block: the viewport is the containing block.
        if (!parent || parent === document.body || parent === root) parent = null;
      }
      known = position === 'fixed' && !parent || (!!parent && parent !== document.body && parent !== root
        && (styleOf(parent).clipsX || clipped(parent)));
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
}
export const horizontalOverflow = (page: Page) => page.evaluate(findHorizontalOverflow);

/** Browser-only helpers: this package is installed independently of the application. */
export async function accessibleLayout(page: Page, info: TestInfo, name: string) {
  await expect(page.locator('html'), name + ': document language').toHaveAttribute('lang', /\S+/);
  // Let finite CSS transitions and animations settle first: axe measuring a button mid-transition reports
  // colors nobody sees at rest. Infinite ones (spinners) never finish, so they're skipped.
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => Number.isFinite(Number(animation.effect?.getComputedTiming().endTime ?? Infinity)))
    .map((animation) => animation.finished.catch(() => undefined))));
  expect(await horizontalOverflow(page), name + ': horizontal scroll').toBeUndefined();
  // An open modal dialog makes the rest of the page inert, so only its own controls can be touched.
  const small = await page.evaluate(() => {
    const controls = 'button, input, select, textarea, a[href], summary, [role="button"], [role="checkbox"]';
    return [...(document.querySelector('dialog:modal')?.querySelectorAll(controls)
    ?? document.querySelectorAll(controls))].flatMap((element) => {
    const target = element.matches('input[type="checkbox"], input[type="radio"]') ? element.closest('label') ?? element : element;
    // A screen-reader-only control has no touch target until it is revealed.
    // The keyboard flow checks the skip link after focus expands it.
    const style = getComputedStyle(target);
    if (style.clip === 'rect(0px, 0px, 0px, 0px)' || style.clipPath === 'inset(50%)') return [];
    const box = target.getBoundingClientRect();
    return box.width > 0 && (box.height < 44 || box.width < 44) ? [(target.textContent || element.getAttribute('aria-label') || element.id).trim()] : [];
    });
  });
  expect(small, name + ': targets smaller than 44px').toEqual([]);
  // Message previews deliberately forbid scripts. Audit the surrounding app and
  // dialog without trying to inject axe into the untrusted email document.
  const result = await new AxeBuilder({ page }).exclude('iframe[sandbox]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  await info.attach(name + '-axe', { body: JSON.stringify(result.violations, null, 2), contentType: 'application/json' });
  expect(result.violations, name + ': axe A/AA').toEqual([]);
}

/** Audit both OS preferences even on pages that currently share the same palette. */
export async function accessibleThemes(page: Page, info: TestInfo, name: string) {
  const original = await page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  try {
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await accessibleLayout(page, info, name + '-' + colorScheme);
      await info.attach(name + '-' + colorScheme, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    }
  } finally { await page.emulateMedia({ colorScheme: original }); }
}

/** Reach a control by Tab alone, with a bounded search that fails on a keyboard trap. */
export async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  for (let count = 0; count < 100; count++) {
    if (await target.evaluate(element => element === document.activeElement)) {
      expect(await target.evaluate(element => {
        const style = getComputedStyle(element);
        return element.matches(':focus-visible') && (style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0));
      }), 'keyboard focus has a visible indicator').toBe(true);
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error('Control could not be reached within 100 Tab presses');
}

export async function keyboardActivate(page: Page, target: Locator) {
  await tabTo(page, target);
  await page.keyboard.press('Enter');
}

export async function reachable(action: Locator, page: Page) {
  const box = await action.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
}
