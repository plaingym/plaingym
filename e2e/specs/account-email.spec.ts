// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

const gym = { id: '00000000-0000-7000-8000-000000000001', name: 'Account test gym', timezone: 'UTC', currency: 'USD', enabledModules: [] };
const session = { userId: '00000000-0000-7000-8000-000000000002', displayName: 'Owner', roles: ['owner'], member: false };
const expiresAt = '2099-11-12T11:00:00.000Z';

for (const width of [360, 1280]) {
  test(`account email preserves pending notices beside errors at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    let pendingEmail = { email: 'pending@example.invalid', expiresAt };
    let failed = true;
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: { gym, session,
        login: { password: false, magicLink: true, google: true } } } });
      if (path === '/api/account') return route.fulfill({ json: { data: { email: 'owner@example.invalid', password: true,
        googleLinked: true, roles: ['owner'], households: [], pendingEmail, emailChange: 'available' } } });
      if (path === '/api/account/email') {
        if (failed) return route.fulfill({ status: 429, json: { error: { code: 'rate_limited' } } });
        pendingEmail = { email: route.request().postDataJSON().newEmail, expiresAt };
        return route.fulfill({ json: { data: pendingEmail } });
      }
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.goto(gymOrigin + '/admin/account');
    const input = page.getByLabel('New email', { exact: true });
    await input.fill('invalid');
    await page.getByRole('button', { name: 'Send link', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Enter a valid email address.');
    await expect(page.getByRole('status').filter({ hasText: 'pending@example.invalid' })).toBeVisible();
    await accessibleLayout(page, info, 'account-invalid-' + width);
    await page.screenshot({ path: info.outputPath('account-invalid-' + width + '.png'), fullPage: true });
    await input.fill('another@example.invalid');
    await page.getByRole('button', { name: 'Send link', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Too many requests.');
    await expect(page.getByRole('status').filter({ hasText: 'pending@example.invalid' })).toBeVisible();
    await accessibleLayout(page, info, 'account-request-failed-' + width);
    await page.screenshot({ path: info.outputPath('account-request-failed-' + width + '.png'), fullPage: true });
    failed = false;
    await page.getByRole('button', { name: 'Send link', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: 'An email was sent' })).toHaveCount(1);
    await expect(page.getByRole('status').filter({ hasText: 'another@example.invalid' })).toBeVisible();
    await accessibleLayout(page, info, 'account-request-sent-' + width);
    await page.screenshot({ path: info.outputPath('account-request-sent-' + width + '.png'), fullPage: true });
  });
}
