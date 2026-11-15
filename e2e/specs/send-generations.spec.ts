// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, gymOrigin, type RecordId } from '../support.js';

for (const width of [360, 1280]) {
  test(`email send forms require a deliberate resend after uncertainty at ${width}px`, async ({ page, context, install }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const owner = install.clients.owner;
    const home = (await owner.json<{ data: RecordId }>('/api/households', 'POST', { name: 'Send generation ' + width })).data;
    const member = (await owner.json<{ data: RecordId }>('/api/members', 'POST', {
      householdId: home.id, firstName: 'Send', lastName: 'Generation' + width,
    })).data;
    const settings = (await owner.json<{ data: { currency: string } }>('/api/settings')).data;
    const bill = (await owner.json<{ data: { id: string; number: number } }>('/api/billing/invoices/one-off', 'POST', {
      householdId: home.id, dueOn: new Date().toISOString().slice(0, 10), source: 'custom', description: 'Send generation',
      currency: settings.currency, amountCents: 1000, taxRateIds: [],
    })).data;
    await owner.browser(context);
    const now = new Date().toISOString(), expiresAt = new Date(Date.now() + 86400_000).toISOString();
    const generations = { invoice: [] as string[], portal: [] as string[], staff: [] as string[] };
    // Deterministic delivery responses exercise the production UI without sending email.
    await page.route('**/api/links/send', route => {
      generations.invoice.push(route.request().postDataJSON().sendGeneration);
      return route.fulfill({ json: { data: {
        id: crypto.randomUUID(), householdId: home.id, invoiceId: bill.id, purpose: 'pay_invoice', memberId: null,
        campaignId: null, createdBy: null, createdAt: now, expiresAt, usedAt: null, revokedAt: null,
        ...(generations.invoice.length === 1 ? { outcome: 'unknown' } : {}),
      } } });
    });
    await page.route(`**/api/households/${home.id}/portal-invitations`, route => {
      if (route.request().method() !== 'POST') return route.continue();
      generations.portal.push(route.request().postDataJSON().sendGeneration);
      return route.fulfill({ json: { data: { delivery: 'email',
        invitation: { userId: crypto.randomUUID(), scope: 'member', memberId: member.id, expiresAt },
        ...(generations.portal.length === 1 ? { outcome: 'unknown' } : {}),
      } } });
    });
    await page.route('**/api/staff/invitations', route => {
      if (route.request().method() !== 'POST') return route.continue();
      generations.staff.push(route.request().postDataJSON().sendGeneration);
      return route.fulfill({ json: { data: { delivery: 'email',
        staffRole: { id: crypto.randomUUID(), userId: crypto.randomUUID(), role: 'coach', revision: 1, createdAt: now },
        ...(generations.staff.length === 1 ? { outcome: 'unknown' } : {}),
      } } });
    });

    await page.goto(gymOrigin + '/admin/billing/invoices');
    await page.getByRole('button', { name: 'View invoice ' + bill.number, exact: true }).click();
    await page.getByRole('button', { name: 'Send or share pay link', exact: true }).click();
    await page.getByRole('region', { name: 'Pay link', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(page.getByText(/may have been delivered/)).toBeVisible();
    await info.attach('invoice-uncertain-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole('button', { name: 'Send again', exact: true }).click();
    await expect(page.getByText('Pay link sent to the household.', { exact: true })).toBeVisible();
    await expect(page.getByText(/may have been delivered/)).toHaveCount(0);

    await page.goto(gymOrigin + '/admin/members');
    await page.getByLabel('Search members', { exact: true }).fill('Send Generation' + width);
    await page.getByRole('link', { name: 'Send Generation' + width }).click();
    await page.getByRole('tab', { name: 'Portal access', exact: true }).click();
    await page.getByRole('button', { name: 'Invite', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Login email', { exact: true }).fill('member@example.test');
    await dialog.getByLabel('Invitation delivery', { exact: true }).selectOption('email');
    await dialog.getByRole('button', { name: 'Invite', exact: true }).click();
    await expect(dialog.getByText(/may have been delivered/)).toBeVisible();
    await info.attach('portal-uncertain-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Send again', exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await page.goto(gymOrigin + '/admin/staff');
    await page.getByLabel('Email address', { exact: true }).fill('coach@example.test');
    await page.getByRole('combobox', { name: 'Delivery', exact: true }).selectOption('email');
    await page.getByRole('button', { name: 'Invite staff', exact: true }).click();
    await expect(page.getByText(/may have been delivered/)).toBeVisible();
    await info.attach('staff-uncertain-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    await page.getByRole('button', { name: 'Send again', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Invite staff', exact: true })).toBeEnabled();
    await expect(page.getByText(/may have been delivered/)).toHaveCount(0);
    for (const sends of Object.values(generations)) {
      expect(sends).toHaveLength(2);
      expect(sends[1]).not.toBe(sends[0]);
    }
  });
}
