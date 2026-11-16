// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

for (const width of [360, 1280]) {
  test(`household imports cards before its first invoice at ${width}px`, async ({ browser, install }, info) => {
    const owner = install.clients.owner;
    const household = (await owner.json<{ data: { id: string } }>('/api/households', 'POST', { name: 'Household cards ' + width })).data;
    const member = (await owner.json<{ data: { id: string } }>('/api/members', 'POST', {
      householdId: household.id, firstName: 'Casey', lastName: 'Cards' + width, status: 'active',
    })).data;
    const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
    try {
      await owner.browser(context);
      const page = await context.newPage();
      await page.goto(gymOrigin + '/admin/members/' + member.id + '#memberTabs.invoices');
      await expect(page.getByRole('button', { name: 'Import cards from Stripe', exact: true })).toBeVisible();
      await expect(page.getByText('No saved cards', { exact: true })).toBeVisible();
      await page.route(`**/api/billing/households/${household.id}/payment-methods/import`, route => route.fulfill({ json: { data: { queued: true } } }));
      await page.getByRole('button', { name: 'Import cards from Stripe', exact: true }).click();
      await expect(page.getByText(/Card import queued/)).toBeVisible();
      await page.route(url => url.pathname === `/api/billing/households/${household.id}/payment-methods`, route => route.fulfill({ json: {
        data: [{ id: crypto.randomUUID(), createdAt: new Date().toISOString(), householdId: household.id,
          brand: 'visa', last4: '4242', expiryMonth: 12, expiryYear: 2035, isDefault: true, revokedAt: null }],
        pagination: { total: 1, offset: 0, limit: 25 },
      } }));
      await page.getByRole('button', { name: 'Refresh cards', exact: true }).click();
      await expect(page.getByText(/4242/)).toBeVisible();
      await expect(page.getByText('Default card', { exact: true })).toBeVisible();
      await accessibleLayout(page, info, 'household-card-import-' + width);
      await mkdir('coverage/customer-card-import', { recursive: true });
      await writeFile(`coverage/customer-card-import/${width}-household.png`, await page.screenshot({ fullPage: true }));
    } finally { await context.close(); }
  });
  test(`staff requests card import and refreshes its results at ${width}px`, async ({ browser, install }, info) => {
    const owner = install.clients.owner;
    const household = (await owner.json<{ data: { id: string } }>('/api/households', 'POST', { name: 'Card import ' + width })).data;
    const settings = (await owner.json<{ data: { currency: string } }>('/api/settings')).data;
    const invoice = (await owner.json<{ data: { number: number } }>('/api/billing/invoices/one-off', 'POST', {
      householdId: household.id, dueOn: new Date().toISOString().slice(0, 10), source: 'custom', description: 'Card import check',
      currency: settings.currency, amountCents: 1000, taxRateIds: [],
    })).data;
    const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
    try {
      await owner.browser(context);
      const page = await context.newPage();
      await page.goto(gymOrigin + '/admin/billing/invoices');
      await page.getByRole('button', { name: 'View invoice ' + invoice.number, exact: true }).click();
      await page.getByRole('button', { name: 'Import cards from Stripe', exact: true }).click();
      await expect(page.getByText('This household has no linked Stripe customer. Link its customer before importing cards.')).toBeVisible();
      // Stripe test credentials are not required for browser feedback; adapter and database suites cover the actual import.
      await page.route(`**/api/billing/households/${household.id}/payment-methods/import`, async route => {
        expect(route.request().method()).toBe('POST'); expect(route.request().postDataJSON()).toEqual({});
        await route.fulfill({ json: { data: { queued: true } } });
      });
      await page.getByRole('button', { name: 'Import cards from Stripe', exact: true }).click();
      await expect(page.getByText(/Card import queued/)).toBeVisible();
      await page.getByRole('button', { name: 'Refresh cards', exact: true }).click();
      await accessibleLayout(page, info, 'customer-card-import-' + width);
      await mkdir('coverage/customer-card-import', { recursive: true });
      await writeFile(`coverage/customer-card-import/${width}.png`, await page.screenshot({ fullPage: true }));
    } finally { await context.close(); }
  });
}
