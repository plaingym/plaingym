// SPDX-License-Identifier: AGPL-3.0-only
import type { Page } from '@playwright/test';
import { horizontalOverflow } from '../responsive.js';
import { demoClient, expect, gymOrigin, test } from '../support.js';
import { viewports } from './mobile-screens.js';

const storageKey = 'plaingym.theme';
const schemes = {
  light: { label: 'Light', background: 'rgb(255, 255, 255)' },
  dark: { label: 'Dark', background: 'rgb(12, 21, 20)' },
};
type Scheme = keyof typeof schemes;
const account = (page: Page) => page.getByRole('button', { name: 'Account', exact: true });
const theme = (page: Page) => page.getByRole('group', { name: 'Theme', exact: true });
const app = (page: Page) => page.locator('#root > div');

async function expectEarlyTheme(page: Page, scheme: Scheme) {
  const entry = await page.locator('script[type="module"][src]').evaluate((script: HTMLScriptElement) => script.src);
  let release!: () => void;
  let intercepted = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(entry, async route => {
    intercepted = true;
    await held;
    await route.continue();
  }, { times: 1 });
  try {
    await page.reload({ waitUntil: 'commit' });
    await expect(page.locator('script[type="module"]')).toBeAttached();
    await expect.poll(() => intercepted).toBe(true);
    await expect(page.locator('#root')).toBeEmpty();
    const html = page.locator('html');
    // Before React mounts, color-scheme controls the canvas and the stylesheet already resolves the palette.
    await expect(html).toHaveClass(scheme);
    await expect(html).toHaveCSS('color-scheme', scheme);
    await expect.poll(() => page.evaluate(() => {
      const probe = document.createElement('div');
      probe.className = 'bg-background';
      document.body.append(probe);
      try { return getComputedStyle(probe).backgroundColor; }
      finally { probe.remove(); }
    })).toBe(schemes[scheme].background);
  } finally {
    release();
  }
}

// The kiosk setup URL carries a device credential.
test.use({ serviceWorkers: 'block', trace: 'off', screenshot: 'off' });

for (const surface of ['admin', 'portal'] as const) {
  test.describe(surface, () => {
    if (surface === 'admin') {
      test.beforeEach(async ({ page, context, install }) => {
        await install.clients.owner.browser(context);
        await page.goto(gymOrigin + '/admin');
      });
    } else {
      test.beforeEach(async ({ page, context, sandboxes }) => {
        const sandbox = sandboxes[0]!;
        const student = await demoClient(sandbox, 'student');
        await student.browser(context);
        await page.goto(sandbox.origin + '/portal');
      });
    }
    test.beforeEach(async ({ page }) => {
      await expect(account(page)).toBeVisible();
    });

    for (const { name, viewport, hasTouch } of viewports) {
      test.describe(name, () => {
        test.use({ viewport, hasTouch });
        test('applies the menu choice, paints it before React, and follows the device on System', async ({ page }, info) => {
          const chosen = name === 'phone' ? 'dark' : 'light';
          const device = chosen === 'dark' ? 'light' : 'dark';
          await page.emulateMedia({ colorScheme: device });
          await expect(app(page)).toHaveCSS('background-color', schemes[device].background);

          await account(page).focus();
          await page.keyboard.press('Enter');
          await page.keyboard.press('Tab');
          await expect(page.getByRole('link', { name: 'Your account', exact: true })).toBeFocused();
          await page.keyboard.press('Tab');
          const system = theme(page).getByRole('radio', { name: 'System', exact: true });
          await expect(system).toBeChecked();
          await expect(system).toBeFocused();
          await page.keyboard.press(chosen === 'light' ? 'ArrowRight' : 'ArrowLeft');
          const explicit = theme(page).getByRole('radio', { name: schemes[chosen].label, exact: true });
          await expect(explicit).toBeChecked();
          await expect(explicit).toBeFocused();
          await expect(app(page)).toHaveCSS('background-color', schemes[chosen].background);
          expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe(chosen);
          expect(await horizontalOverflow(page)).toBeUndefined();
          for (const radio of await theme(page).getByRole('radio').all()) {
            const box = (await radio.boundingBox())!;
            expect(box.width).toBeGreaterThanOrEqual(44);
            expect(box.height).toBeGreaterThanOrEqual(44);
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
          }
          await info.attach(surface + '-' + name + '-account-theme', { body: await page.screenshot(), contentType: 'image/png' });

          await expectEarlyTheme(page, chosen);
          await expect(app(page)).toHaveCSS('background-color', schemes[chosen].background);
          await account(page).click();
          await expect(explicit).toBeChecked();
          await system.click();
          await expect(system).toBeChecked();
          await expect(page.locator('html')).toHaveClass('theme-system');
          await expect(app(page)).toHaveCSS('background-color', schemes[device].background);
          await page.emulateMedia({ colorScheme: chosen });
          await expect(app(page)).toHaveCSS('background-color', schemes[chosen].background);
          await expect(system).toBeChecked();
        });
      });
    }

    test('uses System when accessing local storage throws', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.addInitScript(() => {
        Object.defineProperty(window, 'localStorage', {
          get: () => { throw new DOMException('Storage blocked', 'SecurityError'); },
        });
      });
      await page.reload();
      await expect(page.locator('html')).toHaveClass('theme-system');
      await expect(app(page)).toHaveCSS('background-color', schemes.dark.background);
      await account(page).click();
      const system = theme(page).getByRole('radio', { name: 'System', exact: true });
      await expect(system).toBeChecked();
      await theme(page).getByRole('radio', { name: 'Light', exact: true }).click();
      await expect(system).toBeChecked();
      await expect(page.locator('html')).toHaveClass('theme-system');
      await expect(app(page)).toHaveCSS('background-color', schemes.dark.background);
      expect(errors).toEqual([]);
    });
  });
}

test('kiosk ignores stored Dark while the device is light and offers no theme choice', async ({ page, sandboxes }) => {
  const sandbox = sandboxes[0]!;
  await page.emulateMedia({ colorScheme: 'light' });
  await page.addInitScript(key => localStorage.setItem(key, 'dark'), storageKey);
  await page.goto(sandbox.origin + '/kiosk#token=' + sandbox.kioskToken);
  await expect(page.getByRole('heading', { name: 'How would you like to check in?', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveClass('theme-system');
  await expect(app(page)).toHaveCSS('background-color', schemes.light.background);
  await expect(account(page)).toHaveCount(0);
  await expect(theme(page)).toHaveCount(0);
  expect(await page.evaluate(key => localStorage.getItem(key), storageKey)).toBe('dark');
});
