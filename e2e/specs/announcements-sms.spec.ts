// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

const id = '01900000-0000-7000-8000-000000000001';
for (const width of [360, 1280]) {
  test(`announcement text preview, test, confirmation and scheduled history at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let sent = false, textTest: unknown, submitted: unknown;
    const row = { id, createdBy: id, subject: 'Class update', body: 'Email message.',
      audience: { statuses: ['active', 'trial', 'frozen'], programIds: [] }, recipientCount: 0, status: 'sent',
      createdAt: '2026-11-10T22:00:00Z', completedAt: '2026-11-10T22:00:01Z', sent: 0, failed: 0, skipped: 0,
      smsBody: 'Classes resume Monday — bring water. Please arrive early.', smsRecipientCount: 2, smsSent: 0, smsFailed: 0, smsSkipped: 0,
      smsScheduledFor: '2026-11-11T08:00:00Z', smsCompletedAt: null };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const list = (data: unknown[]) => ({ data, pagination: { offset: 0, limit: 100, total: data.length } });
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: {
        gym: { id, name: 'Our Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] },
        session: { userId: id, email: 'owner@example.invalid', displayName: 'Owner', roles: ['owner'], member: false },
        login: { password: true, magicLink: false },
      } } });
      if (path === '/api/programs' || path === '/api/staff/profiles') return route.fulfill({ json: list([]) });
      if (path === '/api/announcements') return route.fulfill({ json: list(sent ? [row] : []) });
      if (path.endsWith('/preview')) return route.fulfill({ json: { data: { recipientCount: 0, smsRecipientCount: 2, smsSegments: 2 } } });
      if (path.endsWith('/test-sms')) { textTest = route.request().postDataJSON(); return route.fulfill({ json: { data: { sent: true } } }); }
      if (path.endsWith('/send')) { submitted = route.request().postDataJSON(); sent = true; return route.fulfill({ json: { data: row } }); }
      return route.fulfill({ status: 404 });
    });
    const capture = async (name: string) => {
      await accessibleLayout(page, info, name);
      await page.screenshot({ path: info.outputPath(`sms-${width}-${name}.png`), fullPage: true });
    };
    await page.goto(gymOrigin + '/admin/announcements');
    await page.getByRole('button', { name: 'New announcement' }).click();
    await page.getByLabel('Subject', { exact: true }).fill(row.subject);
    await page.getByLabel('Message', { exact: true }).fill(row.body);
    await page.getByLabel('Include a text message').check();
    await page.getByLabel('Text message', { exact: true }).fill(row.smsBody);
    await expect(page.getByText(/2 segments per text/)).toBeVisible();
    await capture('compose');
    await page.getByLabel('Test phone number').fill('+12025550124');
    await page.getByRole('button', { name: 'Send test text', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Test text sent' })).toBeVisible();
    expect(textTest).toMatchObject({ sms: { body: row.smsBody }, testTo: '+12025550124' });
    await page.getByRole('button', { name: 'Preview announcement', exact: true }).click();
    await expect(page.getByText('2 text recipients · 2 segments per recipient')).toBeVisible();
    await expect(page.getByText(/Reply STOP to opt out/)).toBeVisible();
    await capture('preview');
    await page.getByRole('button', { name: 'Continue to confirmation' }).click();
    await capture('confirm');
    await page.getByRole('button', { name: 'Send 0 emails and 2 texts', exact: true }).click();
    expect(submitted).toMatchObject({ sms: { body: row.smsBody }, confirm: true });
    await expect(page.getByText('Texts scheduled for', { exact: false })).toBeVisible();
    await expect(page.getByText('Texts: 2 recipients · 0 sent · 0 failed · 0 skipped')).toBeVisible();
    await capture('scheduled');
  });
}
