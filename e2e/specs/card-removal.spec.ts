// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

for (const width of [360, 1280]) {
  test(`invoice processing status, saved methods and removal at ${width}px`, async ({ browser, install }, info) => {
    const owner = install.clients.owner;
    const household = (await owner.json<{ data: { id: string } }>('/api/households', 'POST', { name: 'Card removal ' + width })).data;
    const settings = (await owner.json<{ data: { currency: string } }>('/api/settings')).data;
    const bill = (await owner.json<{ data: { id: string; number: number } }>('/api/billing/invoices/one-off', 'POST', {
      householdId: household.id, dueOn: new Date().toISOString().slice(0, 10), source: 'custom', description: 'Card removal notice',
      currency: settings.currency, amountCents: 1000, taxRateIds: [],
    })).data;
    const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
    try {
      await owner.browser(context);
      const page = await context.newPage();
      // Substitute the read status for this invoice so the screen can be checked without a live debit.
      await page.route(url => url.pathname === '/api/billing/invoices', async route => {
        const response = await route.fetch();
        const body = await response.json();
        for (const invoice of body.data) if (invoice.id === bill.id) invoice.status = 'processing';
        await route.fulfill({ response, json: body });
      });
      await page.route(url => url.pathname === '/api/billing/invoices/' + bill.id, async route => {
        const response = await route.fetch();
        const body = await response.json();
        body.data.invoice.status = 'processing';
        await route.fulfill({ response, json: body });
      });
      const bankName = 'AReallyLongExampleBankNameThatNeedsToWrapOnASmallScreen';
      const bankLabel = bankName + ' account ending 6789';
      await page.route(`**/api/billing/households/${household.id}/payment-methods*`, route => route.fulfill({ json: {
        data: [{ id: crypto.randomUUID(), createdAt: new Date().toISOString(), householdId: household.id,
          type: 'card', bankName: null, brand: 'visa', last4: '4242', expiryMonth: 12, expiryYear: 2030, isDefault: true, revokedAt: null },
        { id: crypto.randomUUID(), createdAt: new Date().toISOString(), householdId: household.id,
          type: 'us_bank_account', bankName, brand: null, last4: '6789', expiryMonth: null, expiryYear: null, isDefault: false, revokedAt: null }],
        pagination: { limit: 25, offset: 0, total: 2 },
      } }));
      await page.goto(gymOrigin + '/admin/billing/invoices');
      const view = page.getByRole('button', { name: 'View invoice ' + bill.number, exact: true });
      const row = page.getByRole('listitem').filter({ has: view });
      await expect(row.getByText('Processing', { exact: true })).toBeVisible();
      await accessibleLayout(page, info, 'processing-invoice-list-' + width);
      await info.attach('processing-invoice-list-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      await view.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByText('Processing', { exact: true })).toBeVisible();
      await expect(dialog.getByText(bankLabel, { exact: true })).toBeVisible();
      await accessibleLayout(page, info, 'processing-invoice-dialog-' + width);
      await info.attach('processing-invoice-dialog-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      await page.goto(gymOrigin + '/admin/billing/invoices/' + bill.id);
      await expect(page.getByText('Processing', { exact: true })).toBeVisible();
      await expect(page.getByText(bankLabel, { exact: true })).toBeVisible();
      await accessibleLayout(page, info, 'processing-invoice-detail-' + width);
      await info.attach('processing-invoice-detail-' + width, { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });
      const card = page.getByRole('listitem').filter({ hasText: 'Visa · 4242 · 12/2030' });
      await card.getByRole('button', { name: 'Remove payment method', exact: true }).click();
      const confirmation = page.getByRole('region', { name: 'Remove saved payment method', exact: true });
      await expect(confirmation.getByText('The newest remaining payment method without an expiry date or whose stored expiry has not passed becomes the default for automatic payments.', { exact: false })).toBeVisible();
      await expect(confirmation.getByText('If no payment methods remain, automatic payments stop until another is saved.', { exact: false })).toBeVisible();
      await accessibleLayout(page, info, 'card-removal-' + width);
      await mkdir('coverage/card-removal', { recursive: true });
      await writeFile(`coverage/card-removal/${width}.png`, await page.screenshot({ fullPage: true }));
    } finally { await context.close(); }
  });
}
