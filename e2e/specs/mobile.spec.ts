// SPDX-License-Identifier: AGPL-3.0-only
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import { gymOrigin, test } from '../support.js';

const viewports = [
  { name: 'phone', viewport: { width: 360, height: 740 }, hasTouch: true },
  { name: 'desktop', viewport: { width: 1280, height: 800 }, hasTouch: false },
] as const;

async function noHorizontalScroll(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(scrollWidth, 'page scrolls horizontally').toBeLessThanOrEqual(clientWidth);
}
/** Shell controls (header, menu, account menu, footer) must be at least 44 px tall and wide enough to tap. */
async function shellTargets(page: Page) {
  const small = await page.evaluate(() => [...document.querySelectorAll(
    'header button, header a, #admin-navigation a, #account-menu button, body > div footer a')]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.height < 44 || box.width < 44); })
    .map((element) => (element.textContent || element.getAttribute('aria-label') || '').trim()));
  expect(small, 'shell touch targets under 44 px').toEqual([]);
}
async function shellAxe(page: Page) {
  const result = await new AxeBuilder({ page }).include('header').include('#admin-navigation').include('footer')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(result.violations.map((violation) => violation.id)).toEqual([]);
}

for (const { name, viewport, hasTouch } of viewports) {
  test(`admin shell at ${name} width: every page through the menu, no sideways scroll, 44 px targets, axe`, async ({ browser, install }, info) => {
    const context = await browser.newContext({ viewport, hasTouch, ignoreHTTPSErrors: true });
    await install.clients.owner.browser(context);
    const page = await context.newPage();
    await page.goto(gymOrigin + '/admin');
    const nav = page.getByRole('navigation', { name: 'Gym navigation' });
    const menu = page.getByRole('button', { name: 'Menu' });
    if (name === 'phone') {
      await expect(menu).toBeVisible();
      await expect(nav).toBeHidden();
      await menu.click();
    } else {
      await expect(menu).toBeHidden();
    }
    await expect(nav).toBeVisible();
    const hrefs = await nav.getByRole('link').evaluateAll((links) => links.map((link) => link.getAttribute('href')!));
    expect(hrefs.length).toBeGreaterThan(5);
    await shellTargets(page);
    const axe = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    await info.attach(`${name}-dashboard-accessibility`, { body: JSON.stringify(axe.violations, null, 2), contentType: 'application/json' });
    expect(axe.violations.map((violation) => violation.id)).toEqual([]);
    for (const href of hrefs) {
      if (name === 'phone' && !await nav.isVisible()) await menu.click();
      await nav.locator(`a[href="${href}"]`).click();
      await expect(page).toHaveURL(gymOrigin + href);
      await expect(page.locator('#main-content')).toBeVisible();
      if (name === 'phone') await expect(nav).toBeHidden();
      // The closed phone menu is hidden, so look the link up by id rather than by role.
      await expect(page.locator(`#admin-navigation a[href="${href}"]`)).toHaveAttribute('aria-current', 'page');
      await noHorizontalScroll(page);
      await shellTargets(page);
      await shellAxe(page);
    }
    const account = page.getByRole('button', { name: 'Account' });
    await account.click();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await shellTargets(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeHidden();
    await expect(account).toBeFocused();
    await context.close();
  });
}
