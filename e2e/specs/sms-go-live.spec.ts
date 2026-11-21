// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

const gym = { id: '00000000-0000-7000-8000-000000000001', name: 'Sample gym', timezone: 'UTC', currency: 'USD', enabledModules: [] };
const session = { userId: '00000000-0000-7000-8000-000000000002', displayName: 'Owner', roles: ['owner'], member: false };
const login = { password: true, magicLink: false }, now = '2026-11-16T04:00:00Z';
const initial = { ...gym, slug: 'sample-gym', address: {}, branding: {}, websiteEnabled: false, existingSiteUrl: null,
  bookingWindowDays: 14, cancellationCutoffMinutes: 60, openMatCountsAsClass: false, billingEnabled: false, bankDebitsEnabled: false, memberEmailsEnabled: false,
  memberSmsEnabled: false, smsDailyCap: 1000, retryDays: [3, 7], dropInChargeTypeId: null, revision: 3, createdAt: now, updatedAt: now };
const integrations = { email: { source: 'none', unreadable: false, googleConfigured: false, host: null, port: null, security: null, from: null,
  signIn: login, signInAfterSave: login, signInAfterRemove: null, removeBlocked: false },
sms: { configured: false, provider: 'twilio', unreadable: false, accountSid: null, authKind: null, from: null, messagingServiceSid: null, baseUrl: 'https://api.twilio.com' },
payments: { configured: false, mode: null, webhookRegistered: false, accountLocked: false, testData: null, importedCustomersOnly: false },
backups: null, sandbox: false, integrationsEditable: true, revision: 3 };
const ids = ['last_backup', 'failed_jobs', 'smtp', 'disk', 'version', 'stripe_webhooks', 'last_charge_run', 'automatic_updates', 'update_available', 'google_login', 'sms', 'invoice_effects'];
const overdue = { id: '00000000-0000-7000-8000-000000000005', memberId: '00000000-0000-7000-8000-000000000006',
  memberName: 'Ana Silva', planName: 'Monthly classes', revision: 2, nextDueOn: '2026-10-20' };

