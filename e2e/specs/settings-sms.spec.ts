// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

const accountSid = 'AC' + '1'.repeat(32), apiKey = 'SK' + '2'.repeat(32), messagingServiceSid = 'MG' + '3'.repeat(32);
const gym = { id: '00000000-0000-7000-8000-000000000001', name: 'SMS settings gym', timezone: 'UTC', currency: 'USD', enabledModules: [] };
const session = { userId: '00000000-0000-7000-8000-000000000002', displayName: 'Owner', roles: ['owner'], member: false };
const login = { password: true, magicLink: false };
const settings = { ...gym, slug: 'sms-settings', address: {}, branding: {}, websiteEnabled: false, existingSiteUrl: null,
  bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false, billingEnabled: false, memberEmailsEnabled: false,
  memberSmsEnabled: false, smsDailyCap: 1000,
  retryDays: [3, 7], dropInChargeTypeId: null, revision: 3, createdAt: '2026-11-01T12:00:00Z', updatedAt: '2026-11-01T12:00:00Z' };
const sms = { configured: false, provider: 'twilio', unreadable: false, accountSid: null as string | null,
  authKind: null as 'token' | 'apiKey' | null, from: null as string | null, messagingServiceSid: null as string | null, baseUrl: 'https://api.twilio.com' };
const integrations = {
  email: { source: 'none', unreadable: false, googleConfigured: false, host: null, port: null, security: null, from: null,
    signIn: login, signInAfterSave: login, signInAfterRemove: null, removeBlocked: false },
  sms, payments: { configured: false, mode: null, webhookRegistered: false, accountLocked: false, testData: null, importedCustomersOnly: false },
  backups: null, sandbox: false, integrationsEditable: true, revision: 3,
};
// Exercise the production form with API fixtures; no provider is contacted and no text is sent.
for (const width of [360, 1280]) {
  test(`SMS settings save, empty replacement secrets and removal at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 800 });
    let current = structuredClone(integrations);
    const requests: Record<string, unknown>[] = [];
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: { gym, session, login } } });
      if (path === '/api/settings') return route.fulfill({ json: { data: settings } });
      if (path === '/api/settings/integrations/google') return route.fulfill({ json: { data: {
        source: 'none', editable: false, unreadable: false, clientId: null, clientSecretSet: false, removeBlocked: false, revision: current.revision,
      } } });
      if (path === '/api/settings/integrations') return route.fulfill({ json: { data: current } });
      if (path === '/api/settings/integrations/sms') {
        const request = route.request().postDataJSON() as Record<string, unknown>; requests.push(request);
        if (route.request().method() === 'DELETE') {
          current = { ...current, revision: current.revision + 1, sms: { ...sms } };
          return route.fulfill({ json: { data: current } });
        }
        current = { ...current, revision: current.revision + 1, sms: { ...sms, configured: true, accountSid,
          authKind: 'token', from: '+14155552671' } };
        return route.fulfill({ json: { data: { test: 'sent', integrations: current } } });
      }
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.goto(gymOrigin + '/admin/settings');
    const cap = page.getByRole('spinbutton', { name: 'Daily text cap' });
    await cap.fill('25');
    const section = page.getByRole('region', { name: 'SMS', exact: true });
    await page.getByRole('button', { name: 'Connect SMS provider' }).click();
    const form = page.getByRole('form', { name: 'SMS provider settings' });
    await form.getByLabel('Account SID', { exact: true }).fill(accountSid);
    await form.getByLabel('Auth token', { exact: true }).fill('test-token');
    await form.getByLabel('From phone number', { exact: true }).fill('+14155552671');
    await form.getByLabel('Send the test text to').fill('+1 (202) 555-0123');
    await accessibleLayout(page, info, 'sms-token-form-' + width);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath('sms-token-form-' + width + '.png'), fullPage: true });
    await form.getByRole('button', { name: 'Send test text and save' }).click();
    await expect(section.getByRole('status')).toContainText('SMS settings are saved');
    await expect(cap).toHaveValue('25');
    expect(requests).toEqual([{ revision: 3, provider: 'twilio', accountSid, auth: { token: 'test-token' },
      sender: { from: '+14155552671' }, testTo: '+1 (202) 555-0123', baseUrl: 'https://api.twilio.com' }]);
    await expect(page.getByText('Credentials are stored securely', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Change SMS settings' }).click();
    await expect(form.getByLabel('Auth token', { exact: true })).toHaveValue('');
    await expect(form.getByLabel('Send the test text to')).toHaveValue('');
    await form.getByLabel('Authentication method').selectOption('apiKey');
    await form.getByLabel('API key SID').fill(apiKey);
    await form.getByLabel('API key secret').fill('test-secret');
    await form.getByLabel('Send using').selectOption('service');
    await form.getByLabel('Messaging Service SID', { exact: true }).fill(messagingServiceSid);
    await accessibleLayout(page, info, 'sms-api-key-form-' + width);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: info.outputPath('sms-api-key-form-' + width + '.png'), fullPage: true });
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('button', { name: 'Remove SMS provider' }).click();
    await expect(section.getByRole('status')).toContainText('SMS credentials are removed');
    expect(requests[1]).toEqual({ revision: 4 });
  });
}
