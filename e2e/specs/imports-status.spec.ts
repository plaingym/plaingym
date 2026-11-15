// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

for (const width of [360, 1280]) {
  test(`import run outcomes at ${width}px`, async ({ browser, install }, info) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
    try {
      await install.clients.owner.browser(context);
      const page = await context.newPage();
      const uploadId = '01900000-0000-7000-8000-000000000001';
      const runId = '01900000-0000-7000-8000-000000000002';
      const createdAt = new Date().toISOString();
      let job = { id: runId, uploadId, mapper: 'people', dryRun: true, status: 'succeeded',
        totalRows: 1000, processedRows: 1000, committedRows: 0, errorCount: 0, createdAt, completedAt: createdAt };
      await page.route('**/api/imports/uploads', route => route.fulfill({ json: { data: {
        id: uploadId, filename: 'people.csv', rowCount: 1000, columns: ['Name'],
        suggestedMapping: [{ sourceColumn: 'Name', targetField: 'firstName' }], expiresAt: createdAt,
      } } }));
      await page.route('**/api/imports', route => route.fulfill({ json: { data: job } }));
      await page.route('**/api/imports/019*', route => route.fulfill({ json: { data: job } }));
      await page.route('**/api/imports/*/errors?*', route => route.fulfill({ json: {
        data: [], pagination: { limit: 50, offset: 0, total: 0 },
      } }));
      for (const outcome of [
        { status: 'succeeded', processedRows: 1000, committedRows: 1000, errorCount: 0, label: 'Complete', name: 'clean' },
        { status: 'failed', processedRows: 1000, committedRows: 999, errorCount: 1, label: 'Finished with 1 row error', name: 'row-errors' },
        { status: 'failed', processedRows: 500, committedRows: 499, errorCount: 1, label: 'Failed; review the error report', name: 'stopped' },
      ]) {
        job = { ...job, id: runId, dryRun: true, status: 'succeeded', processedRows: 1000, committedRows: 0, errorCount: 0 };
        await page.goto(gymOrigin + '/admin/imports');
        await page.getByLabel('CSV file').setInputFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from('Name\nPerson') });
        await page.getByRole('button', { name: 'Dry run', exact: true }).click();
        await expect(page.getByRole('button', { name: 'Commit import', exact: true })).toBeEnabled();
        job = { ...job, id: '01900000-0000-7000-8000-000000000003', dryRun: false, status: outcome.status, processedRows: outcome.processedRows,
          committedRows: outcome.committedRows, errorCount: outcome.errorCount };
        await page.getByRole('button', { name: 'Commit import', exact: true }).click();
        await expect(page.getByRole('status')).toContainText('Import CSV: ' + outcome.label);
        await expect(page.getByRole('status')).toContainText('Committed: ' + outcome.committedRows.toLocaleString('en'));
        await accessibleLayout(page, info, 'import-' + outcome.name);
        await mkdir('coverage/imports-status', { recursive: true });
        await writeFile(`coverage/imports-status/${outcome.name}-${width}.png`, await page.screenshot({ fullPage: true }));
      }
    } finally { await context.close(); }
  });
}
