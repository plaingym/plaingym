// SPDX-License-Identifier: AGPL-3.0-only
import type { Locator, Page } from '@playwright/test';
import { demoClient, expect, test } from '../support.js';
import { adminScreens } from './mobile-admin.js';
import { viewports } from './mobile-screens.js';

test.use({ trace: 'off', screenshot: 'off' });
test.beforeEach(() => { test.setTimeout(270_000); });

const updateBanner = {
  id: 'update_available', status: 'warning', checkedAt: new Date().toISOString(),
  message: 'Version 1.3.0 is available. This install runs 1.2.3. Run the updater on the server to install it.',
  details: { currentVersion: '1.2.3', latestVersion: '1.3.0', available: true,
    releaseUrl: 'https://github.com/plaingym/plaingym/releases/tag/v1.3.0' },
};

/** Opens the phone menu and checks it is the only scrolling surface, with Settings in reach. */
async function openPhoneMenu(page: Page, withBanner: boolean): Promise<Locator> {
  const nav = page.getByRole('navigation', { name: 'Gym navigation' });
  const before = await page.evaluate(() => window.scrollY);
  await expect(page.getByRole('complementary', { name: 'Demo controls' })).toBeVisible();
  if (withBanner) await expect(page.getByTestId('update-banner')).toBeVisible();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(nav).toBeVisible();
  for (const name of ['Overview', 'Gym', 'Billing', 'Communication', 'Administration'])
    await expect(nav.getByRole('heading', { name, exact: true })).toBeHidden();
  if (withBanner) {
    const menu = (await nav.boundingBox())!;
    const banner = (await page.getByTestId('update-banner').boundingBox())!;
    expect(menu.y, 'the phone menu starts below the update banner').toBeGreaterThanOrEqual(banner.y + banner.height - 1);
  }
  const root = await page.evaluate(() => ({
    innerWidth: window.innerWidth,
    clientWidth: document.documentElement.clientWidth,
    overflow: getComputedStyle(document.documentElement).overflowY,
  }));
  expect(root.overflow).toBe('hidden');
  expect(root.clientWidth, 'the page shows no scrollbar of its own').toBe(root.innerWidth);
  // Scrolling the menu to its end, then further, must leave the page where it was.
  const scrolled = await nav.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return { top: element.scrollTop, pageHeight: document.documentElement.scrollHeight, viewportHeight: document.documentElement.clientHeight };
  });
  expect(scrolled.top, 'the menu itself scrolls').toBeGreaterThan(0);
  expect(scrolled.pageHeight, 'the page behind the menu has content to scroll').toBeGreaterThan(scrolled.viewportHeight);
  await page.mouse.move(180, page.viewportSize()!.height - 40);
  await page.mouse.wheel(0, 1200);
  expect(await page.evaluate(() => window.scrollY), 'the page behind the menu does not move').toBe(before);
  const settings = nav.getByRole('link', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings).toBeInViewport();
  const box = (await settings.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  return settings;
}

test('admin screens at phone width: find a member, move a session, check in, promote, dashboard', async ({ browser, install }, info) => {
  await adminScreens(browser, install, info, viewports[0]);
});

test('phone menu reaches Settings, hides the group headings and leaves the page behind it still', async ({ page, sandboxes }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 360, height: 640 });
  const sandbox = sandboxes[1]!;
  const owner = await demoClient(sandbox, 'owner');
  await owner.browser(page.context());
  await page.goto(sandbox.origin + '/admin');

  let settings = await openPhoneMenu(page, false);
  await settings.click();
  await expect(page).toHaveURL(sandbox.origin + '/admin/settings');
  const nav = page.getByRole('navigation', { name: 'Gym navigation' });
  await expect(nav).toBeHidden();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe('hidden');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await page.evaluate(() => window.scrollY), 'the page scrolls again once the menu closes').toBeGreaterThan(0);

  // Opening the menu after the page has scrolled keeps it below the sticky header and scrolls to Settings.
  await page.evaluate(() => window.scrollTo(0, 300));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(nav).toBeVisible();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).toBe('hidden');
  const headerBox = (await page.locator('header').boundingBox())!;
  const menuBox = (await nav.boundingBox())!;
  expect(menuBox.y, 'the scrolled page keeps the menu below the sticky header').toBeGreaterThanOrEqual(headerBox.y + headerBox.height - 1);
  const settingsInTop = nav.getByRole('link', { name: 'Settings', exact: true });
  await nav.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(settingsInTop).toBeInViewport();
  await page.keyboard.press('Escape');
  await expect(nav).toBeHidden();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe('hidden');

  // Reaching the desktop breakpoint closes it, restores the sidebar and releases the page.
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(nav).toBeVisible();
  await page.setViewportSize({ width: 900, height: 640 });
  await expect(page.locator('button[aria-controls="admin-navigation"]')).toHaveAttribute('aria-expanded', 'false');
  await expect(nav).toHaveCSS('position', 'sticky');
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe('hidden');
  await page.setViewportSize({ width: 360, height: 640 });
  await expect(nav).toBeHidden();

  // The same with the update banner between the header and the menu.
  await page.route('**/api/health/update', (route) => route.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ data: updateBanner }) }));
  await page.goto(sandbox.origin + '/admin');
  await expect(page.getByTestId('update-banner')).toBeVisible();
  settings = await openPhoneMenu(page, true);
  await settings.click();
  await expect(page).toHaveURL(sandbox.origin + '/admin/settings');
  await expect(nav).toBeHidden();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflowY)).not.toBe('hidden');
});
