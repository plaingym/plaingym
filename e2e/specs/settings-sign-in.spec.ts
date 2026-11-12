// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

const gym = { id: '00000000-0000-7000-8000-000000000001', name: 'Settings test gym', timezone: 'UTC', currency: 'USD', enabledModules: [] };
const session = { userId: '00000000-0000-7000-8000-000000000002', displayName: 'Owner', roles: ['owner'], member: false };
const login = { password: true, magicLink: false };
const settings = { ...gym, slug: 'settings-test', address: {}, branding: {}, websiteEnabled: false, existingSiteUrl: null,
  bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false, billingEnabled: false, memberEmailsEnabled: false,
  retryDays: [3, 7], dropInChargeTypeId: null, revision: 3, createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z' };
const google = { source: 'none', editable: true, unreadable: false, clientId: null, clientSecretSet: false, removeBlocked: false, revision: 3 };
const integrations = { email: { source: 'gym', host: 'smtp.example.invalid', port: 587, security: 'starttls', from: 'owner@example.invalid',
  signIn: { password: false, magicLink: true }, signInAfterSave: { password: false, magicLink: true }, signInAfterRemove: login, removeBlocked: false },
  payments: { configured: false, mode: null, webhookRegistered: false, accountLocked: false, testData: null, importedCustomersOnly: false },
  backups: null, sandbox: false, integrationsEditable: true, revision: 3 };
const rejected = { error: { code: 'invalid_request', message: 'Client refused', details: { reason: ['google_rejected'] } } };

// API fixtures exercise both Google forms in the production bundle without contacting Google or storing credentials.
for (const width of [360, 1280]) {
  test(`settings clears Google refusal and reloads operator-managed payments at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    let editable = true;
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: { gym, session, login } } });
      if (path === '/api/settings') return route.fulfill({ json: { data: settings } });
      if (path === '/api/settings/integrations/google') return route.fulfill(route.request().method() === 'GET'
        ? { json: { data: google } } : { status: 400, json: rejected });
      if (path === '/api/settings/integrations/stripe') {
        editable = false;
        return route.fulfill({ status: 403, json: { error: { code: 'forbidden', details: { integrations: ['operator_managed'] } } } });
      }
      if (path === '/api/settings/integrations') return route.fulfill({ json: { data: { ...integrations, integrationsEditable: editable } } });
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.goto(gymOrigin + '/admin/settings');
    await expect(page.getByText(/It does not check whether your account can use it/)).toBeVisible();
    await page.getByLabel('Client ID', { exact: true }).fill('client.apps.googleusercontent.com');
    await page.getByLabel('Client secret', { exact: true }).fill('test-secret');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByLabel('Client ID', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await accessibleLayout(page, info, 'settings-google-rejected-' + width);
    await page.screenshot({ path: info.outputPath('settings-google-rejected-' + width + '.png'), fullPage: true });
    await page.getByLabel('Client ID', { exact: true }).fill('corrected.apps.googleusercontent.com');
    await expect(page.getByLabel('Client ID', { exact: true })).not.toHaveAttribute('aria-invalid');
    await expect(page.getByLabel('Client secret', { exact: true })).not.toHaveAttribute('aria-invalid');
    await expect(page.getByText(/doesn't recognise this client ID and secret/)).toHaveCount(0);
    await page.getByLabel('Restricted Stripe key', { exact: true }).fill('rk_test_candidate');
    await page.getByRole('button', { name: 'Check and save key', exact: true }).click();
    await expect(page.getByRole('form', { name: 'Payments', exact: true })).toHaveCount(0);
    await expect(page.getByRole('alert').filter({ hasText: 'Whoever runs this install' })).toBeVisible();
    await accessibleLayout(page, info, 'settings-operator-managed-' + width);
    await page.screenshot({ path: info.outputPath('settings-operator-managed-' + width + '.png'), fullPage: true });
  });

  test(`setup clears Google refusal when either credential is corrected at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: { gym, session, login } } });
      if (path === '/api/setup') return route.fulfill({ json: { data: { currentStep: 6, completedSteps: [0, 1, 2, 3, 4, 5],
        completed: false, revision: 3, googleSkipped: false, backupsLater: false } } });
      if (path === '/api/setup/google') return route.fulfill({ status: 400, json: rejected });
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.goto(gymOrigin + '/setup#token=fixture');
    await page.getByLabel('Client ID', { exact: true }).fill('client.apps.googleusercontent.com');
    await page.getByLabel('Client secret', { exact: true }).fill('test-secret');
    for (const field of ['Client ID', 'Client secret']) {
      await page.getByRole('button', { name: 'Save Google client', exact: true }).click();
      await expect(page.getByLabel(field, { exact: true })).toHaveAttribute('aria-invalid', 'true');
      await accessibleLayout(page, info, 'setup-google-rejected-' + width + '-' + field);
      await page.screenshot({ path: info.outputPath('setup-google-rejected-' + width + '-' + field.replaceAll(' ', '-') + '.png'), fullPage: true });
      await page.getByLabel(field, { exact: true }).fill(field === 'Client ID' ? 'corrected.apps.googleusercontent.com' : 'corrected-secret');
      for (const name of ['Client ID', 'Client secret']) await expect(page.getByLabel(name, { exact: true })).not.toHaveAttribute('aria-invalid');
      await expect(page.getByRole('alert')).toHaveCount(0);
    }
  });
}
