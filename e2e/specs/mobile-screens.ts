// SPDX-License-Identifier: AGPL-3.0-only
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { expect, gymOrigin, type Install } from '../support.js';
import { accessibleThemes } from '../responsive.js';

export const browserZone = 'Pacific/Honolulu';
export const viewports = [
  { name: 'phone', viewport: { width: 360, height: 740 }, hasTouch: true },
  { name: 'desktop', viewport: { width: 1280, height: 800 }, hasTouch: false },
] as const;

export async function check(page: Page, info: TestInfo, name: string, privateText?: string) {
  // The marker covers the shared loading state; the text wait covers the plain "Loading..." statuses that don't carry it.
  await expect(page.locator('[data-loading]')).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: /^Loading\b/i })).toHaveCount(0);
  // Checks page width, touch targets, language and axe, and attaches a screenshot, per color preference.
  await accessibleThemes(page, info, name, privateText ? { mask: [page.locator(privateText)], axeExclude: privateText } : undefined);
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
