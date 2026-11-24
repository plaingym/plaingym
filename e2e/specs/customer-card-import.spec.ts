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
      await expect(page.getByText('No saved payment methods', { exact: true })).toBeVisible();
      await page.route(`**/api/billing/households/${household.id}/payment-methods/import`, route => route.fulfill({ json: { data: { queued: true } } }));
      await page.getByRole('button', { name: 'Import cards from Stripe', exact: true }).click();
      await expect(page.getByText(/Card import queued/)).toBeVisible();
      const firstId = crypto.randomUUID(), secondId = crypto.randomUUID(), finishedId = crypto.randomUUID(), plainId = crypto.randomUUID();
      let selected = false, removed = false;
      const revokedAt = new Date().toISOString();
      const cards = () => [
        { id: firstId, createdAt: revokedAt, householdId: household.id,
          type: 'card', bankName: null, brand: 'visa', last4: '4242', expiryMonth: 12, expiryYear: 2035, isDefault: !selected || removed, revokedAt: null },
        { id: secondId, createdAt: revokedAt, householdId: household.id,
          type: 'acss_debit', bankName: null, brand: null, last4: '4444', expiryMonth: null, expiryYear: null, isDefault: selected && !removed,
          revokedAt: removed ? revokedAt : null, ...(removed ? { removal: 'pending' as const } : {}) },
        { id: finishedId, createdAt: revokedAt, householdId: household.id,
          type: 'card', bankName: null, brand: 'mastercard', last4: '5555', expiryMonth: 10, expiryYear: 2034, isDefault: false,
          revokedAt, removal: 'finished' as const },
        { id: plainId, createdAt: revokedAt, householdId: household.id,
          type: 'us_bank_account', bankName: 'Test Bank', brand: null, last4: '6666', expiryMonth: null, expiryYear: null, isDefault: false,
          revokedAt },
      ];
      await page.route(url => url.pathname === `/api/billing/households/${household.id}/payment-methods`, route => route.fulfill({ json: {
        data: cards(), pagination: { total: 4, offset: 0, limit: 25 },
      } }));
      await page.route(`**/api/billing/households/${household.id}/payment-methods/${secondId}/default`, route => {
        selected = true; return route.fulfill({ json: { data: cards()[1] } });
      });
      await page.route(`**/api/billing/households/${household.id}/payment-methods/${secondId}/revoke`, route => {
        removed = true; return route.fulfill({ status: 503, json: {} });
      });
      await page.getByRole('button', { name: 'Refresh payment methods', exact: true }).click();
      await expect(page.getByText(/4242/)).toBeVisible();
      await expect(page.getByText('Default payment method', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Make default', exact: true }).click();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      const second = page.getByRole('listitem').filter({ hasText: 'Bank account ending 4444' });
      await expect(second.getByText('Default payment method', { exact: true })).toBeVisible();
      await second.getByRole('button', { name: 'Remove payment method', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Remove saved payment method' }).getByText(/^Bank account ending 4444 · Remove/)).toBeVisible();
      await accessibleLayout(page, info, 'household-card-confirm-' + width);
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(page.getByRole('alert')).toBeVisible();
      await page.getByRole('button', { name: 'Back to payment methods', exact: true }).click();
      await expect(second.getByText('Removal pending', { exact: true })).toBeVisible();
      await expect(second.getByRole('button', { name: 'Retry payment method removal', exact: true })).toBeVisible();
      await expect(second.getByText('Default payment method', { exact: true })).toHaveCount(0);
      const finished = page.getByRole('listitem').filter({ hasText: '5555' });
      await expect(finished.getByText('Removed from Stripe', { exact: true })).toBeVisible();
      await expect(finished.getByRole('button', { name: 'Retry payment method removal', exact: true })).toHaveCount(0);
      const plain = page.getByRole('listitem').filter({ hasText: '6666' });
      await expect(plain.getByText('Removed', { exact: true })).toBeVisible();
      await expect(plain.getByRole('button', { name: 'Retry payment method removal', exact: true })).toHaveCount(0);
      await accessibleLayout(page, info, 'household-card-import-' + width);
      await info.attach('household-payment-methods-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      await mkdir('coverage/customer-card-import', { recursive: true });
      await writeFile(`coverage/customer-card-import/${width}-household.png`, await page.screenshot({ fullPage: true }));
      const settings = (await owner.json<{ data: { currency: string } }>('/api/settings')).data;
      const invoice = (await owner.json<{ data: { number: number } }>('/api/billing/invoices/one-off', 'POST', {
        householdId: household.id, dueOn: new Date().toISOString().slice(0, 10), source: 'custom', description: 'Household cards check',
        currency: settings.currency, amountCents: 1000, taxRateIds: [],
      })).data;
      await page.reload();
      await page.getByRole('button', { name: 'View invoice ' + invoice.number, exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('button', { name: 'Import cards from Stripe', exact: true })).toHaveCount(0);
      await expect(page.locator('button').filter({ hasText: /^Import cards from Stripe$/ })).toHaveCount(1);
      await expect(dialog.getByText(/4242/)).toBeVisible();
      await accessibleLayout(page, info, 'household-card-invoice-' + width);
      await writeFile(`coverage/customer-card-import/${width}-household-invoice.png`, await page.screenshot({ fullPage: true }));
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
      await page.getByRole('button', { name: 'Refresh payment methods', exact: true }).click();
      await accessibleLayout(page, info, 'customer-card-import-' + width);
      await mkdir('coverage/customer-card-import', { recursive: true });
      await writeFile(`coverage/customer-card-import/${width}.png`, await page.screenshot({ fullPage: true }));
    } finally { await context.close(); }
  });
}
