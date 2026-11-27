// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout, horizontalOverflow } from '../responsive.js';

const gym = { id: '00000000-0000-7000-8000-000000000001', name: 'Account test gym', timezone: 'UTC', currency: 'USD', enabledModules: [] };
const session = { userId: '00000000-0000-7000-8000-000000000002', displayName: 'Owner', roles: ['owner'], member: false };
const expiresAt = '2099-11-12T11:00:00.000Z';

for (const width of [360, 1280]) {
  test(`account email preserves pending notices beside errors at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    let pendingEmail = { email: 'pending@example.invalid', expiresAt, awaiting: 'new_address' };
    let failed = true;
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: { gym, session,
        login: { password: false, magicLink: true, google: true } } } });
      if (path === '/api/account') return route.fulfill({ json: { data: { email: 'owner@example.invalid', password: true,
        googleLinked: true, roles: ['owner'], households: [], pendingEmail, emailChange: 'available', emailChangeProof: 'current_address' } } });
      if (path === '/api/account/email') {
        if (failed) return route.fulfill({ status: 429, json: { error: { code: 'rate_limited' } } });
        pendingEmail = { email: route.request().postDataJSON().newEmail, expiresAt, awaiting: 'new_address' };
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

  test(`account email asks for the current password where it proves the login at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    const sent: unknown[] = [];
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: { gym, session,
        login: { password: true, magicLink: false, google: false } } } });
      if (path === '/api/account') return route.fulfill({ json: { data: { email: 'owner@example.invalid', password: true,
        googleLinked: false, roles: ['owner'], households: [], pendingEmail: null, emailChange: 'available', emailChangeProof: 'password' } } });
      if (path === '/api/account/email') {
        const body = route.request().postDataJSON();
        sent.push(body);
        if (body.currentPassword !== 'right-password') return route.fulfill({ status: 400,
          json: { error: { code: 'invalid_request', details: { currentPassword: ['wrong_password'] } } } });
        return route.fulfill({ json: { data: { email: body.newEmail, expiresAt, awaiting: 'new_address' } } });
      }
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.goto(gymOrigin + '/admin/account');
    const section = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Change sign-in email' }) });
    const current = section.getByLabel('Current password', { exact: true });
    await section.getByLabel('New email', { exact: true }).fill('moved@example.invalid');
    await current.fill('wrong-password');
    await section.getByRole('button', { name: 'Send link', exact: true }).click();
    await expect(section.getByRole('alert')).toContainText('The current password is wrong.');
    await expect(current).toHaveValue('');
    await accessibleLayout(page, info, 'account-password-proof-wrong-' + width);
    await page.screenshot({ path: info.outputPath('account-password-proof-wrong-' + width + '.png'), fullPage: true });
    await current.fill('right-password');
    await section.getByRole('button', { name: 'Send link', exact: true }).click();
    await expect(section.getByRole('status').filter({ hasText: 'An email was sent to moved@example.invalid' })).toBeVisible();
    expect(sent).toEqual([{ newEmail: 'moved@example.invalid', currentPassword: 'wrong-password' }, { newEmail: 'moved@example.invalid', currentPassword: 'right-password' }]);
    await accessibleLayout(page, info, 'account-password-proof-sent-' + width);
    await page.screenshot({ path: info.outputPath('account-password-proof-sent-' + width + '.png'), fullPage: true });
  });

  test(`account email sends a passwordless login's first link to its current address at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: { gym, session,
        login: { password: false, magicLink: true, google: false } } } });
      if (path === '/api/account') return route.fulfill({ json: { data: { email: 'owner@example.invalid', password: false,
        googleLinked: false, roles: ['owner'], households: [], pendingEmail: null, emailChange: 'available', emailChangeProof: 'current_address' } } });
      if (path === '/api/account/email') return route.fulfill({ json: { data: { email: route.request().postDataJSON().newEmail, expiresAt, awaiting: 'current_address' } } });
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.goto(gymOrigin + '/admin/account');
    await expect(page.getByText(/We first email your current address a link to confirm it's you/)).toBeVisible();
    await expect(page.getByLabel('Current password', { exact: true })).toHaveCount(0);
    await page.getByLabel('New email', { exact: true }).fill('moved@example.invalid');
    await page.getByRole('button', { name: 'Send link', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'We sent a link to your current sign-in email' })).toContainText('moved@example.invalid');
    await accessibleLayout(page, info, 'account-current-proof-sent-' + width);
    await page.screenshot({ path: info.outputPath('account-current-proof-sent-' + width + '.png'), fullPage: true });
  });

  test(`email change confirmation page says what each link did at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    const answers = [{ email: 'moved@example.invalid', status: 'sent' }, { email: 'moved@example.invalid', status: 'changed' }];
    await page.route('**/api/account/email/confirm', route => route.fulfill({ json: { data: answers.shift() } }));
    for (const [name, shown] of [['current', 'Thanks. We sent a confirmation link to the new address.'], ['new', 'Your sign-in email is now moved@example.invalid']] as const) {
      // A fragment-only navigation wouldn't load the page again (its script already dropped the fragment), so leave it first.
      await page.goto('about:blank');
      await page.goto(gymOrigin + '/account-email#' + 'a'.repeat(64));
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(page.getByRole('status')).toContainText(shown);
      await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeHidden();
      expect(await horizontalOverflow(page), 'confirmation page fits at ' + width).toBeUndefined();
      await page.screenshot({ path: info.outputPath('account-email-confirm-' + name + '-' + width + '.png'), fullPage: true });
    }
  });
}
