// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { expect, type Locator, type Page, type TestInfo } from '@playwright/test';

export const sizes = [{ width: 360, height: 740 }, { width: 768, height: 1024 }, { width: 1280, height: 800 }];

/** Browser-only helpers: this package is installed independently of the application. */
export async function accessibleLayout(page: Page, info: TestInfo, name: string) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), name + ': horizontal scroll').toBe(true);
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
