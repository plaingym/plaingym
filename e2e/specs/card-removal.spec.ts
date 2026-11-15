// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

for (const width of [360, 1280]) {
  test(`card removal explains the next automatic payment at ${width}px`, async ({ browser, install }, info) => {
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
      // Only the saved-card read is a fixture: this checks the rendered confirmation without detaching a real card.
      await page.route(`**/api/billing/households/${household.id}/payment-methods*`, route => route.fulfill({ json: {
        data: [{ id: crypto.randomUUID(), createdAt: new Date().toISOString(), householdId: household.id,
          brand: 'visa', last4: '4242', expiryMonth: 12, expiryYear: 2030, isDefault: true, revokedAt: null }],
        pagination: { limit: 25, offset: 0, total: 1 },
      } }));
      await page.goto(gymOrigin + '/admin/billing/invoices');
      await page.getByRole('button', { name: 'View invoice ' + bill.number, exact: true }).click();
      await page.getByRole('button', { name: 'Remove card', exact: true }).click();
      const confirmation = page.getByRole('region', { name: 'Remove saved card', exact: true });
      await expect(confirmation.getByText('the most recently added remaining card becomes the default for automatic payments', { exact: false })).toBeVisible();
      await expect(confirmation.getByText('If no cards remain, automatic card payments stop until another card is saved.', { exact: false })).toBeVisible();
      await accessibleLayout(page, info, 'card-removal-' + width);
      await mkdir('coverage/card-removal', { recursive: true });
      await writeFile(`coverage/card-removal/${width}.png`, await page.screenshot({ fullPage: true }));
    } finally { await context.close(); }
  });
}
