// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

for (const width of [360, 1280]) {
  test(`public intake offers a short busy retry at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route('**/api/public/trial', route => route.fulfill({ status: 429, headers: { 'Retry-After': '1' },
      json: { error: { code: 'rate_limited', message: 'The server is busy. Wait a moment, then try again.', details: { reason: ['busy'] } } } }));
    await page.goto(gymOrigin + '/trial');
    for (const [name, value] of Object.entries({ firstName: 'Alex', lastName: 'Visitor', dateOfBirth: '1990-01-02',
      contactName: 'Alex Visitor', email: 'retry@example.invalid' })) await page.locator(`[name="${name}"]`).fill(value);
    await page.locator('[data-public-form] button[type="submit"]').click();
    const status = page.locator('#feedback');
    await expect(status).toContainText('Wait a moment');
    await expect(page.locator('[name="email"]')).toHaveValue('retry@example.invalid');
    await accessibleLayout(page, info, 'public-intake-retry-' + width);
    await info.attach('public-intake-retry-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
  });
}
