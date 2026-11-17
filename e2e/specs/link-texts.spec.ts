// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

for (const width of [360, 1280]) {
  test(`invoice text recipients, consent refusals and uncertain resend at ${width}px`, async ({ browser, install }, info) => {
    const owner = install.clients.owner;
    const household = (await owner.json<{ data: { id: string; revision: number } }>('/api/households', 'POST', {
      name: `Text recipients ${width}`, phone: '+12025550123',
    })).data;
    await owner.json(`/api/households/${household.id}/sms-consent`, 'PUT', { consent: true, revision: household.revision });
    const member = (await owner.json<{ data: { id: string; revision: number } }>('/api/members', 'POST', {
      householdId: household.id, firstName: 'Consented', lastName: `Recipient ${width}`, phone: '+12025550124',
    })).data;
    await owner.json(`/api/members/${member.id}/sms-consent`, 'PUT', { kind: 'notices', consent: true, revision: member.revision });
    await owner.json('/api/members', 'POST', { householdId: household.id, firstName: 'No consent', lastName: `${width}`, phone: '+12025550125' });
    const settings = (await owner.json<{ data: { currency: string } }>('/api/settings')).data;
    const bill = (await owner.json<{ data: { id: string; number: number } }>('/api/billing/invoices/one-off', 'POST', {
      householdId: household.id, dueOn: new Date().toISOString().slice(0, 10), source: 'custom', description: 'Text pay link',
      currency: settings.currency, amountCents: 1000, taxRateIds: [],
    })).data;
    const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
    try {
      await owner.browser(context);
      const page = await context.newPage(), sends: { channel: string; recipientMemberId?: string; sendGeneration: string }[] = [];
      await page.route('**/api/links/send', route => {
        sends.push(route.request().postDataJSON());
        return route.fulfill({ json: { data: {
          id: crypto.randomUUID(), householdId: household.id, invoiceId: bill.id, purpose: 'pay_invoice', memberId: null,
          campaignId: null, createdBy: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(),
          usedAt: null, revokedAt: null, ...(sends.length === 1 ? { outcome: 'unknown' } : {}),
        } } });
      });
      await page.goto(gymOrigin + '/admin/billing/invoices');
      await page.getByRole('button', { name: 'View invoice ' + bill.number, exact: true }).click();
      await page.getByRole('button', { name: 'Send or share pay link', exact: true }).click();
      const delivery = page.getByRole('combobox', { name: 'Delivery', exact: true });
      await expect(page.getByRole('option', { name: /No consent.*No notices consent/ })).toHaveAttribute('disabled', '');
      await expect(page.getByRole('option', { name: 'Send by text: Household billing phone', exact: true })).not.toHaveAttribute('disabled');
      await delivery.selectOption('sms:' + member.id);
      await accessibleLayout(page, info, 'text-link-recipients-' + width);
      await mkdir('coverage/link-texts', { recursive: true });
      await writeFile(`coverage/link-texts/${width}-recipients.png`, await page.screenshot({ fullPage: true }));
      await page.getByRole('region', { name: 'Pay link', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(page.getByText(/earlier message may have been delivered/)).toBeVisible();
      await page.getByRole('button', { name: 'Send again', exact: true }).click();
      await expect(page.getByText('Pay link sent to the household.', { exact: true })).toBeVisible();
      expect(sends).toHaveLength(2);
      expect(sends[0]).toMatchObject({ channel: 'sms', recipientMemberId: member.id });
      expect(sends[1]!.sendGeneration).not.toBe(sends[0]!.sendGeneration);
      await delivery.selectOption('sms:household');
      await page.getByRole('region', { name: 'Pay link', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect.poll(() => sends.length).toBe(3);
      expect(sends[2]).toMatchObject({ channel: 'sms' });
      expect(sends[2]!.recipientMemberId).toBeUndefined();
      expect(sends[2]!.sendGeneration).not.toBe(sends[1]!.sendGeneration);
    } finally { await context.close(); }
  });
  test(`campaign text outcomes at ${width}px`, async ({ browser, install }, info) => {
    const owner = install.clients.owner;
    const household = (await owner.json<{ data: { id: string } }>('/api/households', 'POST', { name: `Campaign text outcomes ${width}` })).data;
    const id = crypto.randomUUID(), createdAt = new Date().toISOString(), expiresAt = new Date(Date.now() + 86400_000).toISOString();
    const detail = { campaign: { id, name: 'Card collection by text', purpose: 'update_card', createdBy: null,
      reminderSchedule: [], completedAt: null, createdAt }, progress: { total: 3, pending: 3, completed: 0, expired: 0, revoked: 0 } };
    const context = await browser.newContext({ viewport: { width, height: 1000 }, ignoreHTTPSErrors: true });
    try {
      await owner.browser(context);
      const page = await context.newPage();
      await page.route('**/api/households?*', route => route.fulfill({ json: {
        data: [household], pagination: { total: 1, limit: 100, offset: 0 },
      } }));
      await page.route('**/api/link-campaigns**', route => {
        const path = new URL(route.request().url()).pathname;
        return route.fulfill({ json: path.endsWith('/recipients') ? {
          data: ['sent', 'unknown', 'not_accepted'].map(smsState => ({ smsState, state: 'pending', link: {
            id: crypto.randomUUID(), householdId: household.id, campaignId: id, purpose: 'update_card', invoiceId: null, memberId: null,
            usedAt: null, revokedAt: null, createdBy: null, createdAt, expiresAt,
          } })), pagination: { total: 3, limit: 20, offset: 0 },
        } : path === '/api/link-campaigns' ? { data: [detail], pagination: { total: 1, limit: 20, offset: 0 } } : { data: detail } });
      });
      await page.goto(gymOrigin + '/admin/campaigns');
      await page.getByRole('button', { name: 'View Card collection by text', exact: true }).click();
      await expect(page.getByText('Text sent', { exact: true })).toBeVisible();
      await expect(page.getByText('Text delivery uncertain; this occurrence will not be resent', { exact: true })).toBeVisible();
      await expect(page.getByText('Text was not sent', { exact: true })).toBeVisible();
      await accessibleLayout(page, info, 'campaign-text-outcomes-' + width);
      await mkdir('coverage/link-texts', { recursive: true });
      await writeFile(`coverage/link-texts/${width}-campaign.png`, await page.screenshot({ fullPage: true }));
    } finally { await context.close(); }
  });
}

test('the permission sweep refuses a coach sending a link by text', async ({ install }) => {
  const response = await install.clients.coach.request('/api/links/send', 'POST', {
    channel: 'sms', purpose: 'update_card', householdId: crypto.randomUUID(), sendGeneration: crypto.randomUUID(),
    expiresAt: new Date(Date.now() + 86400_000).toISOString(),
  });
  expect(response.status).toBe(403);
});
