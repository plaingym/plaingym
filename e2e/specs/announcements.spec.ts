// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

const id = '01900000-0000-7000-8000-000000000001';
const gym = { id, name: 'Our Gym', timezone: 'UTC', currency: 'USD', enabledModules: [] };
const session = { userId: id, email: 'owner@example.invalid', displayName: 'Owner', roles: ['owner'], member: false };
const announcement = { id, createdBy: id, subject: 'Winter classes', body: 'Classes resume Monday.',
  audience: { statuses: ['active', 'trial', 'frozen'], programIds: [] }, recipientCount: 3, status: 'sent',
  createdAt: '2026-11-12T12:00:00Z', completedAt: '2026-11-12T12:01:00Z', sent: 3, failed: 0, skipped: 0 };

// Exercise the production dialog's recovery states with deterministic API refusals and a lost response.
for (const width of [360, 1280]) {
  test(`announcement tests before go-live and send recovery at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    let previewReason: string | null = 'disabled', sendOutcome: 'unknown' | 'refused' | 'accepted' = 'unknown';
    const generations: string[] = [];
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const list = (data: unknown[]) => ({ data, pagination: { offset: 0, limit: 100, total: data.length } });
      if (path === '/api/demo') return route.fulfill({ json: { data: { mode: 'disabled' } } });
      if (path === '/api/auth/bootstrap') return route.fulfill({ json: { data: { gym, session, login: { password: true, magicLink: false } } } });
      if (path === '/api/programs' || path === '/api/staff/profiles') return route.fulfill({ json: list([]) });
      if (path === '/api/announcements') return route.fulfill({ json: list([]) });
      if (path.endsWith('/preview')) return previewReason
        ? route.fulfill({ status: 409, json: { error: { code: 'conflict', details: { reason: [previewReason] } } } })
        : route.fulfill({ json: { data: { recipientCount: 3 } } });
      if (path.endsWith('/test')) return route.fulfill({ json: { data: { sent: true } } });
      if (path.endsWith('/send')) {
        generations.push(route.request().postDataJSON().sendGeneration);
        if (sendOutcome === 'unknown') return route.abort('failed');
        if (sendOutcome === 'refused') return route.fulfill({ status: 503, json: { error: { code: 'unavailable' } } });
        return route.fulfill({ json: { data: announcement } });
      }
      return route.fulfill({ status: 404 });
    });
    const check = async (name: string) => {
      await accessibleLayout(page, info, name);
      await page.screenshot({ path: info.outputPath(`announcements-${width}-${name}.png`), fullPage: true });
      const body = page.locator('[data-dialog-body]');
      if (await body.count()) {
        await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
        await page.screenshot({ path: info.outputPath(`announcements-${width}-${name}-actions.png`), fullPage: true });
        await body.evaluate(element => { element.scrollTop = 0; });
      }
    };
    await page.goto(gymOrigin + '/admin/announcements');
    await page.getByRole('button', { name: 'New announcement' }).click();
    await page.getByLabel('Subject', { exact: true }).fill('Winter classes');
    await page.getByLabel('Message', { exact: true }).fill('Classes resume Monday.\nhttps://example.invalid/' + 'x'.repeat(160));
    await check('compose');
    await page.getByRole('button', { name: 'Preview announcement', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Member email is switched off');
    await check('disabled');
    await page.getByRole('button', { name: 'Send me a test' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Test sent' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue to confirmation' })).toHaveCount(0);
    await check('compose-test');
    previewReason = 'no_origin';
    await page.getByRole('button', { name: 'Preview announcement', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('canonical HTTPS gym address');
    await expect(page.getByRole('link', { name: 'Open gym address settings' })).toHaveAttribute('target', '_blank');
    await check('origin-refusal');
    previewReason = 'no_smtp';
    await page.getByRole('button', { name: 'Preview announcement', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Email is not set up');
    await expect(page.getByRole('link', { name: 'Open email settings' })).toHaveAttribute('target', '_blank');
    await check('smtp-refusal');
    previewReason = null;
    await page.getByRole('button', { name: 'Preview announcement', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Member message preview' })).toBeVisible();
    await check('preview');
    await page.getByRole('button', { name: 'Continue to confirmation' }).click();
    await page.getByRole('button', { name: 'Send to 3 members' }).click();
    await expect(page.getByRole('alert')).toContainText('Retry this same announcement');
    await check('unknown');
    await page.getByRole('button', { name: 'Close announcement' }).click();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await page.getByRole('button', { name: 'New announcement' }).click();
    await expect(page.getByRole('button', { name: 'Edit message' })).toHaveCount(0);
    await check('reopened');
    sendOutcome = 'refused';
    await page.getByRole('button', { name: 'Send to 3 members' }).click();
    await expect(page.getByRole('alert')).toContainText('Retry this same announcement');
    await expect(page.getByRole('alert')).not.toContainText('announcement was not accepted');
    await expect(page.getByRole('button', { name: 'Edit message' })).toHaveCount(0);
    expect(generations).toHaveLength(2); expect(generations[1]).toBe(generations[0]);
    await check('retry-refusal');
    await page.getByRole('button', { name: 'Close announcement' }).click();
    await page.getByRole('button', { name: 'Discard changes' }).click();
    await page.getByRole('button', { name: 'New announcement' }).click();
    sendOutcome = 'accepted';
    await page.getByRole('button', { name: 'Send to 3 members' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Announcement accepted' })).toBeVisible();
    expect(generations[2]).toBe(generations[1]);

    // A refusal of the first request still permits editing and a fresh generation.
    sendOutcome = 'refused';
    await page.getByRole('button', { name: 'New announcement' }).click();
    await page.getByLabel('Subject', { exact: true }).fill('New announcement');
    await page.getByLabel('Message', { exact: true }).fill('A separate message.');
    await page.getByRole('button', { name: 'Preview announcement', exact: true }).click();
    await page.getByRole('button', { name: 'Continue to confirmation' }).click();
    await page.getByRole('button', { name: 'Send to 3 members' }).click();
    await expect(page.getByRole('alert')).toContainText('announcement was not accepted');
    await check('first-refusal');
    await page.getByRole('button', { name: 'Edit message' }).click();
    await page.getByRole('button', { name: 'Preview announcement', exact: true }).click();
    await page.getByRole('button', { name: 'Continue to confirmation' }).click();
    sendOutcome = 'accepted';
    await page.getByRole('button', { name: 'Send to 3 members' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Announcement accepted' })).toBeVisible();
    expect(generations).toHaveLength(5); expect(generations[4]).not.toBe(generations[3]);
  });
}
