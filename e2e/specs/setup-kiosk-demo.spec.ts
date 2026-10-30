// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, Client, gymOrigin, password } from '../support.js';
import { accessibleLayout, sizes } from '../responsive.js';

test('login at phone, tablet and desktop widths supports errors and password sign-in', async ({ page }, info) => {
  test.setTimeout(120_000);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.goto(gymOrigin + '/login');
    await expect(page.getByRole('heading', { name: 'Sign in to your gym', exact: true })).toBeVisible();
    await accessibleLayout(page, info, 'login-' + size.width);
    await page.screenshot({ path: info.outputPath('login-' + size.width + '.png'), fullPage: true });
    await page.goto(gymOrigin + '/demo');
    await expect(page.getByRole('heading', { name: 'PlainGym demo', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try the demo', exact: true })).toHaveCount(0);
    await accessibleLayout(page, info, 'ordinary-demo-page-' + size.width);
  }
  await page.setViewportSize(sizes[0]!);
  await page.goto(gymOrigin + '/login');
  await page.getByLabel('Email address', { exact: true }).fill('owner@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('wrong-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Email address', { exact: true })).toHaveValue('owner@example.invalid');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
  await accessibleLayout(page, info, 'login-error');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  expect((await page.context().cookies(gymOrigin)).some((cookie) => cookie.name.includes('session_token'))).toBe(true);
});

test('demo entry creates a gym, phone role controls and guide work, full-name kiosk check-in fits every size', async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.goto('https://demo.localhost/');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await expect(page.getByRole('button', { name: 'Try the demo', exact: true })).toBeVisible();
    await expect(page.getByText('Explore PlainGym', { exact: true })).toHaveCount(1);
    await accessibleLayout(page, info, 'demo-entry-' + size.width);
  }
  await page.setViewportSize(sizes[0]!);
  const created = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/demo/sandboxes' && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Try the demo', exact: true }).click();
  const creation = await created;
  expect(creation.status()).toBe(201);
  await page.waitForURL((url) => url.hostname.endsWith('.demo.localhost'));
  const sandbox = { origin: new URL(page.url()).origin };
  const banner = page.getByRole('complementary', { name: 'Demo controls', exact: true });
  await expect(banner.getByText(/Marcus Rivera.*2468/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => location.hash.includes('kioskToken'))).toBe(false);
  await expect(page.getByRole('button', { name: 'Try the demo', exact: true })).toHaveCount(0);
  // Follow the public visitor path; sandbox creation provisions the device.
  await banner.getByRole('link', { name: 'Try the kiosk', exact: true }).click();
  await expect(page.getByLabel('Device token', { exact: true })).toHaveCount(0);
  await expect(banner.getByRole('link', { name: 'Try the kiosk', exact: true })).toHaveCount(0);
  await expect(page.getByText(/Search the full name Marcus Rivera with household PIN 2468/)).toHaveCount(1);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await expect(page.getByLabel('Your name', { exact: true })).toBeVisible();
    await accessibleLayout(page, info, 'kiosk-search-' + size.width);
    await page.screenshot({ path: info.outputPath('kiosk-search-' + size.width + '.png'), fullPage: true });
  }
  await page.setViewportSize(sizes[0]!);
  await page.getByLabel('Your name', { exact: true }).fill('Marcus Rivera');
  for (const digit of '2468') await page.getByRole('button', { name: digit, exact: true }).click();
  await page.getByRole('button', { name: 'Find me', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: /Marcus/ })).toBeVisible();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await accessibleLayout(page, info, 'kiosk-family-' + size.width);
  }
  await page.setViewportSize(sizes[0]!);
  await page.getByRole('button', { name: 'Check in', exact: true }).click();
  // Explicit open-mat selection makes this independent of the gym's current timetable.
  await expect(page.getByRole('button', { name: 'Open mat', exact: true }).first()).toBeVisible();
  for (const button of await page.getByRole('button', { name: 'Open mat', exact: true }).all()) await button.click();
  await expect(page.getByText(/Checked in|Already checked in/, { exact: true }).first()).toBeVisible();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await accessibleLayout(page, info, 'kiosk-results-' + size.width);
  }
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Household PIN', { exact: true })).toHaveValue('');
  expect((await page.context().cookies()).filter((cookie) => cookie.name.includes('session_token'))).toHaveLength(0);
  // A sandbox's /demo is its start page: every role, the join walkthrough with the test card, and the kiosk.
  await page.goto(sandbox.origin + '/demo');
  const start = page.getByRole('main');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await expect(page.getByRole('heading', { name: 'Your demo gym', exact: true })).toBeVisible();
    for (const role of ['Owner', 'Coach', 'Student']) await expect(start.getByRole('heading', { name: role, exact: true })).toBeVisible();
    await expect(start.getByText('4242 4242 4242 4242')).toBeVisible();
    await expect(start.getByRole('link', { name: 'Open the join page', exact: true })).toHaveAttribute('href', '/join');
    await accessibleLayout(page, info, 'sandbox-demo-page-' + size.width);
  }
  await page.goto(sandbox.origin + '/admin');
  await page.getByRole('button', { name: 'Demo guide', exact: true }).click();
  const guide = page.getByRole('dialog', { name: 'Demo guide', exact: true });
  await expect(guide.getByText(/Marcus Rivera.*2468/)).toBeVisible();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await accessibleLayout(page, info, 'demo-guide-' + size.width);
  }
  await page.keyboard.press('Escape');
  await expect(guide).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Demo guide', exact: true })).toBeFocused();
  for (const role of ['owner', 'coach', 'owner']) {
    await Promise.all([page.waitForNavigation(), banner.getByRole('button', { name: 'Sign in as ' + role, exact: true }).click()]);
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  }
  const owner = new Client(sandbox.origin);
  owner.cookie = (await page.context().cookies(sandbox.origin)).map((cookie) => cookie.name + '=' + cookie.value).join('; ');
  await owner.json('/api/staff/invitations', 'POST', { email: 'phone-preview@example.invalid', role: 'coach', delivery: 'email' });
  await page.goto(sandbox.origin + '/admin/outbox');
  await expect(page.getByRole('button', { name: 'Preview HTML', exact: true }).first()).toBeVisible();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await accessibleLayout(page, info, 'outbox-' + size.width);
  }
  const previewButton = page.getByRole('button', { name: 'Preview HTML', exact: true }).first();
  await previewButton.click();
  const preview = page.getByRole('dialog');
  await expect(preview.locator('iframe')).toHaveAttribute('sandbox', '');
  await expect(preview.locator('iframe')).toHaveAttribute('title', 'Your staff invitation');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await accessibleLayout(page, info, 'outbox-preview-' + size.width);
  }
  await page.keyboard.press('Escape');
  await expect(preview).toHaveCount(0);
  await expect(previewButton).toBeFocused();

});
