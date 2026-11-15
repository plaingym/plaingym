// SPDX-License-Identifier: AGPL-3.0-only
import { mkdir, writeFile } from 'node:fs/promises';
import { test, expect, gymOrigin } from '../support.js';
import { accessibleLayout } from '../responsive.js';

for (const width of [360, 1280]) for (const amountCents of [1000, 32]) {
  test(`pay-link replay confirmation follows the invoice amount ${amountCents} at ${width}px`, async ({ browser, install }, info) => {
    const owner = install.clients.owner;
    const household = (await owner.json<{ data: { id: string } }>('/api/households', 'POST', { name: `Pay-link confirmation ${width} ${amountCents}` })).data;
    const settings = (await owner.json<{ data: { currency: string } }>('/api/settings')).data;
    const bill = (await owner.json<{ data: { id: string; number: number } }>('/api/billing/invoices/one-off', 'POST', {
      householdId: household.id, dueOn: new Date().toISOString().slice(0, 10), source: 'custom', description: 'Pay-link confirmation',
      currency: settings.currency, amountCents, taxRateIds: [],
    })).data;
    const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
    try {
      await owner.browser(context);
      const page = await context.newPage();
      // Replay a send whose credential has since been revoked, without sending another email.
      await page.route('**/api/links/send', route => route.fulfill({ json: { data: {
        id: crypto.randomUUID(), householdId: household.id, invoiceId: bill.id, purpose: 'pay_invoice',
        memberId: null, campaignId: null, createdBy: null, createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400_000).toISOString(), usedAt: null, revokedAt: new Date().toISOString(),
      } } }));
      await page.goto(gymOrigin + '/admin/billing/invoices');
      await page.getByRole('button', { name: 'View invoice ' + bill.number, exact: true }).click();
      await page.getByRole('button', { name: 'Send or share pay link', exact: true }).click();
      await page.getByRole('region', { name: 'Pay link', exact: true }).getByRole('button', { name: 'Confirm', exact: true }).click();
      const message = amountCents === 32 ? 'Manual-payment instructions sent to the household.' : 'Pay link sent to the household.';
      await expect(page.getByText(message, { exact: true })).toBeVisible();
      await accessibleLayout(page, info, `pay-link-${width}-${amountCents}`);
      await mkdir('coverage/pay-link-confirmation', { recursive: true });
      await writeFile(`coverage/pay-link-confirmation/${width}-${amountCents}.png`, await page.screenshot({ fullPage: true }));
    } finally { await context.close(); }
  });
}
