// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, gymOrigin, type RecordId } from '../support.js';
import { accessibleLayout } from '../responsive.js';

for (const width of [360, 1280]) {
  test(`catalog clashes and import preview explanations at ${width}px`, async ({ browser, install }, info) => {
    const owner = install.clients.owner;
    const currency = (await owner.json<{ data: { currency: string } }>('/api/settings')).data.currency;
    const name = 'Review charge ' + width;
    const charge = (await owner.json<{ data: RecordId & { revision: number } }>('/api/billing/charge-types', 'POST', {
      name, currency, amountCents: 4000, active: true, taxRateIds: [],
    })).data;
    const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
    try {
      await owner.browser(context);
      const page = await context.newPage();
      const capture = async (label: string) => {
        await accessibleLayout(page, info, label);
        await mkdir('coverage/imports-catalog', { recursive: true });
        await writeFile(`coverage/imports-catalog/${label}-${width}.png`, await page.screenshot({ fullPage: true }));
      };
      await page.goto(gymOrigin + '/admin/billing/plans');
      await page.getByRole('button', { name: 'Charge types', exact: true }).click();
      await page.getByRole('button', { name: 'Edit ' + name, exact: true }).click();
      await page.getByLabel(`Amount (${currency})`, { exact: true }).fill('45.00');
      await owner.json('/api/billing/charge-types/' + charge.id, 'PATCH', { revision: charge.revision, amountCents: 5000 });
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('button', { name: 'Reload record', exact: true }).click();
      await expect(page.getByRole('note').filter({ hasText: 'Latest value: 50.00' })).toBeVisible();
      await expect(page.getByLabel(`Amount (${currency})`, { exact: true })).toHaveValue('45.00');
      await capture('catalog-clash');

      const uploadId = '01900000-0000-7000-8000-000000000001';
      await page.route('**/api/imports/uploads', route => route.fulfill({ json: { data: {
        id: uploadId, filename: 'people.csv', rowCount: 1, columns: ['Name'],
        suggestedMapping: [{ sourceColumn: 'Name', targetField: 'firstName' }], expiresAt: new Date(Date.now() + 3600000).toISOString(),
      } } }));
      await page.route('**/api/imports/preview?*', route => route.fulfill({ status: 503, json: {
        error: { code: 'unavailable', message: 'Preview timed out. Split the file into smaller files and try again.' },
      } }));
      await page.goto(gymOrigin + '/admin/imports');
      await page.getByLabel('CSV file').setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from('Name\nPerson') });
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(page.getByRole('alert')).toContainText('Split the file');
      await capture('import-preview-error');
      await page.getByRole('combobox', { name: /^Import type/ }).selectOption('memberships');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await capture('import-plan-changed');
      await page.route('**/api/imports/preview?*', route => route.fulfill({ json: {
        data: [{ rowNumber: 2, values: { firstName: 'Person', lastName: 'Preview' }, action: 'create', duplicateIds: [] }],
        pagination: { limit: 50, offset: 0, total: 1 }, summary: { totalRows: 1, create: 1, update: 0, skip: 0, errors: 0 },
      } }));
      await page.getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(page.getByRole('columnheader', { name: 'First name', exact: true })).toBeVisible();
      await expect(page.getByRole('columnheader', { name: 'Last name', exact: true })).toBeVisible();
      await expect(page.getByRole('cell', { name: 'Person', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Previous', exact: true })).toHaveCount(0);
      await capture('import-preview-columns');
    } finally { await context.close(); }
  });
}
