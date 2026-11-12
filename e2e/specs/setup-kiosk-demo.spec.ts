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

test('demo entry creates a gym, the slim bar and demo menu work at every size, full-name kiosk check-in fits every size', async ({ page }, info) => {
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
  const menuButton = banner.getByRole('button', { name: 'Demo menu', exact: true }), menu = page.getByRole('dialog', { name: 'Demo menu', exact: true });
  // One slim row: the sandbox, its expiry and the demo menu. The kiosk's sample household shows only on the kiosk's name search.
  await expect(menuButton).toBeVisible();
  await expect(page.getByText(/Marcus Rivera/)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => location.hash.includes('kioskToken'))).toBe(false);
  await expect(page.getByRole('button', { name: 'Try the demo', exact: true })).toHaveCount(0);
  // Follow the public visitor path through the demo menu; sandbox creation provisions the device.
  await menuButton.click();
  await menu.getByRole('navigation', { name: 'Go to' }).getByRole('link', { name: 'Kiosk', exact: true }).click();
  await expect(page.getByLabel('Device token', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Name and PIN', exact: true })).toBeVisible();
  await expect(page.getByText(/Marcus Rivera/)).toHaveCount(0);
  for (const size of sizes) {
    await page.setViewportSize(size);
    expect((await banner.boundingBox())!.height, 'the demo bar stays one slim row').toBeLessThanOrEqual(56);
    // The start screen offers the two ways in and shows neither flow.
    for (const name of ['Scan a QR code', 'Name and PIN']) {
      const choice = page.getByRole('button', { name, exact: true });
      await expect(choice).toBeVisible();
      expect((await choice.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    }
    await expect(page.getByLabel('Your name', { exact: true })).toHaveCount(0);
    await accessibleLayout(page, info, 'kiosk-choice-' + size.width);
  }
  // Exercise both camera failures on the real kiosk at phone, tablet and desktop widths.
  for (const enumerationFails of [true, false]) {
    await page.evaluate((fails) => {
      Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
        enumerateDevices: async () => { if (fails) throw new Error('unavailable'); return [{ kind: 'videoinput' }]; },
        getUserMedia: async () => { throw new Error('permission denied'); },
      } });
    }, enumerationFails);
    await page.getByRole('button', { name: 'Scan a QR code', exact: true }).click();
    await expect(page.getByText(enumerationFails ? /This device can't scan/ : /Allow camera access/)).toBeVisible();
    if (!enumerationFails) {
      await page.getByRole('button', { name: 'Try again', exact: true }).click();
      await expect(page.getByText(/Allow camera access/)).toBeVisible();
    }
    for (const size of sizes) {
      await page.setViewportSize(size);
      await accessibleLayout(page, info, 'kiosk-camera-' + enumerationFails + '-' + size.width);
      await page.screenshot({ path: info.outputPath('kiosk-camera-' + enumerationFails + '-' + size.width + '.png'), fullPage: true });
    }
    await page.getByRole('button', { name: 'Start over', exact: true }).click();
  }
  await page.getByRole('button', { name: 'Name and PIN', exact: true }).click();
  await expect(page.getByText(/Search the full name Marcus Rivera with household PIN 2468/)).toHaveCount(1);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await expect(page.getByLabel('Your name', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Scan a QR code', exact: true })).toHaveCount(0);
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
  await expect(page.getByRole('button', { name: 'Name and PIN', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Name and PIN', exact: true }).click();
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
  await menuButton.click();
  // A bottom sheet on a phone and a side panel on wider screens, with its three labelled groups and no hints.
  await expect(menu.getByRole('region', { name: 'Sign in as', exact: true }).getByRole('button', { name: 'Sign in as owner', exact: true })).toBeVisible();
  await expect(menu.getByRole('navigation', { name: 'Go to', exact: true }).getByRole('link', { name: 'Demo outbox', exact: true })).toHaveAttribute('href', '/admin/outbox');
  await expect(menu.getByRole('region', { name: 'About this demo', exact: true }).getByText(/^Expires: /)).toBeVisible();
  await expect(menu.getByText(/Marcus Rivera|4242/)).toHaveCount(0);
  for (const size of sizes) {
    await page.setViewportSize(size);
    const box = (await menu.boundingBox())!;
    if (size.width < 640) expect(Math.round(box.y + box.height)).toBe(size.height);
    else expect([Math.round(box.x + box.width), Math.round(box.height)]).toEqual([size.width, size.height]);
    await accessibleLayout(page, info, 'demo-menu-' + size.width);
  }
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(menuButton).toBeFocused();
  for (const role of ['owner', 'coach', 'owner']) {
    await menuButton.click();
    await Promise.all([page.waitForNavigation(), menu.getByRole('button', { name: 'Sign in as ' + role, exact: true }).click()]);
    await expect(page.getByRole('heading', { name: 'Dashboard', exact: true })).toBeVisible();
  }
  const owner = new Client(sandbox.origin);
  owner.cookie = (await page.context().cookies(sandbox.origin)).map((cookie) => cookie.name + '=' + cookie.value).join('; ');
  await owner.json('/api/staff/invitations', 'POST', { email: 'phone-preview@example.invalid', role: 'coach', delivery: 'email', sendGeneration: crypto.randomUUID() });
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

  await page.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new Error('Storage blocked'); };
  });
  await page.goto(sandbox.origin + '/demo#kioskToken=blocked-demo-device');
  await expect(page.getByRole('alert')).toContainText("couldn't save");
  expect(new URL(page.url()).hash).toContain('kioskToken=blocked-demo-device');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await accessibleLayout(page, info, 'demo-token-save-error-' + size.width);
    await page.screenshot({ path: info.outputPath('demo-token-save-error-' + size.width + '.png'), fullPage: true });
  }

});
