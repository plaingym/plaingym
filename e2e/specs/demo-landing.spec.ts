// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect } from '../support.js';
import { accessibleLayout } from '../responsive.js';

for (const width of [360, 1280]) for (const colorScheme of ['light', 'dark'] as const) {
  test(`demo product landing at ${width}px in ${colorScheme}`, async ({ page }, info) => {
    // An implicit icon request is unrelated to this page's stylesheet and CSP.
    await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    // Registered before navigation, including the stylesheet load.
    await page.addInitScript(() => {
      (window as Window & { policyViolations?: string[] }).policyViolations = [];
      document.addEventListener('securitypolicyviolation', event => {
        (window as Window & { policyViolations?: string[] }).policyViolations!.push(event.violatedDirective);
      });
    });
    const stylesLoaded = page.waitForResponse(response => new URL(response.url()).pathname === '/public/pages/styles.css');
    const response = await page.goto('https://demo.localhost/');
    expect(response?.status()).toBe(200);
    expect(response?.headers()['content-security-policy']).toContain("script-src 'none'");
    expect(response?.headers()['content-security-policy']).toContain("style-src 'self'");
    await expect(page.getByRole('heading', { level: 1, name: 'PlainGym', exact: true })).toBeVisible();
    const links = page.getByRole('main').getByRole('link');
    await expect(links.nth(0)).toHaveText('Try the demo');
    await expect(links.nth(0)).toHaveAttribute('href', /^https:\/\/showcase\.demo\.localhost\/demo#kioskToken=.+$/);
    await expect(links.nth(1)).toHaveText('GitHub');
    await expect(links.nth(1)).toHaveAttribute('href', 'https://github.com/plaingym/plaingym');
    await expect(page.getByRole('link', { name: 'Source code', exact: true })).toHaveAttribute('href', '/source');
    await expect(page.locator('script, [style]')).toHaveCount(0);
    // Explain the general lifetime without showing a particular sandbox's expiry notice.
    await expect(page.getByText('Private copies expire after inactivity and are deleted within 24 hours.', { exact: true })).toBeVisible();
    await expect(page.locator('[data-demo-deletion]')).toHaveCount(0);
    const stylesheet = await stylesLoaded;
    expect(stylesheet.status()).toBe(200);
    expect(stylesheet.headers()['content-type']).toContain('text/css');
    await accessibleLayout(page, info, `product-${width}-${colorScheme}`);
    expect(await page.evaluate(() => (window as Window & { policyViolations?: string[] }).policyViolations)).toEqual([]);
    expect(errors).toEqual([]);
    await page.screenshot({ path: info.outputPath(`product-${width}-${colorScheme}.png`), fullPage: true });
    await links.first().click();
    await expect(page).toHaveURL('https://showcase.demo.localhost/demo');
    await expect(page.getByRole('heading', { level: 1, name: 'Your demo gym', exact: true })).toBeVisible();
    await expect(page.locator('[data-demo-deletion]')).toHaveCount(0);
  });
}

test('old demo entry links redirect to the product page', async ({ page }) => {
  await page.goto('https://demo.localhost/demo');
  await expect(page).toHaveURL('https://demo.localhost/');
  await expect(page.getByRole('heading', { level: 1, name: 'PlainGym', exact: true })).toBeVisible();
});
