// SPDX-License-Identifier: AGPL-3.0-only
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { expect, gymOrigin, type Install } from '../support.js';
import { accessibleThemes } from '../responsive.js';

export const browserZone = 'Pacific/Honolulu';
export const viewports = [
  { name: 'phone', viewport: { width: 360, height: 740 }, hasTouch: true },
  { name: 'desktop', viewport: { width: 1280, height: 800 }, hasTouch: false },
] as const;

/** Controls in the page content (and an open dialog) must be at least 44 px tall, and buttons and selects 44 px wide.
 * Checkboxes are covered by their 44 px label rows; inline links may be narrower. */
async function contentTargets(page: Page) {
  const small = await page.evaluate(() => [...document.querySelectorAll(
    '#main-content :is(button, select, a[href], input:not([type=checkbox]):not([type=radio]):not([type=hidden])), dialog[open] :is(button, select, a[href], input:not([type=checkbox]):not([type=radio]))')]
    .filter((element) => { const box = element.getBoundingClientRect(); return box.width > 0 && (box.height < 44 || (element.matches('button, select') && box.width < 44)); })
    .map((element) => (element.getAttribute('aria-label') || element.textContent || element.getAttribute('name') || element.tagName).trim().slice(0, 60)));
  expect(small, 'content touch targets under 44 px').toEqual([]);
}
export async function check(page: Page, info: TestInfo, name: string) {
  await expect(page.locator('[role=status]').filter({ hasText: /Loading/ })).toHaveCount(0);
  await contentTargets(page);
  // Checks page width, touch targets, language and axe, and attaches a screenshot, per color preference.
  await accessibleThemes(page, info, name);
}
export async function open(browser: import('@playwright/test').Browser, install: Install, role: 'owner' | 'coach', options: { viewport: { width: number; height: number }; hasTouch: boolean }): Promise<[BrowserContext, Page]> {
  const context = await browser.newContext({ ...options, timezoneId: browserZone, ignoreHTTPSErrors: true });
  await install.clients[role].browser(context);
  return [context, await context.newPage()];
}
/** Navigates through the admin menu like a user (no full page load, so assets and bootstrap aren't refetched). */
export async function go(page: Page, href: string) {
  const link = page.locator(`#admin-navigation a[href="${href}"]`);
  await link.waitFor({ state: 'attached' });
  if (!await link.isVisible()) await page.getByRole('button', { name: 'Menu' }).click();
  await link.click();
  await expect(page).toHaveURL(gymOrigin + href);
}
/** A session button containing its exact class name, independently of the displayed clock style. */
export function sessionButton(page: Page, size: string) {
  return page.getByRole('button').filter({ has: page.getByText(`QA ${size} class`, { exact: true }) });
}
/** A phone dialog fills the screen; on desktop it is a centered panel. */
export async function dialogLayout(page: Page, name: string, phone: boolean) {
  const box = (await page.getByRole('dialog', { name }).boundingBox())!;
  const viewport = page.viewportSize()!;
  if (phone) { expect(box.width).toBeGreaterThanOrEqual(viewport.width - 1); expect(box.height).toBeGreaterThanOrEqual(viewport.height - 1); }
  else expect(box.width).toBeLessThan(viewport.width - 100);
}
