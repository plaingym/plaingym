// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, demoClient, type RecordId } from '../support.js';
import { accessibleLayout } from '../responsive.js';

// Outbox URLs are bearer credentials. Keep them out of traces and screenshots.
test.use({ trace: 'off', screenshot: 'off' });
test('a campaign outbox link opens onboarding on its sandbox, loads assets, and shows revoked-link feedback', async ({ page, sandboxes }, info) => {
  const sandbox = sandboxes[0]!, owner = await demoClient(sandbox, 'owner');
  const initial = (await owner.json<{ data: RecordId & { memberEmailsEnabled: boolean } }>('/api/settings/go-live')).data;
  try {
    if (!initial.memberEmailsEnabled) await owner.json('/api/settings/go-live', 'PATCH', { revision: initial.revision, memberEmailsEnabled: true });
    const households = (await owner.json<{ data: { id: string; email: string | null }[] }>('/api/households?limit=100')).data;
    const household = households.find(home => home.email)!;
    const campaign = await owner.json<{ data: { campaign: { id: string } } }>('/api/link-campaigns', 'POST', {
      name: 'Browser onboarding', purpose: 'onboarding', expiresAt: new Date(Date.now() + 3600000).toISOString(),
      reminderSchedule: [], recipients: [{ householdId: household.id }],
    });
    let link: URL | undefined;
    await expect.poll(async () => {
      const outbox = await owner.request<{ data: { recipient: string; text: string }[] }>('/api/demo/outbox?limit=100');
      if (outbox.status !== 200) return false;
      for (const message of outbox.body.data.filter(message => message.recipient === household.email)) {
        const match = message.text.match(/https:\/\/[^\s<>]+\/l\/[A-Za-z0-9_-]+/);
        if (match) { link = new URL(match[0]); return true; }
      }
      return false;
    }, { timeout: 30000, message: 'Onboarding email reaches the sandbox outbox' }).toBe(true);
    expect(link!.origin === sandbox.origin).toBe(true);
    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      try { await page.goto(link!.href); } catch { throw new Error('Onboarding page could not be opened'); }
      await expect(page.getByRole('heading', { name: 'Get ready to train', exact: true })).toBeVisible();
      expect(await page.locator('link[href="/l/styles.css"]').evaluate((node: HTMLLinkElement) => !!node.sheet)).toBe(true);
      await expect(page.locator('script[src="/l/client.js"]')).toHaveCount(1);
      await accessibleLayout(page, info, 'onboarding-' + width);
    }
    const recipients = (await owner.json<{ data: { link: { id: string } }[] }>(`/api/link-campaigns/${campaign.data.campaign.id}/recipients`)).data;
    await owner.json('/api/links/' + recipients[0]!.link.id + '/revoke', 'POST', {});
    const response = await page.reload(); expect(response?.status()).toBe(404);
    await expect(page.getByRole('heading', { name: 'This link is unavailable' })).toBeVisible();
  } finally {
    if (!initial.memberEmailsEnabled) {
      const current = (await owner.json<{ data: RecordId }>('/api/settings/go-live')).data;
      await owner.json('/api/settings/go-live', 'PATCH', { revision: current.revision, memberEmailsEnabled: false });
    }
  }
});
