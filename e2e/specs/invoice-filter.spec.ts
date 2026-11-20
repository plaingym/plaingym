// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

for (const width of [360, 1280]) {
  test(`invoice status filter at ${width}px`, async ({ browser, install }, info) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
    try {
      await install.clients.owner.browser(context);
      const page = await context.newPage();
      await page.goto(gymOrigin + '/admin/billing/invoices');
      const filter = page.getByRole('combobox', { name: 'Status', exact: true });
      await expect(filter).toBeVisible();
      await expect(filter.locator('option')).toHaveCount(9);
      expect(await filter.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value)))
        .toEqual(['', 'draft', 'open', 'processing', 'past_due', 'paid', 'void', 'partially_refunded', 'refunded']);
      await filter.selectOption('past_due');
      await expect(filter).toHaveValue('past_due');
      await accessibleLayout(page, info, 'invoice-filter-' + width);
      await mkdir('coverage/invoice-filter', { recursive: true });
      await writeFile(`coverage/invoice-filter/${width}.png`, await page.screenshot({ fullPage: true }));
    } finally { await context.close(); }
  });
}