for (const width of [360, 1280]) {
  test(`SMS go-live, cap, Health and mixed demo outbox at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let settings = { ...initial }, hasProvider = false, smsReadFails = false;
    const requests: unknown[] = [];
    const checklist = () => ({ data: { revision: settings.revision, billingEnabled: false, memberEmailsEnabled: false, memberSmsEnabled: settings.memberSmsEnabled,
      items: [{ id: 'sms_ready', status: hasProvider ? 'ready' : 'needs_attention', message: hasProvider ? 'Text delivery is configured.' : 'Save an SMS provider before turning member texts on.' }],
      pastDueMemberships: [overdue] } });
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname, method = route.request().method();
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: { gym, session, login } } });
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/settings') return route.fulfill({ json: { data: settings } });
      if (path === '/api/billing/charge-types' || path === '/api/kiosk/devices')
        return route.fulfill({ json: { data: [], pagination: { limit: 100, offset: 0, total: 0 } } });
      if (path === '/api/website') return route.fulfill({ json: { data: { revision: settings.revision,
        tagline: null, about: null, phone: null, email: null, primaryColor: null, accentColor: null, logo: false, logoVersion: null, photos: [] } } });
      if (path === '/api/health/auto-update') return route.fulfill({ json: { data: { enabled: false, available: false, revision: 1 } } });
      if (path === '/api/settings/integrations') return route.fulfill({ json: { data: { ...integrations, revision: settings.revision } } });
      if (path === '/api/settings/integrations/google') return route.fulfill({ json: { data: {
        source: 'none', editable: false, unreadable: false, clientId: null, clientSecretSet: false, removeBlocked: false, revision: settings.revision,
      } } });
      if (path === '/api/settings/go-live') {
        if (method === 'PATCH') {
          const body = route.request().postDataJSON() as { revision: number; memberSmsEnabled?: boolean; billingEnabled?: boolean };
          requests.push(body);
          const failedSwitch = body.billingEnabled ? 'billingEnabled' : smsReadFails && body.memberSmsEnabled ? 'memberSmsEnabled' : null;
          if (failedSwitch) return route.fulfill({ status: 503, json: { error: { code: 'unavailable', details: { [failedSwitch]: ['read_failed'] } } } });
          if (!hasProvider && body.memberSmsEnabled) return route.fulfill({ status: 409, json: { error: { code: 'conflict', details: { memberSmsEnabled: ['no_provider'] } } } });
          if (body.memberSmsEnabled !== undefined) settings = { ...settings, revision: settings.revision + 1, memberSmsEnabled: body.memberSmsEnabled };
        }
        return route.fulfill({ json: checklist() });
      }
      if (path === '/api/settings/integrations/sms/cap') {
        const body = route.request().postDataJSON() as { revision: number; smsDailyCap: number }; requests.push(body);
        settings = { ...settings, revision: settings.revision + 1, smsDailyCap: body.smsDailyCap };
        return route.fulfill({ json: { data: settings } });
      }
      if (path === '/api/health') return route.fulfill({ json: { data: { generatedAt: now, tiles: ids.map(id => id === 'sms'
        ? { id, status: 'warning', checkedAt: now, message: "Member texts have been refused because today's daily cap was reached.",
          details: { configured: true, memberSmsEnabled: true, sentToday: 12, refusedToday: 3, smsDailyCap: 12, lastTestAt: now, lastTestResult: 'sent' } }
        : { id, status: 'not_configured', checkedAt: null, details: null, message: 'Not set up' }) } } });
      if (path === '/api/health/backups') return route.fulfill({ json: { data: { available: false, configured: false, pruningHeld: false, revision: settings.revision, manual: null } } });
      if (path === '/api/demo/outbox') return route.fulfill({ json: { data: [
        { id: '00000000-0000-7000-8000-000000000004', channel: 'sms', recipient: '+12025550110', subject: '', text: 'Sample gym: Your class starts soon.', sentAt: now },
        { id: '00000000-0000-7000-8000-000000000003', channel: 'email', recipient: 'member@example.invalid', subject: 'Email sample', text: 'Your class is on the schedule.', sentAt: now },
      ], next: null } });
      return route.fulfill({ status: 404, json: { error: { code: 'not_found' } } });
    });
    await page.goto(gymOrigin + '/admin/settings');
    await page.getByRole('button', { name: 'Turn on: Member texts', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Save a working SMS provider' })).toBeVisible();
    hasProvider = true;
    const enableTexts = page.getByRole('button', { name: 'Turn on: Member texts', exact: true });
    smsReadFails = true;
    await enableTexts.click();
    const smsAlert = page.getByRole('alert').filter({ hasText: 'The SMS provider could not be checked. Try turning member texts on again.' });
    await expect(smsAlert).toBeVisible();
    await expect(enableTexts).toBeEnabled();
    await info.attach('sms-read-failed-' + width, { body: await smsAlert.screenshot(), contentType: 'image/png' });
    smsReadFails = false;
    await enableTexts.click();
    await expect(page.getByRole('button', { name: 'Turn off: Member texts', exact: true })).toBeVisible();
    await page.getByRole('spinbutton', { name: 'Daily text cap' }).fill('12');
    await page.getByRole('button', { name: 'Save daily text cap', exact: true }).click();
    await expect(page.getByRole('region', { name: 'SMS', exact: true }).getByRole('status')).toContainText('daily text cap is saved');
    await accessibleLayout(page, info, 'sms-go-live-' + width);
    await page.screenshot({ path: info.outputPath('sms-go-live-' + width + '.png'), fullPage: true });
    await page.getByRole('button', { name: 'Turn on: Billing', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Review past billing dates' });
    await confirmation.getByRole('checkbox').check();
    await confirmation.getByRole('button', { name: 'Confirm dates and turn billing on' }).click();
    await expect(confirmation.getByRole('alert')).toHaveText('Stripe could not be checked. Try turning billing on again.');
    expect(requests).toEqual([{ revision: 3, memberSmsEnabled: true }, { revision: 3, memberSmsEnabled: true },
      { revision: 3, memberSmsEnabled: true }, { revision: 4, smsDailyCap: 12 }, { revision: 5, billingEnabled: true,
        confirmedPastDueDates: [{ id: overdue.id, revision: overdue.revision, nextDueOn: overdue.nextDueOn }] }]);
    await info.attach('stripe-read-failed-' + width, { body: await confirmation.screenshot(), contentType: 'image/png' });
    await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.goto(gymOrigin + '/admin/health');
    await expect(page.getByRole('heading', { name: 'SMS', exact: true })).toBeVisible();
    await expect(page.getByText('Refused past the cap today', { exact: true })).toBeVisible();
    await accessibleLayout(page, info, 'sms-health-' + width);
    await page.screenshot({ path: info.outputPath('sms-health-' + width + '.png'), fullPage: true });
    await page.goto(gymOrigin + '/admin/outbox');
    await expect(page.getByRole('heading', { name: 'Text message', exact: true })).toBeVisible();
    await expect(page.getByText('Sample gym: Your class starts soon.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Preview HTML' })).toHaveCount(1);
    await accessibleLayout(page, info, 'sms-outbox-' + width);
    await page.screenshot({ path: info.outputPath('sms-outbox-' + width + '.png'), fullPage: true });
  });
}
