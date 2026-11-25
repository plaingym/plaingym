// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

const gym = { id: '00000000-0000-7000-8000-000000000001', name: 'Account test gym', timezone: 'UTC', currency: 'USD', enabledModules: [] };
const session = { userId: '00000000-0000-7000-8000-000000000002', displayName: 'Owner', roles: ['owner'], member: false };

for (const width of [360, 1280]) {
  test(`account password change fits and explains its answers at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    let wrong = true;
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: { gym, session,
        login: { password: true, magicLink: false, google: false } } } });
      if (path === '/api/account') return route.fulfill({ json: { data: { email: 'owner@example.invalid', password: true,
        googleLinked: false, roles: ['owner'], households: [], pendingEmail: null, emailChange: 'no_email' } } });
      if (path === '/api/account/password') {
        if (wrong) return route.fulfill({ status: 400, json: { error: { code: 'invalid_request', details: { currentPassword: ['wrong_password'] } } } });
        return route.fulfill({ json: { data: null } });
      }
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.goto(gymOrigin + '/admin/account');
    const submit = page.getByRole('button', { name: 'Change password', exact: true });
    const fill = async () => {
      await page.getByLabel('Current password', { exact: true }).fill('current-password-1');
      await page.getByLabel('New password', { exact: true }).fill('new-password-12');
      await page.getByLabel('New password again', { exact: true }).fill('new-password-12');
    };
    await fill();
    expect((await submit.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await submit.click();
    await expect(page.getByRole('alert')).toContainText('The current password is wrong.');
    await accessibleLayout(page, info, 'account-password-wrong-' + width);
    await page.screenshot({ path: info.outputPath('account-password-wrong-' + width + '.png'), fullPage: true });
    wrong = false;
    await submit.click();
    await expect(page.getByRole('status').filter({ hasText: 'Password changed.' })).toBeVisible();
    await expect(page.getByLabel('Current password', { exact: true })).toHaveValue('');
    await accessibleLayout(page, info, 'account-password-changed-' + width);
    await page.screenshot({ path: info.outputPath('account-password-changed-' + width + '.png'), fullPage: true });
  });
}
