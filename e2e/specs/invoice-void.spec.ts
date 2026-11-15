// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

for (const width of [360, 1280]) {
  test(`staff voids an invoice with a reason at ${width}px`, async ({ browser, install }, info) => {
    const owner = install.clients.owner;
    const household = (await owner.json<{ data: { id: string } }>('/api/households', 'POST', { name: 'Void invoice ' + width })).data;
    const settings = (await owner.json<{ data: { currency: string } }>('/api/settings')).data;
    const bill = (await owner.json<{ data: { id: string; number: number } }>('/api/billing/invoices/one-off', 'POST', {
      householdId: household.id, dueOn: new Date().toISOString().slice(0, 10), source: 'custom', description: 'Invoice entered in error',
      currency: settings.currency, amountCents: 1000, taxRateIds: [],
    })).data;
    const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
    try {
      await owner.browser(context);
      const page = await context.newPage();
      await page.goto(gymOrigin + '/admin/billing/invoices');
      await page.getByRole('button', { name: 'View invoice ' + bill.number, exact: true }).click();
      await page.getByRole('button', { name: 'Void invoice', exact: true }).click();
      const reason = page.getByRole('textbox', { name: 'Reason', exact: true });
      await expect(reason).toHaveAttribute('required', '');
      await reason.fill('Invoice entered in error');
      await expect(page.getByText('This invoice will no longer be owed.', { exact: false })).toBeVisible();
      await accessibleLayout(page, info, 'invoice-void-' + width);
      await mkdir('coverage/invoice-void', { recursive: true });
      await writeFile(`coverage/invoice-void/${width}.png`, await page.screenshot({ fullPage: true }));
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(page.getByText('Invoice voided. No payment is owed on this invoice.')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Void invoice', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Charge saved card', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Send or share pay link', exact: true })).toHaveCount(0);
      const detail = await owner.json<{ data: { invoice: { status: string } } }>('/api/billing/invoices/' + bill.id);
      expect(detail.data.invoice.status).toBe('void');
    } finally { await context.close(); }
  });
}
